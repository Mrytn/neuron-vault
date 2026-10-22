import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { GRAPH_COLORS } from '../src/graph-model';
import { layoutNetwork, selectNeighborhood } from '../src/network-layout';
import type { GraphData, GraphEdge, GraphNode } from '../src/types';

const node = (id: string, group = 'folder'): GraphNode => ({ id, title: `Note ${id}`, group, tags: [] });
const edge = (source: string, target: string, type: GraphEdge['type'] = 'link'): GraphEdge => ({ source, target, type, label: type === 'tag' ? 'shared tag' : '' });
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
function finite(points: ReturnType<typeof layoutNetwork>, count: number) {
  assert.equal(points.length, count);
  assert.ok(points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.z === 0));
}
function freezeGraph(data: GraphData) {
  data.nodes.forEach(n => { Object.freeze(n.tags); Object.freeze(n); });
  data.edges.forEach(Object.freeze);
  Object.freeze(data.nodes); Object.freeze(data.edges); Object.freeze(data);
  return data;
}
function largeGraph(count: number): GraphData {
  const nodes = Array.from({ length: count }, (_, i) => node(`n${String(i).padStart(5, '0')}`, `folder-${i % 7}`));
  const edges: GraphEdge[] = [];
  for (let i = 0; i < count; i++) for (let jump = 1; jump <= 5; jump++) edges.push(edge(nodes[i].id, nodes[(i + jump) % count].id, jump <= 2 ? 'link' : 'tag'));
  return { nodes, edges };
}

test('network handles empty and single-node graphs without fabricated neighbors', () => {
  assert.deepEqual(layoutNetwork({ nodes: [], edges: [] }), []);
  const single = node('alone');
  assert.deepEqual(layoutNetwork({ nodes: [single], edges: [] }), [{ node: single, x: 0, y: 0, z: 0, color: GRAPH_COLORS[0], degree: 0 }]);
  assert.deepEqual(selectNeighborhood({ nodes: [], edges: [] }, 'unknown'), { nodes: [], edges: [] });
});

test('network retains all isolated nodes, with finite distinct positions', () => {
  const data = freezeGraph({ nodes: Array.from({ length: 150 }, (_, i) => node(`isolated-${i}`)), edges: [] });
  const points = layoutNetwork(data);
  finite(points, 150);
  assert.deepEqual(points.map(p => p.node), data.nodes);
  assert.ok(points.every(p => p.degree === 0));
  assert.equal(new Set(points.map(p => `${p.x},${p.y}`)).size, 150);
  assert.deepEqual(selectNeighborhood(data, 'isolated-10'), { nodes: [data.nodes[10]], edges: [] });
});

test('network degrees count only real endpoint incidences, including parallel edges and self loops', () => {
  const data = freezeGraph({
    nodes: [node('A'), node('B'), node('C')],
    edges: [edge('A', 'B'), edge('B', 'A', 'tag'), edge('A', 'A'), edge('A', 'missing'), edge('missing', 'C')],
  });
  const points = layoutNetwork(data);
  finite(points, 3);
  assert.deepEqual(points.map(p => p.degree), [4, 2, 0]);
  assert.equal(data.edges.length, 5);
});

test('one-hop selection includes target and actual neighbors plus only their induced edges', () => {
  const data = freezeGraph({
    nodes: ['A', 'B', 'C', 'D', 'isolated'].map(id => node(id)),
    edges: [edge('A', 'B'), edge('C', 'A', 'tag'), edge('B', 'C'), edge('B', 'D'), edge('A', 'missing'), edge('A', 'A')],
  });
  const selected = selectNeighborhood(data, 'A');
  assert.deepEqual(selected.nodes.map(n => n.id), ['A', 'B', 'C']);
  assert.deepEqual(selected.edges, [data.edges[0], data.edges[1], data.edges[2], data.edges[5]]);
  assert.ok(selected.nodes.every(n => data.nodes.includes(n)));
  assert.ok(selected.edges.every(e => data.edges.includes(e)));
  assert.deepEqual(selectNeighborhood(data, 'missing'), { nodes: [], edges: [] });
});

test('colors match group sorting and the shared graph palette, independent of node order', () => {
  const groups = ['zeta', 'alpha', 'gamma', 'beta', 'omega', 'epsilon', 'delta', 'theta'];
  const points = layoutNetwork({ nodes: groups.map(group => node(group, group)), edges: [] });
  const sorted = [...groups].sort();
  for (const p of points) assert.equal(p.color, GRAPH_COLORS[sorted.indexOf(p.node.group) % GRAPH_COLORS.length]);
});

test('network layout is reproducible and independent of input node/edge order', () => {
  const data = freezeGraph(largeGraph(80));
  const first = layoutNetwork(data), second = layoutNetwork(data);
  assert.deepEqual(second, first);
  const permuted = layoutNetwork({ nodes: [...data.nodes].reverse(), edges: [...data.edges].reverse() });
  const byId = (points: typeof first) => [...points].sort((a, b) => a.node.id.localeCompare(b.node.id));
  assert.deepEqual(byId(permuted), byId(first));
});

for (const type of ['link', 'tag'] as const) test(`${type} topology forms communities even when a real bridge joins them`, () => {
  const nodes = Array.from({ length: 20 }, (_, i) => node(`n${String(i).padStart(2, '0')}`));
  const edges: GraphEdge[] = [];
  for (const start of [0, 10]) for (let i = start; i < start + 10; i++) for (let j = i + 1; j < start + 10; j++) edges.push(edge(nodes[i].id, nodes[j].id, type));
  edges.push(edge(nodes[9].id, nodes[10].id, type));
  const data = freezeGraph({ nodes, edges }), points = layoutNetwork(data);
  finite(points, 20);
  const within: number[] = [], between: number[] = [];
  for (let i = 0; i < 20; i++) for (let j = i + 1; j < 20; j++) (Math.floor(i / 10) === Math.floor(j / 10) ? within : between).push(distance(points[i], points[j]));
  assert.ok(average(within) < average(between) * .7, `Within-community distance ${average(within)} should be lower than between-community ${average(between)}`);
  assert.equal(data.edges.length, 91, 'Layout must not remove the bridge or add relationships');
});

test('a branching graph keeps direct hub neighbors closer than unrelated terminal branches', () => {
  const nodes = [node('hub')], edges: GraphEdge[] = [];
  for (let branch = 0; branch < 6; branch++) {
    let previous = 'hub';
    for (let depth = 0; depth < 4; depth++) { const id = `b${branch}-${depth}`; nodes.push(node(id)); edges.push(edge(previous, id)); previous = id; }
  }
  const points = layoutNetwork({ nodes, edges }), lookup = new Map(points.map(p => [p.node.id, p]));
  const adjacent = edges.map(e => distance(lookup.get(e.source)!, lookup.get(e.target)!));
  const tips: number[] = [];
  for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) tips.push(distance(lookup.get(`b${a}-3`)!, lookup.get(`b${b}-3`)!));
  assert.ok(average(adjacent) < average(tips) * .7);
  finite(points, 25);
});

test('1200 nodes / 6000 edges remain complete with a bounded layout time', context => {
  const data = largeGraph(1200), start = performance.now(), points = layoutNetwork(data), duration = performance.now() - start;
  finite(points, 1200);
  assert.ok(points.every(p => p.degree === 10));
  assert.equal(data.edges.length, 6000);
  assert.ok(duration < 5000, `Unexpectedly unbounded runtime: ${duration.toFixed(1)}ms`);
  context.diagnostic(`1200 nodes, 6000 edges: ${duration.toFixed(1)}ms (Node; not a browser rendering measurement)`);
});

test('dense tag cliques use bounded refinement without dropping nodes or corrupting true degrees', context => {
  const nodes = Array.from({ length: 500 }, (_, i) => node(`dense-${String(i).padStart(4, '0')}`));
  const edges: GraphEdge[] = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) edges.push(edge(nodes[i].id, nodes[j].id, 'tag'));
  const start = performance.now(), points = layoutNetwork({ nodes, edges }), duration = performance.now() - start;
  finite(points, 500);
  assert.ok(points.every(p => p.degree === 499));
  assert.equal(edges.length, 124750);
  assert.ok(duration < 5000, `Dense edges should not all be refined each frame: ${duration.toFixed(1)}ms`);
  context.diagnostic(`500 nodes, 124750 tag edges: ${duration.toFixed(1)}ms, all original degrees retained`);
});
