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
  /** Rename a node's label (overrides the HireHop name). */
  renameNode?: (nodeId: string) => void;
  /** Set a node's accent/border colour (null clears). */
  setColor?: (nodeId: string, color: string | null) => void;
  /** Set a text node's content. */
  setText?: (nodeId: string, text: string) => void;
  /** Edit / delete a connection (used by the custom edge). */
  editEdge?: (edgeId: string) => void;
  deleteEdge?: (edgeId: string) => void;
  /** Current front-panel photo URL for a HireHop stock item, if any. */
  photoUrl?: (listId: number) => string | undefined;
  /** Trigger the upload flow for a stock item's front-panel photo. */
  requestPhoto?: (listId: number) => void;
  /** True when a placed item's HireHop row is no longer on the job (drift). */
  isMissing?: (itemId: number) => boolean;
  /** Whether the per-item 📷 photo controls are shown (off by default — opt-in). */
  photoEditMode?: boolean;
  /** Read-only mode (public view) — hide all edit affordances. */
  readOnly?: boolean;
}

export const RackPlanCtx = createContext<RackPlanActions | null>(null);
