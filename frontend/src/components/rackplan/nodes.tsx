import { memo, useContext } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { RackNode, RackStackItem } from './types';
import { RackPlanCtx } from './context';
import { packStackRows, computeUsedU } from './stack-utils';

/** Pixels per rack U. ~26 keeps front-panel photos close to true rack proportion. */
export const U_PX = 26;
/** All standalone + rack nodes share one exact width so the plot lines up. */
const NODE_W = 240;
const PALETTE = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899'];

export type RackFlowNode = Node<{ node: RackNode }, 'built_here' | 'pre_built' | 'loose' | 'text'>;

function useActions() {
  const ctx = useContext(RackPlanCtx);
  if (!ctx) throw new Error('RackPlanCtx missing');
  return ctx;
}

const baseHandle = { width: 9, height: 9, background: '#6b7280' };

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

/** Swatch row to set a node's accent/border colour (editor, when selected). */
function NodeColorBar({ id }: { id: string }) {
  const { setColor, readOnly } = useActions();
  if (readOnly || !setColor) return null;
  return (
    <div className="nodrag flex items-center gap-1 px-1.5 py-1 border-t border-gray-200/60">
      {PALETTE.map((c) => (
        <button key={c} style={{ background: c }} className="w-3.5 h-3.5 rounded-full border border-white shadow-sm"
          onClick={(e) => { e.stopPropagation(); setColor(id, c); }} title="Border colour" />
      ))}
      <button className="w-3.5 h-3.5 rounded-full border border-gray-300 bg-white text-[8px] leading-none text-gray-400"
        onClick={(e) => { e.stopPropagation(); setColor(id, null); }} title="No colour">✕</button>
    </div>
  );
}

const ringFor = (selected: boolean) => (selected ? 'ring-2 ring-ooosh-500' : '');
const rootStyle = (color?: string | null) => ({ width: NODE_W, ...(color ? { borderColor: color } : {}) });

// ── Pre-built (opaque package) ──────────────────────────────────────────────
export const PreBuiltNode = memo(({ id, data, selected }: NodeProps<RackFlowNode>) => {
  const { removeNode, renameNode, readOnly, photoUrl, requestPhoto } = useActions();
  const node = data.node;
  const listId = node.hh_list_id ?? 0;
  const url = listId > 0 ? photoUrl?.(listId) : undefined;
  return (
    <div style={rootStyle(node.color)} className={`rounded-md border-2 border-gray-300 bg-purple-50 shadow-sm overflow-hidden ${ringFor(!!selected)}`}>
      <NodeHandles />
      <div className="flex items-start justify-between gap-1 px-2 py-1.5">
        <div className="text-xs font-semibold text-purple-900 leading-tight"
          onDoubleClick={(e) => { if (!readOnly) { e.stopPropagation(); renameNode?.(id); } }}
          title={readOnly ? undefined : 'Double-click to rename'}>{node.label}</div>
        {!readOnly && (
          <button className="nodrag text-gray-400 hover:text-red-600 text-xs leading-none"
            onClick={() => removeNode(id)} title="Remove from plan">✕</button>
        )}
      </div>
      {url && <div className="bg-gray-900"><img src={url} alt="" className="w-full h-24 object-contain" draggable={false} /></div>}
      <div className="flex items-center justify-between px-2 pb-2 pt-1">
        <span className="text-[10px] uppercase tracking-wide text-purple-500">Pre-built unit</span>
        {!readOnly && requestPhoto && listId > 0 && (
          <button className="nodrag text-[9px] text-gray-500 hover:text-ooosh-600"
            onClick={(e) => { e.stopPropagation(); requestPhoto(listId); }}
            title={url ? 'Replace photo' : 'Add photo'}>📷</button>
        )}
      </div>
      {node.notes && <div className="px-2 pb-1.5 text-[10px] text-purple-700 italic line-clamp-3">📝 {node.notes}</div>}
      {selected && <NodeColorBar id={id} />}
    </div>
  );
});
PreBuiltNode.displayName = 'PreBuiltNode';

// ── Loose element (label only) ──────────────────────────────────────────────
export const LooseNode = memo(({ id, data, selected }: NodeProps<RackFlowNode>) => {
  const { removeNode, renameNode, readOnly } = useActions();
  const node = data.node;
  return (
    <div style={rootStyle(node.color)} className={`rounded-md border-2 border-gray-300 bg-white shadow-sm ${ringFor(!!selected)}`}>
      <NodeHandles />
      <div className="flex items-start justify-between gap-1 px-2 py-1.5">
        <div className="text-xs font-medium text-gray-800 leading-tight"
          onDoubleClick={(e) => { if (!readOnly) { e.stopPropagation(); renameNode?.(id); } }}
          title={readOnly ? undefined : 'Double-click to rename'}>{node.label}</div>
        {!readOnly && (
          <button className="nodrag text-gray-400 hover:text-red-600 text-xs leading-none"
            onClick={() => removeNode(id)} title="Remove from plan">✕</button>
        )}
      </div>
      {node.notes && <div className="px-2 pb-1.5 text-[10px] text-gray-500 italic line-clamp-3">📝 {node.notes}</div>}
      {selected && <NodeColorBar id={id} />}
    </div>
  );
});
LooseNode.displayName = 'LooseNode';

// ── Free-text note node ─────────────────────────────────────────────────────
export const TextNode = memo(({ id, data, selected }: NodeProps<RackFlowNode>) => {
  const { removeNode, setText, readOnly } = useActions();
  const node = data.node;
  return (
    <div style={rootStyle(node.color)} className={`rounded-md border-2 border-amber-300 bg-amber-50 shadow-sm ${ringFor(!!selected)}`}>
      <NodeHandles />
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-[10px] uppercase tracking-wide text-amber-600">Note</span>
        {!readOnly && (
          <button className="nodrag text-gray-400 hover:text-red-600 text-xs leading-none"
            onClick={() => removeNode(id)} title="Remove note">✕</button>
        )}
      </div>
      {readOnly ? (
        <div className="px-2 pb-2 text-xs text-gray-800 whitespace-pre-wrap">{node.label}</div>
      ) : (
        <textarea value={node.label} rows={3} placeholder="Type a note…"
          onChange={(e) => setText?.(id, e.target.value)}
          className="nodrag w-full text-xs px-2 pb-2 bg-transparent resize-y outline-none" />
      )}
      {selected && <NodeColorBar id={id} />}
    </div>
  );
});
TextNode.displayName = 'TextNode';

// ── A single U-stack cell (fills its wrapper; wrapper sets the width) ────────
function StackCell({
  item, index, lastIndex, nodeId, readOnly, onMove, onRemove,
}: {
  item: RackStackItem; index: number; lastIndex: number;
  nodeId: string; readOnly: boolean;
  onMove: (nodeId: string, index: number, dir: -1 | 1) => void;
  onRemove: (nodeId: string, index: number) => void;
}) {
  const { photoUrl, requestPhoto } = useActions();
  const h = Math.max(1, item.rackheight || 1);
  const uTag = `${h}U${item.half_width ? ' ½' : ''}`;
  const url = photoUrl?.(item.hh_list_id);
  return (
    <div className="relative flex flex-col justify-center px-1.5 min-w-0 h-full w-full overflow-hidden">
      {url && (
        <div className="absolute inset-0 bg-gray-900">
          <img src={url} alt="" className="w-full h-full object-contain" draggable={false} />
        </div>
      )}
      {url ? (
        <div className="relative z-10 self-start max-w-full bg-black/55 text-white rounded px-1 py-0.5 mr-5">
          <span className="text-[9px] font-medium truncate block">{item.label} · {uTag}</span>
        </div>
      ) : (
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
      )}
      {!readOnly && requestPhoto && item.hh_list_id > 0 && (
        <button className="nodrag absolute bottom-0 left-0 z-10 text-[9px] leading-none px-1 py-0.5 bg-white/80 rounded-tr text-gray-600 hover:text-ooosh-600"
          onClick={(e) => { e.stopPropagation(); requestPhoto(item.hh_list_id); }}
          title={url ? 'Replace photo' : 'Add front-panel photo'}>📷</button>
      )}
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
  const { removeNode, selectNode, renameNode, moveStackItem, removeStackItem, setCapacity, readOnly } = useActions();
  const node = data.node;
  const items = node.items ?? [];
  const rows = packStackRows(items);
  const usedU = computeUsedU(items);
  const cap = node.capacity_u ?? null;
  const emptyU = cap !== null ? Math.max(0, cap - usedU) : 0;
  const overU = cap !== null ? Math.max(0, usedU - cap) : 0;
  const lastIndex = items.length - 1;

  return (
    <div style={rootStyle(node.color)} className={`rounded-md border-2 border-gray-300 bg-gray-900 shadow-md ${ringFor(!!selected)}`}
      onClick={() => !readOnly && selectNode(id)}>
      <NodeHandles />

      {/* Header */}
      <div className="flex items-center justify-between gap-1 px-2 py-1.5 bg-gray-800 rounded-t">
        <div className="text-xs font-semibold text-white leading-tight truncate flex-1"
          onDoubleClick={(e) => { if (!readOnly) { e.stopPropagation(); renameNode?.(id); } }}
          title={readOnly ? undefined : 'Double-click to rename'}>{node.label}</div>
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
      {selected && <NodeColorBar id={id} />}
    </div>
  );
});
BuiltHereNode.displayName = 'BuiltHereNode';

export const rackNodeTypes = {
  built_here: BuiltHereNode,
  pre_built: PreBuiltNode,
  loose: LooseNode,
  text: TextNode,
};
