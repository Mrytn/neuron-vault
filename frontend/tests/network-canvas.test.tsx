import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import NetworkCanvas, { type NetworkCanvasProps } from '../src/NetworkCanvas';
import type { GraphPoint } from '../src/graph-model';

// Synthetic coordinates and a Canvas recorder: no browser, private notes or real network.
type Dot = { x: number; y: number; radius: number; color: string; alpha: number };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const sample: GraphPoint[] = [
  { node: { id: 'A', title: 'Synthetic A', group: '', tags: [] }, x: -100, y: 0, z: 0, degree: 1, color: '#ABB2BF' },
  { node: { id: 'B', title: 'Synthetic B', group: '', tags: [] }, x: 100, y: 0, z: 0, degree: 2, color: '#ABB2BF' },
  { node: { id: 'C', title: 'Synthetic C', group: '', tags: [] }, x: 0, y: 100, z: 0, degree: 1, color: '#ABB2BF' },
];
function environment(width = 800, height = 600) {
  const keys = ['window', 'document', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const frames = new Map<number, FrameRequestCallback>(); let sequence = 0, disconnected = 0;
  const windowListeners = new Map<string, () => void>(), documentListeners = new Map<string, () => void>();
  const listeners = new Map<string, { callback: (event: any) => void; options?: any }>();
  const captured = new Set<number>(), released: number[] = [];
  let dimensions = { width, height }, resizeCallback: (() => void) | undefined;
  let dots: Dot[] = [], labels: string[] = [], arc: { x: number; y: number; radius: number } | undefined;
  const context: any = {
    globalAlpha: 1, fillStyle: '', font: '', strokeStyle: '',
    setTransform() {}, clearRect() { dots = []; labels = []; }, fillRect() {},
    beginPath() { arc = undefined; }, arc(x: number, y: number, radius: number) { assert.ok([x, y, radius].every(Number.isFinite)); arc = { x, y, radius }; },
    fill() { if (arc) dots.push({ ...arc, color: context.fillStyle, alpha: context.globalAlpha }); },
    stroke() {}, setLineDash() {}, moveTo() {}, lineTo() {},
    measureText(value: string) { return { width: Array.from(value).length * 6 }; },
    fillText(value: string) { labels.push(value); },
  };
  const element: any = {
    parentElement: { getBoundingClientRect: () => ({ ...dimensions }) }, getContext: () => context,
    style: {}, width: 0, height: 0, getBoundingClientRect: () => ({ left: 20, top: 30, ...dimensions }),
    setPointerCapture(id: number) { captured.add(id); }, releasePointerCapture(id: number) { captured.delete(id); released.push(id); },
    addEventListener(name: string, callback: (event: any) => void, options?: any) { listeners.set(name, { callback, options }); },
    removeEventListener(name: string, callback: (event: any) => void) { if (listeners.get(name)?.callback === callback) listeners.delete(name); },
  };
  const document = { hidden: false, addEventListener(name: string, callback: () => void) { documentListeners.set(name, callback); }, removeEventListener(name: string) { documentListeners.delete(name); } };
  const window = { innerWidth: width, devicePixelRatio: 3, addEventListener(name: string, callback: () => void) { windowListeners.set(name, callback); }, removeEventListener(name: string) { windowListeners.delete(name); } };
  const globals: Record<string, unknown> = {
    window, document, ResizeObserver: class { constructor(callback: () => void) { resizeCallback = callback; } observe() {} disconnect() { disconnected++; } },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return {
    element, frames, listeners, windowListeners, documentListeners, document, released,
    get dots() { return dots; }, get labels() { return labels; }, get disconnected() { return disconnected; },
    flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(16)); },
    resize(width: number, height: number) { dimensions = { width, height }; resizeCallback?.(); },
    event(x: number, y: number, extra: Record<string, unknown> = {}) { return { clientX: x + 20, clientY: y + 30, pointerId: 1, button: 0, currentTarget: element, preventDefault() {}, ...extra }; },
    restore() { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key]; } },
  };
}
async function mount(points = sample, dimensions = [800, 600]) {
  const env = environment(...dimensions), selected: (string | null)[] = [], hovered: (string | null)[] = [], opened: string[] = [], zoomed: number[] = [];
  let props: NetworkCanvasProps = { points, edges: [{ source: 'A', target: 'B', type: 'link', label: 'real' }], active: null, zoom: 1, resetKey: 0,
    onHover: id => hovered.push(id), onSelect: id => selected.push(id), onOpen: id => opened.push(id), onZoom: factor => zoomed.push(factor) };
  let app!: ReactTestRenderer, unmounted = false;
  cleanups.push(async () => { try { if (!unmounted) await act(async () => app?.unmount()); } finally { env.restore(); } });
  await act(async () => { app = create(<NetworkCanvas {...props} />, { createNodeMock: node => node.type === 'canvas' ? env.element : null }); });
  return { env, selected, hovered, opened, zoomed, get canvas() { return app.root.findByType('canvas'); },
    async update(next: Partial<NetworkCanvasProps>) { props = { ...props, ...next }; await act(async () => app.update(<NetworkCanvas {...props} />)); },
    async unmount() { await act(async () => app.unmount()); unmounted = true; },
  };
}
const samePosition = (actual: Dot, expected: Dot) => { assert.ok(Math.abs(actual.x - expected.x) < .001); assert.ok(Math.abs(actual.y - expected.y) < .001); };

test('2D network draws every synthetic node, then stays idle and cleans pending frames/listeners', async () => {
  const points = Array.from({ length: 1200 }, (_, i) => ({ ...sample[0], node: { ...sample[0].node, id: String(i), title: `Synthetic ${i}` }, x: (i % 40) * 20, y: Math.floor(i / 40) * 20, degree: i % 9 }));
  const app = await mount(points); assert.equal(app.env.frames.size, 1); app.env.flush();
  assert.equal(app.env.dots.length, 1200); assert.equal(app.env.frames.size, 0);
  assert.ok(app.env.dots.every(dot => dot.x >= 0 && dot.x <= 800 && dot.y >= 0 && dot.y <= 600));
  assert.ok(app.env.labels.length > 0 && app.env.labels.length <= 45);
  assert.equal(app.env.element.width, 1600, 'Device pixel ratio must be capped at 2');
  await app.update({ active: '0' }); assert.equal(app.env.frames.size, 1);
  await app.unmount(); assert.equal(app.env.frames.size, 0); assert.equal(app.env.disconnected, 1);
  assert.equal(app.env.listeners.size, 0); assert.equal(app.env.windowListeners.size, 0); assert.equal(app.env.documentListeners.size, 0);
});

test('2D hover and selection updates retain a panned viewport; reset restores its fitted view', async () => {
  const app = await mount(); app.env.flush(); const fitted = app.env.dots.map(dot => ({ ...dot }));
  await act(async () => { app.canvas.props.onPointerDown(app.env.event(4, 4)); app.canvas.props.onPointerMove(app.env.event(64, 39)); app.canvas.props.onPointerUp(app.env.event(64, 39)); });
  app.env.flush(); const panned = app.env.dots.map(dot => ({ ...dot })); assert.notEqual(panned[0].x, fitted[0].x); assert.equal(app.selected.length, 0);
  await act(async () => app.canvas.props.onPointerMove(app.env.event(panned[0].x, panned[0].y)));
  await app.update({ active: 'A', onHover: id => app.hovered.push(id) }); app.env.flush();
  samePosition(app.env.dots[0], panned[0]); assert.equal(app.env.dots[0].color, '#1D71F6'); assert.equal(app.env.dots[1].color, '#91BAFF'); assert.equal(app.env.dots[2].alpha, .2);
  assert.equal(app.env.frames.size, 0);
  await app.update({ resetKey: 1 }); app.env.flush(); samePosition(app.env.dots[0], fitted[0]);
});

test('2D wheel prevents page scroll, respects zoom bounds and anchors the pointed node', async () => {
  const app = await mount(); app.env.flush(); const before = { ...app.env.dots[0] }, wheel = app.env.listeners.get('wheel');
  assert.ok(wheel); assert.equal(wheel.options.passive, false); let prevented = 0;
  await act(async () => wheel.callback(app.env.event(before.x, before.y, { deltaY: -120, deltaMode: 0, preventDefault() { prevented++; } })));
  assert.equal(prevented, 1); assert.equal(app.zoomed.length, 1); assert.ok(app.zoomed[0] > 1);
  await app.update({ zoom: app.zoomed[0] }); app.env.flush(); samePosition(app.env.dots[0], before);
  await app.update({ zoom: 5 }); app.env.flush();
  wheel.callback(app.env.event(400, 300, { deltaY: -120, deltaMode: 0, preventDefault() { prevented++; } }));
  assert.equal(prevented, 2); assert.equal(app.zoomed.length, 1, 'At the zoom ceiling no further zoom callback is needed');
});

test('2D click selects, double click opens, and dragging/cancel never opens a note', async () => {
  const app = await mount(); app.env.flush(); const first = { ...app.env.dots[0] };
  await act(async () => { app.canvas.props.onPointerDown(app.env.event(first.x, first.y)); app.canvas.props.onPointerUp(app.env.event(first.x, first.y)); });
  assert.deepEqual(app.selected, ['A']); assert.deepEqual(app.opened, []);
  await act(async () => app.canvas.props.onDoubleClick(app.env.event(first.x, first.y))); assert.deepEqual(app.opened, ['A']);
  await act(async () => { app.canvas.props.onPointerDown(app.env.event(first.x, first.y)); app.canvas.props.onPointerMove(app.env.event(first.x + 45, first.y + 25)); });
  app.env.flush(); const dragged = { ...app.env.dots[0] }; assert.ok(dragged.x > first.x + 40);
  await act(async () => { app.canvas.props.onPointerUp(app.env.event(dragged.x, dragged.y)); app.canvas.props.onDoubleClick(app.env.event(dragged.x, dragged.y)); });
  assert.deepEqual(app.opened, ['A']); assert.deepEqual(app.selected, ['A']);
  await act(async () => { app.canvas.props.onPointerDown(app.env.event(4, 4)); app.canvas.props.onPointerCancel(app.env.event(4, 4)); app.canvas.props.onPointerMove(app.env.event(100, 80)); });
  app.env.flush(); samePosition(app.env.dots[0], dragged); assert.ok(app.env.released.length >= 3);
  await act(async () => { app.canvas.props.onPointerDown(app.env.event(4, 4)); app.canvas.props.onPointerUp(app.env.event(4, 4)); });
  assert.equal(app.selected.at(-1), null);
});

test('2D zero-size and hidden containers remain idle and redraw only when visible again', async () => {
  const app = await mount(sample, [0, 0]); app.env.flush(); assert.equal(app.env.dots.length, 0); assert.equal(app.env.frames.size, 0);
  app.env.resize(800, 600); app.env.flush(); assert.equal(app.env.dots.length, 3);
  app.env.resize(700, 500); assert.equal(app.env.frames.size, 1); app.env.document.hidden = true; app.env.documentListeners.get('visibilitychange')!(); assert.equal(app.env.frames.size, 0);
  app.env.document.hidden = false; app.env.documentListeners.get('visibilitychange')!(); assert.equal(app.env.frames.size, 1); app.env.flush(); assert.equal(app.env.frames.size, 0);
});
