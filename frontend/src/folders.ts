import type { NoteSummary } from './types';

export type FolderNode = {path:string;name:string;count:number;children:FolderNode[]};
export function readableFolderName(path:string) {
  const name = path.split('/').pop() || '根目录';
  return path.startsWith('有道/') ? name.replace(/__[a-f\d]{8}$/i, '') : name;
}
export function readableFolderPath(path:string) {
  return path.split('/').map((name,i,parts)=>readableFolderName(parts.slice(0,i+1).join('/'))).join('/');
}
export function buildFolderTree(folders:string[],notes:NoteSummary[]):FolderNode[] {
  const roots:FolderNode[] = [], lookup = new Map<string,FolderNode>();
  function ensure(path:string):FolderNode|undefined {
    if(!path) return;
    const existing = lookup.get(path); if(existing) return existing;
    const slash = path.lastIndexOf('/'), parent = slash < 0 ? undefined : ensure(path.slice(0,slash));
    const node:FolderNode = {path,name:readableFolderName(path),count:0,children:[]};
    lookup.set(path,node);(parent ? parent.children : roots).push(node);return node;
  }
  folders.forEach(ensure);
  for(const note of notes) {
    ensure(note.folder);
    const parts=note.folder.split('/').filter(Boolean);
    for(let i=1;i<=parts.length;i++) { const node=lookup.get(parts.slice(0,i).join('/'));if(node)node.count++; }
  }
  const sort=(nodes:FolderNode[])=>{nodes.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')||a.path.localeCompare(b.path));nodes.forEach(n=>sort(n.children));};sort(roots);
  return roots;
}
export function filterFolderTree(nodes:FolderNode[],query:string):FolderNode[] {
  const text=query.trim().toLowerCase();if(!text)return nodes;
  return nodes.flatMap(node=>{const children=filterFolderTree(node.children,text);return readableFolderPath(node.path).toLowerCase().includes(text)?[node]:children.length?[{...node,children}]:[];});
}
