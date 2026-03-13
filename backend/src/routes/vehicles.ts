/**
 * Vehicle Module Proxy Routes
 *
 * Proxies /api/vehicles/* requests to the VM's Netlify functions deployment.
 * Short-term bridge — these will be migrated to native Express routes
 * as the VM's Netlify functions are moved into the OP backend.
 *
 * Pattern:
 *   GET  /api/vehicles/get-stock  →  GET  https://ooosh-vehicles.netlify.app/.netlify/functions/get-stock
 *   POST /api/vehicles/monday     →  POST https://ooosh-vehicles.netlify.app/.netlify/functions/monday
 */
import { Router, Request, Response } from 'express';
import { authenticate, authorize, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authenticate);

const NETLIFY_BASE = process.env.VEHICLE_MODULE_URL || 'https://ooosh-vehicles.netlify.app';

/**
 * Catch-all proxy: forwards any /api/vehicles/:functionName(/*) to Netlify
 */
router.all('/:functionName', proxyToNetlify);
router.all('/:functionName/*', proxyToNetlify);

async function proxyToNetlify(req: Request, res: Response): Promise<void> {
  const functionName = req.params.functionName;
  // Build the remaining path (for sub-paths like /get-stock/123)
  const subPath = req.params[0] ? `/${req.params[0]}` : '';
  const netlifyUrl = `${NETLIFY_BASE}/.netlify/functions/${functionName}${subPath}`;

  // Forward query string
  const queryString = new URL(req.url, 'http://localhost').search;
  const targetUrl = `${netlifyUrl}${queryString}`;

  try {
    const headers: Record<string, string> = {
      'Content-Type': req.headers['content-type'] || 'application/json',
    };

    // Forward the OP auth token so Netlify functions can validate if needed
    if (req.headers.authorization) {
      headers['Authorization'] = req.headers.authorization as string;
    }

    // Forward the OP user info as custom headers (useful during migration)
    const authReq = req as AuthRequest;
    if (authReq.user) {
      headers['X-OP-User-Id'] = authReq.user.id;
      headers['X-OP-User-Email'] = authReq.user.email;
      headers['X-OP-User-Role'] = authReq.user.role;
    }

    const fetchOptions: RequestInit = {
      method: req.method,
      headers,
    };

    // Forward body for non-GET requests
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, fetchOptions);

    // Forward status code
    res.status(response.status);

    // Forward relevant response headers
    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    // Stream the response body
    const body = await response.text();
    res.send(body);
  } catch (error) {
    console.error(`[Vehicle Proxy] Error forwarding to ${targetUrl}:`, error);
    res.status(502).json({
      error: 'Vehicle Module proxy error',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export default router;
