/**
 * Portal API Routes — Freelancer Portal Backend
 *
 * These endpoints serve the freelancer-facing Next.js portal app,
 * replacing Monday.com as the data source. The portal authenticates
 * via its own JWT session cookie (not the OP staff JWT).
 *
 * Auth: Portal session JWT (HS256, signed with PORTAL_SESSION_SECRET)
 * Access: Freelancers see only jobs assigned to them via quote_assignments.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { query } from '../config/database';
import { hhBroker } from '../services/hirehop-broker';

const router = Router();

// ── Portal auth middleware (separate from OP staff auth) ──────────────

interface PortalUser {
  id: string;       // person_id from people table
  email: string;
  name: string;
}

interface PortalRequest extends Request {
  portalUser?: PortalUser;
}

const PORTAL_SECRET = process.env.PORTAL_SESSION_SECRET || process.env.SESSION_SECRET || process.env.JWT_SECRET!;

function portalAuth(req: PortalRequest, res: Response, next: NextFunction) {
  try {
    // Check session cookie first, then Authorization header
    const token = req.cookies?.session ||
      req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const decoded = jwt.verify(token, PORTAL_SECRET) as PortalUser & { iat: number; exp: number };
    req.portalUser = {
      id: decoded.id,
      email: decoded.email,
      name: decoded.name,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// ── POST /api/portal/auth/login — freelancer login ───────────────────

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const { email, password } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();

    // Find freelancer in people table
    const result = await query(
      `SELECT p.id, p.first_name, p.last_name, p.email, p.portal_password_hash,
              p.is_freelancer, p.is_approved, p.portal_email_verified
       FROM people p
       WHERE LOWER(p.email) = $1 AND p.is_freelancer = true`,
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const freelancer = result.rows[0];

    // Check if they have a portal password set
    if (!freelancer.portal_password_hash) {
      // Fallback: check if they have a user account in the OP
      const userResult = await query(
        `SELECT u.password_hash FROM users u
         JOIN people p ON p.id = u.person_id
         WHERE LOWER(u.email) = $1 AND u.is_active = true`,
        [normalizedEmail]
      );

      if (userResult.rows.length > 0) {
        const valid = await bcrypt.compare(password, userResult.rows[0].password_hash);
        if (!valid) {
          res.status(401).json({ error: 'Invalid email or password' });
          return;
        }
      } else {
        res.status(401).json({ error: 'Account not set up. Please register first.' });
        return;
      }
    } else {
      const valid = await bcrypt.compare(password, freelancer.portal_password_hash);
      if (!valid) {
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }
    }

    const name = `${freelancer.first_name} ${freelancer.last_name}`.trim();

    // Create session token (compatible with portal's jose-based verification)
    const sessionToken = jwt.sign(
      { id: freelancer.id, email: freelancer.email || normalizedEmail, name },
      PORTAL_SECRET,
      { expiresIn: '30d', algorithm: 'HS256' }
    );

    // Set as cookie (matching portal's existing cookie format)
    res.cookie('session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      path: '/',
    });

    // Update last login timestamp (fire and forget)
    query(
      'UPDATE people SET portal_last_login = NOW() WHERE id = $1',
      [freelancer.id]
    ).catch(err => console.error('Failed to update portal_last_login:', err));

    res.json({
      success: true,
      user: {
        id: freelancer.id,
        name,
        email: freelancer.email || normalizedEmail,
      },
    });
  } catch (error) {
    console.error('Portal login error:', error);
    res.status(500).json({ error: 'An error occurred during login' });
  }
});

// ── POST /api/portal/auth/logout ─────────────────────────────────────

router.post('/auth/logout', (_req: Request, res: Response) => {
  res.clearCookie('session', { path: '/' });
  res.json({ success: true });
});

// ── All remaining routes require portal auth ─────────────────────────

router.use(portalAuth);

// ── GET /api/portal/me — current user info ───────────────────────────

router.get('/me', async (req: PortalRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT p.id, p.first_name, p.last_name, p.email, p.mobile,
              p.is_freelancer, p.is_approved
       FROM people p WHERE p.id = $1`,
      [req.portalUser!.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const p = result.rows[0];
    res.json({
      success: true,
      user: {
        id: p.id,
        name: `${p.first_name} ${p.last_name}`.trim(),
        email: p.email,
        phone: p.mobile,
        emailVerified: true, // if they can log in, they're verified
      },
    });
  } catch (error) {
    console.error('Portal me error:', error);
    res.status(500).json({ error: 'Failed to load user' });
  }
});

// ── GET /api/portal/jobs — freelancer's job list ─────────────────────

router.get('/jobs', async (req: PortalRequest, res: Response) => {
  try {
    const email = req.portalUser!.email.toLowerCase();
    const personId = req.portalUser!.id;

    // Get all quotes where this freelancer is assigned (by person_id or by email)
    const result = await query(
      `SELECT
        q.id, q.job_id, q.job_type, q.calculation_mode,
        q.venue_name, q.venue_id, q.distance_miles, q.drive_time_mins,
        q.arrival_time, q.job_date, q.job_finish_date, q.is_multi_day,
        q.work_duration_hrs, q.num_days,
        q.what_is_it, q.status, q.ops_status,
        q.key_points, q.client_introduction,
        q.work_type, q.work_type_other, q.work_description,
        q.freelancer_notes, q.freelancer_fee, q.freelancer_fee_rounded,
        q.run_group, q.run_order, q.run_group_fee,
        q.is_local, q.completed_at, q.completion_notes,
        q.client_name, q.client_email,
        q.tolls_status, q.accommodation_status, q.flight_status,
        q.expenses,
        qa.id as assignment_id, qa.role as assignment_role,
        qa.agreed_rate, qa.rate_type,
        qa.expected_expenses as assignment_expected_expenses,
        j.job_name, j.hirehop_id, j.client_name as job_client_name,
        j.out_date, j.return_date, j.files as job_files,
        v.name as linked_venue_name, v.address as venue_address, v.city as venue_city
       FROM quote_assignments qa
       JOIN quotes q ON q.id = qa.quote_id
       LEFT JOIN jobs j ON j.id = q.job_id
       LEFT JOIN venues v ON v.id = q.venue_id
       WHERE qa.person_id = $1
         AND q.is_deleted = false
         AND q.status IN ('confirmed', 'completed')
       ORDER BY q.job_date ASC NULLS LAST, q.arrival_time ASC NULLS LAST`,
      [personId]
    );

    // Categorise into today/upcoming/completed/cancelled
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const today: unknown[] = [];
    const upcoming: unknown[] = [];
    const completed: unknown[] = [];
    const cancelled: unknown[] = [];

    for (const row of result.rows) {
      const item = formatJobForPortal(row);

      if (row.ops_status === 'completed' || row.status === 'completed') {
        if (row.job_date >= thirtyDaysAgo) {
          completed.push(item);
        }
      } else if (row.ops_status === 'cancelled' || row.status === 'cancelled') {
        if (row.job_date >= thirtyDaysAgo) {
          cancelled.push(item);
        }
      } else if (row.job_date === todayStr) {
        today.push(item);
      } else if (row.job_date > todayStr) {
        upcoming.push(item);
      } else if (row.job_date && row.job_date < todayStr) {
        // Past job that hasn't been completed — show in today for action
        today.push(item);
      }
    }

    res.json({
      success: true,
      user: {
        id: req.portalUser!.id,
        name: req.portalUser!.name,
        email: req.portalUser!.email,
      },
      today,
      upcoming,
      completed,
      cancelled,
    });
  } catch (error) {
    console.error('Portal jobs error:', error);
    res.status(500).json({ error: 'Failed to load jobs' });
  }
});

// ── GET /api/portal/jobs/:quoteId — single job detail ────────────────

router.get('/jobs/:quoteId', async (req: PortalRequest, res: Response) => {
  try {
    const personId = req.portalUser!.id;
    const quoteId = req.params.quoteId;

    // Verify this freelancer is assigned to this quote
    const result = await query(
      `SELECT
        q.*,
        qa.id as assignment_id, qa.role as assignment_role,
        qa.agreed_rate, qa.rate_type,
        qa.expected_expenses as assignment_expected_expenses,
        j.job_name, j.hirehop_id, j.client_name as job_client_name,
        j.out_date, j.return_date, j.files as job_files,
        v.name as linked_venue_name, v.address as venue_address,
        v.city as venue_city, v.what_three_words as venue_w3w,
        v.contact_name as venue_contact1, v.contact_phone as venue_phone,
        v.contact_email as venue_email, v.notes as venue_access_notes
       FROM quote_assignments qa
       JOIN quotes q ON q.id = qa.quote_id
       LEFT JOIN jobs j ON j.id = q.job_id
       LEFT JOIN venues v ON v.id = q.venue_id
       WHERE qa.quote_id = $1 AND qa.person_id = $2
         AND q.is_deleted = false`,
      [quoteId, personId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Job not found or not assigned to you' });
      return;
    }

    const row = result.rows[0];
    const job = formatJobForPortal(row);

    // Build venue info
    let venue = null;
    if (row.venue_id) {
      // Check 48-hour privacy rule for phone numbers
      const jobDate = row.job_date ? new Date(row.job_date) : null;
      const hoursUntilJob = jobDate ? (jobDate.getTime() - Date.now()) / (1000 * 60 * 60) : 999;
      const contactsVisible = hoursUntilJob <= 48;

      venue = {
        id: row.venue_id,
        name: row.linked_venue_name || row.venue_name,
        address: row.venue_address,
        whatThreeWords: row.venue_w3w,
        contact1: row.venue_contact1,
        phone: contactsVisible ? row.venue_phone : null,
        email: row.venue_email,
        accessNotes: row.venue_access_notes,
        phoneHidden: !contactsVisible,
        phoneVisibleFrom: !contactsVisible && jobDate
          ? new Date(jobDate.getTime() - 48 * 60 * 60 * 1000).toLocaleDateString('en-GB', {
              weekday: 'short', day: 'numeric', month: 'short',
            })
          : null,
      };
    }

    res.json({
      success: true,
      job,
      venue,
      contactsVisible: venue ? !venue.phoneHidden : true,
      boardType: row.job_type === 'crewed' ? 'crew' : 'dc',
    });
  } catch (error) {
    console.error('Portal job detail error:', error);
    res.status(500).json({ error: 'Failed to load job' });
  }
});

// ── GET /api/portal/jobs/:quoteId/equipment — HireHop equipment list ─

router.get('/jobs/:quoteId/equipment', async (req: PortalRequest, res: Response) => {
  try {
    const personId = req.portalUser!.id;
    const quoteId = req.params.quoteId;

    // Verify access and get HireHop job ID
    const result = await query(
      `SELECT q.what_is_it, j.hirehop_id
       FROM quote_assignments qa
       JOIN quotes q ON q.id = qa.quote_id
       LEFT JOIN jobs j ON j.id = q.job_id
       WHERE qa.quote_id = $1 AND qa.person_id = $2
         AND q.is_deleted = false`,
      [quoteId, personId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const { hirehop_id, what_is_it } = result.rows[0];

    if (!hirehop_id) {
      res.json({ success: true, items: [], message: 'No HireHop job linked' });
      return;
    }

    // Fetch equipment from HireHop via broker
    try {
      const hhResponse = await hhBroker.get('/api/job_data.php', {
        job: hirehop_id,
      }, { priority: 'high', cacheTTL: 300 });

      const hhData = hhResponse as unknown as Record<string, unknown>;
      const items = Array.isArray(hhData.items) ? hhData.items : [];

      // Filter based on what_is_it
      const filteredItems = items
        .filter((item: Record<string, unknown>) => !item.VIRTUAL)
        .map((item: Record<string, unknown>) => ({
          id: item.ID || item.id,
          name: item.DESCRIPTION || item.name || '',
          quantity: item.QUANTITY || item.qty || 1,
          category: item.ACC_CATEGORY_NAME || item.category || '',
          categoryId: item.ACC_CATEGORY || null,
        }));

      res.json({ success: true, items: filteredItems, whatIsIt: what_is_it });
    } catch (hhError) {
      console.error('HireHop equipment fetch error:', hhError);
      res.json({ success: true, items: [], message: 'Could not fetch equipment list' });
    }
  } catch (error) {
    console.error('Portal equipment error:', error);
    res.status(500).json({ error: 'Failed to load equipment' });
  }
});

// ── POST /api/portal/jobs/:quoteId/complete — completion submission ──

const completionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per file
}).fields([
  { name: 'photos', maxCount: 5 },
  { name: 'signature', maxCount: 1 },
]);

const completionSchema = z.object({
  notes: z.string().optional().default(''),
  customerPresent: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(true),
  equipmentChecklist: z.string().optional(), // JSON string of {itemId: boolean}
  clientEmails: z.string().optional(), // comma-separated
  staffName: z.string().optional(), // For Ooosh staff completing on behalf of system account
});

router.post('/jobs/:quoteId/complete', (req: PortalRequest, res: Response, next: NextFunction) => {
  completionUpload(req, res, (err) => {
    if (err) {
      res.status(400).json({ error: err instanceof multer.MulterError ? err.message : 'Upload failed' });
      return;
    }
    next();
  });
}, async (req: PortalRequest, res: Response) => {
  try {
    const personId = req.portalUser!.id;
    const quoteId = req.params.quoteId;

    // Verify access
    const accessCheck = await query(
      `SELECT qa.id, q.id as quote_id, q.ops_status
       FROM quote_assignments qa
       JOIN quotes q ON q.id = qa.quote_id
       WHERE qa.quote_id = $1 AND qa.person_id = $2
         AND q.is_deleted = false`,
      [quoteId, personId]
    );

    if (accessCheck.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const parsed = completionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid completion data', details: parsed.error.issues });
      return;
    }

    const { notes, customerPresent, equipmentChecklist, staffName } = parsed.data;
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

    // Build completion data
    const completionPhotos: string[] = [];
    // Store photos as base64 in JSONB for now (R2 upload can be added later)
    if (files?.photos) {
      for (const photo of files.photos) {
        const base64 = `data:${photo.mimetype};base64,${photo.buffer.toString('base64')}`;
        completionPhotos.push(base64);
      }
    }

    let signatureValue: string | null = null;
    if (files?.signature?.[0]) {
      const sig = files.signature[0];
      signatureValue = `data:${sig.mimetype};base64,${sig.buffer.toString('base64')}`;
    }

    // Build completion notes
    let fullNotes = notes || '';
    if (!customerPresent) {
      fullNotes = `[Customer not present] ${fullNotes}`;
    }

    // Parse equipment checklist
    let checklistData = null;
    if (equipmentChecklist) {
      try {
        checklistData = JSON.parse(equipmentChecklist);
      } catch {
        // Ignore parse errors
      }
    }

    // Build completed_by: use staffName if provided (Ooosh staff completing via system account)
    const completedBy = staffName
      ? `${staffName} (${req.portalUser!.email})`
      : req.portalUser!.email;

    // Update the quote
    await query(
      `UPDATE quotes SET
        ops_status = 'completed',
        completed_at = NOW(),
        completed_by = $1,
        completion_notes = $2,
        completion_signature = $3,
        completion_photos = $4::jsonb,
        customer_present = $5,
        updated_at = NOW()
       WHERE id = $6`,
      [
        completedBy,
        fullNotes,
        signatureValue,
        JSON.stringify(completionPhotos),
        customerPresent,
        quoteId,
      ]
    );

    // Update the assignment status
    await query(
      `UPDATE quote_assignments SET status = 'completed', updated_at = NOW()
       WHERE quote_id = $1 AND person_id = $2`,
      [quoteId, personId]
    );

    // Store checklist in an interaction if provided
    const completionName = staffName || req.portalUser!.name;
    if (checklistData) {
      await query(
        `INSERT INTO interactions (type, notes, related_type, related_id, created_by, metadata)
         VALUES ('completion', $1, 'quote', $2, $3, $4)`,
        [
          `Job completed by ${completionName}`,
          quoteId,
          personId,
          JSON.stringify({ equipmentChecklist: checklistData }),
        ]
      );
    }

    res.json({ success: true, message: 'Job completed successfully' });
  } catch (error) {
    console.error('Portal completion error:', error);
    res.status(500).json({ error: 'Failed to submit completion' });
  }
});

// ── GET /api/portal/venues/:id — venue detail for portal ─────────────

router.get('/venues/:id', async (req: PortalRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT v.id, v.name, v.address, v.city, v.postcode,
              v.what_three_words, v.contact_name, v.contact_phone,
              v.contact_email, v.notes, v.files
       FROM venues v WHERE v.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Venue not found' });
      return;
    }

    const v = result.rows[0];
    res.json({
      success: true,
      venue: {
        id: v.id,
        name: v.name,
        address: v.address,
        city: v.city,
        postcode: v.postcode,
        whatThreeWords: v.what_three_words,
        contact1: v.contact_name,
        phone: v.contact_phone,
        email: v.contact_email,
        accessNotes: v.notes,
        files: v.files || [],
      },
    });
  } catch (error) {
    console.error('Portal venue error:', error);
    res.status(500).json({ error: 'Failed to load venue' });
  }
});

// ── Helper: format a quote row into portal-friendly shape ────────────

function formatJobForPortal(row: Record<string, unknown>) {
  const jobType = row.job_type as string;
  const isCrew = jobType === 'crewed';

  // Map ops_status to portal-visible status
  const opsStatus = (row.ops_status as string) || 'todo';
  let portalStatus: string;
  switch (opsStatus) {
    case 'todo': portalStatus = 'TO DO!'; break;
    case 'arranging': portalStatus = 'Arranging'; break;
    case 'arranged': portalStatus = 'All arranged & email driver'; break;
    case 'dispatched': portalStatus = 'Dispatched'; break;
    case 'arrived': portalStatus = 'Arrived'; break;
    case 'completed': portalStatus = 'All done!'; break;
    case 'cancelled': portalStatus = 'Not needed'; break;
    default: portalStatus = opsStatus; break;
  }

  // Base fields common to D&C and crew
  const base = {
    id: row.id as string,
    name: row.job_name
      ? `${jobType === 'delivery' ? 'DEL' : jobType === 'collection' ? 'COL' : 'CREW'}: ${(row.linked_venue_name || row.venue_name || row.job_name)}`
      : `${jobType === 'delivery' ? 'Delivery' : jobType === 'collection' ? 'Collection' : 'Crewed Job'}`,
    board: isCrew ? 'crew' as const : 'dc' as const,
    type: jobType as string,
    date: row.job_date as string | null,
    time: row.arrival_time as string | null,
    venueName: (row.linked_venue_name || row.venue_name) as string | null,
    venueId: row.venue_id as string | null,
    hhRef: row.hirehop_id ? String(row.hirehop_id) : null,
    status: portalStatus,
    opsStatus,
    keyNotes: row.key_points as string | null,
    completedAtDate: row.completed_at ? new Date(row.completed_at as string).toISOString().split('T')[0] : null,
    completionNotes: row.completion_notes as string | null,
    isLocal: row.is_local as boolean,
    // Run grouping (D&C only)
    runGroup: row.run_group as string | null,
    runOrder: row.run_order as number | null,
    runGroupFee: row.run_group_fee as number | null,
    // Fee info
    driverPay: Number(row.agreed_rate || row.freelancer_fee_rounded || row.freelancer_fee || 0),
    // Freelancer notes
    freelancerNotes: row.freelancer_notes as string | null,
    // Arrangement details (so freelancer knows what's booked for them)
    tollsStatus: row.tolls_status as string | null,
    accommodationStatus: row.accommodation_status as string | null,
    flightStatus: row.flight_status as string | null,
    clientIntroduction: row.client_introduction as string | null,
    // Shared files from the job (filtered: only share_with_freelancer = true)
    sharedFiles: (() => {
      try {
        const files = row.job_files as unknown[];
        if (!Array.isArray(files)) return [];
        return files.filter((f: any) => f?.share_with_freelancer === true).map((f: any) => ({
          name: f.name || f.original_name || 'File',
          url: f.url,
          type: f.type || f.content_type || '',
          label: f.label || '',
        }));
      } catch { return []; }
    })(),
    // Expense clarity
    expensesIncluded: (() => {
      try {
        const expenses = row.expenses as unknown[];
        if (!Array.isArray(expenses)) return 0;
        return expenses.filter((e: any) => e?.includedInCharge === true && e?.type !== 'fuel')
          .reduce((sum: number, e: any) => sum + (Number(e.amount) || 0), 0);
      } catch { return 0; }
    })(),
    expensesNotIncluded: (() => {
      try {
        const expenses = row.expenses as unknown[];
        if (!Array.isArray(expenses)) return 0;
        return expenses.filter((e: any) => e?.includedInCharge === false && e?.type !== 'fuel')
          .reduce((sum: number, e: any) => sum + (Number(e.amount) || 0), 0);
      } catch { return 0; }
    })(),
  };

  if (isCrew) {
    return {
      ...base,
      isGrouped: false,
      jobType: row.work_type ? 'Transport + Crew' : 'Crew Only',
      workType: row.work_type as string | null,
      workTypeOther: row.work_type_other as string | null,
      workDurationHours: row.work_duration_hrs as number | null,
      workDescription: row.work_description as string | null,
      numberOfDays: row.num_days as number | null,
      finishDate: row.job_finish_date as string | null,
      freelancerFee: Number(row.agreed_rate || row.freelancer_fee_rounded || row.freelancer_fee || 0),
      distanceMiles: row.distance_miles as number | null,
      driveTimeMinutes: row.drive_time_mins as number | null,
      expenses: row.expenses || [],
      assignmentExpectedExpenses: row.assignment_expected_expenses as number | null,
    };
  }

  return {
    ...base,
    isGrouped: false,
    whatIsIt: row.what_is_it === 'vehicle' ? 'A vehicle' : 'Equipment',
    clientEmail: row.client_email as string | null,
  };
}

export default router;
