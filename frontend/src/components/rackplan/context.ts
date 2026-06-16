import { createContext } from 'react';

/**
 * Actions custom canvas nodes call back into the RackPlanTab container with.
 * (React-flow only hands custom nodes their `data`, so interaction callbacks
 * come through context rather than being stuffed — non-serialisably — into data.)
 */
export interface RackPlanActions {
  selectedNodeId: string | null;
  selectNode: (id: string | null) => void;
  removeNode: (nodeId: string) => void;
  /** Move a U-stack item within a built-here node (dir: -1 up, +1 down). */
  moveStackItem: (nodeId: string, index: number, dir: -1 | 1) => void;
  removeStackItem: (nodeId: string, index: number) => void;
  /** Set a built-here node's U capacity (null/0 = ungated). */
  setCapacity: (nodeId: string, capacity: number | null) => void;
  /** Read-only mode (public view) — hide all edit affordances. */
  readOnly?: boolean;
}

export const RackPlanCtx = createContext<RackPlanActions | null>(null);
