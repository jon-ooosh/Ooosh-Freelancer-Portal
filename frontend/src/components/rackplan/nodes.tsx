import { memo, useContext } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { RackNode, RackStackItem } from './types';
import { RackPlanCtx } from './context';
import { packStackRows, computeUsedU } from './stack-utils';

/** Pixels per rack U in the built-here stack rendering. */
export const U_PX = 32;
/** Standalone nodes (pre-built + loose) match the built-here rack width exactly (w-60). */
const STANDALONE_W = 'w-60';

export type RackFlowNode = Node<{ node: RackNode }, 'built_here' | 'pre_built' | 'loose'>;

function useActions() {
  const ctx = useContext(RackPlanCtx);
  if (!ctx) throw new Error('RackPlanCtx missing');
  return ctx;
}

const baseHandle = { width: 9, height: 9, background: '#6b7280' };
const selRing = (selected: boolean) =>
  selected ? 'ring-2 ring-ooosh-500 border-ooosh-400' : 'border-gray-300';

/**
 * Four connectable points per node. In read-only they're invisible (opacity 0)
 * but STILL rendered as normal source handles so existing edges anchor to them.
 * (Hiding them via isConnectable=false stops react-flow measuring them, which
 * dropped the lines from the client view.)
 */
function NodeHandles() {
  const { readOnly } = useActions();
  const style = readOnly ? { ...baseHandle, opacity: 0 } : baseHandle;
  return (
    <>
      <Handle id="l" type="source" position={Position.Left} style={style} />
      <Handle id="r" type="source" position={Position.Right} style={style} />
      <Handle id="t" type="source" position={Position.Top} style={style} />
      <Handle id="b" type="source" position={Position.Bottom} style={style} />
    </>
  );
}

// ── Pre-built (opaque package) ──────────────────────────────────────────────
export const PreBuiltNode = memo(({ id, data, selected }: NodeProps<RackFlowNode>) => {
  const { removeNode, readOnly } = useActions();
  const node = data.node;
  return (
    <div className={`rounded-md border-2 bg-purple-50 shadow-sm ${STANDALONE_W} ${selRing(!!selected)}`}>
      <NodeHandles />
      <div className="flex items-start justify-between gap-1 px-2 py-1.5">
        <div className="text-xs font-semibold text-purple-900 leading-tight">{node.label}</div>
        {!readOnly && (
          <button className="nodrag text-gray-400 hover:text-red-600 text-xs leading-none"
            onClick={() => removeNode(id)} title="Remove from plan">✕</button>
        )}
      </div>
      <div className="px-2 pb-2 text-[10px] uppercase tracking-wide text-purple-500">Pre-built unit</div>
      {node.notes && <div className="px-2 pb-1.5 text-[10px] text-purple-700 italic line-clamp-3">📝 {node.notes}</div>}
    </div>
  );
});
PreBuiltNode.displayName = 'PreBuiltNode';

// ── Loose element (label only) ──────────────────────────────────────────────
export const LooseNode = memo(({ id, data, selected }: NodeProps<RackFlowNode>) => {
  const { removeNode, readOnly } = useActions();
  const node = data.node;
  return (
    <div className={`rounded-md border bg-white shadow-sm ${STANDALONE_W} ${selRing(!!selected)}`}>
      <NodeHandles />
      <div className="flex items-start justify-between gap-1 px-2 py-1.5">
        <div className="text-xs font-medium text-gray-800 leading-tight">{node.label}</div>
        {!readOnly && (
          <button className="nodrag text-gray-400 hover:text-red-600 text-xs leading-none"
            onClick={() => removeNode(id)} title="Remove from plan">✕</button>
        )}
      </div>
      {node.notes && <div className="px-2 pb-1.5 text-[10px] text-gray-500 italic line-clamp-3">📝 {node.notes}</div>}
    </div>
  );
});
LooseNode.displayName = 'LooseNode';

// ── A single U-stack cell (fills its wrapper; wrapper sets the width) ────────
function StackCell({
  item, index, lastIndex, nodeId, readOnly, onMove, onRemove,
}: {
  item: RackStackItem; index: number; lastIndex: number;
  nodeId: string; readOnly: boolean;
  onMove: (nodeId: string, index: number, dir: -1 | 1) => void;
  onRemove: (nodeId: string, index: number) => void;
}) {
  const h = Math.max(1, item.rackheight || 1);
  const uTag = `${h}U${item.half_width ? ' ½' : ''}`;
  return (
    <div className="relative flex flex-col justify-center px-1.5 min-w-0 h-full w-full">
      <div className={readOnly ? '' : 'pr-5'}>
        {h === 1 ? (
          <div className="flex items-center gap-1 min-w-0">
            <span className="text-[10px] font-medium text-gray-800 truncate">{item.label}</span>
            <span className="text-[9px] text-gray-400 shrink-0">{uTag}</span>
          </div>
        ) : (
          <>
            <div className="text-[10px] font-medium text-gray-800 leading-tight line-clamp-2">{item.label}</div>
            <div className="text-[9px] text-gray-500">{uTag}</div>
          </>
        )}
      </div>
      {!readOnly && (
        <div className="nodrag absolute top-0 right-0 bottom-0 w-5 flex flex-col items-center justify-center bg-white/70">
          <button className="text-[9px] leading-none text-gray-500 hover:text-ooosh-600 disabled:opacity-30"
            disabled={index === 0} onClick={(e) => { e.stopPropagation(); onMove(nodeId, index, -1); }} title="Up">▲</button>
          <button className="text-[10px] leading-none text-red-400 hover:text-red-600 my-0.5"
            onClick={(e) => { e.stopPropagation(); onRemove(nodeId, index); }} title="Remove">✕</button>
          <button className="text-[9px] leading-none text-gray-500 hover:text-ooosh-600 disabled:opacity-30"
            disabled={index === lastIndex} onClick={(e) => { e.stopPropagation(); onMove(nodeId, index, 1); }} title="Down">▼</button>
        </div>
      )}
    </div>
  );
}

// ── Built-here case (U-stack interior) ──────────────────────────────────────
export const BuiltHereNode = memo(({ id, data, selected }: NodeProps<RackFlowNode>) => {
  const { removeNode, selectNode, moveStackItem, removeStackItem, setCapacity, readOnly } = useActions();
  const node = data.node;
  const items = node.items ?? [];
  const rows = packStackRows(items);
  const usedU = computeUsedU(items);
  const cap = node.capacity_u ?? null;
  const emptyU = cap !== null ? Math.max(0, cap - usedU) : 0;
  const overU = cap !== null ? Math.max(0, usedU - cap) : 0;
  const lastIndex = items.length - 1;

  return (
    <div className={`rounded-md border-2 bg-gray-900 shadow-md w-60 ${selRing(!!selected)}`}
      onClick={() => !readOnly && selectNode(id)}>
      <NodeHandles />

      {/* Header */}
      <div className="flex items-center justify-between gap-1 px-2 py-1.5 bg-gray-800 rounded-t">
        <div className="text-xs font-semibold text-white leading-tight truncate flex-1">{node.label}</div>
        <div className="flex items-center gap-1 shrink-0">
          {readOnly ? (
            <span className="text-[10px] text-gray-300">{cap !== null ? `${cap}U` : ''}</span>
          ) : (
            <>
              <input type="number" min={0} value={cap ?? ''} placeholder="U"
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setCapacity(id, e.target.value === '' ? null : Math.max(0, Number(e.target.value)))}
                className="nodrag w-9 text-[10px] px-1 py-0.5 rounded bg-gray-700 text-white border border-gray-600 text-center"
                title="Rack U capacity" />
              <span className="text-[10px] text-gray-400">U</span>
              <button className="nodrag text-gray-400 hover:text-red-400 text-xs leading-none ml-0.5"
                onClick={(e) => { e.stopPropagation(); removeNode(id); }} title="Remove rack">✕</button>
            </>
          )}
        </div>
      </div>

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

        {rows.map((row, ri) => {
          const isPair = row.cells.length === 2;
          const loneHalf = !isPair && row.cells[0].item.half_width;
          return (
            <div key={ri} className="flex items-stretch rounded bg-gray-100 border border-gray-300 overflow-hidden"
              style={{ height: row.heightU * U_PX }}>
              {row.cells.map((cell, ci) => (
                <div key={cell.index}
                  className={ci > 0 ? 'border-l border-dashed border-gray-300' : ''}
                  style={{ width: isPair ? '50%' : (cell.item.half_width ? '50%' : '100%') }}>
                  <StackCell item={cell.item} index={cell.index} lastIndex={lastIndex}
                    nodeId={id} readOnly={!!readOnly} onMove={moveStackItem} onRemove={removeStackItem} />
                </div>
              ))}
              {loneHalf && (
                <div className="w-1/2 border-l border-dashed border-gray-300 bg-gray-50 flex items-center justify-center text-[9px] text-gray-400">
                  pair / blank
                </div>
              )}
            </div>
          );
        })}

        {Array.from({ length: emptyU }).map((_, i) => (
          <div key={`empty-${i}`} className="rounded border border-dashed border-gray-600 bg-gray-800/40"
            style={{ height: U_PX }} />
        ))}
      </div>

      {node.notes && <div className="px-2 pb-1.5 text-[10px] text-gray-300 italic line-clamp-3">📝 {node.notes}</div>}
    </div>
  );
});
BuiltHereNode.displayName = 'BuiltHereNode';

export const rackNodeTypes = {
  built_here: BuiltHereNode,
  pre_built: PreBuiltNode,
  loose: LooseNode,
};
