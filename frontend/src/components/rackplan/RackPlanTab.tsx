import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  applyNodeChanges,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../../services/api';
import {
  ClassifiedRackItem,
  RackNode,
  RackPlanLayout,
  RackPlanResponse,
  RackStackItem,
} from './types';
import { rackNodeTypes, type RackFlowNode } from './nodes';
import { RackPlanCtx, RackPlanActions } from './context';

interface Props {
  jobId: string;
}

const genId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `n_${Math.random().toString(36).slice(2)}`);

function toFlowNode(n: RackNode): RackFlowNode {
  return { id: n.id, type: n.type, position: { x: n.x, y: n.y }, data: { node: n } };
}

export default function RackPlanTab({ jobId }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);
  const [viewToken, setViewToken] = useState<string | null>(null);
  const [picker, setPicker] = useState<ClassifiedRackItem[]>([]);
  const [arrows, setArrows] = useState<RackPlanLayout['arrows']>([]);
  const [rfNodes, setRfNodes] = useState<RackFlowNode[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.get<{ data: RackPlanResponse }>(`/rack-plans/by-job/${jobId}`);
        if (cancelled) return;
        const d = res.data;
        setPlanId(d.plan.id);
        setViewToken(d.plan.viewToken);
        setPicker(d.picker);
        setArrows(d.plan.layout?.arrows ?? []);
        setRfNodes((d.plan.layout?.nodes ?? []).map(toFlowNode));
        setDirty(false);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load rack plan');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [jobId]);

  // ── Node mutation helpers ───────────────────────────────────────────────────
  const updateNode = useCallback((nodeId: string, updater: (n: RackNode) => RackNode) => {
    setRfNodes((nds) =>
      nds.map((fn) => (fn.id === nodeId ? { ...fn, data: { node: updater(fn.data.node) } } : fn)),
    );
    setDirty(true);
  }, []);

  const actions: RackPlanActions = useMemo(() => ({
    selectedNodeId,
    selectNode: (id) => setSelectedNodeId(id),
    removeNode: (nodeId) => {
      setRfNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setSelectedNodeId((cur) => (cur === nodeId ? null : cur));
      setDirty(true);
    },
    moveStackItem: (nodeId, index, dir) =>
      updateNode(nodeId, (n) => {
        const items = [...(n.items ?? [])];
        const j = index + dir;
        if (j < 0 || j >= items.length) return n;
        [items[index], items[j]] = [items[j], items[index]];
        return { ...n, items };
      }),
    removeStackItem: (nodeId, index) =>
      updateNode(nodeId, (n) => ({ ...n, items: (n.items ?? []).filter((_, i) => i !== index) })),
  }), [selectedNodeId, updateNode]);

  const onNodesChange = useCallback((changes: NodeChange<RackFlowNode>[]) => {
    setRfNodes((nds) => applyNodeChanges(changes, nds));
    if (changes.some((c) => c.type === 'position' || c.type === 'remove')) setDirty(true);
  }, []);

  // ── Placement ───────────────────────────────────────────────────────────────
  const placedIds = useMemo(() => {
    const ids = new Set<number>();
    for (const fn of rfNodes) {
      const n = fn.data.node;
      if (typeof n.hh_item_id === 'number') ids.add(n.hh_item_id);
      for (const it of n.items ?? []) ids.add(it.hh_item_id);
    }
    return ids;
  }, [rfNodes]);

  const nextPos = useCallback(() => {
    const c = rfNodes.length;
    return { x: 40 + (c % 5) * 60, y: 40 + (c % 8) * 50 };
  }, [rfNodes]);

  const addStandaloneNode = useCallback(
    (item: ClassifiedRackItem, type: 'pre_built' | 'loose') => {
      const pos = nextPos();
      const node: RackNode = {
        id: genId(), type, x: pos.x, y: pos.y, label: item.name,
        hh_item_id: item.itemId, hh_list_id: item.listId, front_photo_key: item.frontPhotoKey,
      };
      setRfNodes((nds) => [...nds, toFlowNode(node)]);
      setDirty(true);
    }, [nextPos]);

  const addBuiltHereNode = useCallback((label: string) => {
    const pos = nextPos();
    const node: RackNode = { id: genId(), type: 'built_here', x: pos.x, y: pos.y, label, items: [] };
    setRfNodes((nds) => [...nds, toFlowNode(node)]);
    setSelectedNodeId(node.id);
    setDirty(true);
  }, [nextPos]);

  const addUItem = useCallback((item: ClassifiedRackItem) => {
    const target = rfNodes.find((n) => n.id === selectedNodeId && n.data.node.type === 'built_here');
    if (!target) { setHint('Select a rack first (or add one with “+ New rack”), then click a U-item.'); return; }
    setHint(null);
    const stackItem: RackStackItem = {
      hh_item_id: item.itemId, hh_list_id: item.listId, label: item.name,
      rackheight: item.rackHeight ?? 1, half_width: item.halfWidth, front_photo_key: item.frontPhotoKey,
    };
    updateNode(target.id, (n) => ({ ...n, items: [...(n.items ?? []), stackItem] }));
  }, [rfNodes, selectedNodeId, updateNode]);

  // ── Save ────────────────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (!planId) return;
    setSaving(true);
    try {
      const nodes: RackNode[] = rfNodes.map((fn) => ({
        ...fn.data.node, id: fn.id, type: fn.data.node.type, x: fn.position.x, y: fn.position.y,
      }));
      const layout: RackPlanLayout = { nodes, arrows };
      await api.put(`/rack-plans/${planId}`, { layout });
      setDirty(false);
    } catch (e) {
      setHint(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [planId, rfNodes, arrows]);

  // ── Picker buckets ──────────────────────────────────────────────────────────
  const buckets = useMemo(() => ({
    pre_built: picker.filter((p) => p.bucket === 'pre_built'),
    u_item: picker.filter((p) => p.bucket === 'u_item'),
    case: picker.filter((p) => p.bucket === 'case'),
    loose: picker.filter((p) => p.bucket === 'loose'),
  }), [picker]);

  if (loading) return <div className="text-sm text-gray-500 py-8 text-center">Loading rack plan…</div>;
  if (error) return <div className="text-sm text-red-600 py-8 text-center">{error}</div>;

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <button
            className="px-3 py-1.5 text-sm rounded bg-gray-800 text-white hover:bg-gray-700"
            onClick={() => addBuiltHereNode('Rack')}
          >+ New rack</button>
          {hint && <span className="text-xs text-amber-600">{hint}</span>}
        </div>
        <div className="flex items-center gap-2">
          {viewToken && (
            <a
              className="text-xs text-ooosh-600 hover:underline"
              href={`/rack/${viewToken}`}
              target="_blank"
              rel="noreferrer"
            >Open view-only link ↗</a>
          )}
          <button
            className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50"
            onClick={save}
            disabled={!dirty || saving}
          >{saving ? 'Saving…' : dirty ? 'Save plan' : 'Saved'}</button>
        </div>
      </div>

      <div className="flex gap-3" style={{ height: 600 }}>
        {/* Canvas */}
        <div className="flex-1 border border-gray-200 rounded-md overflow-hidden">
          <RackPlanCtx.Provider value={actions}>
            <ReactFlow
              nodes={rfNodes}
              edges={[]}
              onNodesChange={onNodesChange}
              nodeTypes={rackNodeTypes}
              onSelectionChange={({ nodes }) => {
                const sel = nodes.find((n) => n.type === 'built_here');
                setSelectedNodeId(sel ? sel.id : null);
              }}
              fitView
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls />
            </ReactFlow>
          </RackPlanCtx.Provider>
        </div>

        {/* Picker */}
        <div className="w-64 border border-gray-200 rounded-md overflow-y-auto p-2 space-y-3 bg-gray-50">
          <PickerSection
            title="Pre-built units" items={buckets.pre_built} placedIds={placedIds}
            onAdd={(it) => addStandaloneNode(it, 'pre_built')}
          />
          <PickerSection
            title="Cases" items={buckets.case} placedIds={placedIds}
            onAdd={(it) => addBuiltHereNode(it.name)}
          />
          <PickerSection
            title="U-items" items={buckets.u_item} placedIds={placedIds}
            onAdd={addUItem}
            badge={(it) => `${it.rackHeight ?? '?'}U${it.halfWidth ? ' ½' : ''}`}
          />
          <PickerSection
            title="Loose" items={buckets.loose} placedIds={placedIds}
            onAdd={(it) => addStandaloneNode(it, 'loose')}
          />
        </div>
      </div>
    </div>
  );
}

function PickerSection({
  title, items, placedIds, onAdd, badge,
}: {
  title: string;
  items: ClassifiedRackItem[];
  placedIds: Set<number>;
  onAdd: (item: ClassifiedRackItem) => void;
  badge?: (item: ClassifiedRackItem) => string;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">
        {title} ({items.length})
      </div>
      <div className="space-y-1">
        {items.map((it) => {
          const placed = placedIds.has(it.itemId);
          return (
            <button
              key={it.itemId}
              disabled={placed}
              onClick={() => onAdd(it)}
              className={`w-full text-left text-xs px-2 py-1 rounded border flex items-center justify-between gap-1 ${
                placed
                  ? 'bg-gray-100 border-gray-200 text-gray-400 cursor-default'
                  : 'bg-white border-gray-300 hover:border-ooosh-400 hover:bg-ooosh-50 text-gray-800'
              }`}
            >
              <span className="truncate leading-tight">
                {it.quantity > 1 ? `${it.quantity}× ` : ''}{it.name}
              </span>
              <span className="shrink-0 text-[10px] text-gray-400">
                {placed ? '✓' : badge ? badge(it) : ''}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
