import type { GraphData } from './types';
import { GRAPH_COLORS, type GraphPoint } from './graph-model';

type Spring = { a: number; b: number; tag: boolean; rank: number };
type Component = { nodes: number[]; x: number; y: number };
type Cell = { x: number; y: number; count: number };

const TAU = Math.PI * 2;
const CELL_SIZE = 110;
const SPRINGS_PER_NODE = 12;
const MAX_SAMPLED_SPRINGS = 24_000;

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
}

function mix(value: number): number {
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function compareSprings(a: Spring, b: Spring): number {
  return a.rank - b.rank || a.a - b.a || a.b - b.b || Number(a.tag) - Number(b.tag);
}

// Keep the smallest deterministic hashes, rather than the first edges returned
// by the server. This max heap has a fixed O(n) capacity even for tag cliques.
function sampleSpring(heap: Spring[], edge: Spring, capacity: number): void {
  if (heap.length < capacity) {
    heap.push(edge);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (compareSprings(heap[parent], edge) >= 0) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = edge;
    return;
  }
  if (compareSprings(edge, heap[0]) >= 0) return;
  let i = 0;
  while (i * 2 + 1 < heap.length) {
    let child = i * 2 + 1;
    if (child + 1 < heap.length && compareSprings(heap[child + 1], heap[child]) > 0) child++;
    if (compareSprings(edge, heap[child]) >= 0) break;
    heap[i] = heap[child];
    i = child;
  }
  heap[i] = edge;
}

/** The target and its actual one-hop neighbors, with their induced real edges. */
export function selectNeighborhood(data: GraphData, id: string): GraphData {
  const valid = new Set(data.nodes.map(node => node.id));
  if (!valid.has(id)) return { nodes: [], edges: [] };
  const selected = new Set([id]);
  for (const edge of data.edges) {
    if (!valid.has(edge.source) || !valid.has(edge.target)) continue;
    if (edge.source === id) selected.add(edge.target);
    if (edge.target === id) selected.add(edge.source);
  }
  return {
    nodes: data.nodes.filter(node => selected.has(node.id)),
    edges: data.edges.filter(edge => selected.has(edge.source) && selected.has(edge.target)),
  };
}

/**
 * Deterministic 2D force layout. All nodes and valid degrees are retained.
 * Reading topology is O(E); the bounded heap is O(E log(min(12N, 24,000))).
 * Each refinement step is O(N + min(12N, 24,000)), using nine nearby grid
 * cells as aggregate repulsion rather than testing every pair of notes.
 * Dense-edge sampling affects geometry only; it never changes GraphData.
 */
export function layoutNetwork(data: GraphData): GraphPoint[] {
  if (!data.nodes.length) return [];
  const nodes = [...data.nodes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const count = nodes.length;
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const groups = [...new Set(nodes.map(node => node.group))].sort();
  const colors = new Map(groups.map((group, i) => [group, GRAPH_COLORS[i % GRAPH_COLORS.length]]));
  const degree = new Float64Array(count);
  const parent = Int32Array.from({ length: count }, (_, i) => i);
  const hashes = Uint32Array.from(nodes, node => hash(node.id));
  const heap: Spring[] = [];
  const nearest: (Spring | undefined)[] = new Array(count);
  const capacity = Math.min(count * SPRINGS_PER_NODE, MAX_SAMPLED_SPRINGS);
  function find(i: number): number {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  for (const edge of data.edges) {
    const from = index.get(edge.source), to = index.get(edge.target);
    if (from === undefined || to === undefined) continue;
    // An actual self-loop contributes two incidences, but has no spring force.
    degree[from]++;
    degree[to]++;
    if (from === to) continue;
    const a = Math.min(from, to), b = Math.max(from, to);
    const rootA = find(a), rootB = find(b);
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
    const tag = edge.type === 'tag';
    const spring: Spring = { a, b, tag, rank: mix(hashes[a] ^ Math.imul(hashes[b], 31) ^ (tag ? 0x9e3779b9 : 0)) };
    sampleSpring(heap, spring, capacity);
    // Even in a dense sampled graph, every nonisolated note has a real spring.
    if (!nearest[a] || compareSprings(spring, nearest[a]!) < 0) nearest[a] = spring;
    if (!nearest[b] || compareSprings(spring, nearest[b]!) < 0) nearest[b] = spring;
  }

  const unique = new Map<string, Spring>();
  for (const edge of [...heap, ...nearest]) if (edge) unique.set(`${edge.a}:${edge.b}:${Number(edge.tag)}`, edge);
  const springs = [...unique.values()].sort((a, b) => a.a - b.a || a.b - b.b || Number(a.tag) - Number(b.tag));
  const adjacency: number[][] = Array.from({ length: count }, () => []);
  for (const edge of springs) { adjacency[edge.a].push(edge.b); adjacency[edge.b].push(edge.a); }
  for (const neighbors of adjacency) neighbors.sort((a, b) => a - b);
  const componentMap = new Map<number, Component>();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    if (!componentMap.has(root)) componentMap.set(root, { nodes: [], x: 0, y: 0 });
    componentMap.get(root)!.nodes.push(i);
  }
  const components = [...componentMap.values()].sort((a, b) => b.nodes.length - a.nodes.length || a.nodes[0] - b.nodes[0]);
  const x = new Float64Array(count), y = new Float64Array(count);
  const anchorX = new Float64Array(count), anchorY = new Float64Array(count);
  const visited = new Uint8Array(count);
  const initialArea = components.reduce((area, c) => area + (Math.sqrt(c.nodes.length) * 42 + 70) ** 2, 0);
  const initialWidth = Math.sqrt(initialArea) * 1.15;
  let shelfX = 0, shelfY = 0, shelfHeight = 0;
  for (const component of components) {
    const size = component.nodes.length, diameter = Math.sqrt(size) * 42 + 70;
    if (shelfX > 0 && shelfX + diameter > initialWidth) { shelfX = 0; shelfY += shelfHeight; shelfHeight = 0; }
    component.x = shelfX + diameter / 2;
    component.y = shelfY + diameter / 2;
    shelfX += diameter;
    shelfHeight = Math.max(shelfHeight, diameter);
    // Breadth-first topology ordering starts related branches near one another.
    // It also gives a stable compact seed for cycles, disconnected samples and
    // huge cliques without forcing a circle/sphere as the final geometry.
    const roots = [...component.nodes].sort((a, b) => degree[b] - degree[a] || a - b);
    const order: number[] = [];
    for (const root of roots) {
      if (visited[root]) continue;
      const queue = [root];
      visited[root] = 1;
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const node = queue[cursor];
        order.push(node);
        for (const next of adjacency[node]) if (!visited[next]) { visited[next] = 1; queue.push(next); }
      }
    }
    order.forEach((node, i) => {
      const angle = i * Math.PI * (3 - Math.sqrt(5)), radius = size === 1 ? 0 : 21 * Math.sqrt(i);
      x[node] = component.x + Math.cos(angle) * radius;
      y[node] = component.y + Math.sin(angle) * radius;
      anchorX[node] = component.x;
      anchorY[node] = component.y;
    });
  }

  const fx = new Float64Array(count), fy = new Float64Array(count);
  const vx = new Float64Array(count), vy = new Float64Array(count);
  const steps = count <= 180 ? 120 : count <= 1800 ? 84 : 48;
  if (springs.length) for (let step = 0; step < steps; step++) {
    fx.fill(0); fy.fill(0);
    let minCellX = Infinity, maxCellX = -Infinity, minCellY = Infinity, maxCellY = -Infinity;
    for (let i = 0; i < count; i++) {
      const cx = Math.floor(x[i] / CELL_SIZE), cy = Math.floor(y[i] / CELL_SIZE);
      minCellX = Math.min(minCellX, cx); maxCellX = Math.max(maxCellX, cx);
      minCellY = Math.min(minCellY, cy); maxCellY = Math.max(maxCellY, cy);
    }
    const stride = maxCellY - minCellY + 1;
    const grid = new Map<number, Cell>();
    for (let i = 0; i < count; i++) {
      const key = (Math.floor(x[i] / CELL_SIZE) - minCellX) * stride + Math.floor(y[i] / CELL_SIZE) - minCellY;
      const cell = grid.get(key);
      if (cell) { cell.x += x[i]; cell.y += y[i]; cell.count++; }
      else grid.set(key, { x: x[i], y: y[i], count: 1 });
    }
    for (let i = 0; i < count; i++) {
      if (!adjacency[i].length) continue;
      const cx = Math.floor(x[i] / CELL_SIZE), cy = Math.floor(y[i] / CELL_SIZE);
      for (let gx = Math.max(minCellX, cx - 1); gx <= Math.min(maxCellX, cx + 1); gx++) {
        for (let gy = Math.max(minCellY, cy - 1); gy <= Math.min(maxCellY, cy + 1); gy++) {
          const cell = grid.get((gx - minCellX) * stride + gy - minCellY);
          if (!cell) continue;
          const own = gx === cx && gy === cy ? 1 : 0, mass = cell.count - own;
          if (!mass) continue;
          let dx = x[i] - (cell.x - x[i] * own) / mass, dy = y[i] - (cell.y - y[i] * own) / mass;
          let distanceSquared = dx * dx + dy * dy;
          if (distanceSquared < 1) { const angle = hashes[i] / 0xffffffff * TAU; dx = Math.cos(angle); dy = Math.sin(angle); distanceSquared = 1; }
          const force = Math.min(9, mass * 1550 / Math.max(100, distanceSquared)) / Math.sqrt(distanceSquared);
          fx[i] += dx * force; fy[i] += dy * force;
        }
      }
    }
    for (const edge of springs) {
      const dx = x[edge.b] - x[edge.a], dy = y[edge.b] - y[edge.a], distance = Math.max(1, Math.hypot(dx, dy));
      const strength = (edge.tag ? .035 : .065) / Math.sqrt(Math.max(1, Math.min(adjacency[edge.a].length, adjacency[edge.b].length)));
      const force = (distance - (edge.tag ? 96 : 72)) * strength / distance;
      fx[edge.a] += dx * force; fy[edge.a] += dy * force;
      fx[edge.b] -= dx * force; fy[edge.b] -= dy * force;
    }
    const maxStep = 10 * (1 - step / steps) + 1.5;
    for (let i = 0; i < count; i++) {
      if (!adjacency[i].length) continue;
      vx[i] = (vx[i] + fx[i] + (anchorX[i] - x[i]) * .002) * .68;
      vy[i] = (vy[i] + fy[i] + (anchorY[i] - y[i]) * .002) * .68;
      const scale = Math.min(1, maxStep / Math.max(.001, Math.hypot(vx[i], vy[i])));
      x[i] += vx[i] * scale; y[i] += vy[i] * scale;
    }
  }

  // Pack actual connected components after relaxation, including every isolated
  // note. Empty space between components is not interpreted as a relationship.
  const boxes = components.map(component => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const i of component.nodes) { minX = Math.min(minX, x[i]); maxX = Math.max(maxX, x[i]); minY = Math.min(minY, y[i]); maxY = Math.max(maxY, y[i]); }
    return { component, minX, minY, width: maxX - minX + 90, height: maxY - minY + 90 };
  });
  const packedWidth = Math.sqrt(boxes.reduce((area, box) => area + box.width * box.height, 0)) * 1.2;
  shelfX = 0; shelfY = 0; shelfHeight = 0;
  for (const box of boxes) {
    if (shelfX > 0 && shelfX + box.width > packedWidth) { shelfX = 0; shelfY += shelfHeight; shelfHeight = 0; }
    for (const i of box.component.nodes) { x[i] += shelfX - box.minX + 45; y[i] += shelfY - box.minY + 45; }
    shelfX += box.width; shelfHeight = Math.max(shelfHeight, box.height);
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < count; i++) { minX = Math.min(minX, x[i]); maxX = Math.max(maxX, x[i]); minY = Math.min(minY, y[i]); maxY = Math.max(maxY, y[i]); }
  const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
  return data.nodes.map(node => {
    const i = index.get(node.id)!;
    return { node, x: x[i] - centerX, y: y[i] - centerY, z: 0, color: colors.get(node.group)!, degree: degree[i] };
  });
}
