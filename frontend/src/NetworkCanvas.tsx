import { useEffect, useMemo, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { GraphPoint } from './graph-model';
import type { GraphEdge } from './types';

export type NetworkCanvasProps = {
  points: GraphPoint[]; edges: GraphEdge[]; active: string | null; zoom: number; resetKey: number;
  onHover: (id: string | null) => void; onSelect: (id: string | null) => void;
  onOpen: (id: string) => void; onZoom: (factor: number) => void;
};
type Label = { text: string; width: number };
type Pixel = { point: GraphPoint; sx: number; sy: number; radius: number; labels: Map<boolean, Label> };
type Segment = { edge: GraphEdge; a: Pixel; b: Pixel };
type Rect = { left: number; top: number; right: number; bottom: number };
type Gesture = { id: number; node: string | null; startX: number; startY: number; lastX: number; lastY: number; nodeX: number; nodeY: number; dragged: boolean };
const CELL = 64;
const clampZoom = (value: number) => Number.isFinite(value) ? Math.max(.2, Math.min(5, value)) : 1;
const finite = (value: number) => Number.isFinite(value) ? value : 0;
const cellKey = (x: number, y: number) => `${x},${y}`;
function makeScene(points: GraphPoint[], edges: GraphEdge[]) {
  const pixels: Pixel[] = points.map(point => ({ point, sx: 0, sy: 0, radius: 4, labels: new Map() }));
  const byId = new Map(pixels.map(pixel => [pixel.point.node.id, pixel]));
  const neighbors = new Map<string, Set<string>>(), links: Segment[] = [], tags: Segment[] = [];
  for (const edge of edges) {
    const a = byId.get(edge.source), b = byId.get(edge.target); if (!a || !b) continue;
    (edge.type === 'tag' ? tags : links).push({ edge, a, b });
    if (!neighbors.has(edge.source)) neighbors.set(edge.source, new Set());
    if (!neighbors.has(edge.target)) neighbors.set(edge.target, new Set());
    neighbors.get(edge.source)!.add(edge.target); neighbors.get(edge.target)!.add(edge.source);
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) { const x = finite(point.x), y = finite(point.y); minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  if (!points.length) minX = minY = maxX = maxY = 0;
  return { pixels, byId, neighbors, links, tags,
    labelOrder: pixels.slice().sort((a, b) => b.point.degree - a.point.degree || a.point.node.id.localeCompare(b.point.node.id)),
    centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2, spanX: maxX - minX, spanY: maxY - minY };
}

/** The layout owns positions; this component draws only on invalidation, never on an idle animation loop. */
export default function NetworkCanvas(props: NetworkCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useMemo(() => makeScene(props.points, props.edges), [props.points, props.edges]);
  const current = useRef({ ...props, scene }); current.current = { ...props, scene };
  const camera = useRef({ panX: 0, panY: 0, zoom: clampZoom(props.zoom) });
  const viewport = useRef({ width: 0, height: 0, fit: 1 });
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const hitCells = useRef(new Map<string, Pixel[]>()), hovered = useRef<string | null>(null);
  const gesture = useRef<Gesture | null>(null), lastGestureDragged = useRef(false), requestDraw = useRef(() => {});
  function setHover(id: string | null) { if (id !== hovered.current) { hovered.current = id; current.current.onHover(id); requestDraw.current(); } }
  function cancelGesture() {
    const pointer = gesture.current; gesture.current = null;
    if (pointer && canvas.current) { try { canvas.current.releasePointerCapture(pointer.id); } catch { /* Already released or detached. */ } }
    if (canvas.current) canvas.current.style.cursor = 'grab';
  }
  useEffect(() => {
    const next = clampZoom(props.zoom), previous = camera.current.zoom;
    if (next !== previous) { const factor = next / previous; camera.current.panX *= factor; camera.current.panY *= factor; camera.current.zoom = next; requestDraw.current(); }
  }, [props.zoom]);
  useEffect(() => {
    camera.current.panX = camera.current.panY = 0; positions.current.clear(); hitCells.current.clear(); cancelGesture(); setHover(null); requestDraw.current();
  }, [props.points, props.resetKey]);
  useEffect(() => { requestDraw.current(); }, [scene, props.active]);

  useEffect(() => {
    const element = canvas.current, container = element?.parentElement; if (!element || !container) return;
    const context = element.getContext('2d'); if (!context) return;
    const ctx = context; let frame: number | null = null, disposed = false, dpr = 1;
    function schedule() { if (!disposed && frame === null && !document.hidden) frame = requestAnimationFrame(render); }
    function render() {
      frame = null; if (disposed || document.hidden) return;
      const { width, height } = viewport.current; if (width <= 0 || height <= 0) { hitCells.current.clear(); return; }
      const data = current.current, scene = data.scene, motion = camera.current;
      const margin = Math.min(56, Math.min(width, height) * .18);
      const fit = Math.max(.000001, Math.min(2, Math.max(1, width - margin * 2) / Math.max(1, scene.spanX), Math.max(1, height - margin * 2) / Math.max(1, scene.spanY)));
      viewport.current.fit = fit; const scale = fit * motion.zoom;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height); ctx.globalAlpha = 1; ctx.fillStyle = '#373E4B'; ctx.fillRect(0, 0, width, height);
      const focus = new Set<string>();
      if (data.active && scene.byId.has(data.active)) focus.add(data.active);
      if (hovered.current && scene.byId.has(hovered.current)) focus.add(hovered.current);
      const related = new Set(focus); for (const id of focus) for (const neighbor of scene.neighbors.get(id) || []) related.add(neighbor);
      const cells = new Map<string, Pixel[]>();
      for (const pixel of scene.pixels) {
        const p = pixel.point, position = positions.current.get(p.node.id);
        pixel.sx = width / 2 + motion.panX + ((position?.x ?? finite(p.x)) - scene.centerX) * scale;
        pixel.sy = height / 2 + motion.panY + ((position?.y ?? finite(p.y)) - scene.centerY) * scale;
        pixel.radius = Math.max(2.2, Math.min(13, (3 + Math.log2(1 + Math.max(0, p.degree)) * .85) * Math.sqrt(motion.zoom)));
        if (pixel.sx < -24 || pixel.sy < -24 || pixel.sx > width + 24 || pixel.sy > height + 24) continue;
        const key = cellKey(Math.floor(pixel.sx / CELL), Math.floor(pixel.sy / CELL)); if (!cells.has(key)) cells.set(key, []); cells.get(key)!.push(pixel);
      }
      hitCells.current = cells;
      function segments(items: Segment[], tag: boolean, highlight: boolean) {
        ctx.strokeStyle = highlight ? 'rgba(29,113,246,.85)' : focus.size ? 'rgba(171,178,191,.055)' : 'rgba(171,178,191,.22)';
        ctx.lineWidth = highlight ? 1.25 : .65; ctx.setLineDash(tag ? [2, 4] : []); ctx.beginPath();
        for (const { edge, a, b } of items) {
          if ((focus.has(edge.source) || focus.has(edge.target)) !== highlight) continue;
          if (Math.max(a.sx, b.sx) < 0 || Math.min(a.sx, b.sx) > width || Math.max(a.sy, b.sy) < 0 || Math.min(a.sy, b.sy) > height) continue;
          ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy);
        }
        ctx.stroke();
      }
      segments(scene.links, false, false); segments(scene.tags, true, false);
      if (focus.size) { segments(scene.links, false, true); segments(scene.tags, true, true); } ctx.setLineDash([]);
      for (const pixel of scene.pixels) {
        const { sx, sy, radius, point } = pixel, id = point.node.id;
        if (sx + radius < 0 || sx - radius > width || sy + radius < 0 || sy - radius > height) continue;
        ctx.globalAlpha = focus.size && !related.has(id) ? .2 : 1; ctx.fillStyle = focus.has(id) ? '#1D71F6' : related.has(id) ? '#91BAFF' : '#ABB2BF';
        ctx.beginPath(); ctx.arc(sx, sy, radius, 0, Math.PI * 2); ctx.fill();
        if (focus.has(id)) { ctx.strokeStyle = 'rgba(29,113,246,.42)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(sx, sy, radius + 4, 0, Math.PI * 2); ctx.stroke(); }
      }
      ctx.globalAlpha = 1;
      // Spatial hashing bounds label collision queries to nearby cells; no all-label pair scan.
      const occupied = new Map<string, Rect[]>();
      function cellRange(rect: Rect, visit: (key: string) => void) {
        for (let x = Math.floor(rect.left / CELL); x <= Math.floor(rect.right / CELL); x++) for (let y = Math.floor(rect.top / CELL); y <= Math.floor(rect.bottom / CELL); y++) visit(cellKey(x, y));
      }
      function overlaps(rect: Rect) {
        let collision = false;
        cellRange(rect, key => { for (const other of occupied.get(key) || []) if (rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top) collision = true; }); return collision;
      }
      function measured(pixel: Pixel, emphasized: boolean) {
        const cached = pixel.labels.get(emphasized); if (cached) return cached;
        const chars = Array.from(pixel.point.node.title); let kept = Math.min(chars.length, emphasized ? 42 : 28);
        let text = chars.slice(0, kept).join('') + (kept < chars.length ? '…' : '');
        while (kept > 1 && ctx.measureText(text).width > (emphasized ? 250 : 180)) { kept--; text = chars.slice(0, kept).join('') + '…'; }
        const label = { text, width: ctx.measureText(text).width }; pixel.labels.set(emphasized, label); return label;
      }
      const budget = motion.zoom < .55 ? 8 : motion.zoom < 1 ? 20 : motion.zoom < 1.6 ? 45 : motion.zoom < 2.8 ? 100 : 190;
      let labels = 0; const visited = new Set<string>();
      function label(pixel: Pixel | undefined) {
        if (!pixel || visited.has(pixel.point.node.id)) return;
        const id = pixel.point.node.id; visited.add(id); const emphasized = focus.has(id);
        if (!emphasized && (labels >= budget || focus.size && !related.has(id))) return;
        if (pixel.sx < 0 || pixel.sx > width || pixel.sy < 0 || pixel.sy > height) return;
        ctx.font = `${emphasized ? '500 12' : '400 11'}px Inter, "Noto Sans SC", sans-serif`;
        const text = measured(pixel, emphasized), labelWidth = text.width + 10; let x = pixel.sx - labelWidth / 2, y = pixel.sy + pixel.radius + 6;
        if (y + 18 > height - 4) y = pixel.sy - pixel.radius - 24;
        if (emphasized) x = Math.max(4, Math.min(width - labelWidth - 4, x));
        const rect = { left: x, top: y, right: x + labelWidth, bottom: y + 18 };
        if (rect.left < 4 || rect.top < 4 || rect.right > width - 4 || rect.bottom > height - 4 || overlaps(rect)) return;
        cellRange(rect, key => { if (!occupied.has(key)) occupied.set(key, []); occupied.get(key)!.push(rect); });
        ctx.fillStyle = 'rgba(55,62,75,.9)'; ctx.fillRect(x, y, labelWidth, 18); ctx.fillStyle = '#ABB2BF'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text.text, x + labelWidth / 2, y + 9); labels++;
      }
      // Pinned selection owns the first collision slot; hover follows, then connection degree.
      label(data.active ? scene.byId.get(data.active) : undefined); label(hovered.current ? scene.byId.get(hovered.current) : undefined);
      for (const pixel of scene.labelOrder) label(pixel);
    }
    function resize() {
      if (disposed) return; const rect = container!.getBoundingClientRect();
      const width = Math.max(0, finite(rect.width)), height = Math.max(0, finite(rect.height)); dpr = Math.max(1, Math.min(2, finite(window.devicePixelRatio || 1)));
      viewport.current.width = width; viewport.current.height = height;
      element!.width = Math.max(1, Math.round(width * dpr)); element!.height = Math.max(1, Math.round(height * dpr)); element!.style.width = `${width}px`; element!.style.height = `${height}px`; schedule();
    }
    function wheel(event: WheelEvent) {
      event.preventDefault(); if (gesture.current) return;
      const { width, height } = viewport.current; if (width <= 0 || height <= 0) return;
      const rect = element!.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
      const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1, motion = camera.current;
      const next = clampZoom(motion.zoom * Math.exp(-Math.max(-500, Math.min(500, event.deltaY * units)) * .0015)), factor = next / motion.zoom; if (factor === 1) return;
      // Pointer-anchored wheel zoom; external +/- controls zoom around the viewport center.
      motion.panX = (x - width / 2) * (1 - factor) + motion.panX * factor; motion.panY = (y - height / 2) * (1 - factor) + motion.panY * factor;
      motion.zoom = next; current.current.onZoom(factor); schedule();
    }
    function visibility() { if (document.hidden) { if (frame !== null) cancelAnimationFrame(frame); frame = null; } else schedule(); }
    requestDraw.current = schedule; const observer = new ResizeObserver(resize); observer.observe(container); resize();
    element.addEventListener('wheel', wheel, { passive: false }); window.addEventListener('resize', resize); document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; if (frame !== null) cancelAnimationFrame(frame); observer.disconnect(); element.removeEventListener('wheel', wheel); window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', visibility); requestDraw.current = () => {}; hitCells.current.clear(); gesture.current = null; };
  }, []);

  function coords(event: ReactPointerEvent<HTMLCanvasElement> | ReactMouseEvent<HTMLCanvasElement>) { const rect = event.currentTarget.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
  function pick(x: number, y: number) {
    let found: Pixel | undefined, distance = Infinity;
    for (let gx = Math.floor((x - 20) / CELL); gx <= Math.floor((x + 20) / CELL); gx++) for (let gy = Math.floor((y - 20) / CELL); gy <= Math.floor((y + 20) / CELL); gy++)
      for (const pixel of hitCells.current.get(cellKey(gx, gy)) || []) { const d = Math.hypot(pixel.sx - x, pixel.sy - y); if (d <= Math.max(8, pixel.radius + 4) && d < distance) { found = pixel; distance = d; } }
    return found || null;
  }
  return <canvas ref={canvas} tabIndex={0} style={{ display: 'block', touchAction: 'none', cursor: 'grab' }}
    aria-label="2D 知识关系网：拖动空白平移，拖动节点调整位置，滚轮缩放；单击选择，双击打开笔记。也可用下方节点列表操作。"
    onPointerDown={event => {
      if (event.button !== 0 || gesture.current) return;
      const point = coords(event), pixel = pick(point.x, point.y), position = pixel ? positions.current.get(pixel.point.node.id) : undefined;
      gesture.current = { id: event.pointerId, node: pixel?.point.node.id || null, startX: point.x, startY: point.y, lastX: point.x, lastY: point.y,
        nodeX: position?.x ?? finite(pixel?.point.x ?? 0), nodeY: position?.y ?? finite(pixel?.point.y ?? 0), dragged: false };
      lastGestureDragged.current = false; try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Pointer may already have ended. */ }
      event.currentTarget.style.cursor = 'grabbing'; event.preventDefault();
    }}
    onPointerMove={event => {
      const point = coords(event), pointer = gesture.current;
      if (pointer) {
        if (pointer.id !== event.pointerId) return;
        if (Math.hypot(point.x - pointer.startX, point.y - pointer.startY) > 4) pointer.dragged = true;
        if (pointer.dragged) {
          if (pointer.node) { const scale = Math.max(.000001, viewport.current.fit * camera.current.zoom); positions.current.set(pointer.node, { x: pointer.nodeX + (point.x - pointer.startX) / scale, y: pointer.nodeY + (point.y - pointer.startY) / scale }); }
          else { camera.current.panX += point.x - pointer.lastX; camera.current.panY += point.y - pointer.lastY; }
          requestDraw.current();
        }
        pointer.lastX = point.x; pointer.lastY = point.y;
      } else { const pixel = pick(point.x, point.y); setHover(pixel?.point.node.id || null); event.currentTarget.style.cursor = pixel ? 'pointer' : 'grab'; }
    }}
    onPointerUp={event => {
      const pointer = gesture.current; if (!pointer || pointer.id !== event.pointerId) return;
      const point = coords(event), pixel = pick(point.x, point.y); lastGestureDragged.current = pointer.dragged; cancelGesture();
      if (!pointer.dragged) current.current.onSelect(pixel?.point.node.id || null); setHover(pixel?.point.node.id || null);
    }}
    onPointerCancel={event => { if (gesture.current?.id === event.pointerId) { lastGestureDragged.current = true; cancelGesture(); setHover(null); } }}
    onLostPointerCapture={event => { if (gesture.current?.id === event.pointerId) { gesture.current = null; event.currentTarget.style.cursor = 'grab'; } }}
    onPointerLeave={() => { if (!gesture.current) setHover(null); }}
    onDoubleClick={event => { if (lastGestureDragged.current) return; const point = coords(event), pixel = pick(point.x, point.y); if (pixel) { event.preventDefault(); current.current.onOpen(pixel.point.node.id); } }}
    onKeyDown={event => { if (event.key === 'Escape') { cancelGesture(); setHover(null); current.current.onSelect(null); } if (event.key === 'Enter' && current.current.active) { event.preventDefault(); current.current.onOpen(current.current.active); } }}/>
}
