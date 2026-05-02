import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

/**
 * Middleware factory that validates request body/params/query against a Zod schema.
 */
export function validate(schema: ZodSchema, source: 'body' | 'params' | 'query' = 'body') {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const data = schema.parse(req[source]);
      req[source] = data;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const details = error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));
        const summary = details.map(d => `${d.field}: ${d.message}`).join('; ');
        const bodyKeys = source === 'body' && req.body && typeof req.body === 'object'
          ? Object.keys(req.body)
          : [];
        console.warn(`[validate] 400 ${req.method} ${req.originalUrl} — ${summary}`,
          bodyKeys.length ? `(${source} keys: ${bodyKeys.join(', ')})` : '');
        res.status(400).json({
          error: `Validation failed: ${summary}`,
          details,
        });
        return;
      }
      next(error);
    }
  };
}
