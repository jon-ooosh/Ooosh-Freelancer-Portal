import { Request, Response, NextFunction } from 'express';
import { z, ZodSchema, ZodError } from 'zod';

/**
 * The schema for an EDIT route, built from the create schema: every field
 * optional, and NO `.default()` values.
 *
 * Never use a bare `createSchema.partial()` for an edit. Zod 4 (Nov 2026)
 * applies a field's `.default()` even inside `.partial()` — zod 3 did not — so
 * every field the caller left out was filled in with its starting value and
 * written to the database. "Mark as Referred to Insurer" sends two fields; the
 * server added `requires_referral: false`, `licence_points: 0` and
 * `licence_endorsements: []`, and the driver read as Approved with no points
 * (Willoughby Robinson, 5 Nov 2026). The same hit people (`is_freelancer`,
 * `files`), storage tenancies (status, billing settings), organisations, venues and
 * held items. A test in `middleware/__tests__/partial-for-update.test.ts`
 * fails if a route goes back to a bare `.partial()`.
 */
export function partialForUpdate<S extends z.ZodRawShape>(schema: z.ZodObject<S>) {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    shape[key] = withoutDefault(field as z.ZodType);
  }
  return schema.extend(shape).partial() as unknown as ReturnType<z.ZodObject<S>['partial']>; // partial-ok: defaults removed above
}

/** Peels `.default()` / `.prefault()` off a field, keeping optional / nullable. */
function withoutDefault(field: z.ZodType): z.ZodType {
  if (field instanceof z.ZodDefault || field instanceof z.ZodPrefault) {
    return withoutDefault(field.unwrap() as z.ZodType).optional();
  }
  if (field instanceof z.ZodOptional) {
    return withoutDefault(field.unwrap() as z.ZodType).optional();
  }
  if (field instanceof z.ZodNullable) {
    return withoutDefault(field.unwrap() as z.ZodType).nullable();
  }
  return field;
}

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
        const details = error.issues.map((e) => ({
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
