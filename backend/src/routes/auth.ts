import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { query } from '../config/database';
import { validate } from '../middleware/validate';
import { authenticate, AuthRequest } from '../middleware/auth';
import { uploadToR2, deleteFromR2, getFromR2, isR2Configured } from '../config/r2';

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
  role: z.enum(['admin', 'manager', 'staff', 'general_assistant', 'weekend_manager', 'freelancer']).default('staff'),
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8),
});

const updateProfileSchema = z.object({
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
});

// Avatar upload config — images only, 5MB limit
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not allowed. Use JPG, PNG, GIF, or WebP.`));
    }
  },
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
      `SELECT u.*, p.first_name, p.last_name
       FROM users u JOIN people p ON u.person_id = p.id
       WHERE u.email = $1 AND u.is_active = true`,
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
        avatar_url: user.avatar_url || null,
        force_password_change: user.force_password_change || false,
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
      `SELECT u.*, p.first_name, p.last_name
       FROM users u JOIN people p ON u.person_id = p.id
       WHERE u.id = $1 AND u.refresh_token = $2 AND u.is_active = true`,
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
      `SELECT u.id, u.email, u.role, u.avatar_url, u.force_password_change,
              p.first_name, p.last_name
       FROM users u JOIN people p ON u.person_id = p.id
       WHERE u.id = $1`,
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

// PUT /api/auth/profile — update own profile (name only, not email/role)
router.put('/profile', authenticate, validate(updateProfileSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { first_name, last_name } = req.body;
    const userId = req.user!.id;

    const updates: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (first_name) {
      updates.push(`first_name = $${idx}`);
      params.push(first_name);
      idx++;
    }
    if (last_name) {
      updates.push(`last_name = $${idx}`);
      params.push(last_name);
      idx++;
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    params.push(userId);
    await query(
      `UPDATE people SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = (SELECT person_id FROM users WHERE id = $${idx})`,
      params
    );

    // Return updated user
    const result = await query(
      `SELECT u.id, u.email, u.role, u.avatar_url, u.force_password_change,
              p.first_name, p.last_name
       FROM users u JOIN people p ON u.person_id = p.id
       WHERE u.id = $1`,
      [userId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/change-password — change own password
router.post('/change-password', authenticate, validate(changePasswordSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { current_password, new_password } = req.body;
    const userId = req.user!.id;

    // Verify current password
    const result = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const valid = await bcrypt.compare(current_password, result.rows[0].password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }

    const newHash = await bcrypt.hash(new_password, 12);
    await query(
      'UPDATE users SET password_hash = $1, force_password_change = false, password_changed_at = NOW() WHERE id = $2',
      [newHash, userId]
    );

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/avatar — upload profile photo
router.post('/avatar', authenticate, avatarUpload.single('avatar'), async (req: AuthRequest, res: Response) => {
  try {
    if (!isR2Configured()) {
      res.status(503).json({ error: 'File storage not configured' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: 'No image provided' });
      return;
    }

    const userId = req.user!.id;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const key = `avatars/${userId}/${uuid()}${ext}`;

    // Delete old avatar if exists
    const existing = await query('SELECT avatar_url FROM users WHERE id = $1', [userId]);
    if (existing.rows[0]?.avatar_url) {
      try {
        await deleteFromR2(existing.rows[0].avatar_url);
      } catch {
        // Old avatar may already be deleted, continue
      }
    }

    await uploadToR2(key, req.file.buffer, req.file.mimetype);
    await query('UPDATE users SET avatar_url = $1 WHERE id = $2', [key, userId]);

    res.json({ avatar_url: key });
  } catch (error) {
    console.error('Avatar upload error:', error);
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'Image too large (max 5MB)' });
      return;
    }
    const message = error instanceof Error ? error.message : 'Upload failed';
    res.status(500).json({ error: message });
  }
});

// DELETE /api/auth/avatar — remove profile photo
router.delete('/avatar', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const existing = await query('SELECT avatar_url FROM users WHERE id = $1', [userId]);

    if (existing.rows[0]?.avatar_url) {
      try {
        await deleteFromR2(existing.rows[0].avatar_url);
      } catch {
        // Continue even if R2 delete fails
      }
    }

    await query('UPDATE users SET avatar_url = NULL WHERE id = $1', [userId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Avatar delete error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/avatar/:filename — public avatar endpoint (no auth required)
// Looks up which user owns this avatar file and streams it from R2
router.get('/avatar/:filename', async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    // Validate filename to prevent path traversal
    if (!filename || filename.includes('/') || filename.includes('..')) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    if (!isR2Configured()) {
      console.error('[Avatar GET] R2 not configured');
      res.status(503).json({ error: 'File storage not configured' });
      return;
    }

    // Find user with this avatar filename
    const result = await query(
      "SELECT avatar_url FROM users WHERE avatar_url LIKE $1 LIMIT 1",
      [`%/${filename}`]
    );

    if (!result.rows[0]?.avatar_url) {
      console.error(`[Avatar GET] No DB row found for filename: ${filename}`);
      res.status(404).json({ error: 'Avatar not found' });
      return;
    }

    const key = result.rows[0].avatar_url;
    console.log(`[Avatar GET] Found key in DB: ${key}, fetching from R2...`);
    const object = await getFromR2(key);

    if (!object.Body) {
      console.error(`[Avatar GET] R2 returned no Body for key: ${key}`);
      res.status(404).json({ error: 'Avatar not found in storage' });
      return;
    }

    console.log(`[Avatar GET] Streaming avatar, ContentType=${object.ContentType}, ContentLength=${object.ContentLength}`);
    // Cache for 1 hour (avatars don't change often)
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (object.ContentType) {
      res.setHeader('Content-Type', object.ContentType);
    }
    if (object.ContentLength) {
      res.setHeader('Content-Length', object.ContentLength.toString());
    }

    const stream = object.Body as NodeJS.ReadableStream;
    stream.pipe(res);
  } catch (error) {
    console.error('[Avatar GET] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
