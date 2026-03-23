/**
 * HireHop Contact Sync Service
 *
 * Reads contacts from HireHop and syncs them into the Ooosh data model:
 * - HireHop Company → Ooosh Organisation
 * - HireHop Person  → Ooosh Person
 * - HireHop Person.JOB + Company link → person_organisation_roles
 * - HireHop VENUE=1 → also creates a Venue record
 * - Xero ACC_IDS preserved in external_id_map
 *
 * Uses external_id_map to track which HireHop IDs map to which Ooosh UUIDs.
 */
import { query, getClient } from '../config/database';
import { hhBroker } from './hirehop-broker';

// ── HireHop response types ─────────────────────────────────────────────

interface HHContactRow {
  ID: number;        // Person ID
  cID: number;       // Company ID
  COMPANY: string;
  NAME: string;
  JOB: string;
  ADDRESS: string;
  TELEPHONE: string; // Company phone
  FAX: string;
  VAT_NUMBER: string;
  SOURCE: string;
  WEB: string;
  MEMO: string;      // Company memo
  CLIENT: number;    // 1 = client
  VENUE: number;     // 1 = delivery address
  SUBCONTRACTOR: number; // 1 = supplier
  DD: string;        // Person direct dial
  MOBILE: string;    // Person mobile
  EMAIL: string;     // Person email
  pMEMO: string;     // Person memo
  MAIL: number;
  STATUS: number;
  RATING: number;
  ACCOUNT_REFERENCE: string;
  names: Array<{ ID: number; NAME: string }>;
  ACC_IDS: Array<{ ID: number; ACC_ID: string; PACKAGE: string; ACC_ID_2: string }>;
}

interface HHListResponse {
  page: number;
  total: number;
  records: number;
  totalRecords?: number;
  data: HHContactRow[];
}

// ── Name splitting ──────────────────────────────────────────────────────

function splitName(fullName: string): { first_name: string; last_name: string } {
  const trimmed = fullName.trim();
  if (!trimmed) return { first_name: 'Unknown', last_name: '' };

  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };

  const first_name = parts[0];
  const last_name = parts.slice(1).join(' ');
  return { first_name, last_name };
}

// ── Organisation type from HH flags ─────────────────────────────────────

// Types that HireHop can assign — if the org already has a different type,
// it was manually classified in OP and should NOT be overwritten by sync.
const HH_DERIVED_ORG_TYPES = new Set(['client', 'venue', 'supplier', 'unknown']);

function getOrgType(contact: HHContactRow): string {
  const types: string[] = [];
  if (contact.CLIENT === 1) types.push('client');
  if (contact.VENUE === 1) types.push('venue');
  if (contact.SUBCONTRACTOR === 1) types.push('supplier');
  return types[0] || 'unknown';
}

function getOrgTags(contact: HHContactRow): string[] {
  const tags: string[] = [];
  if (contact.CLIENT === 1) tags.push('client');
  if (contact.VENUE === 1) tags.push('venue');
  if (contact.SUBCONTRACTOR === 1) tags.push('supplier');
  return tags;
}

// ── Fetch all contacts from HireHop (paginated) ────────────────────────

export async function fetchAllHireHopContacts(): Promise<HHContactRow[]> {
  const allContacts: HHContactRow[] = [];
  let page = 1;
  const rows = 200; // Max allowed

  while (true) {
    const result = await hhBroker.get<HHListResponse>('/modules/contacts/list.php', {
      page,
      rows,
    }, { priority: 'low', cacheTTL: 1800 });

    if (!result.success || !result.data) {
      throw new Error(`Failed to fetch HireHop contacts page ${page}: ${result.error}`);
    }

    const data = result.data;
    allContacts.push(...data.data);

    console.log(`[HH Sync] Fetched page ${page}/${data.total} (${data.data.length} contacts, ${allContacts.length} total)`);

    if (page >= data.total) break;
    page++;

    // Broker handles rate limiting, but keep a small delay for paging
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return allContacts;
}

// ── Sync contacts into Ooosh ────────────────────────────────────────────

export interface SyncResult {
  orgsCreated: number;
  orgsUpdated: number;
  peopleCreated: number;
  peopleUpdated: number;
  rolesCreated: number;
  venuesCreated: number;
  reviewsFlagged: number;
  errors: string[];
  total: number;
}

// Helper to flag an entity for manual review (dedupes by entity + review_type)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function flagForReview(
  dbClient: any,
  params: {
    entity_type: string;
    entity_id: string | null;
    external_id: string;
    review_type: string;
    summary: string;
    details?: Record<string, unknown>;
  }
): Promise<boolean> {
  // Don't create duplicate pending reviews for the same entity+type
  const existing = await dbClient.query(
    `SELECT id FROM sync_review_queue
     WHERE entity_type = $1 AND external_id = $2 AND review_type = $3 AND status = 'pending'`,
    [params.entity_type, params.external_id, params.review_type]
  );
  if (existing.rows.length > 0) return false;

  await dbClient.query(
    `INSERT INTO sync_review_queue (entity_type, entity_id, external_id, review_type, summary, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [params.entity_type, params.entity_id, params.external_id, params.review_type, params.summary, JSON.stringify(params.details || {})]
  );
  return true;
}

export async function syncContactsFromHireHop(userId: string): Promise<SyncResult> {
  const result: SyncResult = {
    orgsCreated: 0,
    orgsUpdated: 0,
    peopleCreated: 0,
    peopleUpdated: 0,
    rolesCreated: 0,
    venuesCreated: 0,
    reviewsFlagged: 0,
    errors: [],
    total: 0,
  };

  // Fetch all contacts
  const contacts = await fetchAllHireHopContacts();
  result.total = contacts.length;

  // Group by company ID to avoid duplicate org processing
  const companyMap = new Map<number, HHContactRow[]>();
  for (const c of contacts) {
    const existing = companyMap.get(c.cID) || [];
    existing.push(c);
    companyMap.set(c.cID, existing);
  }

  console.log(`[HH Sync] Processing ${contacts.length} contacts across ${companyMap.size} companies`);

  for (const [companyId, companyContacts] of companyMap) {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Use the first contact for company-level data
      const rep = companyContacts[0];

      // ── 1. Sync Organisation ──────────────────────────────────────────

      let orgId: string | null = null;

      if (rep.COMPANY && rep.COMPANY.trim()) {
        // Check if already mapped
        const existingMap = await client.query(
          `SELECT entity_id FROM external_id_map
           WHERE external_system = 'hirehop' AND entity_type = 'organisations'
           AND external_id = $1`,
          [String(companyId)]
        );

        if (existingMap.rows.length > 0) {
          orgId = existingMap.rows[0].entity_id;

          // Check current org type — only overwrite if it's a HH-derived type
          // (preserve manually-set types like 'band', 'management', 'label', etc.)
          const currentOrg = await client.query(
            `SELECT type, tags FROM organisations WHERE id = $1`,
            [orgId]
          );
          const currentType = currentOrg.rows[0]?.type || 'unknown';
          const hhType = getOrgType(rep);
          const shouldUpdateType = HH_DERIVED_ORG_TYPES.has(currentType);

          // Merge HH tags into existing tags (don't replace)
          const existingTags: string[] = currentOrg.rows[0]?.tags || [];
          const hhTags = getOrgTags(rep);
          const mergedTags = [...new Set([...existingTags, ...hhTags])];

          // Update existing org — conditionally update type
          await client.query(
            `UPDATE organisations SET
               name = $1, address = $2, phone = $3, website = $4,
               notes = $5,
               type = CASE WHEN $6 THEN $7 ELSE type END,
               tags = $8, updated_at = NOW()
             WHERE id = $9`,
            [
              rep.COMPANY.trim(),
              rep.ADDRESS || null,
              rep.TELEPHONE || null,
              rep.WEB || null,
              rep.MEMO || null,
              shouldUpdateType,
              hhType,
              mergedTags,
              orgId,
            ]
          );

          if (!shouldUpdateType && hhType !== currentType) {
            console.log(`[HH Sync] Preserved org type '${currentType}' for "${rep.COMPANY.trim()}" (HH says '${hhType}')`);
            // Flag for review if HH thinks it's a different type
            const flagged = await flagForReview(client, {
              entity_type: 'organisation',
              entity_id: orgId,
              external_id: String(companyId),
              review_type: 'type_mismatch',
              summary: `"${rep.COMPANY.trim()}" is '${currentType}' in OP but HireHop says '${hhType}'`,
              details: { op_type: currentType, hh_type: hhType, hh_flags: { client: rep.CLIENT, venue: rep.VENUE, subcontractor: rep.SUBCONTRACTOR } },
            });
            if (flagged) result.reviewsFlagged++;
          }

          result.orgsUpdated++;
        } else {
          // Create new org
          const orgResult = await client.query(
            `INSERT INTO organisations (name, type, address, phone, website, notes, tags, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [
              rep.COMPANY.trim(),
              getOrgType(rep),
              rep.ADDRESS || null,
              rep.TELEPHONE || null,
              rep.WEB || null,
              rep.MEMO || null,
              getOrgTags(rep),
              userId,
            ]
          );
          orgId = orgResult.rows[0].id;

          // Map HH company ID → Ooosh org ID
          await client.query(
            `INSERT INTO external_id_map (entity_type, entity_id, external_system, external_id)
             VALUES ('organisations', $1, 'hirehop', $2)
             ON CONFLICT (entity_type, entity_id, external_system) DO UPDATE SET
               external_id = $2, synced_at = NOW()`,
            [orgId, String(companyId)]
          );
          result.orgsCreated++;

          // Flag new org for review if it might be misclassified
          // (e.g., HH says 'client' but name doesn't look like a company)
          const orgName = rep.COMPANY.trim();
          const newOrgType = getOrgType(rep);
          const companyWords = /\b(ltd|limited|group|inc|llc|plc|services|productions|consulting|management|agency)\b/i;
          if (newOrgType === 'client' && !companyWords.test(orgName)) {
            const flagged = await flagForReview(client, {
              entity_type: 'organisation',
              entity_id: orgId,
              external_id: String(companyId),
              review_type: 'possible_band',
              summary: `New org "${orgName}" imported as '${newOrgType}' from HireHop — could this be a band/artist?`,
              details: { name: orgName, hh_type: newOrgType, hh_flags: { client: rep.CLIENT, venue: rep.VENUE, subcontractor: rep.SUBCONTRACTOR } },
            });
            if (flagged) result.reviewsFlagged++;
          }
        }

        // ── 1b. Create Venue if VENUE flag is set ───────────────────────

        if (rep.VENUE === 1 && orgId) {
          const existingVenueMap = await client.query(
            `SELECT entity_id FROM external_id_map
             WHERE external_system = 'hirehop_venue' AND entity_type = 'venues'
             AND external_id = $1`,
            [String(companyId)]
          );

          if (existingVenueMap.rows.length === 0) {
            const venueResult = await client.query(
              `INSERT INTO venues (name, organisation_id, address, created_by)
               VALUES ($1, $2, $3, $4)
               RETURNING id`,
              [rep.COMPANY.trim(), orgId, rep.ADDRESS || null, userId]
            );

            await client.query(
              `INSERT INTO external_id_map (entity_type, entity_id, external_system, external_id)
               VALUES ('venues', $1, 'hirehop_venue', $2)`,
              [venueResult.rows[0].id, String(companyId)]
            );
            result.venuesCreated++;
          }
        }

        // ── 1c. Store Xero ACC_IDS ──────────────────────────────────────

        if (rep.ACC_IDS && rep.ACC_IDS.length > 0 && orgId) {
          for (const acc of rep.ACC_IDS) {
            if (acc.ACC_ID) {
              await client.query(
                `INSERT INTO external_id_map (entity_type, entity_id, external_system, external_id)
                 VALUES ('organisations', $1, 'xero', $2)
                 ON CONFLICT (entity_type, entity_id, external_system) DO UPDATE SET
                   external_id = $2, synced_at = NOW()`,
                [orgId, acc.ACC_ID]
              );
            }
          }
        }
      }

      // ── 2. Sync People (all names at this company) ────────────────────

      for (const contact of companyContacts) {
        if (!contact.NAME || !contact.NAME.trim()) continue;

        const { first_name, last_name } = splitName(contact.NAME);

        // Check if person already mapped
        const existingPersonMap = await client.query(
          `SELECT entity_id FROM external_id_map
           WHERE external_system = 'hirehop' AND entity_type = 'people'
           AND external_id = $1`,
          [String(contact.ID)]
        );

        let personId: string;

        if (existingPersonMap.rows.length > 0) {
          personId = existingPersonMap.rows[0].entity_id;

          // Update existing person
          await client.query(
            `UPDATE people SET
               first_name = $1, last_name = $2,
               email = COALESCE(NULLIF($3, ''), email),
               mobile = COALESCE(NULLIF($4, ''), mobile),
               phone = COALESCE(NULLIF($5, ''), phone),
               notes = COALESCE(NULLIF($6, ''), notes),
               updated_at = NOW()
             WHERE id = $7`,
            [
              first_name,
              last_name,
              contact.EMAIL || null,
              contact.MOBILE || null,
              contact.DD || null,
              contact.pMEMO || null,
              personId,
            ]
          );
          result.peopleUpdated++;
        } else {
          // Create new person
          const personResult = await client.query(
            `INSERT INTO people (first_name, last_name, email, mobile, phone, notes, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id`,
            [
              first_name,
              last_name,
              contact.EMAIL || null,
              contact.MOBILE || null,
              contact.DD || null,
              contact.pMEMO || null,
              userId,
            ]
          );
          personId = personResult.rows[0].id;

          // Map HH person ID → Ooosh person ID
          await client.query(
            `INSERT INTO external_id_map (entity_type, entity_id, external_system, external_id)
             VALUES ('people', $1, 'hirehop', $2)
             ON CONFLICT (entity_type, entity_id, external_system) DO UPDATE SET
               external_id = $2, synced_at = NOW()`,
            [personId, String(contact.ID)]
          );
          result.peopleCreated++;

          // Check if this person's name matches an existing organisation
          // (suggests the HH contact might actually be a band/org, not a person)
          const fullName = `${first_name} ${last_name}`.trim();
          if (fullName.length > 2) {
            const nameMatchOrg = await client.query(
              `SELECT id, name, type FROM organisations
               WHERE lower(name) = lower($1) AND is_deleted = false
               LIMIT 1`,
              [fullName]
            );
            if (nameMatchOrg.rows.length > 0) {
              const matchedOrg = nameMatchOrg.rows[0];
              const flagged = await flagForReview(client, {
                entity_type: 'person',
                entity_id: personId,
                external_id: String(contact.ID),
                review_type: 'name_conflict',
                summary: `New person "${fullName}" has same name as org "${matchedOrg.name}" (${matchedOrg.type}). May be a duplicate or misclassified.`,
                details: { person_name: fullName, matching_org_id: matchedOrg.id, matching_org_name: matchedOrg.name, matching_org_type: matchedOrg.type },
              });
              if (flagged) result.reviewsFlagged++;
            }
          }
        }

        // ── 3. Link person to org ───────────────────────────────────────

        if (orgId) {
          const existingRole = await client.query(
            `SELECT id FROM person_organisation_roles
             WHERE person_id = $1 AND organisation_id = $2`,
            [personId, orgId]
          );

          if (existingRole.rows.length === 0) {
            await client.query(
              `INSERT INTO person_organisation_roles (person_id, organisation_id, role, status, is_primary)
               VALUES ($1, $2, $3, 'active', true)`,
              [personId, orgId, contact.JOB || 'Contact']
            );
            result.rolesCreated++;
          }
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      const errMsg = `Company ${companyId} (${companyContacts[0]?.COMPANY}): ${err}`;
      console.error(`[HH Sync] Error:`, errMsg);
      result.errors.push(errMsg);
    } finally {
      client.release();
    }
  }

  console.log(`[HH Sync] Complete:`, {
    orgsCreated: result.orgsCreated,
    orgsUpdated: result.orgsUpdated,
    peopleCreated: result.peopleCreated,
    peopleUpdated: result.peopleUpdated,
    rolesCreated: result.rolesCreated,
    venuesCreated: result.venuesCreated,
    reviewsFlagged: result.reviewsFlagged,
    errors: result.errors.length,
  });

  return result;
}

/**
 * Preview what would be synced (dry run) — fetches contacts without writing
 */
export async function previewHireHopSync(): Promise<{
  totalContacts: number;
  totalCompanies: number;
  alreadyMapped: { people: number; organisations: number };
  newPeople: number;
  newOrganisations: number;
  sample: Array<{ name: string; company: string; email: string }>;
}> {
  const contacts = await fetchAllHireHopContacts();

  // Count unique companies
  const companies = new Set(contacts.map(c => c.cID));

  // Check how many are already mapped
  const mappedPeople = await query(
    `SELECT COUNT(*) FROM external_id_map WHERE external_system = 'hirehop' AND entity_type = 'people'`
  );
  const mappedOrgs = await query(
    `SELECT COUNT(*) FROM external_id_map WHERE external_system = 'hirehop' AND entity_type = 'organisations'`
  );

  const mappedPersonIds = new Set<string>();
  const mappedRes = await query(
    `SELECT external_id FROM external_id_map WHERE external_system = 'hirehop' AND entity_type = 'people'`
  );
  for (const row of mappedRes.rows) {
    mappedPersonIds.add(row.external_id);
  }

  const mappedOrgIds = new Set<string>();
  const mappedOrgRes = await query(
    `SELECT external_id FROM external_id_map WHERE external_system = 'hirehop' AND entity_type = 'organisations'`
  );
  for (const row of mappedOrgRes.rows) {
    mappedOrgIds.add(row.external_id);
  }

  const newPeople = contacts.filter(c => !mappedPersonIds.has(String(c.ID))).length;
  const newOrgs = [...companies].filter(cId => !mappedOrgIds.has(String(cId))).length;

  return {
    totalContacts: contacts.length,
    totalCompanies: companies.size,
    alreadyMapped: {
      people: parseInt(mappedPeople.rows[0].count),
      organisations: parseInt(mappedOrgs.rows[0].count),
    },
    newPeople,
    newOrganisations: newOrgs,
    sample: contacts.slice(0, 10).map(c => ({
      name: c.NAME,
      company: c.COMPANY,
      email: c.EMAIL,
    })),
  };
}
