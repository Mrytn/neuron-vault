import type { GraphData, GraphNode } from './types';

export const GRAPH_COLORS=['#1D71F6','#53d2c2','#81b6ff','#e6ad71','#66c6ed','#b8cb78'];
export const DENSE_EDGE_LIMIT=4000;
export type GraphPoint={node:GraphNode;x:number;y:number;z:number;color:string;degree:number};
export function selectGraph(data:GraphData,folder:string,query:string,showTags:boolean,showLinks:boolean):GraphData {
  const text=query.trim().toLowerCase();
  const nodes=data.nodes.filter(n=>(!folder||n.group===folder||n.group.startsWith(folder+'/'))&&(!text||`${n.title} ${n.group} ${n.tags.join(' ')}`.toLowerCase().includes(text)));
  const ids=new Set(nodes.map(n=>n.id));
  return {nodes,edges:data.edges.filter(e=>(e.type==='tag'?showTags:showLinks)&&ids.has(e.source)&&ids.has(e.target))};
}
export function layoutGraph(data:GraphData):GraphPoint[] {
  if (!data.nodes.length) return [];
  const nodes = [...data.nodes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const count = nodes.length, index = new Map(nodes.map((node, i) => [node.id, i]));
  const groups = [...new Set(nodes.map(node => node.group))].sort();
  const colors = new Map(groups.map((group, i) => [group, GRAPH_COLORS[i % GRAPH_COLORS.length]]));
  const degree = new Float64Array(count), parent = Int32Array.from({ length: count }, (_, i) => i);
  type Spring = { a: number; b: number; tag: boolean; rank: number };
  const samples: Spring[][] = Array.from({ length: count }, () => []);
  const mix = (value: number): number => {
    value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
    value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
    return (value ^ (value >>> 16)) >>> 0;
  };
  const hash = (text: string): number => {
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
    return mix(value);
  };
  const hashes = Uint32Array.from(nodes, node => hash(node.id));
  const compare = (a: Spring, b: Spring) => a.rank - b.rank || a.a - b.a || a.b - b.b || Number(a.tag) - Number(b.tag);
  const find = (start: number): number => {
    let i = start;
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  // Every node keeps up to eight distinct real springs. All valid edges still
  // contribute to degree and connectivity. Dense tag cliques therefore have an
  // O(E) ingestion pass and a bounded O(N) spring refinement, without truncating
  // the actual graph or silently omitting low-degree notes.
  const retain = (i: number, spring: Spring) => {
    const list = samples[i];
    if (list.length === 8 && compare(spring, list[0]) >= 0) return;
    if (list.some(edge => edge.a === spring.a && edge.b === spring.b && edge.tag === spring.tag)) return;
    if (list.length === 8) list[0] = spring; else list.push(spring);
    list.sort((a, b) => compare(b, a));
  };
  for (const edge of data.edges) {
    const source = index.get(edge.source), target = index.get(edge.target);
    if (source === undefined || target === undefined) continue;
    degree[source]++; degree[target]++;
    if (source === target) continue; // A self-loop counts twice, but exerts no spring force.
    const a = Math.min(source, target), b = Math.max(source, target), rootA = find(a), rootB = find(b);
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
    const tag = edge.type === 'tag';
    const spring = { a, b, tag, rank: mix(hashes[a] ^ Math.imul(hashes[b], 31) ^ (tag ? 0x9e3779b9 : 0)) };
    retain(a, spring); retain(b, spring);
  }
  const unique = new Map<string, Spring>();
  for (const list of samples) for (const spring of list) unique.set(`${spring.a}:${spring.b}:${Number(spring.tag)}`, spring);
  const springs = [...unique.values()].sort((a, b) => a.a - b.a || a.b - b.b || Number(a.tag) - Number(b.tag));
  const springDegree = new Uint32Array(count);
  for (const spring of springs) { springDegree[spring.a]++; springDegree[spring.b]++; }
  const components = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    if (!components.has(root)) components.set(root, []);
    components.get(root)!.push(i);
  }
  // Uniform volume samples: independent direction plus a cube-root radial
  // distribution. This is a ball, not equal-radius spherical surface points.
  const volume = (seed: number, innerRadius = 0): [number, number, number] => {
    const unit = (salt: number) => (mix(seed ^ salt) + .5) / 4294967296;
    const height = unit(0x68bc21eb) * 2 - 1, angle = unit(0x02e5be93) * Math.PI * 2;
    const radius = Math.cbrt(innerRadius ** 3 + unit(0x967a889b) * (1 - innerRadius ** 3));
    const ring = Math.sqrt(Math.max(0, 1 - height * height));
    return [Math.cos(angle) * ring * radius, height * radius, Math.sin(angle) * ring * radius];
  };
  const x = new Float64Array(count), y = new Float64Array(count), z = new Float64Array(count);
  const anchorX = new Float64Array(count), anchorY = new Float64Array(count), anchorZ = new Float64Array(count);
  const worldRadius = Math.max(95, Math.cbrt(count) * 32), hasRelations = springs.length > 0;
  const connectedComponents = [...components.values()].filter(component => component.length > 1).length;
  for (const [root, component] of components) {
    if (component.length === 1) {
      // A modest core clearance leaves almost the full radial volume available:
      // thousands of isolated notes must not become an opaque spherical shell.
      const i = component[0], position = volume(hashes[i], hasRelations ? .28 : 0);
      x[i] = position[0] * worldRadius; y[i] = position[1] * worldRadius; z[i] = position[2] * worldRadius;
      continue;
    }
    const center = connectedComponents === 1 ? [0, 0, 0] : volume(hashes[root] ^ 0x37a4b9d1);
    const localRadius = Math.max(32, Math.cbrt(component.length) * 25);
    for (const i of component) {
      const position = volume(hashes[i] ^ 0xb5297a4d);
      anchorX[i] = center[0] * worldRadius * .48;
      anchorY[i] = center[1] * worldRadius * .48;
      anchorZ[i] = center[2] * worldRadius * .48;
      x[i] = anchorX[i] + position[0] * localRadius;
      y[i] = anchorY[i] + position[1] * localRadius;
      z[i] = anchorZ[i] + position[2] * localRadius;
    }
  }
  const fx = new Float64Array(count), fy = new Float64Array(count), fz = new Float64Array(count);
  const vx = new Float64Array(count), vy = new Float64Array(count), vz = new Float64Array(count);
  const CELL = 75, steps = count <= 180 ? 100 : count <= 1800 ? 64 : 40;
  type Cell = { x: number; y: number; z: number; count: number };
  if (hasRelations) for (let step = 0; step < steps; step++) {
    fx.fill(0); fy.fill(0); fz.fill(0);
    let minCX = Infinity, maxCX = -Infinity, minCY = Infinity, maxCY = -Infinity, minCZ = Infinity, maxCZ = -Infinity;
    for (let i = 0; i < count; i++) {
      const cx = Math.floor(x[i] / CELL), cy = Math.floor(y[i] / CELL), cz = Math.floor(z[i] / CELL);
      minCX = Math.min(minCX, cx); maxCX = Math.max(maxCX, cx);
      minCY = Math.min(minCY, cy); maxCY = Math.max(maxCY, cy);
      minCZ = Math.min(minCZ, cz); maxCZ = Math.max(maxCZ, cz);
    }
    const strideZ = maxCZ - minCZ + 1, strideY = (maxCY - minCY + 1) * strideZ;
    const grid = new Map<number, Cell>();
    for (let i = 0; i < count; i++) {
      const key = (Math.floor(x[i] / CELL) - minCX) * strideY + (Math.floor(y[i] / CELL) - minCY) * strideZ + Math.floor(z[i] / CELL) - minCZ;
      const cell = grid.get(key);
      if (cell) { cell.x += x[i]; cell.y += y[i]; cell.z += z[i]; cell.count++; }
      else grid.set(key, { x: x[i], y: y[i], z: z[i], count: 1 });
    }
    for (let i = 0; i < count; i++) {
      if (!springDegree[i]) continue;
      const cx = Math.floor(x[i] / CELL), cy = Math.floor(y[i] / CELL), cz = Math.floor(z[i] / CELL);
      for (let gx = Math.max(minCX, cx - 1); gx <= Math.min(maxCX, cx + 1); gx++) {
        for (let gy = Math.max(minCY, cy - 1); gy <= Math.min(maxCY, cy + 1); gy++) {
          for (let gz = Math.max(minCZ, cz - 1); gz <= Math.min(maxCZ, cz + 1); gz++) {
            const cell = grid.get((gx - minCX) * strideY + (gy - minCY) * strideZ + gz - minCZ);
            if (!cell) continue;
            const own = gx === cx && gy === cy && gz === cz ? 1 : 0, mass = cell.count - own;
            if (!mass) continue;
            let dx = x[i] - (cell.x - x[i] * own) / mass, dy = y[i] - (cell.y - y[i] * own) / mass, dz = z[i] - (cell.z - z[i] * own) / mass;
            let squared = dx * dx + dy * dy + dz * dz;
            if (squared < 1) { const direction = volume(hashes[i]); dx = direction[0]; dy = direction[1]; dz = direction[2]; squared = Math.max(.01, dx * dx + dy * dy + dz * dz); }
            const force = Math.min(10, mass * 1050 / Math.max(100, squared)) / Math.sqrt(squared);
            fx[i] += dx * force; fy[i] += dy * force; fz[i] += dz * force;
          }
        }
      }
    }
    for (const spring of springs) {
      const dx = x[spring.b] - x[spring.a], dy = y[spring.b] - y[spring.a], dz = z[spring.b] - z[spring.a];
      const distance = Math.max(1, Math.hypot(dx, dy, dz));
      const strength = (spring.tag ? .035 : .065) / Math.sqrt(Math.max(1, Math.min(springDegree[spring.a], springDegree[spring.b])));
      const force = (distance - (spring.tag ? 66 : 48)) * strength / distance;
      fx[spring.a] += dx * force; fy[spring.a] += dy * force; fz[spring.a] += dz * force;
      fx[spring.b] -= dx * force; fy[spring.b] -= dy * force; fz[spring.b] -= dz * force;
    }
    const maxStep = 8 * (1 - step / steps) + 1;
    for (let i = 0; i < count; i++) {
      if (!springDegree[i]) continue;
      vx[i] = (vx[i] + fx[i] + (anchorX[i] - x[i]) * .0015) * .68;
      vy[i] = (vy[i] + fy[i] + (anchorY[i] - y[i]) * .0015) * .68;
      vz[i] = (vz[i] + fz[i] + (anchorZ[i] - z[i]) * .0015) * .68;
      const scale = Math.min(1, maxStep / Math.max(.001, Math.hypot(vx[i], vy[i], vz[i])));
      x[i] += vx[i] * scale; y[i] += vy[i] * scale; z[i] += vz[i] * scale;
    }
  }
  // Center and cap the volume within the renderer's perspective-camera range.
  // The same scale is applied to all three axes, preserving depth.
  let centerX = 0, centerY = 0, centerZ = 0;
  for (let i = 0; i < count; i++) { centerX += x[i]; centerY += y[i]; centerZ += z[i]; }
  centerX /= count; centerY /= count; centerZ /= count;
  let maxRadius = 0;
  for (let i = 0; i < count; i++) maxRadius = Math.max(maxRadius, Math.hypot(x[i] - centerX, y[i] - centerY, z[i] - centerZ));
  const scale = Math.min(1, 245 / Math.max(1, maxRadius));
  return data.nodes.map(node => {
    const i = index.get(node.id)!;
    return { node, x: (x[i] - centerX) * scale, y: (y[i] - centerY) * scale, z: (z[i] - centerZ) * scale, color: colors.get(node.group)!, degree: degree[i] };
  });
}
