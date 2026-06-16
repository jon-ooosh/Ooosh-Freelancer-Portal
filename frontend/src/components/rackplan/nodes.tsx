import { memo, useContext } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { RackNode } from './types';
import { RackPlanCtx } from './context';

/** Pixels per rack U in the built-here stack rendering. */
export const U_PX = 26;

export type RackFlowNode = Node<{ node: RackNode }, 'built_here' | 'pre_built' | 'loose'>;

function useActions() {
  const ctx = useContext(RackPlanCtx);
  if (!ctx) throw new Error('RackPlanCtx missing');
  return ctx;
}

const handleStyle = { width: 9, height: 9 };
const selRing = (selected: boolean) =>
  selected ? 'ring-2 ring-ooosh-500 border-ooosh-400' : 'border-gray-300';

// ── Pre-built (opaque package) ──────────────────────────────────────────────
export const PreBuiltNode = memo(({ id, data, selected }: NodeProps<RackFlowNode>) => {
  const { removeNode, readOnly } = useActions();
  const node = data.node;
  return (
    <div className={`rounded-md border-2 bg-purple-50 shadow-sm w-44 ${selRing(!!selected)}`}>
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <div className="flex items-start justify-between gap-1 px-2 py-1.5">
        <div className="text-xs font-semibold text-purple-900 leading-tight">{node.label}</div>
        {!readOnly && (
          <button className="nodrag text-gray-400 hover:text-red-600 text-xs leading-none"
            onClick={() => removeNode(id)} title="Remove from plan">✕</button>
        )}
      </div>
      <div className="px-2 pb-2 text-[10px] uppercase tracking-wide text-purple-500">Pre-built unit</div>
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </div>
  );
});
PreBuiltNode.displayName = 'PreBuiltNode';

// ── Loose element (label only) ──────────────────────────────────────────────
export const LooseNode = memo(({ id, data, selected }: NodeProps<RackFlowNode>) => {
  const { removeNode, readOnly } = useActions();
  const node = data.node;
  return (
    <div className={`rounded-md border bg-white shadow-sm w-40 ${selRing(!!selected)}`}>
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <div className="flex items-start justify-between gap-1 px-2 py-1.5">
        <div className="text-xs font-medium text-gray-800 leading-tight">{node.label}</div>
        {!readOnly && (
          <button className="nodrag text-gray-400 hover:text-red-600 text-xs leading-none"
            onClick={() => removeNode(id)} title="Remove from plan">✕</button>
        )}
      </div>
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </div>
  );
});
LooseNode.displayName = 'LooseNode';

// ── Built-here case (U-stack interior) ──────────────────────────────────────
export const BuiltHereNode = memo(({ id, data, selected }: NodeProps<RackFlowNode>) => {
  const { removeNode, selectNode, moveStackItem, removeStackItem, setCapacity, readOnly } = useActions();
  const node = data.node;
  const items = node.items ?? [];
  const usedU = items.reduce((s, it) => s + Math.max(1, it.rackheight || 1), 0);
  const cap = node.capacity_u ?? null;
  const emptyU = cap !== null ? Math.max(0, cap - usedU) : 0;
  const overU = cap !== null ? Math.max(0, usedU - cap) : 0;

  return (
    <div
      className={`rounded-md border-2 bg-gray-900 shadow-md w-56 ${selRing(!!selected)}`}
      onClick={() => !readOnly && selectNode(id)}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />

      {/* Header */}
      <div className="flex items-center justify-between gap-1 px-2 py-1.5 bg-gray-800 rounded-t">
        <div className="text-xs font-semibold text-white leading-tight truncate flex-1">{node.label}</div>
        <div className="flex items-center gap-1 shrink-0">
          {readOnly ? (
            <span className="text-[10px] text-gray-300">{cap !== null ? `${cap}U` : ''}</span>
          ) : (
            <>
              <input
                type="number" min={0} value={cap ?? ''} placeholder="U"
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setCapacity(id, e.target.value === '' ? null : Math.max(0, Number(e.target.value)))}
                className="nodrag w-9 text-[10px] px-1 py-0.5 rounded bg-gray-700 text-white border border-gray-600 text-center"
                title="Rack U capacity"
              />
              <span className="text-[10px] text-gray-400">U</span>
              <button className="nodrag text-gray-400 hover:text-red-400 text-xs leading-none ml-0.5"
                onClick={(e) => { e.stopPropagation(); removeNode(id); }} title="Remove rack">✕</button>
            </>
          )}
        </div>
      </div>

      {/* Capacity readout */}
      {cap !== null && (
        <div className={`px-2 py-0.5 text-[9px] ${overU > 0 ? 'bg-red-600 text-white' : 'bg-gray-700 text-gray-300'}`}>
          {overU > 0 ? `⚠ Over capacity by ${overU}U (${usedU}U in a ${cap}U rack)` : `${usedU} / ${cap}U used`}
        </div>
      )}

      {/* U-stack */}
      <div className="p-1.5 space-y-1">
        {items.length === 0 && (
          <div className="text-[10px] text-gray-400 text-center py-3 border border-dashed border-gray-600 rounded">
            {readOnly ? 'Empty' : selected ? 'Click U-items in the picker to add them' : 'Empty rack — click to select'}
          </div>
        )}

        {items.map((it, idx) => {
          const h = Math.max(1, it.rackheight || 1);
          return (
            <div key={`${it.hh_item_id}-${idx}`}
              className="flex items-stretch rounded bg-gray-100 border border-gray-300 overflow-hidden"
              style={{ height: h * U_PX }}>
              {/* content */}
              <div className="flex-1 flex min-w-0">
                <div className="flex flex-col justify-center px-1.5 py-0.5 min-w-0"
                  style={{ width: it.half_width ? '50%' : '100%' }}>
                  <div className="text-[10px] font-medium text-gray-800 leading-tight line-clamp-2">{it.label}</div>
                  <div className="text-[9px] text-gray-500">{h}U{it.half_width ? ' · ½' : ''}</div>
                </div>
                {it.half_width && (
                  <div className="w-1/2 border-l border-dashed border-gray-300 bg-gray-50 flex items-center justify-center text-[9px] text-gray-400">
                    pair / blank
                  </div>
                )}
              </div>
              {/* controls column (own column — never overlaps text) */}
              {!readOnly && (
                <div className="nodrag w-5 shrink-0 flex flex-col border-l border-gray-300 bg-white">
                  <button className="flex-1 text-[9px] text-gray-500 hover:text-ooosh-600 disabled:opacity-30"
                    disabled={idx === 0} onClick={(e) => { e.stopPropagation(); moveStackItem(id, idx, -1); }} title="Up">▲</button>
                  <button className="flex-1 text-[9px] text-gray-500 hover:text-ooosh-600 disabled:opacity-30"
                    disabled={idx === items.length - 1} onClick={(e) => { e.stopPropagation(); moveStackItem(id, idx, 1); }} title="Down">▼</button>
                  <button className="flex-1 text-[9px] text-gray-400 hover:text-red-600"
                    onClick={(e) => { e.stopPropagation(); removeStackItem(id, idx); }} title="Remove">✕</button>
                </div>
              )}
            </div>
          );
        })}

        {/* empty U slots (proportional to capacity) */}
        {Array.from({ length: emptyU }).map((_, i) => (
          <div key={`empty-${i}`} className="rounded border border-dashed border-gray-600 bg-gray-800/40"
            style={{ height: U_PX }} />
        ))}
      </div>
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </div>
  );
});
BuiltHereNode.displayName = 'BuiltHereNode';

export const rackNodeTypes = {
  built_here: BuiltHereNode,
  pre_built: PreBuiltNode,
  loose: LooseNode,
};
