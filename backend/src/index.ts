import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import jwt from 'jsonwebtoken';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import dotenv from 'dotenv';
import routes from './routes';
import { connectRedis } from './config/redis';
import { startScheduler } from './config/scheduler';

dotenv.config();

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

const app = express();
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
app.use(morgan('short'));
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

// Socket.io authentication middleware — verify JWT before allowing connection
io.use((socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) {
    return next(new Error('Authentication required'));
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string; email: string; role: string };
    (socket as unknown as Record<string, unknown>).userId = decoded.id;
    (socket as unknown as Record<string, unknown>).userEmail = decoded.email;
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
});

// Socket.io connection handling — only authenticated users reach here
io.on('connection', (socket) => {
  const userId = (socket as unknown as Record<string, unknown>).userId as string;
  console.log(`Socket connected: ${socket.id} (user: ${userId})`);

  // Auto-join user's notification room (no longer trusts client-supplied userId)
  socket.join(`user:${userId}`);

  socket.on('join-entity', (entityId: string) => {
    socket.join(`entity:${entityId}`);
  });

  socket.on('leave-entity', (entityId: string) => {
    socket.leave(`entity:${entityId}`);
  });

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
  });
}

start();

export { io };
