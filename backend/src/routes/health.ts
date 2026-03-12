import { Router, Request, Response } from 'express';
import { testConnection } from '../config/database';
import { testRedisConnection } from '../config/redis';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  const startTime = process.uptime();
  const days = Math.floor(startTime / 86400);
  const hours = Math.floor((startTime % 86400) / 3600);
  const minutes = Math.floor((startTime % 3600) / 60);

  const [dbOk, redisOk] = await Promise.all([
    testConnection(),
    testRedisConnection(),
  ]);

  const status = dbOk && redisOk ? 'ok' : 'degraded';
  const httpStatus = status === 'ok' ? 200 : 503;

  res.status(httpStatus).json({
    status,
    database: dbOk ? 'connected' : 'disconnected',
    redis: redisOk ? 'connected' : 'disconnected',
    uptime: `${days}d ${hours}h ${minutes}m`,
    version: process.env.npm_package_version || '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

export default router;
