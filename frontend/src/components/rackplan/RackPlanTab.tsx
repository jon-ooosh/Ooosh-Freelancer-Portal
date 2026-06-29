import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  ConnectionMode,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type NodeChange,
  type NodePositionChange,
  type Node,
  type EdgeChange,
  type Edge,
  type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getHelperLines, HelperLines } from './helper-lines';
import { api } from '../../services/api';
import {
  ClassifiedRackItem,
  RackNode,
  RackPlanLayout,
  RackPlanResponse,
  RackStackItem,
} from './types';
import { rackNodeTypes, type RackFlowNode } from './nodes';
import { rackEdgeTypes } from './edges';
import { computeUsedU } from './stack-utils';
import { RackPlanCtx, RackPlanActions } from './context';

interface Props {
  jobId: string;
}

const genId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `n_${Math.random().toString(36).slice(2)}`);

const toFlowNode = (n: RackNode): RackFlowNode => ({
  id: n.id, type: n.type, position: { x: n.x, y: n.y }, data: { node: n },
});

export default function RackPlanTab({ jobId }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);
  const [viewToken, setViewToken] = useState<string | null>(null);
  const [picker, setPicker] = useState<ClassifiedRackItem[]>([]);
  const [rfNodes, setRfNodes] = useState<RackFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // Picker items dismissed to the "Not needed" group (by HH itemId). Persisted with the plan.
  const [notNeeded, setNotNeeded] = useState<Set<number>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [uploadedPhotos, setUploadedPhotos] = useState<Record<number, string>>({});
  const [photoEditMode, setPhotoEditMode] = useState(false);
  const [helperLineH, setHelperLineH] = useState<number | undefined>(undefined);
  const [helperLineV, setHelperLineV] = useState<number | undefined>(undefined);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const pendingPhotoListId = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const res = await api.get<{ data: RackPlanResponse }>(`/rack-plans/by-job/${jobId}`);
        if (cancelled) return;
        const d = res.data;
        setPlanId(d.plan.id);
        setViewToken(d.plan.slug ?? d.plan.viewToken);
        setPicker(d.picker);
        setRfNodes((d.plan.layout?.nodes ?? []).map(toFlowNode));
        setEdges((d.plan.layout?.arrows ?? []).map((a) => ({
          id: a.id, source: a.from_node, target: a.to_node, type: 'rackEdge',
          data: { label: a.label }, deletable: true,
          sourceHandle: a.from_handle ?? undefined, targetHandle: a.to_handle ?? undefined,
        })));
        setNotNeeded(new Set(d.plan.layout?.notNeeded ?? []));
        setDirty(false);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load rack plan');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [jobId]);

  // Pull fresh items from HireHop, then refresh ONLY the picker (keep local layout).
  const refreshHH = useCallback(async () => {
    setRefreshing(true); setHint(null);
    try {
      await api.post(`/hirehop/jobs/${jobId}/sync`, {}).catch(() => { /* sync best-effort */ });
      const res = await api.get<{ data: RackPlanResponse }>(`/rack-plans/by-job/${jobId}`);
      setPicker(res.data.picker);
    } catch (e) {
      setHint(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }, [jobId]);

  const updateNode = useCallback((nodeId: string, updater: (n: RackNode) => RackNode) => {
    setRfNodes((nds) => nds.map((fn) => (fn.id === nodeId ? { ...fn, data: { node: updater(fn.data.node) } } : fn)));
    setDirty(true);
  }, []);

  // Photos resolved by stock list_id: uploaded-this-session overlays the picker's saved URLs.
  const pickerPhotos = useMemo(() => {
    const m: Record<number, string> = {};
    for (const p of picker) if (p.frontPhotoKey) m[p.listId] = p.frontPhotoKey;
    return m;
  }, [picker]);
  const photoUrl = useCallback(
    (listId: number) => uploadedPhotos[listId] ?? pickerPhotos[listId],
    [uploadedPhotos, pickerPhotos],
  );
  const requestPhoto = useCallback((listId: number) => {
    pendingPhotoListId.current = listId;
    photoInputRef.current?.click();
  }, []);

  // Drift: a placed item whose HireHop row is no longer on the job.
  const currentItemIds = useMemo(() => new Set(picker.map((p) => p.itemId)), [picker]);
  const isMissing = useCallback(
    (itemId: number) => itemId > 0 && !currentItemIds.has(itemId),
    [currentItemIds],
  );
  const onPhotoFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const listId = pendingPhotoListId.current;
    e.target.value = '';
    if (!file || !listId) return;
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.upload<{ data: { url: string } }>(`/rack-plans/photo/${listId}`, fd);
      setUploadedPhotos((m) => ({ ...m, [listId]: res.data.url }));
    } catch (err) {
      setHint(err instanceof Error ? err.message : 'Photo upload failed');
    }
  }, []);

  const actions: RackPlanActions = useMemo(() => ({
    selectedNodeId,
    readOnly: false,
    photoUrl,
    requestPhoto,
    isMissing,
    photoEditMode,
    selectNode: (id) => setSelectedNodeId(id),
    removeNode: (nodeId) => {
      setRfNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setSelectedNodeId((cur) => (cur === nodeId ? null : cur));
      setDirty(true);
    },
    moveStackItem: (nodeId, index, dir) => updateNode(nodeId, (n) => {
      const items = [...(n.items ?? [])];
      const j = index + dir;
      if (j < 0 || j >= items.length) return n;
      [items[index], items[j]] = [items[j], items[index]];
      return { ...n, items };
    }),
    removeStackItem: (nodeId, index) =>
      updateNode(nodeId, (n) => ({ ...n, items: (n.items ?? []).filter((_, i) => i !== index) })),
    setCapacity: (nodeId, capacity) => updateNode(nodeId, (n) => ({ ...n, capacity_u: capacity })),
    renameNode: (nodeId) => {
      setRfNodes((nds) => nds.map((fn) => {
        if (fn.id !== nodeId) return fn;
        const next = window.prompt('Label', fn.data.node.label ?? '');
        if (next === null) return fn;
        return { ...fn, data: { node: { ...fn.data.node, label: next } } };
      }));
      setDirty(true);
    },
    setColor: (nodeId, color) => updateNode(nodeId, (n) => ({ ...n, color })),
    setText: (nodeId, text) => updateNode(nodeId, (n) => ({ ...n, label: text })),
    renameStackItem: (nodeId, index) => {
      setRfNodes((nds) => nds.map((fn) => {
        if (fn.id !== nodeId) return fn;
        const items = [...(fn.data.node.items ?? [])];
        const cur = items[index];
        if (!cur) return fn;
        const next = window.prompt('Item label', cur.label ?? '');
        if (next === null) return fn;
        items[index] = { ...cur, label: next };
        return { ...fn, data: { node: { ...fn.data.node, items } } };
      }));
      setDirty(true);
    },
    editEdge: (edgeId) => {
      setEdges((eds) => {
        const cur = eds.find((e) => e.id === edgeId);
        const label = window.prompt('Connection label (e.g. "8-way XLR loom", "Cat5 to stagebox")',
          String((cur?.data as { label?: string } | undefined)?.label ?? ''));
        if (label === null) return eds;
        return eds.map((e) => (e.id === edgeId ? { ...e, data: { ...(e.data ?? {}), label } } : e));
      });
      setDirty(true);
    },
    deleteEdge: (edgeId) => { setEdges((eds) => eds.filter((e) => e.id !== edgeId)); setDirty(true); },
  }), [selectedNodeId, updateNode, photoUrl, requestPhoto, isMissing, photoEditMode]);

  const onNodesChange = useCallback((changes: NodeChange<RackFlowNode>[]) => {
    setHelperLineH(undefined);
    setHelperLineV(undefined);
    // Single-node drag → snap to alignment with other nodes + show guide lines.
    const first = changes[0];
    if (changes.length === 1 && first.type === 'position' && first.dragging && first.position) {
      const lines = getHelperLines(first as NodePositionChange, rfNodes as Node[]);
      first.position.x = lines.snapPosition.x ?? first.position.x;
      first.position.y = lines.snapPosition.y ?? first.position.y;
      setHelperLineH(lines.horizontal);
      setHelperLineV(lines.vertical);
    }
    setRfNodes((nds) => applyNodeChanges(changes, nds));
    if (changes.some((c) => c.type === 'position' || c.type === 'remove')) setDirty(true);
  }, [rfNodes]);

  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
    if (changes.some((c) => c.type === 'remove')) setDirty(true);
  }, []);

  const onConnect = useCallback((c: Connection) => {
    const id = genId();
    setEdges((eds) => addEdge({ ...c, id, type: 'rackEdge', data: { label: '' }, deletable: true }, eds));
    setDirty(true);
    // Auto-prompt for the label — deferred so it can't interrupt the connect drag.
    setTimeout(() => {
      const label = window.prompt('Connection label (e.g. "8-way XLR loom", "Cat5 to stagebox")', '');
      if (label) setEdges((eds) => eds.map((x) => (x.id === id ? { ...x, data: { ...(x.data ?? {}), label } } : x)));
    }, 10);
  }, []);

  // Count of each HH row already placed (quantity-aware — a qty:3 item can be placed 3×).
  const placedCounts = useMemo(() => {
    const m = new Map<number, number>();
    const inc = (n?: number) => { if (typeof n === 'number') m.set(n, (m.get(n) ?? 0) + 1); };
    for (const fn of rfNodes) {
      const n = fn.data.node;
      inc(n.hh_item_id);
      for (const it of n.items ?? []) inc(it.hh_item_id);
    }
    return m;
  }, [rfNodes]);

  // Spread new nodes across a grid so they land in open space, not stacked.
  const nextPos = useCallback(() => {
    const i = rfNodes.length;
    return { x: 60 + (i % 4) * 240, y: 60 + Math.floor(i / 4) * 170 };
  }, [rfNodes]);

  const addStandaloneNode = useCallback((item: ClassifiedRackItem, type: 'pre_built' | 'loose') => {
    const pos = nextPos();
    const node: RackNode = {
      id: genId(), type, x: pos.x, y: pos.y, label: item.name,
      hh_item_id: item.itemId, hh_list_id: item.listId, front_photo_key: item.frontPhotoKey,
    };
    setRfNodes((nds) => [...nds, toFlowNode(node)]);
    setDirty(true);
  }, [nextPos]);

  const addTextNode = useCallback(() => {
    const pos = nextPos();
    const node: RackNode = { id: genId(), type: 'text', x: pos.x, y: pos.y, label: '' };
    setRfNodes((nds) => [...nds, toFlowNode(node)]);
    setSelectedNodeId(node.id);
    setDirty(true);
  }, [nextPos]);

  const addBuiltHereNode = useCallback((label: string, capacity: number | null, item?: ClassifiedRackItem) => {
    const pos = nextPos();
    const node: RackNode = {
      id: genId(), type: 'built_here', x: pos.x, y: pos.y, label, items: [],
      capacity_u: capacity && capacity > 0 ? capacity : null,
      // A case from HireHop carries its item ref so the picker quantity gate counts it.
      hh_item_id: item?.itemId, hh_list_id: item?.listId,
    };
    setRfNodes((nds) => [...nds, toFlowNode(node)]);
    setSelectedNodeId(node.id);
    setDirty(true);
  }, [nextPos]);

  const addUItem = useCallback((item: ClassifiedRackItem) => {
    const target = rfNodes.find((n) => n.id === selectedNodeId && n.data.node.type === 'built_here');
    if (!target) { setHint('Select a rack first (or add one with “+ New rack”), then click a U-item.'); return; }
    const cap = target.data.node.capacity_u ?? null;
    const usedU = computeUsedU(target.data.node.items ?? []);
    const h = item.rackHeight ?? 1;
    if (cap !== null && usedU + h > cap) {
      setHint(`Won't fit — ${target.data.node.label} is ${cap}U and already has ${usedU}U.`);
      return;
    }
    setHint(null);
    const stackItem: RackStackItem = {
      hh_item_id: item.itemId, hh_list_id: item.listId, label: item.name,
      rackheight: h, half_width: item.halfWidth, front_photo_key: item.frontPhotoKey,
    };
    updateNode(target.id, (n) => ({ ...n, items: [...(n.items ?? []), stackItem] }));
  }, [rfNodes, selectedNodeId, updateNode]);

  const save = useCallback(async () => {
    if (!planId) return;
    setSaving(true);
    try {
      const nodes: RackNode[] = rfNodes.map((fn) => ({
        ...fn.data.node, id: fn.id, type: fn.data.node.type, x: fn.position.x, y: fn.position.y,
      }));
      const arrows = edges.map((e) => ({
        id: e.id, from_node: e.source, to_node: e.target,
        label: String((e.data as { label?: string } | undefined)?.label ?? ''),
        from_handle: e.sourceHandle ?? null, to_handle: e.targetHandle ?? null,
      }));
      const layout: RackPlanLayout = { nodes, arrows, notNeeded: [...notNeeded] };
      await api.put(`/rack-plans/${planId}`, { layout });
      setDirty(false);
    } catch (e) {
      setHint(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [planId, rfNodes, edges, notNeeded]);

  // "Not needed" tidy-up: dismiss a picker row to the bottom group, restore it back,
  // or promote it straight to the canvas (dispatching to the right add-handler by bucket).
  const dismissItem = useCallback((itemId: number) => {
    setNotNeeded((s) => { const n = new Set(s); n.add(itemId); return n; });
    setDirty(true);
  }, []);
  const restoreItem = useCallback((itemId: number) => {
    setNotNeeded((s) => { const n = new Set(s); n.delete(itemId); return n; });
    setDirty(true);
  }, []);
  const addItemByBucket = useCallback((item: ClassifiedRackItem) => {
    switch (item.bucket) {
      case 'pre_built': addStandaloneNode(item, 'pre_built'); break;
      case 'case': addBuiltHereNode(item.name, item.rackHeight, item); break;
      case 'u_item': addUItem(item); break;
      default: addStandaloneNode(item, 'loose'); break;
    }
  }, [addStandaloneNode, addBuiltHereNode, addUItem]);

  const buckets = useMemo(() => {
    const visible = picker.filter((p) => !notNeeded.has(p.itemId));
    return {
      pre_built: visible.filter((p) => p.bucket === 'pre_built'),
      u_item: visible.filter((p) => p.bucket === 'u_item'),
      case: visible.filter((p) => p.bucket === 'case'),
      loose: visible.filter((p) => p.bucket === 'loose'),
      notNeeded: picker.filter((p) => notNeeded.has(p.itemId)),
    };
  }, [picker, notNeeded]);

  const selectedNode = useMemo(
    () => rfNodes.find((n) => n.id === selectedNodeId)?.data.node ?? null,
    [rfNodes, selectedNodeId],
  );

  // Drift counts: placed items removed from HH, and on-job items not on the plot.
  const removedCount = useMemo(() => {
    let c = 0;
    for (const fn of rfNodes) {
      const n = fn.data.node;
      if (typeof n.hh_item_id === 'number' && isMissing(n.hh_item_id)) c++;
      for (const it of n.items ?? []) if (isMissing(it.hh_item_id)) c++;
    }
    return c;
  }, [rfNodes, isMissing]);
  const unplacedCount = useMemo(
    () => picker.filter((p) => !notNeeded.has(p.itemId) && p.quantity - (placedCounts.get(p.itemId) ?? 0) > 0).length,
    [picker, placedCounts, notNeeded],
  );

  if (loading) return <div className="text-sm text-gray-500 py-8 text-center">Loading rack plan…</div>;
  if (error) return <div className="text-sm text-red-600 py-8 text-center">{error}</div>;

  return (
    <div className="flex flex-col h-full min-h-0">
      <input ref={photoInputRef} type="file" accept="image/*" className="hidden" onChange={onPhotoFile} />
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2 shrink-0">
        <div className="flex items-center gap-2">
          <button className="px-3 py-1.5 text-sm rounded bg-gray-800 text-white hover:bg-gray-700"
            onClick={() => addBuiltHereNode('Rack', null)}>+ New rack</button>
          <button className="px-3 py-1.5 text-sm rounded border border-amber-300 text-amber-700 hover:bg-amber-50"
            onClick={addTextNode}>+ Text</button>
          <button
            className={`px-3 py-1.5 text-sm rounded border ${photoEditMode ? 'border-ooosh-400 bg-ooosh-50 text-ooosh-700' : 'border-gray-300 text-gray-600 hover:bg-gray-100'}`}
            onClick={() => setPhotoEditMode((v) => !v)}
            title="Toggle the per-item 📷 photo controls on/off">
            ⚙️ Photos: {photoEditMode ? 'On' : 'Off'}
          </button>
          <button className="px-3 py-1.5 text-sm rounded border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-50"
            onClick={refreshHH} disabled={refreshing}>{refreshing ? 'Refreshing…' : '↻ Refresh from HireHop'}</button>
          {hint && <span className="text-xs text-amber-600">{hint}</span>}
        </div>
        <div className="flex items-center gap-3">
          {viewToken && (
            <a className="px-3 py-1.5 text-sm rounded border border-ooosh-200 text-ooosh-700 hover:bg-ooosh-50"
              href={`/rack/${viewToken}`} target="_blank" rel="noreferrer">View-only link ↗</a>
          )}
          <button className="px-3 py-1.5 text-sm rounded bg-ooosh-600 text-white hover:bg-ooosh-700 disabled:opacity-50"
            onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : dirty ? 'Save plan' : 'Saved'}</button>
        </div>
      </div>

      {/* Drift banners */}
      {(removedCount > 0 || unplacedCount > 0) && (
        <div className="flex flex-wrap gap-2 mb-2 shrink-0">
          {removedCount > 0 && (
            <div className="text-xs px-2 py-1 rounded bg-red-50 border border-red-200 text-red-700">
              🔴 {removedCount} item{removedCount === 1 ? '' : 's'} on the plan {removedCount === 1 ? 'was' : 'were'} removed from the job (shown in red)
            </div>
          )}
          {unplacedCount > 0 && (
            <div className="text-xs px-2 py-1 rounded bg-amber-50 border border-amber-200 text-amber-700">
              ⚠ {unplacedCount} item{unplacedCount === 1 ? '' : 's'} on the job not yet on the plot — check the picker for anything that should be (looms, Cat5, power…)
            </div>
          )}
        </div>
      )}

      <div className="flex gap-3 flex-1 min-h-0">
        {/* Canvas */}
        <div className="flex-1 border border-gray-200 rounded-md overflow-hidden">
          <RackPlanCtx.Provider value={actions}>
            <ReactFlow
              nodes={rfNodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              connectionMode={ConnectionMode.Loose}
              nodeTypes={rackNodeTypes}
              edgeTypes={rackEdgeTypes}
              onSelectionChange={({ nodes }) => setSelectedNodeId(nodes[0]?.id ?? null)}
              fitView
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls />
              <HelperLines horizontal={helperLineH} vertical={helperLineV} />
            </ReactFlow>
          </RackPlanCtx.Provider>
        </div>

        {/* Right panel: notes (for selected node) + picker */}
        <div className="w-64 border border-gray-200 rounded-md overflow-y-auto p-2 space-y-3 bg-gray-50 shrink-0">
          {selectedNode && (
            <div className="bg-white border border-gray-200 rounded p-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1 truncate">
                Notes — {selectedNode.label}
              </div>
              <textarea
                value={selectedNode.notes ?? ''}
                onChange={(e) => updateNode(selectedNode.id, (n) => ({ ...n, notes: e.target.value }))}
                placeholder="Infrastructure notes (e.g. “1–8 to FOH, 9–12 to monitors; Cat5 from DM0”). Not the channel list."
                rows={3}
                className="w-full text-xs border border-gray-300 rounded p-1.5 resize-y"
              />
            </div>
          )}

          <PickerSection title="Pre-built units" items={buckets.pre_built} placedCounts={placedCounts}
            onAdd={(it) => addStandaloneNode(it, 'pre_built')} onDismiss={dismissItem} />
          <PickerSection title="Cases" items={buckets.case} placedCounts={placedCounts}
            onAdd={(it) => addBuiltHereNode(it.name, it.rackHeight, it)}
            badge={(it) => (it.rackHeight ? `${it.rackHeight}U` : '')} onDismiss={dismissItem} />
          <PickerSection title="U-items" items={buckets.u_item} placedCounts={placedCounts}
            onAdd={addUItem} badge={(it) => `${it.rackHeight ?? '?'}U${it.halfWidth ? ' ½' : ''}`} onDismiss={dismissItem} />
          <PickerSection title="Loose" items={buckets.loose} placedCounts={placedCounts}
            onAdd={(it) => addStandaloneNode(it, 'loose')} onDismiss={dismissItem} />
          <PickerSection title="Not needed" items={buckets.notNeeded} placedCounts={placedCounts}
            onAdd={addItemByBucket} onRestore={restoreItem} muted />
        </div>
      </div>
    </div>
  );
}

function PickerSection({
  title, items, placedCounts, onAdd, badge, onDismiss, onRestore, muted,
}: {
  title: string;
  items: ClassifiedRackItem[];
  placedCounts: Map<number, number>;
  onAdd: (item: ClassifiedRackItem) => void;
  badge?: (item: ClassifiedRackItem) => string;
  /** ✕ icon to banish a row to the "Not needed" group. */
  onDismiss?: (itemId: number) => void;
  /** ↩ icon to return a "Not needed" row to its original bucket. */
  onRestore?: (itemId: number) => void;
  /** Greys the section heading (used for the "Not needed" group). */
  muted?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className={`text-[11px] font-semibold uppercase tracking-wide mb-1 ${muted ? 'text-gray-400' : 'text-gray-500'}`}>{title} ({items.length})</div>
      <div className="space-y-1">
        {items.map((it) => {
          const used = placedCounts.get(it.itemId) ?? 0;
          const remaining = it.quantity - used;
          const exhausted = remaining <= 0;
          return (
            <div key={it.itemId} className="flex items-center gap-1">
              <button disabled={exhausted} onClick={() => onAdd(it)}
                className={`flex-1 min-w-0 text-left text-xs px-2 py-1 rounded border flex items-center justify-between gap-1 ${
                  exhausted ? 'bg-gray-100 border-gray-200 text-gray-400 cursor-default'
                    : 'bg-white border-gray-300 hover:border-ooosh-400 hover:bg-ooosh-50 text-gray-800'}`}>
                <span className="truncate leading-tight">{it.name}</span>
                <span className="shrink-0 text-[10px] text-gray-400">
                  {it.quantity > 1 ? `${remaining}/${it.quantity}` : exhausted ? '✓' : (badge ? badge(it) : '')}
                </span>
              </button>
              {onDismiss && (
                <button onClick={() => onDismiss(it.itemId)} title="Not needed — move to the bottom"
                  className="shrink-0 text-gray-300 hover:text-gray-600 text-sm leading-none px-1">✕</button>
              )}
              {onRestore && (
                <button onClick={() => onRestore(it.itemId)} title="Restore to its group"
                  className="shrink-0 text-gray-400 hover:text-ooosh-600 text-sm leading-none px-1">↩</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
