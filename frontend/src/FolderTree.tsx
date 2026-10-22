import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, Search, X } from 'lucide-react';
import type { NoteSummary } from './types';
import { buildFolderTree, filterFolderTree, type FolderNode } from './folders';

export function FolderTree({folders,notes,selected,onSelect}:{folders:string[];notes:NoteSummary[];selected:string|null;onSelect:(path:string)=>void}) {
  const [expanded,setExpanded]=useState<Set<string>>(()=>new Set()),[query,setQuery]=useState('');
  const tree=useMemo(()=>buildFolderTree(folders,notes),[folders,notes]);
  const visible=useMemo(()=>filterFolderTree(tree,query),[tree,query]);
  useEffect(()=>{if(selected)setExpanded(old=>{const next=new Set(old),parts=selected.split('/');for(let i=1;i<parts.length;i++)next.add(parts.slice(0,i).join('/'));return next;});},[selected]);
  function branch(nodes:FolderNode[],depth=0):React.ReactNode {
    return nodes.map(node=>{const open=!!query.trim()||expanded.has(node.path);return <div key={node.path} className="folder-branch" role="treeitem" aria-expanded={node.children.length?open:undefined} aria-selected={selected===node.path}>
      <div className={`folder-tree-row ${selected===node.path?'selected':''}`} style={{paddingLeft:Math.min(depth,7)*11}}>
        {node.children.length?<button className="folder-expander" aria-label={`${open?'折叠':'展开'}文件夹 ${node.name}`} title={node.path} aria-expanded={open} onClick={()=>{setExpanded(old=>{const next=new Set(old);if(next.has(node.path))next.delete(node.path);else next.add(node.path);return next;});}}>{open?<ChevronDown size={12}/>:<ChevronRight size={12}/>}</button>:<span className="folder-expander-spacer"/>}
        <button className="folder-select" onClick={()=>onSelect(node.path)} title={node.path} aria-label={`选择文件夹 ${node.path}`}>{open?<FolderOpen size={14}/>:<Folder size={14}/>}<span>{node.name}</span><small>{node.count}</small></button>
      </div>{node.children.length>0&&open&&<div role="group">{branch(node.children,depth+1)}</div>}
    </div>;});
  }
  return <div className="folder-browser">{folders.length>12&&<div className="folder-filter"><Search size={12}/><input aria-label="筛选文件夹" placeholder="查找文件夹…" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button aria-label="清空文件夹筛选" onClick={()=>setQuery('')}><X size={12}/></button>}</div>}{folders.length>0&&<div className="folder-tree-tools"><span>{folders.length} 个目录</span><button onClick={()=>{setExpanded(new Set());setQuery('');}}>全部折叠</button></div>}<div role="tree" aria-label="笔记文件夹目录树">{branch(visible)}</div>{!visible.length&&<p className="sidebar-empty">{query?'没有匹配的文件夹':'创建笔记时可指定文件夹'}</p>}</div>;
}
