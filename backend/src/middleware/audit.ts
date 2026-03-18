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
  action: 'create' | 'update' | 'delete',
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
