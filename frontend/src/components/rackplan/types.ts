/**
 * Rack Planner — frontend types. Mirrors backend services/rack-classify.ts and
 * the rack_plans.layout document shape. See docs/RACK-PLANNER-SPEC.md.
 */

export type RackBucket = 'pre_built' | 'u_item' | 'case' | 'loose' | 'absorbed';

/** A classified HireHop line item from the picker (GET /by-job response). */
export interface ClassifiedRackItem {
  itemId: number;
  listId: number;
  name: string;
  quantity: number;
  categoryId: number;
  virtual: boolean;
  lft: number;
  rgt: number;
  rackHeight: number | null;
  halfWidth: boolean;
  bucket: RackBucket;
  collapsedInto: number | null;
  frontPhotoKey: string | null;
}

/** One U-item placed inside a built-here case, top → bottom in array order. */
export interface RackStackItem {
  hh_item_id: number;
  hh_list_id: number;
  label: string;
  rackheight: number;
  half_width: boolean;
  /** Left/right slot for a half-width item sharing a U-band. */
  h_slot?: 'left' | 'right' | null;
  front_photo_key?: string | null;
}

export type RackNodeType = 'built_here' | 'pre_built' | 'loose';

/** A node on the canvas (saved in rack_plans.layout). */
export interface RackNode {
  id: string;
  type: RackNodeType;
  x: number;
  y: number;
  label: string;
  notes?: string;
  /** For pre_built / loose nodes — the HireHop row they represent. */
  hh_item_id?: number;
  hh_list_id?: number;
  front_photo_key?: string | null;
  /** For built_here nodes — the ordered U-stack. */
  items?: RackStackItem[];
  /** For built_here nodes — rack U capacity (gate + proportional render). Null = ungated. */
  capacity_u?: number | null;
}

export interface RackArrow {
  id: string;
  from_node: string;
  to_node: string;
  label: string;
}

export interface RackPlanLayout {
  nodes: RackNode[];
  arrows: RackArrow[];
}

export interface RackPlanDrift {
  removed: number[];
  unplaced: ClassifiedRackItem[];
}

export interface RackPlanResponse {
  plan: {
    id: string;
    jobId: string;
    hhJobNumber: number | null;
    title: string | null;
    viewToken: string;
    layout: RackPlanLayout;
    updatedAt: string;
  };
  jobName: string | null;
  picker: ClassifiedRackItem[];
  drift: RackPlanDrift;
}
