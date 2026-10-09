import { Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest } from './auth';

/**
 * Logs an audit trail entry. Called from services after mutations.
 * Immutable — audit entries cannot be edited or deleted.
 */
export async function logAudit(
  userId: string,
  entityType: string,
  entityId: string,
  // A HINT, not the whole set. `audit_log.action` is unconstrained VARCHAR(50)
  // — migration 032 deliberately dropped the original create/update/delete
  // CHECK because the platform needs 'resolve_referral', 'merge',
  // 'mark_washed', 'override_document_gate' and more, and several call sites
  // INSERT into audit_log directly rather than coming through here.
  //
  // => NEVER "restore" a CHECK constraint on this column. Migration 232 tried
  //    and was refused by existing rows; see docs/STAFF-RECORDS-SPEC.md §13.6.
  //
  // 'read' is for DELIBERATE reveals of sensitive data — a staff NI number
  // behind an admin gate — never for ordinary page views, which would drown
  // the table.
  action: 'create' | 'update' | 'delete' | 'read' | (string & {}),
  previousValues: Record<string, unknown> | null,
  newValues: Record<string, unknown> | null
): Promise<void> {
  await query(
    `INSERT INTO audit_log (user_id, entity_type, entity_id, action, previous_values, new_values)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, entityType, entityId, action, JSON.stringify(previousValues), JSON.stringify(newValues)]
  );
}

/**
 * Middleware that attaches the audit helper to the request for easy use in controllers.
 */
export function attachAuditLogger(req: AuthRequest, _res: Response, next: NextFunction): void {
  (req as AuthRequest & { audit: typeof logAudit }).audit = logAudit;
  next();
}
