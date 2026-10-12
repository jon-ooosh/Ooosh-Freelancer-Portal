import { Request, Response, NextFunction } from 'express';
import { verifyFor } from '../services/tokens';

export interface AuthUser {
  id: string;
  email: string;
  role: 'admin' | 'manager' | 'staff' | 'general_assistant' | 'weekend_manager' | 'freelancer';
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

// Everyone on the team — used to gate routes the whole staff needs.
// Excludes 'freelancer', who authenticate via the portal route, not these.
export const STAFF_ROLES = [
  'admin',
  'manager',
  'staff',
  'general_assistant',
  'weekend_manager',
] as const satisfies readonly AuthUser['role'][];

// Manager tier — actions that move real money out the door (reimburse), waive
// requirements, or override hard gates. Includes weekend_manager so the
// weekend team isn't blocked from manager-level calls when admin/manager are
// off. 'admin' alone is reserved for absolute / irreversible decisions
// (e.g. waive an excess to £0).
export const MANAGER_ROLES = [
  'admin',
  'manager',
  'weekend_manager',
] as const satisfies readonly AuthUser['role'][];


/**
 * Is this a STAFF access token? THE one definition — `authenticate` below and
 * the Socket.io handshake in index.ts both use it, so they cannot drift.
 *
 * ONLY a staff access token is a login here: { id, email, role } and nothing
 * marking it as something else. JWT_SECRET also signs tokens handed to the
 * PUBLIC and to kiosks — the hire-form session ({ email, type }), the claim
 * form ({ typ }), the warehouse kiosk, freelancer book-out / prep ({ scope })
 * and the staff REFRESH token ({ id, type: 'refresh' }). Each of those has its
 * own middleware; none may pass here. Until Oct 2026 any of them did, and a
 * hire-form session read GET /api/drivers (proven on a test database).
 *
 * Since Oct 2026 the token's `aud` is checked first (services/tokens.ts): only a
 * token minted for the 'staff' audience gets as far as the shape check below.
 *
 * Returns null for a bad signature, an expired token, or any other token family.
 */
export function verifyStaffToken(token: string): AuthUser | null {
  const decoded = verifyFor<Record<string, unknown>>('staff', token);
  if (!decoded) return null;
  if (
    typeof decoded.id !== 'string' || typeof decoded.email !== 'string' || typeof decoded.role !== 'string'
    || decoded.scope !== undefined || decoded.type !== undefined || decoded.typ !== undefined
  ) {
    return null;
  }
  return decoded as unknown as AuthUser;
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = authHeader.split(' ')[1];
  const user = verifyStaffToken(token);
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  req.user = user;
  next();
}

export function authorize(...allowedRoles: AuthUser['role'][]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // weekend_manager has IDENTICAL privileges to manager (jon, Jun 2026 —
    // they're one privilege level in our eyes). Accept it ANYWHERE manager is
    // allowed, so callers never need to spell out weekend_manager alongside
    // manager. Purely additive — never removes access a route already granted.
    const allowed = allowedRoles.includes(req.user.role)
      || (req.user.role === 'weekend_manager' && allowedRoles.includes('manager'));
    if (!allowed) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
}
