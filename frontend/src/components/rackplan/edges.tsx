import { useContext } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { RackPlanCtx } from './context';

/**
 * Right-angle connection with an interactive label chip: click the label to
 * edit, ✕ to delete. In read-only (client view) it renders only the label text.
 */
export function LabeledEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data,
}: EdgeProps) {
  const ctx = useContext(RackPlanCtx);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  });
  const label = (data as { label?: string } | undefined)?.label ?? '';
  const readOnly = ctx?.readOnly;

  return (
    <>
      <BaseEdge id={id} path={path} style={{ stroke: '#6b7280', strokeWidth: 1.5 }} />
      <EdgeLabelRenderer>
        {readOnly ? (
          label ? (
            <div className="nodrag nopan absolute bg-white/90 border border-gray-200 rounded px-1 text-[10px] text-gray-700 shadow-sm"
              style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`, pointerEvents: 'none' }}>
              {label}
            </div>
          ) : null
        ) : (
          <div className="nodrag nopan absolute flex items-center gap-1 bg-white border border-gray-300 rounded px-1 text-[10px] shadow-sm"
            style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`, pointerEvents: 'all' }}>
            <button className="text-gray-700 hover:text-ooosh-600" onClick={() => ctx?.editEdge?.(id)} title="Edit label">
              {label || '+ label'}
            </button>
            <button className="text-red-400 hover:text-red-600 leading-none" onClick={() => ctx?.deleteEdge?.(id)} title="Delete connection">✕</button>
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}

export const rackEdgeTypes = { rackEdge: LabeledEdge };
