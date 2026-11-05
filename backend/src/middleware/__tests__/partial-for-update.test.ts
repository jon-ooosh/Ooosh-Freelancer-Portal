import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { partialForUpdate } from '../validate';

// A cut-down copy of the driver create schema's shape — the fields that were
// wiped by "Mark as Referred to Insurer" (Willoughby Robinson, 5 Nov 2026).
const createSchema = z.object({
  full_name: z.string().min(1),
  licence_points: z.number().int().min(0).optional().default(0),
  licence_endorsements: z.array(z.object({ code: z.string() })).optional().default([]),
  requires_referral: z.boolean().optional().default(false),
  size: z.enum(['small', 'medium']).default('medium'),
  nullable_default: z.string().nullable().default('x'),
  default_then_optional: z.string().default('y').optional(),
  referral_status: z.string().max(30).nullable().optional(),
  referral_date: z.string().nullable().optional(),
});

describe('partialForUpdate', () => {
  it('returns only the fields that were sent — no defaults filled in', () => {
    const update = partialForUpdate(createSchema);
    expect(update.parse({ referral_status: 'pending', referral_date: '2026-11-05' })).toEqual({
      referral_status: 'pending',
      referral_date: '2026-11-05',
    });
    expect(update.parse({})).toEqual({});
  });

  it('this is the zod 4 behaviour it exists to stop', () => {
    // If this ever starts passing as {} the library changed back — the helper
    // is still right, but the comment in validate.ts needs updating.
    expect(createSchema.partial().parse({})).toMatchObject({ requires_referral: false, licence_points: 0 });
  });

  it('keeps values that were sent, including the default value itself', () => {
    const update = partialForUpdate(createSchema);
    expect(update.parse({ requires_referral: false, licence_points: 0, size: 'small' })).toEqual({
      requires_referral: false,
      licence_points: 0,
      size: 'small',
    });
    expect(update.parse({ nullable_default: null })).toEqual({ nullable_default: null });
  });

  it('still validates what was sent', () => {
    const update = partialForUpdate(createSchema);
    expect(update.safeParse({ licence_points: -1 }).success).toBe(false);
    expect(update.safeParse({ size: 'huge' }).success).toBe(false);
    expect(update.safeParse({ full_name: '' }).success).toBe(false);
    expect(update.safeParse({ requires_referral: 'yes' }).success).toBe(false);
  });

  it('leaves the create schema alone — creates still get their defaults', () => {
    partialForUpdate(createSchema);
    expect(createSchema.parse({ full_name: 'A' })).toMatchObject({
      requires_referral: false,
      licence_points: 0,
      size: 'medium',
    });
  });

  it('can be extended like a plain partial (pcns.ts does)', () => {
    const update = partialForUpdate(createSchema).extend({ extra: z.string().optional() });
    expect(update.parse({ extra: 'e' })).toEqual({ extra: 'e' });
  });
});

describe('no bare .partial() in the backend', () => {
  // Every edit schema must go through partialForUpdate(). A bare .partial() is
  // allowed only with a "partial-ok:" comment on the same line saying why.
  function tsFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : tsFiles(p);
      return p.endsWith('.ts') ? [p] : [];
    });
  }

  it('finds none', () => {
    const srcRoot = path.join(__dirname, '..', '..');
    const offenders: string[] = [];
    for (const file of tsFiles(srcRoot)) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
        if (!isComment && /\.partial\(\)/.test(line) && !/partial-ok:/.test(line)) {
          offenders.push(`${path.relative(srcRoot, file)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
