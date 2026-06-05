/**
 * Xero Request Broker
 *
 * Centralised gateway for ALL Xero API communication (mirrors the HireHop
 * broker pattern). Handles:
 *   - client_credentials token mint + in-memory cache (re-mint on expiry/401)
 *   - single-tenant resolution via GET /connections (Custom Connection = 1 org)
 *   - token-bucket rate limiting (~55/min; Xero allows 60/min/org)
 *   - retry on 429 / 5xx / network throw
 *
 * Do NOT call Xero directly elsewhere — use this broker so token + tenant +
 * rate-limit handling live in one place.
 */
import {
  getXeroConfig,
  isXeroConfigured,
  XERO_IDENTITY_URL,
  XERO_CONNECTIONS_URL,
  XERO_API_BASE,
  XERO_BILLS_SCOPES,
} from '../config/xero';

// ── Types ────────────────────────────────────────────────────────────────

export interface XeroAccount {
  AccountID: string;
  Code: string;
  Name: string;
  Type: string;
  TaxType?: string;
  Class?: string;
  Status?: string;
  Description?: string;
}

export interface XeroTaxRate {
  Name: string;
  TaxType: string;
  EffectiveRate: number;
  Status?: string;
}

export interface XeroTrackingCategory {
  TrackingCategoryID: string;
  Name: string;
  Status?: string;
  Options?: Array<{ TrackingOptionID: string; Name: string; Status?: string }>;
}

export interface XeroContact {
  ContactID: string;
  Name: string;
}

export interface XeroLineItem {
  Description: string;
  Quantity?: number;
  UnitAmount: number;
  AccountCode?: string;
  TaxType?: string;
  Tracking?: Array<{ Name: string; Option: string }>;
}

export interface CreateBillInput {
  contactName: string;
  reference?: string;
  date?: string;          // YYYY-MM-DD
  dueDate?: string;       // YYYY-MM-DD
  lineItems: XeroLineItem[];
  lineAmountTypes?: 'Inclusive' | 'Exclusive' | 'NoTax';
  status?: 'DRAFT' | 'AUTHORISED';
}

export interface CreateSpendMoneyInput {
  /** Either bankAccountId (Xero AccountID / UUID) or bankAccountCode is required. */
  bankAccountId?: string;
  bankAccountCode?: string;
  /** Either contactId or contactName is required. */
  contactId?: string;
  contactName?: string;
  date?: string;
  reference?: string;
  lineItems: XeroLineItem[];
  lineAmountTypes?: 'Inclusive' | 'Exclusive' | 'NoTax';
}

export interface XeroHealth {
  configured: boolean;
  connected: boolean;
  tenantId?: string;
  tenantName?: string;
  error?: string;
}

class XeroApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
    this.name = 'XeroApiError';
  }
}

// Xero wraps the useful reason for a 400 "A validation exception occurred" in
// Elements[].ValidationErrors[].Message (PUT /Invoices, /BankTransactions,
// /Payments). Surface those so the cost row's error is actionable rather than
// the generic top-level message.
function extractXeroErrorMessage(json: Record<string, unknown>, status: number): string {
  const top = (json.Message as string) || (json.detail as string) || '';
  const elements = json.Elements as Array<{ ValidationErrors?: Array<{ Message?: string }> }> | undefined;
  const details: string[] = [];
  if (Array.isArray(elements)) {
    for (const el of elements) {
      for (const ve of el.ValidationErrors || []) {
        if (ve.Message) details.push(ve.Message);
      }
    }
  }
  if (details.length) {
    return top ? `${top}: ${details.join('; ')}` : details.join('; ');
  }
  return top || `Xero error ${status}`;
}

// ── Rate limiter (simple token bucket) ──────────────────────────────────────

const RATE = { maxTokens: 55, windowMs: 60_000, minDelayMs: 250 };
const RETRY = { maxAttempts: 3, delaysMs: [1_000, 3_000] };

class RateLimiter {
  private tokens = RATE.maxTokens;
  private lastRefill = Date.now();
  private lastRequest = 0;

  private refill() {
    const now = Date.now();
    const add = Math.floor(((now - this.lastRefill) / RATE.windowMs) * RATE.maxTokens);
    if (add > 0) {
      this.tokens = Math.min(RATE.maxTokens, this.tokens + add);
      this.lastRefill = now;
    }
  }

  async acquire() {
    this.refill();
    const sinceLast = Date.now() - this.lastRequest;
    if (sinceLast < RATE.minDelayMs) {
      await new Promise((r) => setTimeout(r, RATE.minDelayMs - sinceLast));
    }
    while (this.tokens < 1) {
      await new Promise((r) => setTimeout(r, 100));
      this.refill();
    }
    this.tokens--;
    this.lastRequest = Date.now();
  }
}

// ── Broker ───────────────────────────────────────────────────────────────

class XeroBroker {
  private limiter = new RateLimiter();
  // Two token caches: the base token (DEFAULT_SCOPES — reads + Spend Money,
  // always mintable) and an isolated bills token (base + granular bill scopes).
  // Keeping them separate means an ungranted bill scope only fails bill ops; it
  // can never break the base reads.
  private token: { value: string; expiresAt: number } | null = null;
  private billsToken: { value: string; expiresAt: number } | null = null;
  private tenant: { id: string; name: string } | null = null;

  private async mintToken(scope: string): Promise<{ value: string; expiresAt: number }> {
    const { clientId, clientSecret } = getXeroConfig();
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch(XERO_IDENTITY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || !body.access_token) {
      throw new XeroApiError(
        res.status,
        `Xero token request failed: ${body.error || res.statusText}`,
        body
      );
    }
    const expiresIn = Number(body.expires_in) || 1800;
    return { value: String(body.access_token), expiresAt: Date.now() + expiresIn * 1000 };
  }

  /**
   * Mint (or reuse cached) access token via client_credentials. `bills=true`
   * uses the isolated bills token (base scopes + accounting.invoices/payments) —
   * a failure here (e.g. scopes not yet granted → invalid_scope) is contained to
   * bill operations and never touches the base token.
   */
  private async getToken(forceFresh = false, bills = false): Promise<string> {
    const cache = bills ? this.billsToken : this.token;
    if (!forceFresh && cache && Date.now() < cache.expiresAt - 60_000) {
      return cache.value;
    }
    const { scopes } = getXeroConfig();
    const minted = await this.mintToken(bills ? `${scopes} ${XERO_BILLS_SCOPES}` : scopes);
    if (bills) this.billsToken = minted; else this.token = minted;
    return minted.value;
  }

  /** Resolve the single tenant for this Custom Connection (cached). */
  private async getTenant(token: string): Promise<{ id: string; name: string }> {
    if (this.tenant) return this.tenant;
    const res = await fetch(XERO_CONNECTIONS_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const conns = (await res.json().catch(() => [])) as Array<{ tenantId: string; tenantName: string }>;
    if (!res.ok || !Array.isArray(conns) || conns.length === 0) {
      throw new XeroApiError(res.status, 'No Xero connection found for this app', conns);
    }
    this.tenant = { id: conns[0].tenantId, name: conns[0].tenantName };
    return this.tenant;
  }

  /** Core request. Re-mints token + tenant on 401, retries 429/5xx. */
  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string>; body?: unknown; rawBody?: { buffer: Buffer; contentType: string }; billsScope?: boolean } = {}
  ): Promise<T> {
    const bills = opts.billsScope === true;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt++) {
      await this.limiter.acquire();
      const forceFresh = attempt > 1 && lastErr instanceof XeroApiError && lastErr.status === 401;
      const token = await this.getToken(forceFresh, bills);
      const tenant = await this.getTenant(token);

      const url = new URL(`${XERO_API_BASE}${path}`);
      for (const [k, v] of Object.entries(opts.query || {})) url.searchParams.set(k, v);

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Xero-Tenant-Id': tenant.id,
        Accept: 'application/json',
      };
      let body: string | Uint8Array | undefined;
      if (opts.rawBody) {
        headers['Content-Type'] = opts.rawBody.contentType;
        body = opts.rawBody.buffer;
      } else if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(opts.body);
      }

      let res: Response;
      try {
        res = await fetch(url, { method, headers, body });
      } catch (networkErr) {
        lastErr = new XeroApiError(0, `Xero network error: ${String(networkErr)}`);
        if (attempt < RETRY.maxAttempts) {
          await new Promise((r) => setTimeout(r, RETRY.delaysMs[attempt - 1] ?? 3_000));
          continue;
        }
        throw lastErr;
      }

      if (res.status === 401) {
        // Insufficient scope on a bill call surfaces as 401 (Xero sends
        // WWW-Authenticate: insufficient_scope). Re-minting won't help if the
        // scope simply isn't granted, but one retry covers a genuinely stale
        // token; the push layer treats a thrown 401 as a scope advisory.
        if (bills) this.billsToken = null; else this.token = null;
        lastErr = new XeroApiError(401, 'Xero token rejected (re-minting)');
        if (attempt < RETRY.maxAttempts) continue;
        throw lastErr;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new XeroApiError(res.status, `Xero transient error ${res.status}`);
        if (attempt < RETRY.maxAttempts) {
          await new Promise((r) => setTimeout(r, RETRY.delaysMs[attempt - 1] ?? 3_000));
          continue;
        }
        throw lastErr;
      }

      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw new XeroApiError(res.status, extractXeroErrorMessage(json, res.status), json);
      }
      return json as T;
    }
    throw lastErr ?? new XeroApiError(0, 'Xero request failed');
  }

  // ── Health / diagnostics ─────────────────────────────────────────────────

  async health(): Promise<XeroHealth> {
    if (!isXeroConfigured()) return { configured: false, connected: false };
    try {
      const token = await this.getToken(true);
      const tenant = await this.getTenant(token);
      return { configured: true, connected: true, tenantId: tenant.id, tenantName: tenant.name };
    } catch (err) {
      return {
        configured: true,
        connected: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  async getAccounts(): Promise<XeroAccount[]> {
    const r = await this.request<{ Accounts: XeroAccount[] }>('GET', '/Accounts');
    return r.Accounts || [];
  }

  async getTaxRates(): Promise<XeroTaxRate[]> {
    const r = await this.request<{ TaxRates: XeroTaxRate[] }>('GET', '/TaxRates');
    return r.TaxRates || [];
  }

  async getTrackingCategories(): Promise<XeroTrackingCategory[]> {
    const r = await this.request<{ TrackingCategories: XeroTrackingCategory[] }>('GET', '/TrackingCategories');
    return r.TrackingCategories || [];
  }

  /** Read bank transactions (e.g. company-card COT account) for reconciliation. */
  async getBankTransactions(where?: string): Promise<unknown[]> {
    const r = await this.request<{ BankTransactions: unknown[] }>('GET', '/BankTransactions', {
      query: where ? { where } : undefined,
    });
    return r.BankTransactions || [];
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  /** Find a contact by exact name or create it (for ACCPAY supplier linkage). */
  async getOrCreateContact(name: string): Promise<XeroContact> {
    const found = await this.request<{ Contacts: XeroContact[] }>('GET', '/Contacts', {
      query: { where: `Name=="${name.replace(/"/g, '\\"')}"` },
    });
    if (found.Contacts?.length) return found.Contacts[0];
    const created = await this.request<{ Contacts: XeroContact[] }>('POST', '/Contacts', {
      body: { Contacts: [{ Name: name }] },
    });
    return created.Contacts[0];
  }

  /**
   * Fuzzy-search Xero contacts by name (uses Xero's `searchTerm` parameter).
   * Powers the capture modal's supplier autocomplete — staff pick an existing
   * supplier rather than retyping (avoids duplicate suppliers from typos).
   * Returns up to `limit` ACTIVE contacts; if the search is empty, returns [].
   */
  async searchContacts(searchTerm: string, limit = 10): Promise<XeroContact[]> {
    const trimmed = searchTerm.trim();
    if (!trimmed) return [];
    const r = await this.request<{ Contacts: (XeroContact & { ContactStatus?: string })[] }>(
      'GET', '/Contacts', { query: { searchTerm: trimmed, page: '1' } }
    );
    return (r.Contacts || [])
      .filter((c) => !c.ContactStatus || c.ContactStatus === 'ACTIVE')
      .slice(0, limit)
      .map((c) => ({ ContactID: c.ContactID, Name: c.Name }));
  }

  /** Create an unpaid supplier bill (ACCPAY invoice). */
  async createBill(input: CreateBillInput): Promise<{ InvoiceID: string; InvoiceNumber?: string }> {
    const contact = await this.getOrCreateContact(input.contactName);
    const r = await this.request<{ Invoices: Array<{ InvoiceID: string; InvoiceNumber?: string }> }>(
      'PUT',
      '/Invoices',
      {
        body: {
          Invoices: [
            {
              Type: 'ACCPAY',
              Contact: { ContactID: contact.ContactID },
              Reference: input.reference,
              Date: input.date,
              DueDate: input.dueDate,
              LineAmountTypes: input.lineAmountTypes || 'Inclusive',
              Status: input.status || 'DRAFT',
              LineItems: input.lineItems,
            },
          ],
        },
        billsScope: true,
      }
    );
    return r.Invoices[0];
  }

  /**
   * Record a payment against an ACCPAY bill (flips it Awaiting Payment → Paid).
   * The payment posts to the chosen bank account on the given date (which may be
   * future, for a scheduled payment). Governed by the `accounting.transactions`
   * scope — same gate as createBill().
   */
  async payInvoice(input: {
    invoiceId: string;
    accountId: string;
    amount: number;
    date?: string;        // YYYY-MM-DD; defaults to today in Xero if omitted
    reference?: string;
  }): Promise<{ PaymentID: string }> {
    const r = await this.request<{ Payments: Array<{ PaymentID: string }> }>(
      'PUT',
      '/Payments',
      {
        body: {
          Payments: [
            {
              Invoice: { InvoiceID: input.invoiceId },
              Account: { AccountID: input.accountId },
              Amount: input.amount,
              Date: input.date,
              Reference: input.reference,
            },
          ],
        },
        billsScope: true,
      }
    );
    return r.Payments[0];
  }

  /** Spend money (petty cash / PayPal / reimbursement not on a bank feed). */
  async createSpendMoney(input: CreateSpendMoneyInput): Promise<{ BankTransactionID: string }> {
    const contactID = input.contactId
      ?? (await this.getOrCreateContact(input.contactName ?? 'Unknown supplier')).ContactID;
    const bankAccount = input.bankAccountId
      ? { AccountID: input.bankAccountId }
      : { Code: input.bankAccountCode };
    const r = await this.request<{ BankTransactions: Array<{ BankTransactionID: string }> }>(
      'PUT',
      '/BankTransactions',
      {
        body: {
          BankTransactions: [
            {
              Type: 'SPEND',
              Contact: { ContactID: contactID },
              BankAccount: bankAccount,
              Date: input.date,
              Reference: input.reference,
              LineAmountTypes: input.lineAmountTypes || 'Inclusive',
              LineItems: input.lineItems,
            },
          ],
        },
      }
    );
    return r.BankTransactions[0];
  }

  /** All ACTIVE bank accounts in the chart of accounts (Type=BANK). */
  async getBankAccounts(): Promise<Array<XeroAccount & { BankAccountNumber?: string }>> {
    const r = await this.request<{ Accounts: Array<XeroAccount & { BankAccountNumber?: string }> }>(
      'GET', '/Accounts', { query: { where: 'Type=="BANK" AND Status=="ACTIVE"' } }
    );
    return r.Accounts || [];
  }

  /** Attach a receipt file to an invoice or bank transaction. */
  async attachReceipt(
    entity: 'Invoices' | 'BankTransactions',
    entityId: string,
    filename: string,
    buffer: Buffer,
    contentType: string
  ): Promise<unknown> {
    return this.request(
      'PUT',
      `/${entity}/${entityId}/Attachments/${encodeURIComponent(filename)}`,
      // Attaching to an invoice (a bill) needs the bills token; bank-transaction
      // attachments use the base token (accounting.attachments already granted).
      { rawBody: { buffer, contentType }, billsScope: entity === 'Invoices' },
    );
  }
}

export const xeroBroker = new XeroBroker();
export default xeroBroker;
export { XeroApiError };
