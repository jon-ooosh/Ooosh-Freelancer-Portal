/**
 * Rack Planner — picker classification (single source of truth).
 *
 * Pure function over a job's stored HireHop line items (jobs.line_items, the
 * mapped HHLineItem shape from hirehop-job-sync.ts). Implements §3.3 of
 * docs/RACK-PLANNER-SPEC.md, validated empirically against job 15553.
 *
 * Rules, applied in order:
 *   1. Containment is the HireHop nested set (LFT/RGT). A child's [LFT,RGT]
 *      falls strictly inside its parent's range. (No usable PARENT_ID.)
 *   2. A top-level VIRTUAL item → pre-built node; its ENTIRE subtree is
 *      collapsed (absorbed), incl. its own autopulled loom/cables. A package
 *      is a trusted opaque unit.
 *   3. Of what remains (not inside any VIRTUAL subtree):
 *        rackheight > 0           → u_item (carries the half-width flag)
 *        category 408 (cases)     → case (built-here node candidate)
 *        else                     → loose
 *
 * Only kind:2 lines are placeable. kind:3 (selected prompts / notes) and kind:4
 * (service/crew) are excluded from the picker. kind:0 headers are already
 * dropped at sync time, so section grouping isn't available here (deferred —
 * see spec §8; would need the sync to preserve headers).
 */
import { HHLineItem } from './hirehop-job-sync';

export type RackBucket = 'pre_built' | 'u_item' | 'case' | 'loose' | 'absorbed';

export const CASE_CATEGORY_ID = 408;

export interface ClassifiedRackItem {
  /** Per-job line row id (HHLineItem.ITEM_ID). Primary drift/placement key. */
  itemId: number;
  /** HireHop stock id (stable across jobs). Drives photo lookup + display. */
  listId: number;
  name: string;
  quantity: number;
  categoryId: number;
  virtual: boolean;
  /** Nested-set bounds — unique within a job, used for containment. */
  lft: number;
  rgt: number;
  rackHeight: number | null;
  halfWidth: boolean;
  bucket: RackBucket;
  /** itemId of the VIRTUAL pre-built node that absorbs this row, if any. */
  collapsedInto: number | null;
}

/** Read an integer custom field (value may be flat or a {type,value} shape). */
function readCustomInt(cf: Record<string, unknown> | null, key: string): number | null {
  if (!cf) return null;
  let v: unknown = cf[key];
  if (v && typeof v === 'object') v = (v as { value?: unknown }).value;
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Read a boolean/checkbox custom field (value may be flat or {type,value}). */
function readCustomBool(cf: Record<string, unknown> | null, key: string): boolean {
  if (!cf) return false;
  let v: unknown = cf[key];
  if (v && typeof v === 'object') v = (v as { value?: unknown }).value;
  return v === 1 || v === '1' || v === true || v === 'true' || v === 'yes' || v === 'Yes';
}

export function classifyRackItems(items: HHLineItem[]): ClassifiedRackItem[] {
  const placeable = items.filter((i) => Number(i.kind) === 2);

  return placeable.map((item) => {
    const cf = item.TYPE_CUSTOM_FIELDS as Record<string, unknown> | null;
    const rackHeight = readCustomInt(cf, 'rackheight');
    const halfWidth = readCustomBool(cf, 'rackwidth');

    // Narrowest VIRTUAL ancestor strictly containing this row (largest LFT).
    let ancestorId: number | null = null;
    let ancestorLft = -Infinity;
    for (const other of placeable) {
      if (other === item || !other.VIRTUAL) continue;
      if (other.LFT < item.LFT && other.RGT > item.RGT && other.LFT > ancestorLft) {
        ancestorLft = other.LFT;
        ancestorId = other.ITEM_ID;
      }
    }

    let bucket: RackBucket;
    if (ancestorId !== null) {
      bucket = 'absorbed'; // inside a pre-built package — collapsed, not offered
    } else if (item.VIRTUAL) {
      bucket = 'pre_built';
    } else if (rackHeight !== null && rackHeight > 0) {
      bucket = 'u_item';
    } else if (Number(item.CATEGORY_ID) === CASE_CATEGORY_ID) {
      bucket = 'case';
    } else {
      bucket = 'loose';
    }

    return {
      itemId: item.ITEM_ID,
      listId: item.LIST_ID,
      name: item.ITEM_NAME,
      quantity: item.QUANTITY,
      categoryId: Number(item.CATEGORY_ID),
      virtual: item.VIRTUAL,
      lft: item.LFT,
      rgt: item.RGT,
      rackHeight,
      halfWidth,
      bucket,
      collapsedInto: ancestorId,
    };
  });
}

/** The picker buckets a user can place from (everything except absorbed). */
export function pickableItems(classified: ClassifiedRackItem[]): ClassifiedRackItem[] {
  return classified.filter((c) => c.bucket !== 'absorbed');
}
