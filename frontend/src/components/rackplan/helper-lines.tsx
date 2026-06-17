import { useEffect, useRef } from 'react';
import { useStore, type Node, type NodePositionChange, type XYPosition } from '@xyflow/react';

interface HelperLineResult {
  horizontal?: number;
  vertical?: number;
  snapPosition: Partial<XYPosition>;
}

/**
 * On a node drag, find the nearest aligned edge (left/right/top/bottom) of any
 * other node within `distance` px and return the snap position + the guide line
 * coordinate. Standard react-flow "helper lines" recipe, condensed.
 */
export function getHelperLines(
  change: NodePositionChange,
  nodes: Node[],
  distance = 5,
): HelperLineResult {
  const result: HelperLineResult = { snapPosition: { x: undefined, y: undefined } };
  const nodeA = nodes.find((n) => n.id === change.id);
  if (!nodeA || !change.position) return result;

  const aw = nodeA.measured?.width ?? 0;
  const ah = nodeA.measured?.height ?? 0;
  const a = {
    left: change.position.x, right: change.position.x + aw,
    top: change.position.y, bottom: change.position.y + ah,
  };
  let vDist = distance;
  let hDist = distance;

  for (const nodeB of nodes) {
    if (nodeB.id === nodeA.id) continue;
    const bw = nodeB.measured?.width ?? 0;
    const bh = nodeB.measured?.height ?? 0;
    const b = {
      left: nodeB.position.x, right: nodeB.position.x + bw,
      top: nodeB.position.y, bottom: nodeB.position.y + bh,
    };

    // Vertical guides (align x)
    if (Math.abs(a.left - b.left) < vDist) { result.snapPosition.x = b.left; result.vertical = b.left; vDist = Math.abs(a.left - b.left); }
    if (Math.abs(a.right - b.right) < vDist) { result.snapPosition.x = b.right - aw; result.vertical = b.right; vDist = Math.abs(a.right - b.right); }
    if (Math.abs(a.left - b.right) < vDist) { result.snapPosition.x = b.right; result.vertical = b.right; vDist = Math.abs(a.left - b.right); }
    if (Math.abs(a.right - b.left) < vDist) { result.snapPosition.x = b.left - aw; result.vertical = b.left; vDist = Math.abs(a.right - b.left); }

    // Horizontal guides (align y)
    if (Math.abs(a.top - b.top) < hDist) { result.snapPosition.y = b.top; result.horizontal = b.top; hDist = Math.abs(a.top - b.top); }
    if (Math.abs(a.bottom - b.bottom) < hDist) { result.snapPosition.y = b.bottom - ah; result.horizontal = b.bottom; hDist = Math.abs(a.bottom - b.bottom); }
    if (Math.abs(a.top - b.bottom) < hDist) { result.snapPosition.y = b.bottom; result.horizontal = b.bottom; hDist = Math.abs(a.top - b.bottom); }
    if (Math.abs(a.bottom - b.top) < hDist) { result.snapPosition.y = b.top - ah; result.horizontal = b.top; hDist = Math.abs(a.bottom - b.top); }
  }

  return result;
}

/** Canvas overlay that draws the active alignment guide lines. Render INSIDE <ReactFlow>. */
export function HelperLines({ horizontal, vertical }: { horizontal?: number; vertical?: number }) {
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const transform = useStore((s) => s.transform);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpi = window.devicePixelRatio || 1;
    canvas.width = width * dpi;
    canvas.height = height * dpi;
    ctx.scale(dpi, dpi);
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = '#7B5EA7';
    ctx.lineWidth = 1;
    const [tx, ty, scale] = transform;
    if (typeof vertical === 'number') {
      ctx.beginPath();
      ctx.moveTo(vertical * scale + tx, 0);
      ctx.lineTo(vertical * scale + tx, height);
      ctx.stroke();
    }
    if (typeof horizontal === 'number') {
      ctx.beginPath();
      ctx.moveTo(0, horizontal * scale + ty);
      ctx.lineTo(width, horizontal * scale + ty);
      ctx.stroke();
    }
  }, [width, height, transform, horizontal, vertical]);

  return <canvas ref={canvasRef} className="absolute top-0 left-0 pointer-events-none z-10" style={{ width: '100%', height: '100%' }} />;
}
