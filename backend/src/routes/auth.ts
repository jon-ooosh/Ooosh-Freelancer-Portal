import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query } from '../config/database';
import { validate } from '../middleware/validate';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

// Rate limiting: 10 login attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts — try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting: 20 token refresh attempts per 15 minutes per IP
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many refresh attempts — try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

if (!process.env.JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is required');
}
const JWT_SECRET: string = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '15m';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  role: z.enum(['admin', 'manager', 'staff', 'general_assistant', 'weekend_manager']).default('staff'),
});

function generateTokens(user: { id: string; email: string; role: string }) {
  const accessToken = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions
  );

  const refreshToken = jwt.sign(
    { id: user.id, type: 'refresh' },
    JWT_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRES_IN } as jwt.SignOptions
  );

  return { accessToken, refreshToken };
}

// POST /api/auth/login
router.post('/login', loginLimiter, validate(loginSchema), async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    const result = await query(
      'SELECT u.*, p.first_name, p.last_name FROM users u JOIN people p ON u.person_id = p.id WHERE u.email = $1 AND u.is_active = true',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const tokens = generateTokens(user);

    // Store refresh token
    await query(
      'UPDATE users SET refresh_token = $1, last_login = NOW() WHERE id = $2',
      [tokens.refreshToken, user.id]
    );

    res.json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        first_name: user.first_name,
        last_name: user.last_name,
      },
      ...tokens,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/register (admin only in production)
router.post('/register', validate(registerSchema), async (req: Request, res: Response) => {
  try {
    const { email, password, first_name, last_name, role } = req.body;

    // Check if email already exists
    const existing = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Create person record first
    const personResult = await query(
      'INSERT INTO people (first_name, last_name, email, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [first_name, last_name, email.toLowerCase(), 'system']
    );

    // Create user account linked to person
    const userResult = await query(
      'INSERT INTO users (email, password_hash, role, person_id) VALUES ($1, $2, $3, $4) RETURNING id, email, role',
      [email.toLowerCase(), passwordHash, role, personResult.rows[0].id]
    );

    const user = userResult.rows[0];
    const tokens = generateTokens(user);

    await query('UPDATE users SET refresh_token = $1 WHERE id = $2', [tokens.refreshToken, user.id]);

    res.status(201).json({
      user: { id: user.id, email: user.email, role: user.role, first_name, last_name },
      ...tokens,
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', refreshLimiter, async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      res.status(400).json({ error: 'Refresh token required' });
      return;
    }

    const decoded = jwt.verify(refreshToken, JWT_SECRET) as { id: string; type: string };

    if (decoded.type !== 'refresh') {
      res.status(401).json({ error: 'Invalid token type' });
      return;
    }

    const result = await query(
      'SELECT u.*, p.first_name, p.last_name FROM users u JOIN people p ON u.person_id = p.id WHERE u.id = $1 AND u.refresh_token = $2 AND u.is_active = true',
      [decoded.id, refreshToken]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid refresh token' });
      return;
    }

    const user = result.rows[0];
    const tokens = generateTokens(user);

    await query('UPDATE users SET refresh_token = $1 WHERE id = $2', [tokens.refreshToken, user.id]);

    res.json(tokens);
  } catch {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

// POST /api/auth/logout
router.post('/logout', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await query('UPDATE users SET refresh_token = NULL WHERE id = $1', [req.user!.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      'SELECT u.id, u.email, u.role, p.first_name, p.last_name FROM users u JOIN people p ON u.person_id = p.id WHERE u.id = $1',
      [req.user!.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
