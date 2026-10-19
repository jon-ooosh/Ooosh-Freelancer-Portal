import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ReactFlow, Background, BackgroundVariant, Controls, ConnectionMode, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../services/api';
import { rackNodeTypes, type RackFlowNode } from '../components/rackplan/nodes';
import { rackEdgeTypes } from '../components/rackplan/edges';
import { RackPlanCtx, RackPlanActions } from '../components/rackplan/context';
import { RackNode, RackPlanLayout } from '../components/rackplan/types';

interface PublicData {
  title: string | null;
  jobName: string | null;
  hhJobNumber: number | null;
  layout: RackPlanLayout;
  photos?: Record<number, string>;
  drift?: { removed?: number[] };
}

const noop = () => {};

export default function RackPlanPublicPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<PublicData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ data: PublicData }>(`/rack-plans/public/${token}`);
        if (!cancelled) setData(res.data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Plan not found');
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const nodes: RackFlowNode[] = useMemo(
    () => (data?.layout?.nodes ?? []).map((n: RackNode) => ({
      id: n.id, type: n.type, position: { x: n.x, y: n.y }, data: { node: n },
    })),
    [data],
  );

  const edges: Edge[] = useMemo(
    () => (data?.layout?.arrows ?? []).map((a) => ({
      id: a.id, source: a.from_node, target: a.to_node, type: 'rackEdge',
      sourceHandle: a.from_handle ?? undefined, targetHandle: a.to_handle ?? undefined,
      data: { label: showLabels ? a.label : '' },
    })),
    [data, showLabels],
  );

  const readOnlyActions: RackPlanActions = useMemo(() => {
    const removed = new Set(data?.drift?.removed ?? []);
    return {
      selectedNodeId: null, readOnly: true,
      selectNode: noop, removeNode: noop, moveStackItem: noop, removeStackItem: noop, setCapacity: noop,
      photoUrl: (listId: number) => data?.photos?.[listId],
      isMissing: (itemId: number) => removed.has(itemId),
    };
  }, [data]);

  if (error) {
    return <div className="min-h-screen flex items-center justify-center text-gray-500">{error}</div>;
  }
  if (!data) {
    return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading rack plan…</div>;
  }

  return (
    <div className="h-screen w-screen flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 bg-white shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <img src="/ooosh-logo-full.jpg" alt="Ooosh Tours" className="h-9 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-800 truncate">{data.title || 'Rack Plan'}</div>
            <div className="text-xs text-gray-500 truncate">
              {data.jobName}{data.hhJobNumber ? ` · #${data.hhJobNumber}` : ''}
            </div>
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-gray-600 shrink-0">
          <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
          Show connection labels
        </label>
      </div>
      <div className="flex-1 min-h-0">
        <RackPlanCtx.Provider value={readOnlyActions}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={rackNodeTypes}
            edgeTypes={rackEdgeTypes}
            connectionMode={ConnectionMode.Loose}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Lines} gap={36} color="#f1f5f9" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </RackPlanCtx.Provider>
      </div>
    </div>
  );
}
