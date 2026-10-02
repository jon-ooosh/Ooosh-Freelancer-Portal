/**
 * The two pure halves of the DVSA MOT module: reading DVSA's response, and
 * deciding whether mot_due moves. The second is the one that matters — it
 * rewrites a compliance date on its own, so it must only ever move FORWARD.
 */
import { parseMotPayload, compareMotDue, normaliseReg, describeDvsaError, entraErrorDetail } from '../dvsa-mot';

// Shaped like a real DVSA VehicleWithMotResponse (openapi spec, Sep 2026).
const vanWithTests = {
  registration: 'RX21ABC',
  make: 'MERCEDES-BENZ',
  model: 'SPRINTER',
  hasOutstandingRecall: 'No',
  motTests: [
    {
      completedDate: '2024-09-10T11:02:00.000Z',
      testResult: 'PASSED',
      expiryDate: '2025-09-09',
      odometerValue: '61234',
      odometerUnit: 'MI',
      odometerResultType: 'READ',
      motTestNumber: '111122223333',
      dataSource: 'DVSA',
      defects: [{ text: 'Nearside front tyre worn close to legal limit', type: 'ADVISORY', dangerous: false }],
    },
    {
      completedDate: '2025-09-02T09:15:00.000Z',
      testResult: 'FAILED',
      expiryDate: null,
      odometerValue: '88410',
      odometerUnit: 'MI',
      odometerResultType: 'READ',
      motTestNumber: '444455556666',
      dataSource: 'DVSA',
      defects: [{ text: 'Brake pipe excessively corroded', type: 'DANGEROUS', dangerous: true }],
    },
    {
      completedDate: '2025-09-03T14:40:00.000Z',
      testResult: 'PASSED',
      expiryDate: '2026-09-02',
      odometerValue: '88415',
      odometerUnit: 'MI',
      odometerResultType: 'READ',
      motTestNumber: '777788889999',
      dataSource: 'DVSA',
      defects: [],
    },
  ],
};

describe('parseMotPayload', () => {
  it('sorts tests newest first', () => {
    const s = parseMotPayload(vanWithTests);
    expect(s.tests.map((t) => t.testNumber)).toEqual(['777788889999', '444455556666', '111122223333']);
  });

  it("takes the MOT due date from the latest PASSED test, not the latest test", () => {
    // The fail on 2 Sep has no expiry; the retest pass on 3 Sep is the MOT.
    expect(parseMotPayload(vanWithTests).dvsaMotDue).toBe('2026-09-02');
  });

  it('ignores an expiry date on a FAILED test', () => {
    const payload = {
      hasOutstandingRecall: 'No',
      motTests: [
        { completedDate: '2025-01-01T00:00:00Z', testResult: 'PASSED', expiryDate: '2025-12-31', odometerResultType: 'READ', dataSource: 'DVSA' },
        { completedDate: '2025-12-20T00:00:00Z', testResult: 'FAILED', expiryDate: '2026-12-19', odometerResultType: 'READ', dataSource: 'DVSA' },
      ],
    };
    expect(parseMotPayload(payload).dvsaMotDue).toBe('2025-12-31');
  });

  it('flags dangerous defects even when only the type says so', () => {
    const payload = {
      hasOutstandingRecall: 'Unknown',
      motTests: [{
        completedDate: '2025-01-01T00:00:00Z', testResult: 'FAILED', odometerResultType: 'READ', dataSource: 'DVSA',
        defects: [{ text: 'x', type: 'DANGEROUS', dangerous: null }],
      }],
    };
    expect(parseMotPayload(payload).tests[0].defects[0].dangerous).toBe(true);
  });

  it('reads the odometer as a number, and not at all when unreadable', () => {
    const s = parseMotPayload({
      hasOutstandingRecall: 'No',
      motTests: [
        { completedDate: '2025-01-02T00:00:00Z', testResult: 'PASSED', odometerValue: '12345', odometerUnit: 'KM', odometerResultType: 'READ', dataSource: 'DVSA' },
        { completedDate: '2025-01-01T00:00:00Z', testResult: 'PASSED', odometerValue: null, odometerUnit: null, odometerResultType: 'UNREADABLE', dataSource: 'DVSA' },
      ],
    });
    expect(s.tests[0].odometer).toBe(12345);
    expect(s.tests[0].odometerUnit).toBe('KM');
    expect(s.tests[1].odometer).toBeNull();
  });

  it('uses the first-MOT due date for a van too new to have had a test', () => {
    const s = parseMotPayload({
      registration: 'RX75NEW', hasOutstandingRecall: 'No', motTestDueDate: '2028-03-01',
    });
    expect(s.tests).toEqual([]);
    expect(s.dvsaMotDue).toBe('2028-03-01');
  });

  it('survives junk without throwing', () => {
    expect(parseMotPayload(null).tests).toEqual([]);
    expect(parseMotPayload('nope').dvsaMotDue).toBeNull();
    expect(parseMotPayload({ motTests: [null, 7, { testResult: 'PASSED' }] }).tests).toHaveLength(1);
  });
});

describe('compareMotDue', () => {
  it('moves forward when DVSA is later', () => {
    expect(compareMotDue('2025-09-09', '2026-09-02')).toBe('update');
  });

  it('fills an empty date', () => {
    expect(compareMotDue(null, '2026-09-02')).toBe('update');
  });

  it('never moves backwards — an earlier DVSA date is a warning only', () => {
    expect(compareMotDue('2027-01-01', '2026-09-02')).toBe('earlier');
  });

  it('does nothing when they match or DVSA has no date', () => {
    expect(compareMotDue('2026-09-02', '2026-09-02')).toBe('same');
    expect(compareMotDue('2026-09-02', null)).toBe('none');
    expect(compareMotDue(null, null)).toBe('none');
  });
});

describe('normaliseReg', () => {
  it('strips spaces and upper-cases', () => {
    expect(normaliseReg(' rx21 abc ')).toBe('RX21ABC');
  });
});

describe('describeDvsaError', () => {
  it('names an expired secret in plain words', () => {
    expect(describeDvsaError('auth')).toMatch(/client secret may have expired/);
  });
});

// ── The network half, against a fake DVSA ─────────────────────────────────
// Can't reach the real API from tests; these pin the token + retry handling
// that only ever runs on the server.
describe('fetchMotHistoryByReg', () => {
  const ENV = { ...process.env };
  const realFetch = global.fetch;

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  beforeEach(() => {
    jest.resetModules();
    Object.assign(process.env, {
      DVSA_CLIENT_ID: 'id', DVSA_CLIENT_SECRET: 'secret', DVSA_SCOPE: 'scope',
      DVSA_TOKEN_URL: 'https://login.example/token', DVSA_API_KEY: 'key',
    });
  });
  afterEach(() => {
    process.env = { ...ENV };
    global.fetch = realFetch;
  });

  it('fetches a token, then the registration with both headers', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return String(url).includes('login.example')
        ? jsonResponse(200, { access_token: 'tok', expires_in: 3600 })
        : jsonResponse(200, { registration: 'RX21ABC', motTests: [] });
    }) as unknown as typeof fetch;

    const { fetchMotHistoryByReg } = await import('../dvsa-mot');
    await fetchMotHistoryByReg('rx21 abc');

    expect(calls[1].url).toBe('https://history.mot.api.gov.uk/v1/trade/vehicles/registration/RX21ABC');
    const headers = calls[1].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['X-API-Key']).toBe('key');
  });

  it('retries once with a fresh token on a 401', async () => {
    let apiCalls = 0, tokenCalls = 0;
    global.fetch = jest.fn(async (url: string | URL | Request) => {
      if (String(url).includes('login.example')) {
        tokenCalls++;
        return jsonResponse(200, { access_token: `tok${tokenCalls}`, expires_in: 3600 });
      }
      apiCalls++;
      return apiCalls === 1 ? jsonResponse(401, {}) : jsonResponse(200, { motTests: [] });
    }) as unknown as typeof fetch;

    const { fetchMotHistoryByReg } = await import('../dvsa-mot');
    await expect(fetchMotHistoryByReg('RX21ABC')).resolves.toEqual({ motTests: [] });
    expect(tokenCalls).toBe(2);
    expect(apiCalls).toBe(2);
  });

  it('reports a rejected secret as an auth error', async () => {
    global.fetch = jest.fn(async () => jsonResponse(401, { error: 'invalid_client' })) as unknown as typeof fetch;
    const { fetchMotHistoryByReg } = await import('../dvsa-mot');
    await expect(fetchMotHistoryByReg('RX21ABC')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps a 404 to not_found', async () => {
    global.fetch = jest.fn(async (url: string | URL | Request) =>
      String(url).includes('login.example')
        ? jsonResponse(200, { access_token: 'tok', expires_in: 3600 })
        : jsonResponse(404, { errorCode: 'MOTH-NF-01' })) as unknown as typeof fetch;
    const { fetchMotHistoryByReg } = await import('../dvsa-mot');
    await expect(fetchMotHistoryByReg('ZZ99ZZZ')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('refuses to run without credentials', async () => {
    delete process.env.DVSA_API_KEY;
    const { fetchMotHistoryByReg } = await import('../dvsa-mot');
    await expect(fetchMotHistoryByReg('RX21ABC')).rejects.toMatchObject({ kind: 'not_configured' });
  });
});

describe('entraErrorDetail', () => {
  it('names an expired secret from the Entra error body', () => {
    const body = JSON.stringify({
      error: 'invalid_client',
      error_description: 'AADSTS7000222: The provided client secret keys for app are expired.',
    });
    expect(entraErrorDetail(body)).toBe('AADSTS7000222 — the client secret has expired');
  });

  it('tells a wrong scope apart from an expired secret', () => {
    expect(entraErrorDetail('{"error":"invalid_scope","error_description":"AADSTS70011: bad scope"}'))
      .toBe('AADSTS70011 — DVSA_SCOPE is not valid');
  });

  it('falls back to the raw code, then the OAuth error name', () => {
    expect(entraErrorDetail('AADSTS12345: something new')).toBe('AADSTS12345');
    expect(entraErrorDetail('{"error":"unauthorized_client"}')).toBe('unauthorized_client');
    expect(entraErrorDetail('<html>gateway</html>')).toBeNull();
  });
});

describe('fetchMotHistoryByReg — API key refused', () => {
  const ENV = { ...process.env };
  const realFetch = global.fetch;
  afterEach(() => { process.env = { ...ENV }; global.fetch = realFetch; });

  it("names DVSA's own reason and points at the API key, not the secret", async () => {
    jest.resetModules();
    Object.assign(process.env, {
      DVSA_CLIENT_ID: 'id', DVSA_CLIENT_SECRET: 'secret', DVSA_SCOPE: 'scope',
      DVSA_TOKEN_URL: 'https://login.example/token', DVSA_API_KEY: '  key-with-spaces \n',
    });
    const seenKeys: string[] = [];
    global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('login.example')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
      }
      seenKeys.push((init?.headers as Record<string, string>)['X-API-Key']);
      return new Response(JSON.stringify({ errorCode: 'MOTH-FB-03', errorMessage: 'Your API key is invalid' }), { status: 403 });
    }) as unknown as typeof fetch;
    const { fetchMotHistoryByReg, explainDvsaError } = await import('../dvsa-mot');
    const err = (await fetchMotHistoryByReg('RX21ABC').catch((e: unknown) => e)) as { kind: string };
    expect(seenKeys[0]).toBe('key-with-spaces');   // trimmed before sending
    expect(err.kind).toBe('auth');
    expect(explainDvsaError(err)).toContain('MOTH-FB-03: Your API key is invalid — the login worked, so check DVSA_API_KEY');
  });
});
