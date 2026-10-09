import express from 'express';
// Patches Express 4 so rejected promises from `async` route handlers are
// forwarded to the global error handler below, instead of escaping as
// unhandled rejections (which terminate the process in Node 15+). Must be
// imported before any routers are constructed. Express 5 does this natively;
// drop this shim if/when we upgrade.
import 'express-async-errors';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { verifyStaffToken } from './middleware/auth';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import dotenv from 'dotenv';
import routes from './routes';
import { connectRedis } from './config/redis';
import { startScheduler } from './config/scheduler';
import { handleStripeWebhook } from './services/stripe-webhook';

dotenv.config({ quiet: true });

// ── Startup validation ──────────────────────────────────────────────────────
const REQUIRED_ENV = ['JWT_SECRET', 'DATABASE_URL'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`FATAL: Missing required environment variable: ${key}`);
    process.exit(1);
  }
}
if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be at least 32 characters');
  process.exit(1);
}

// ── Last-resort process guards ───────────────────────────────────────────────
// The express-async-errors shim routes async route-handler rejections to the
// error middleware, but errors that originate OUTSIDE the request lifecycle
// (scheduler tasks, setImmediate post-hooks, socket.io handlers, stray
// promises) still surface here. Log loudly but DO NOT exit — a single stray
// rejection in one module must never take the whole API down. A genuinely
// unrecoverable state would be caught by systemd's health, not by us crashing.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION (process kept alive):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION (process kept alive):', err);
});

const app = express();
// We sit behind exactly one nginx hop, so trust a single proxy. Without this,
// every request collapses to 127.0.0.1 (so express-rate-limit buckets everyone
// together and logs an ERR_ERL_UNEXPECTED_X_FORWARDED_FOR validation error).
app.set('trust proxy', 1);
const httpServer = createServer(app);
const PORT = process.env.PORT || 3001;

// CORS origins — OP frontend + hire form Netlify app
const CORS_ORIGINS = [
  process.env.FRONTEND_URL || 'http://localhost:5173',
  'https://ooosh-driver-verification.netlify.app',
  ...(process.env.EXTRA_CORS_ORIGINS ? process.env.EXTRA_CORS_ORIGINS.split(',') : []),
];

// Socket.io setup
const io = new SocketServer(httpServer, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ['GET', 'POST'],
  },
});

// Middleware
app.use(helmet());
app.use(cors({
  origin: CORS_ORIGINS,
  credentials: true,
}));
app.use(cookieParser());
app.use(morgan('short'));
// Stripe webhook MUST receive the raw body for signature verification, so mount
// it BEFORE express.json() (which would consume + reparse the body). Scoped to
// the one path — everything else still gets JSON parsing below.
app.post('/api/webhooks/stripe', express.raw({ type: '*/*' }), handleStripeWebhook);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Make io accessible to routes
app.set('io', io);

// Routes
app.use('/api', routes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Socket.io authentication middleware — STAFF access tokens only, the same
// check as `authenticate`. Until Oct 2026 this verified the signature alone,
// so any JWT_SECRET-signed token (a public hire-form session, the kiosk, a
// freelancer book-out) could open a socket (SECURITY-AUDIT-BRIEF B.7).
io.use((socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) {
    return next(new Error('Authentication required'));
  }
  const user = verifyStaffToken(token);
  if (!user) {
    return next(new Error('Invalid or expired token'));
  }
  (socket as unknown as Record<string, unknown>).userId = user.id;
  (socket as unknown as Record<string, unknown>).userEmail = user.email;
  next();
});

// Socket.io connection handling — only authenticated users reach here
io.on('connection', (socket) => {
  const userId = (socket as unknown as Record<string, unknown>).userId as string;
  console.log(`Socket connected: ${socket.id} (user: ${userId})`);

  // Auto-join user's notification room (no longer trusts client-supplied userId).
  // This is the ONLY room: the server emits to `user:<id>` and nothing else.
  // The old `join-entity` / `leave-entity` handlers let any socket join any
  // room by id; nothing ever emitted to those rooms and no client sent the
  // event, so they were removed (Oct 2026). Any future room needs an access
  // check here before the join.
  socket.join(`user:${userId}`);

  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// Start
async function start() {
  try {
    await connectRedis();
    console.log('Redis connected');
  } catch (err) {
    console.warn('Redis not available — running without cache:', err);
  }

  httpServer.listen(PORT, () => {
    console.log(`Ooosh Operations API running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    startScheduler();
    // A restart kills the in-process lead pipeline, orphaning any 'running'
    // lead_runs row. Clear them so the UI doesn't show a phantom stuck search.
    import('./services/leads/pipeline')
      .then((m) => m.sweepZombieLeadRuns())
      .catch((err) => console.warn('[leads] zombie sweep at boot failed:', err));
  });
}

start();

export { io };
