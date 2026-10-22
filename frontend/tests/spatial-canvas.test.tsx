import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import GraphCanvas, { type GraphCanvasProps } from '../src/GraphCanvas';
import type { GraphPoint } from '../src/graph-model';

// A synthetic Canvas recorder, never the user's notes or a browser session.
type Sphere = { x: number; y: number; radius: number; alpha: number; color: string };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function point(id: string, x: number, y: number, z: number): GraphPoint {
  return { node: { id, title: `Synthetic ${id}`, group: '', tags: [] }, x, y, z, degree: 1, color: '#ABB2BF' };
}
// Inverse of the initial camera: these two genuine points overlap in projection.
const onViewAxis = (id: string, z: number) => point(id, -Math.sin(.35) * Math.cos(-.14) * z, Math.sin(-.14) * z, Math.cos(.35) * Math.cos(-.14) * z);
const sample = [{ ...onViewAxis('far', -160), color:'#53d2c2' }, { ...onViewAxis('near', 160), color:'#1D71F6' }];
function environment(width = 800, height = 600) {
  const keys = ['window', 'document', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'];
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const frames = new Map<number, FrameRequestCallback>(), timers = new Map<number, { callback: () => void; delay: number }>();
  const listeners = new Map<string, { callback: (event: any) => void; options?: any }>();
  const windowListeners = new Map<string, () => void>(), documentListeners = new Map<string, () => void>();
  const captured = new Set<number>(), released: number[] = [];
  let sequence = 0, disconnected = 0, spheres: Sphere[] = [], labels: string[] = [];
  let dimensions = { width, height }, resizeCallback: (() => void) | undefined, arc: Omit<Sphere, 'alpha' | 'color'> | undefined;
  const context: any = {
    globalAlpha: 1, fillStyle: '', font: '', setTransform() {}, fillRect() {}, clearRect() { spheres = []; labels = []; },
    beginPath() { arc = undefined; }, arc(x: number, y: number, radius: number) { assert.ok([x, y, radius].every(Number.isFinite)); arc = { x, y, radius }; },
    createRadialGradient() { const stops = new Map<number, string>(); return { stops, addColorStop(offset: number, value: string) { stops.set(offset, value); } }; },
    fill() { if (arc && context.fillStyle?.stops?.has(.3)) spheres.push({ ...arc, alpha: context.globalAlpha, color:context.fillStyle.stops.get(.3) }); },
    stroke() {}, moveTo() {}, lineTo() {}, setLineDash() {}, measureText(text: string) { return { width: Array.from(text).length * 6 }; }, fillText(text: string) { labels.push(text); },
  };
  const element: any = {
    parentElement: { getBoundingClientRect: () => ({ ...dimensions }) }, getContext: () => context, style: {}, width: 0, height: 0,
    getBoundingClientRect: () => ({ left: 20, top: 30, ...dimensions }),
    setPointerCapture(id: number) { captured.add(id); }, releasePointerCapture(id: number) { captured.delete(id); released.push(id); },
    addEventListener(name: string, callback: (event: any) => void, options?: any) { listeners.set(name, { callback, options }); },
    removeEventListener(name: string, callback: (event: any) => void) { if (listeners.get(name)?.callback === callback) listeners.delete(name); },
  };
  const document = { hidden: false, addEventListener(name: string, callback: () => void) { documentListeners.set(name, callback); }, removeEventListener(name: string) { documentListeners.delete(name); } };
  const window = { devicePixelRatio: 3, addEventListener(name: string, callback: () => void) { windowListeners.set(name, callback); }, removeEventListener(name: string) { windowListeners.delete(name); } };
  const globals: Record<string, unknown> = {
    document, window, ResizeObserver: class { constructor(callback: () => void) { resizeCallback = callback; } observe() {} disconnect() { disconnected++; } },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; }, cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: (callback: () => void, delay: number) => { timers.set(++sequence, { callback, delay }); return sequence; }, clearTimeout: (id: number) => timers.delete(id),
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return {
    element, frames, timers, listeners, windowListeners, documentListeners, document, captured, released,
    get spheres() { return spheres; }, get labels() { return labels; }, get disconnected() { return disconnected; },
    flush(time = 16) { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(time)); },
    elapse() { const pending = [...timers.values()]; timers.clear(); pending.forEach(({ callback }) => callback()); },
    resize(width: number, height: number) { dimensions = { width, height }; resizeCallback?.(); },
    event(x: number, y: number, extra: Record<string, unknown> = {}) { return { clientX: x + 20, clientY: y + 30, pointerId: 1, button: 0, currentTarget: element, ...extra }; },
    restore() { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key]; } },
  };
}
async function mount(options: Partial<GraphCanvasProps> = {}, dimensions = [800, 600]) {
  const env = environment(...dimensions), selected: (string | null)[] = [], opened: string[] = [], zoomed: number[] = [];
  let interactions = 0, app!: ReactTestRenderer, unmounted = false;
  let props: GraphCanvasProps = { points: sample, edges: [], active: null, rotating: false, zoom: 1, resetKey: 0, onHover() {},
    onSelect: id => selected.push(id), onOpen: id => opened.push(id), onZoom: factor => zoomed.push(factor), onInteract: () => { interactions++; }, ...options };
  cleanups.push(async () => { try { if (!unmounted) await act(async () => app?.unmount()); } finally { env.restore(); } });
  await act(async () => { app = create(<GraphCanvas {...props} />, { createNodeMock: node => node.type === 'canvas' ? env.element : null }); });
  return { env, selected, opened, zoomed, get interactions() { return interactions; }, get canvas() { return app.root.findByType('canvas'); },
    async update(next: Partial<GraphCanvasProps>) { props = { ...props, ...next }; await act(async () => app.update(<GraphCanvas {...props} />)); },
    async unmount() { await act(async () => app.unmount()); unmounted = true; },
  };
}
function samePosition(a: Sphere, b: Sphere) { assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < .001); }

test('3D depth makes near spheres larger/brighter; drag changes perspective and selection preserves that camera', async () => {
  const app = await mount(); app.env.flush(); const [far, near] = app.env.spheres.map(s => ({ ...s }));
  assert.equal(app.env.spheres.length, 2, 'No decorative points may masquerade as notes');
  assert.equal(far.color,sample[0].color);assert.equal(near.color,sample[1].color,'Group colors must match the legend before selection');
  assert.ok(near.radius > far.radius * 1.8); assert.ok(near.alpha > far.alpha * 1.8); samePosition(near, far);
  assert.equal(app.interactions, 0);
  await act(async () => { app.canvas.props.onPointerDown(app.env.event(4, 4)); app.canvas.props.onPointerMove(app.env.event(84, 34)); app.canvas.props.onPointerUp(app.env.event(84, 34)); });
  app.env.flush(); const dragged = app.env.spheres.map(s => ({ ...s }));
  assert.ok(Math.abs(dragged[0].x - dragged[1].x) > 20, 'Different depths must exhibit rotational parallax'); assert.equal(app.interactions, 1);
  await act(async () => app.canvas.props.onPointerMove(app.env.event(dragged[1].x, dragged[1].y)));
  await app.update({ active: 'near', onHover() {} }); app.env.flush();
  samePosition(app.env.spheres[0], dragged[0]); samePosition(app.env.spheres[1], dragged[1]); assert.equal(app.interactions, 1);
  await app.update({ resetKey: 1 }); app.env.flush(); samePosition(app.env.spheres[1], near);
});

test('3D idle graphs do not loop; rotation is throttled and visibility/unmount clear timers and listeners', async () => {
  const app = await mount(); app.env.flush(); assert.equal(app.env.frames.size, 0); assert.equal(app.env.timers.size, 0); assert.equal(app.env.element.width, 1600);
  await app.update({ rotating: true }); app.env.flush(); assert.equal(app.env.frames.size, 0); assert.equal(app.env.timers.size, 1); assert.ok([...app.env.timers.values()][0].delay >= 30);
  const before = { ...app.env.spheres[1] }; app.env.elapse(); assert.equal(app.env.frames.size, 1); app.env.flush(60); assert.notEqual(app.env.spheres[1].x, before.x);
  app.env.document.hidden = true; app.env.documentListeners.get('visibilitychange')!(); assert.equal(app.env.frames.size, 0); assert.equal(app.env.timers.size, 0);
  app.env.document.hidden = false; app.env.documentListeners.get('visibilitychange')!(); app.env.flush(120); assert.equal(app.env.timers.size, 1);
  await app.update({ rotating: false }); app.env.flush(); assert.equal(app.env.frames.size, 0); assert.equal(app.env.timers.size, 0);
  await act(async () => app.canvas.props.onPointerDown(app.env.event(4, 4))); assert.equal(app.env.captured.size, 1);
  await app.unmount(); assert.equal(app.env.frames.size, 0); assert.equal(app.env.timers.size, 0); assert.equal(app.env.captured.size, 0);
  assert.equal(app.env.listeners.size, 0); assert.equal(app.env.windowListeners.size, 0); assert.equal(app.env.documentListeners.size, 0); assert.equal(app.env.disconnected, 1);
});

test('3D native wheel prevents document scrolling, reports real interaction and respects zoom limits', async () => {
  const app = await mount(); app.env.flush(); const wheel = app.env.listeners.get('wheel'); assert.ok(wheel); assert.equal(wheel.options.passive, false);
  let prevented = 0; const event = (deltaY: number) => ({ deltaY, deltaMode: 0, preventDefault() { prevented++; } });
  wheel.callback(event(0)); assert.equal(prevented, 1); assert.equal(app.interactions, 0);
  wheel.callback(event(-120)); assert.equal(prevented, 2); assert.equal(app.interactions, 1); assert.ok(app.zoomed[0] > 1);
  await app.update({ zoom: 5 }); app.env.flush(); wheel.callback(event(-120)); assert.equal(prevented, 3); assert.equal(app.zoomed.length, 1);
});

test('3D overlapping spheres pick the front one; drag/cancel cannot open and legacy callers only single-click', async () => {
  const app = await mount(); app.env.flush(); const target = app.env.spheres.at(-1)!;
  await act(async () => { app.canvas.props.onPointerDown(app.env.event(target.x, target.y)); app.canvas.props.onPointerUp(app.env.event(target.x, target.y)); });
  assert.deepEqual(app.selected, ['near']); assert.deepEqual(app.opened, []);
  await act(async () => app.canvas.props.onDoubleClick(app.env.event(target.x, target.y))); assert.deepEqual(app.opened, ['near']);
  await act(async () => { app.canvas.props.onPointerDown(app.env.event(4, 4)); app.canvas.props.onPointerMove(app.env.event(50, 50)); app.canvas.props.onPointerUp(app.env.event(50, 50)); app.canvas.props.onDoubleClick(app.env.event(target.x, target.y)); });
  assert.deepEqual(app.opened, ['near']); assert.deepEqual(app.selected, ['near']);
  await act(async () => { app.canvas.props.onPointerDown(app.env.event(4, 4)); app.canvas.props.onPointerCancel(app.env.event(4, 4)); app.canvas.props.onPointerUp(app.env.event(target.x, target.y)); });
  assert.deepEqual(app.selected, ['near']); assert.equal(app.env.captured.size, 0);
  await app.update({ resetKey: 1, onSelect: undefined }); app.env.flush(); const reset = app.env.spheres.at(-1)!;
  await act(async () => { app.canvas.props.onPointerDown(app.env.event(reset.x, reset.y)); app.canvas.props.onPointerUp(app.env.event(reset.x, reset.y)); app.canvas.props.onDoubleClick(app.env.event(reset.x, reset.y)); });
  assert.deepEqual(app.opened, ['near', 'near']);
});

test('3D renders all 1200 synthetic nodes with bounded labels; single/empty/zero-size views do not animate', async () => {
  const points = Array.from({ length: 1200 }, (_, i) => { const angle = i * 2.399, z = (i / 1199 * 2 - 1) * 200, radius = Math.sqrt(40000 - z * z); return point(String(i), Math.cos(angle) * radius, Math.sin(angle) * radius, z); });
  const app = await mount({ points }); app.env.flush(); assert.equal(app.env.spheres.length, 1200); assert.ok(app.env.labels.length > 0 && app.env.labels.length <= 30);
  await app.update({ points: [point('single', 0, 0, 0)], rotating: true }); app.env.flush(); assert.equal(app.env.spheres.length, 1); assert.equal(app.env.timers.size, 0);
  await app.update({ points: [] }); app.env.flush(); assert.equal(app.env.spheres.length, 0); assert.equal(app.env.timers.size, 0);
  app.env.resize(0, 0); await app.update({ points: sample }); app.env.flush(); assert.equal(app.env.frames.size, 0); assert.equal(app.env.timers.size, 0);
  app.env.resize(800, 600); app.env.flush(); assert.equal(app.env.spheres.length, 2); assert.equal(app.env.timers.size, 1);
});
