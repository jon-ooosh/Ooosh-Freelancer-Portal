/**
 * The Socket.io server, for code that has no `req`.
 *
 * Routes reach the server through `req.app.get('io')`; a service called from
 * a route (or from the scheduler) has no request to ask. index.ts hands the
 * server over here once at start-up. Before that — and in scripts and tests,
 * where there is no server — `emitToUser` does nothing, so a caller never has
 * to check.
 *
 * Every socket sits in exactly one room, `user:<id>` (index.ts), so this is
 * the only kind of emit there is.
 */
import type { Server } from 'socket.io';

let server: Server | null = null;

export function setSocketServer(io: Server): void {
  server = io;
}

export function emitToUser(userId: string, event: string, payload: unknown): void {
  server?.to(`user:${userId}`).emit(event, payload);
}
