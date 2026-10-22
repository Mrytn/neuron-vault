import { useEffect, useMemo, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { GraphEdge } from './types';
import type { GraphPoint } from './graph-model';

export type GraphCanvasProps = {
  points: GraphPoint[]; edges: GraphEdge[]; active: string | null; rotating: boolean;
  zoom: number; resetKey: number; onHover: (id: string | null) => void;
  onOpen: (id: string) => void; onSelect?: (id: string | null) => void;
  onZoom: (factor: number) => void; onInteract?: () => void;
};
type Pixel = { point: GraphPoint; sx: number; sy: number; radius: number; depth: number; light: number; scale: number; label?: { text: string; width: number } };
type Gesture = { id: number; x: number; y: number; startX: number; startY: number; dragged: boolean };
type Box = { left: number; top: number; right: number; bottom: number };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const zoomValue = (value: number) => Number.isFinite(value) ? clamp(value, .2, 5) : 1;
const coord = (value: number) => Number.isFinite(value) ? value : 0;
const CELL = 64;
function sceneFor(points: GraphPoint[], edges: GraphEdge[]) {
  const pixels: Pixel[] = points.map(point => ({ point, sx: 0, sy: 0, radius: 0, depth: 0, light: 0, scale: 0 }));
  const byId = new Map(pixels.map(pixel => [pixel.point.node.id, pixel]));
  const neighbors = new Map<string, Set<string>>();
  const segments = edges.flatMap(edge => {
    const a = byId.get(edge.source), b = byId.get(edge.target); if (!a || !b) return [];
    if (!neighbors.has(edge.source)) neighbors.set(edge.source, new Set());
    if (!neighbors.has(edge.target)) neighbors.set(edge.target, new Set());
    neighbors.get(edge.source)!.add(edge.target); neighbors.get(edge.target)!.add(edge.source);
    return [{ edge, a, b }];
  });
  let radius = 0;
  for (const { point } of pixels) radius = Math.max(radius, Math.hypot(coord(point.x), coord(point.y), coord(point.z)));
  return { pixels, order: pixels.slice(), byId, segments, neighbors, radius };
}

export default function GraphCanvas(props: GraphCanvasProps) {
  const canvas = useRef<HTMLCanvasElement>(null), draw = useRef(() => {});
  const motion = useRef({ rx: -.14, ry: .35, zoom: zoomValue(props.zoom) });
  const projected = useRef<Pixel[]>([]), hover = useRef<string | null>(null);
  const pointer = useRef<Gesture | null>(null), lastGestureDragged = useRef(false);
  const scene = useMemo(() => sceneFor(props.points, props.edges), [props.points, props.edges]);
  const latest = useRef({ props, scene }); latest.current = { props, scene };
  useEffect(() => { motion.current.zoom = zoomValue(props.zoom); draw.current(); }, [props.zoom]);
  useEffect(() => { motion.current.rx = -.14; motion.current.ry = .35; draw.current(); }, [props.resetKey]);
  useEffect(() => { draw.current(); }, [scene, props.active, props.rotating]);

  useEffect(() => {
    const el = canvas.current, container = el?.parentElement; if (!el || !container) return;
    const context = el.getContext('2d'); if (!context) return; const ctx = context;
    let frame = 0, timer: ReturnType<typeof setTimeout> | undefined, w = 0, h = 0, dpr = 1, last = 0, disposed = false;
    const stopTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    function requestDraw() {
      stopTimer();
      if (!disposed && !frame && !document.hidden) frame = requestAnimationFrame(render);
    }
    function render(time: number) {
      frame = 0; stopTimer(); if (disposed || document.hidden || w <= 0 || h <= 0) { last = 0; return; }
      const { props: current, scene: view } = latest.current;
      const moving = current.rotating && view.pixels.length > 1 && !pointer.current;
      if (moving) motion.current.ry += Math.min(50, last ? Math.max(0, time - last) : 33) * .00014;
      last = moving ? time : 0;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = 1; ctx.fillStyle = '#373E4B'; ctx.fillRect(0, 0, w, h);
      // Perspective fits the full spatial volume, not just its unrotated x/y bounds.
      const volume = Math.max(110, view.radius), camera = Math.max(440, volume * 1.7);
      const silhouette = volume * camera / Math.sqrt(camera * camera - volume * volume);
      const world = Math.min(2.2, Math.min(w, h) * .40 / silhouette) * motion.current.zoom;
      const cx = w * .5, cy = h * .49, { rx, ry } = motion.current;
      const cosa = Math.cos(ry), sina = Math.sin(ry), cosb = Math.cos(rx), sinb = Math.sin(rx);
      for (const pixel of view.pixels) {
        const p = pixel.point, px = coord(p.x), py = coord(p.y), pz = coord(p.z);
        const x = px * cosa + pz * sina, z0 = -px * sina + pz * cosa;
        const y = py * cosb - z0 * sinb, z = py * sinb + z0 * cosb;
        const scale = camera / (camera - z);
        pixel.sx = cx + x * scale * world; pixel.sy = cy + y * scale * world;
        pixel.depth = z; pixel.scale = scale * world;
        pixel.light = .28 + .72 * clamp((z / volume + 1) / 2, 0, 1);
        const degree = Number.isFinite(p.degree) ? Math.max(0, p.degree) : 0;
        pixel.radius = clamp((3.8 + Math.log2(degree + 1) * .72) * pixel.scale, 1.25, 19);
      }
      view.order.sort((a, b) => a.depth - b.depth); projected.current = view.order;
      const focus = new Set<string>();
      if (current.active && view.byId.has(current.active)) focus.add(current.active);
      if (hover.current && view.byId.has(hover.current)) focus.add(hover.current);
      const related = new Set(focus);
      for (const id of focus) for (const neighbor of view.neighbors.get(id) || []) related.add(neighbor);
      // Only supplied relationships are drawn; depth attenuates distant lines.
      for (const { edge, a, b } of view.segments) {
        const emphasized = focus.has(edge.source) || focus.has(edge.target);
        const light = (a.light + b.light) / 2;
        ctx.globalAlpha = (emphasized ? .8 : focus.size ? .045 : .27) * light;
        ctx.strokeStyle = emphasized ? '#1D71F6' : '#ABB2BF';
        ctx.lineWidth = emphasized ? 1.4 : .65;
        ctx.setLineDash(edge.type === 'tag' ? [2, 4] : []);
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      }
      ctx.setLineDash([]);
      for (const pixel of view.order) {
        const { sx, sy, radius: r } = pixel, id = pixel.point.node.id;
        if (sx + r < 0 || sy + r < 0 || sx - r > w || sy - r > h) continue;
        const focused = focus.has(id), connected = related.has(id), faded = focus.size > 0 && !connected;
        ctx.globalAlpha = pixel.light * (faded ? .18 : 1);
        const color = focused ? '#1D71F6' : connected ? '#91BAFF' : pixel.point.color;
        // Glow belongs to a real node, and only foreground/focused nodes receive it.
        if (focused || !faded && pixel.light > .76 && r > 3) {
          const glow = ctx.createRadialGradient(sx, sy, r * .7, sx, sy, r * 3.4);
          glow.addColorStop(0, focused ? '#1D71F650' : '#91BAFF22'); glow.addColorStop(1, '#91BAFF00');
          ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(sx, sy, r * 3.4, 0, Math.PI * 2); ctx.fill();
        }
        const sphere = ctx.createRadialGradient(sx - r * .32, sy - r * .36, r * .07, sx, sy, r);
        sphere.addColorStop(0, focused ? '#C8DFFF' : '#E9EFF7');
        sphere.addColorStop(.3, color); sphere.addColorStop(1, focused ? '#10428F' : '#596577');
        ctx.fillStyle = sphere; ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
        if (focused) { ctx.strokeStyle = '#1D71F6'; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.arc(sx, sy, r + 4, 0, Math.PI * 2); ctx.stroke(); }
      }
      // A screen-space grid avoids all-pairs label collision checks.
      const cells = new Map<string, Box[]>();
      const keys = (box: Box) => {
        const result: string[] = [];
        for (let y = Math.floor(box.top / CELL); y <= Math.floor(box.bottom / CELL); y++)
          for (let x = Math.floor(box.left / CELL); x <= Math.floor(box.right / CELL); x++) result.push(`${x},${y}`);
        return result;
      };
      const labels = view.order.slice().sort((a, b) => {
        const priority = (p: Pixel) => p.point.node.id === current.active ? 3 : focus.has(p.point.node.id) ? 2 : related.has(p.point.node.id) ? 1 : 0;
        return priority(b) - priority(a) || b.depth - a.depth || b.point.degree - a.point.degree;
      });
      const budget = view.pixels.length <= 40 ? 40 : Math.round(clamp(30 * Math.sqrt(motion.current.zoom), 10, 70));
      let count = 0; ctx.font = '500 11px Inter, "Noto Sans SC", sans-serif'; ctx.textAlign = 'center';
      for (const pixel of labels) {
        if (count >= budget) break;
        const id = pixel.point.node.id, focused = focus.has(id);
        if (!focused && (focus.size ? !related.has(id) : view.pixels.length > 40 && pixel.light < .58)) continue;
        if (!pixel.label) {
          let text = Array.from(pixel.point.node.title).slice(0, 36).join('');
          if (text !== pixel.point.node.title) text += '…';
          while (text.length > 1 && ctx.measureText(text).width > 190) text = Array.from(text).slice(0, -2).join('') + '…';
          pixel.label = { text, width: ctx.measureText(text).width };
        }
        const { text, width } = pixel.label;
        const box = { left: pixel.sx - width / 2 - 5, right: pixel.sx + width / 2 + 5, top: pixel.sy + pixel.radius + 5, bottom: pixel.sy + pixel.radius + 23 };
        if (box.left < 0 || box.right > w || box.top < 0 || box.bottom > h) continue;
        const buckets = keys(box);
        if (buckets.some(key => cells.get(key)?.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top))) continue;
        for (const key of buckets) { if (!cells.has(key)) cells.set(key, []); cells.get(key)!.push(box); }
        ctx.globalAlpha = focused ? 1 : Math.max(.55, pixel.light);
        ctx.fillStyle = '#373E4BE6'; ctx.fillRect(box.left, box.top, box.right - box.left, 18);
        ctx.fillStyle = '#ABB2BF'; ctx.fillText(text, pixel.sx, box.top + 13); count++;
      }
      ctx.globalAlpha = 1;
      // No frame loop while paused. The timer caps automatic rotation near 30 fps.
      if (moving) timer = setTimeout(() => { timer = undefined; requestDraw(); }, 33);
    }
    function resize() {
      const rect = container!.getBoundingClientRect(); w = Math.max(0, rect.width); h = Math.max(0, rect.height);
      dpr = clamp(window.devicePixelRatio || 1, 1, 2);
      el!.width = Math.max(1, Math.round(w * dpr)); el!.height = Math.max(1, Math.round(h * dpr));
      el!.style.width = `${w}px`; el!.style.height = `${h}px`; requestDraw();
    }
    function wheel(event: WheelEvent) {
      event.preventDefault();
      if (!Number.isFinite(event.deltaY) || event.deltaY === 0 || pointer.current || w <= 0 || h <= 0) return;
      latest.current.props.onInteract?.();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? h : 1);
      const before = motion.current.zoom, after = zoomValue(before * Math.exp(clamp(-delta * .0015, -1, 1)));
      if (after !== before) { motion.current.zoom = after; latest.current.props.onZoom(after / before); requestDraw(); }
    }
    function visibility() {
      stopTimer(); last = 0;
      if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else requestDraw();
    }
    const observer = new ResizeObserver(resize); observer.observe(container);
    el.addEventListener?.('wheel', wheel, { passive: false });
    window.addEventListener('resize', resize); document.addEventListener('visibilitychange', visibility);
    draw.current = requestDraw; resize();
    return () => {
      disposed = true; cancelAnimationFrame(frame); stopTimer(); observer.disconnect();
      el.removeEventListener?.('wheel', wheel); window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', visibility);
      if (pointer.current) { try { el.releasePointerCapture?.(pointer.current.id); } catch { /* Capture may already be lost. */ } }
      draw.current = () => {}; projected.current = []; pointer.current = null;
    };
  }, []);

  function pick(x: number, y: number) {
    // Actual visible sphere hits win before forgiving hit areas; within either pass
    // walk front-to-back so a covered rear node cannot steal the front node's click.
    for (const padded of [false, true]) for (let i = projected.current.length - 1; i >= 0; i--) {
      const pixel = projected.current[i], radius = padded ? Math.max(8, pixel.radius + 3) : pixel.radius;
      if (Math.hypot(pixel.sx - x, pixel.sy - y) <= radius) return pixel.point.node.id;
    }
    return null;
  }
  function coords(e: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }) {
    const rect = e.currentTarget.getBoundingClientRect(); return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function setHover(id: string | null) { if (hover.current !== id) { hover.current = id; latest.current.props.onHover(id); draw.current(); } }
  function release(e: ReactPointerEvent<HTMLCanvasElement>) {
    const gesture = pointer.current; if (!gesture || e.pointerId !== undefined && e.pointerId !== gesture.id) return null;
    pointer.current = null; try { e.currentTarget.releasePointerCapture?.(gesture.id); } catch { /* Browser may release it on cancel. */ }
    e.currentTarget.style.cursor = 'grab'; draw.current(); return gesture;
  }
  return <canvas ref={canvas} tabIndex={0} style={{ display: 'block', touchAction: 'none', cursor: 'grab' }}
    aria-label="三维知识图谱：拖动旋转，滚轮缩放，单击选择，双击打开。也可通过下方节点列表打开笔记。"
    onPointerDown={e => {
      if (e.button !== undefined && e.button !== 0 || pointer.current) return;
      const c = coords(e); pointer.current = { ...c, startX: c.x, startY: c.y, id: e.pointerId, dragged: false };
      lastGestureDragged.current = false; try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* Detached pointer. */ }
      e.currentTarget.style.cursor = 'grabbing'; draw.current();
    }}
    onPointerMove={e => {
      const c = coords(e), gesture = pointer.current;
      if (gesture) {
        if (e.pointerId !== undefined && e.pointerId !== gesture.id) return;
        if (!gesture.dragged && Math.hypot(c.x - gesture.startX, c.y - gesture.startY) > 4) {
          gesture.dragged = true; lastGestureDragged.current = true; latest.current.props.onInteract?.();
        }
        if (gesture.dragged) {
          motion.current.ry += (c.x - gesture.x) * .006;
          motion.current.rx = clamp(motion.current.rx + (c.y - gesture.y) * .006, -1.45, 1.45); draw.current();
        }
        gesture.x = c.x; gesture.y = c.y;
      } else { const id = pick(c.x, c.y); setHover(id); e.currentTarget.style.cursor = id ? 'pointer' : 'grab'; }
    }}
    onPointerUp={e => {
      const gesture = release(e); if (!gesture || gesture.dragged) return;
      const c = coords(e), id = pick(c.x, c.y), current = latest.current.props; current.onInteract?.();
      if (current.onSelect) current.onSelect(id); else if (id) current.onOpen(id);
    }}
    onDoubleClick={e => {
      const current = latest.current.props; if (!current.onSelect || lastGestureDragged.current) return;
      const c = coords(e), id = pick(c.x, c.y); if (id) { current.onInteract?.(); current.onOpen(id); }
    }}
    onPointerCancel={e => { if (release(e)) { lastGestureDragged.current = true; setHover(null); } }}
    onLostPointerCapture={e => { if (pointer.current?.id === e.pointerId) { pointer.current = null; lastGestureDragged.current = true; draw.current(); } }}
    onPointerLeave={() => { if (!pointer.current) setHover(null); }}
    onKeyDown={e => {
      const current = latest.current.props;
      if (e.key === 'Escape' && current.onSelect) { current.onInteract?.(); current.onSelect(null); setHover(null); }
      if (e.key === 'Enter' && current.active) { current.onInteract?.(); current.onOpen(current.active); }
    }} />;
}
