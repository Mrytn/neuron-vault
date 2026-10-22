import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { GRAPH_COLORS, layoutGraph, type GraphPoint } from '../src/graph-model';
import type { GraphData, GraphEdge, GraphNode } from '../src/types';

const node = (id: string, group = 'same-folder'): GraphNode => ({ id, title: id, group, tags: [] });
const edge = (source: string, target: string, type: GraphEdge['type'] = 'link'): GraphEdge => ({ source, target, type, label: type === 'tag' ? 'actual-shared-tag' : '' });
const radius = (p: GraphPoint) => Math.hypot(p.x, p.y, p.z);
const distance = (a: GraphPoint, b: GraphPoint) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
function freezeGraph(data: GraphData) {
  data.nodes.forEach(n => { Object.freeze(n.tags); Object.freeze(n); });
  data.edges.forEach(Object.freeze);
  Object.freeze(data.nodes); Object.freeze(data.edges); Object.freeze(data);
  return data;
}
function finite(points: GraphPoint[], count: number) {
  assert.equal(points.length, count);
  assert.ok(points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)));
  assert.ok(points.every(p => radius(p) <= 245.00001), 'All three coordinates must fit the existing perspective camera');
}
function volumeStatistics(points: GraphPoint[]) {
  const means = [mean(points.map(p => p.x)), mean(points.map(p => p.y)), mean(points.map(p => p.z))];
  const cov = Array.from({ length: 3 }, () => Array<number>(3).fill(0));
  for (const p of points) {
    const delta = [p.x - means[0], p.y - means[1], p.z - means[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a][b] += delta[a] * delta[b] / points.length;
  }
  const determinant = cov[0][0] * (cov[1][1] * cov[2][2] - cov[1][2] ** 2)
    - cov[0][1] * (cov[0][1] * cov[2][2] - cov[1][2] * cov[0][2])
    + cov[0][2] * (cov[0][1] * cov[1][2] - cov[1][1] * cov[0][2]);
  return { variance: cov.map((row, i) => row[i]), normalizedDeterminant: determinant / (cov[0][0] * cov[1][1] * cov[2][2]) };
}

test('3D layout handles empty/single graphs and counts only valid edge endpoints', () => {
  assert.deepEqual(layoutGraph({ nodes: [], edges: [] }), []);
  const single = node('single');
  assert.deepEqual(layoutGraph({ nodes: [single], edges: [] }), [{ node: single, x: 0, y: 0, z: 0, color: GRAPH_COLORS[0], degree: 0 }]);
  assert.deepEqual(layoutGraph({ nodes: [single], edges: [edge('single', 'single')] }), [{ node: single, x: 0, y: 0, z: 0, color: GRAPH_COLORS[0], degree: 2 }]);
  const data = freezeGraph({ nodes: [node('A'), node('B'), node('C')], edges: [edge('A', 'B'), edge('B', 'A', 'tag'), edge('A', 'A'), edge('A', 'missing'), edge('missing', 'C')] });
  const points = layoutGraph(data);
  finite(points, 3);
  assert.deepEqual(points.map(p => p.degree), [4, 2, 0]);
  assert.equal(data.edges.length, 5);
});

test('1200 isolated notes occupy a genuine 3D volume with varying radii and no grid rows', context => {
  const data = freezeGraph({ nodes: Array.from({ length: 1200 }, (_, i) => node(`isolated-${i}`)), edges: [] });
  const start = performance.now(), points = layoutGraph(data), duration = performance.now() - start;
  finite(points, 1200);
  assert.deepEqual(points.map(p => p.node), data.nodes);
  assert.ok(points.every(p => p.degree === 0));
  const radii = points.map(radius), { variance, normalizedDeterminant } = volumeStatistics(points);
  assert.ok(Math.min(...radii) < 55 && Math.max(...radii) > 230, 'Points must occupy interior and exterior, not an equal-radius sphere');
  assert.ok(radii.filter(r => r < 130).length > 100, 'The volume needs substantial interior occupancy');
  assert.ok(variance[2] > Math.min(variance[0], variance[1]) * .75, 'Z must have comparable scale to X/Y, not shallow decorative depth');
  assert.ok(normalizedDeterminant > .75, 'Coordinates must not lie in a tilted 2D plane');
  for (const axis of ['x', 'y', 'z'] as const) assert.ok(new Set(points.map(p => p[axis].toFixed(4))).size > 1180, `${axis} must not be snapped to lattice rows`);
  assert.ok(duration < 1000, `Isolated volume generation should remain cheap: ${duration.toFixed(1)}ms`);
  context.diagnostic(`1200 isolated nodes: ${duration.toFixed(1)}ms, radial range ${Math.min(...radii).toFixed(1)}–${Math.max(...radii).toFixed(1)}, full-rank volume ${normalizedDeterminant.toFixed(3)}`);
});

test('a 1000-note synthetic sparse library keeps the related core and all 984 isolates', context => {
  const nodes = Array.from({ length: 1000 }, (_, i) => node(`sparse-${String(i).padStart(4, '0')}`));
  const edges: GraphEdge[] = [];
  for (let i = 0; i < 14; i++) {
    edges.push(edge(nodes[i].id, nodes[i + 1].id));
    edges.push(edge(nodes[i].id, nodes[(i + 3) % 16].id, 'tag'));
  }
  const data = freezeGraph({ nodes, edges }), start = performance.now(), points = layoutGraph(data), duration = performance.now() - start;
  finite(points, 1000);
  const related = points.filter(p => p.degree > 0), isolated = points.filter(p => p.degree === 0);
  assert.equal(related.length, 16); assert.equal(isolated.length, 984); assert.equal(data.edges.length, 28);
  assert.ok(mean(isolated.map(radius)) > mean(related.map(radius)) * 1.6, 'Real relations should concentrate the core while isolates spread around it');
  const radii = isolated.map(radius);
  assert.ok(Math.max(...radii) - Math.min(...radii) > 140, 'Sparse libraries must not place isolates on a thin shell');
  assert.ok(isolated.filter(p => radius(p) < 150).length > isolated.length * .13, 'The surrounding cloud must retain real radial thickness');
  assert.ok(volumeStatistics(isolated).normalizedDeterminant > .75);
  assert.ok(Math.max(...isolated.map(p => p.z)) - Math.min(...isolated.map(p => p.z)) > 400);
  context.diagnostic(`1000 nodes / 28 synthetic real edges: ${duration.toFixed(1)}ms; core mean radius ${mean(related.map(radius)).toFixed(1)}, isolate mean ${mean(radii).toFixed(1)}`);
});

for (const type of ['link', 'tag'] as const) test(`3D ${type} topology creates communities with depth and preserves the bridge`, () => {
  const nodes = Array.from({ length: 20 }, (_, i) => node(`n${i}`)), edges: GraphEdge[] = [];
  for (const start of [0, 10]) for (let i = start; i < start + 10; i++) for (let j = i + 1; j < start + 10; j++) edges.push(edge(nodes[i].id, nodes[j].id, type));
  edges.push(edge('n9', 'n10', type));
  const data = freezeGraph({ nodes, edges }), points = layoutGraph(data), within: number[] = [], between: number[] = [];
  finite(points, 20);
  for (let i = 0; i < 20; i++) for (let j = i + 1; j < 20; j++) (Math.floor(i / 10) === Math.floor(j / 10) ? within : between).push(distance(points[i], points[j]));
  assert.ok(mean(within) < mean(between) * .65);
  assert.ok(Math.max(...points.map(p => p.z)) - Math.min(...points.map(p => p.z)) > 55);
  assert.ok(volumeStatistics(points).normalizedDeterminant > .08, 'Even clustered geometry must occupy three dimensions');
  assert.equal(data.edges.length, 91);
});

test('3D components reflect actual relationships, not merely matching folder colors', () => {
  const nodes = Array.from({ length: 24 }, (_, i) => node(`component-${i}`)), edges: GraphEdge[] = [];
  for (const start of [0, 8, 16]) for (let i = start; i < start + 8; i++) for (let j = i + 1; j < start + 8; j++) edges.push(edge(nodes[i].id, nodes[j].id));
  const points = layoutGraph({ nodes, edges }), within: number[] = [], between: number[] = [];
  for (let i = 0; i < 24; i++) for (let j = i + 1; j < 24; j++) (Math.floor(i / 8) === Math.floor(j / 8) ? within : between).push(distance(points[i], points[j]));
  assert.ok(mean(within) < mean(between) * .75);
  assert.ok(points.every(p => p.color === GRAPH_COLORS[0]));
});

test('3D layout is deterministic under repeated calls and reordered immutable input', () => {
  const nodes = Array.from({ length: 70 }, (_, i) => node(`stable-${i}`, `group-${i % 8}`));
  const edges = nodes.slice(1, 60).map((n, i) => edge(nodes[Math.floor(i / 3)].id, n.id, i % 2 ? 'link' : 'tag'));
  const data = freezeGraph({ nodes, edges }), first = layoutGraph(data);
  assert.deepEqual(layoutGraph(data), first);
  const shuffled = layoutGraph({ nodes: [...nodes].reverse(), edges: [...edges].reverse() });
  const sorted = (points: GraphPoint[]) => [...points].sort((a, b) => a.node.id.localeCompare(b.node.id));
  assert.deepEqual(sorted(shuffled), sorted(first));
  const groups = [...new Set(nodes.map(n => n.group))].sort();
  for (const p of first) assert.equal(p.color, GRAPH_COLORS[groups.indexOf(p.node.group) % GRAPH_COLORS.length]);
});

test('1200 nodes / 6000 edges have bounded 3D refinement and retain every degree', context => {
  const nodes = Array.from({ length: 1200 }, (_, i) => node(`large-${i}`)), edges: GraphEdge[] = [];
  for (let i = 0; i < nodes.length; i++) for (let j = 1; j <= 5; j++) edges.push(edge(nodes[i].id, nodes[(i + j) % nodes.length].id, j <= 2 ? 'link' : 'tag'));
  const start = performance.now(), points = layoutGraph({ nodes, edges }), duration = performance.now() - start;
  finite(points, 1200);
  assert.ok(points.every(p => p.degree === 10));
  assert.ok(volumeStatistics(points).normalizedDeterminant > .65);
  assert.ok(duration < 5000, `Refinement must not become an unbounded all-pairs force calculation: ${duration.toFixed(1)}ms`);
  context.diagnostic(`1200 nodes / 6000 edges: ${duration.toFixed(1)}ms (Node, not GPU/browser rendering)`);
});

test('dense 3D tags keep complete true degrees despite bounded spring sampling', context => {
  const nodes = Array.from({ length: 400 }, (_, i) => node(`dense-${i}`)), edges: GraphEdge[] = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) edges.push(edge(nodes[i].id, nodes[j].id, 'tag'));
  const start = performance.now(), points = layoutGraph({ nodes, edges }), duration = performance.now() - start;
  finite(points, 400);
  assert.ok(points.every(p => p.degree === 399));
  assert.equal(edges.length, 79800);
  assert.ok(volumeStatistics(points).normalizedDeterminant > .7);
  assert.ok(duration < 5000);
  context.diagnostic(`400 nodes / 79800 tag edges: ${duration.toFixed(1)}ms; original incidences retained`);
});
