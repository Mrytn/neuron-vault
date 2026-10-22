import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Focus, Maximize2, Minus, MousePointer2, Network, Orbit, Pause, Play, Plus, Search, X } from 'lucide-react';
import type { GraphData } from './types';
import { readableFolderPath } from './folders';
import { DENSE_EDGE_LIMIT, GRAPH_COLORS, layoutGraph, selectGraph } from './graph-model';
import { layoutNetwork, selectNeighborhood } from './network-layout';
import GraphCanvas from './GraphCanvas';
import NetworkCanvas from './NetworkCanvas';

type ViewMode = 'network' | 'spatial';
const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function Graph({data,onOpen,currentFolder}:{data:GraphData;onOpen:(id:string)=>void;currentFolder?:string|null}) {
  const host=useRef<HTMLDivElement>(null),initialDefaults=useRef(data.nodes.length>0);
  const [mode,setMode]=useState<ViewMode>('spatial');
  const [query,setQuery]=useState(''),[folder,setFolder]=useState(data.nodes.length>300?currentFolder||'':'');
  const [showTags,setShowTags]=useState(data.edges.filter(e=>e.type==='tag').length<=DENSE_EDGE_LIMIT),[showLinks,setShowLinks]=useState(true);
  const [hover,setHover]=useState<string|null>(null),[selected,setSelected]=useState<string|null>(null),[localFocus,setLocalFocus]=useState<string|null>(null);
  const [rotating,setRotating]=useState(()=>!reducedMotion()),[zoom,setZoom]=useState(1),[resetKey,setResetKey]=useState(0),[listOpen,setListOpen]=useState(false),[page,setPage]=useState(0);
  const [fullscreenError,setFullscreenError]=useState('');
  useEffect(()=>{if(data.nodes.length>0&&!initialDefaults.current){initialDefaults.current=true;setShowTags(data.edges.filter(e=>e.type==='tag').length<=DENSE_EDGE_LIMIT);if(data.nodes.length>300&&currentFolder)setFolder(currentFolder);}},[data.nodes.length,data.edges,currentFolder]);
  const groups=useMemo(()=>[...new Set(data.nodes.map(n=>n.group))].sort(),[data]);
  const folderOptions=useMemo(()=>[...new Set(groups.flatMap(group=>group.split('/').map((_,i,parts)=>parts.slice(0,i+1).join('/'))).concat(folder?[folder]:[]))].filter(Boolean).sort(),[groups,folder]);
  const scoped=useMemo(()=>selectGraph(data,folder,query,showTags,showLinks),[data,folder,query,showTags,showLinks]);
  const localCenter=localFocus?scoped.nodes.find(n=>n.id===localFocus):undefined;
  const visible=useMemo(()=>localFocus&&scoped.nodes.some(n=>n.id===localFocus)?selectNeighborhood(scoped,localFocus):scoped,[scoped,localFocus]);
  const points=useMemo(()=>mode==='network'?layoutNetwork(visible):layoutGraph(visible),[visible,mode]);
  const visibleIds=useMemo(()=>new Set(visible.nodes.map(n=>n.id)),[visible]);
  const connectedCount=useMemo(()=>{const ids=new Set<string>();for(const e of visible.edges){ids.add(e.source);ids.add(e.target);}return ids.size;},[visible]);
  const active=hover&&visibleIds.has(hover)?hover:selected&&visibleIds.has(selected)?selected:null;
  const dense=visible.edges.length>DENSE_EDGE_LIMIT;
  const edges=useMemo(()=>dense?visible.edges.filter(e=>e.source===active||e.target===active):visible.edges,[visible,dense,active]);
  const counts=useMemo(()=>({links:data.edges.filter(e=>e.type==='link').length,tags:data.edges.filter(e=>e.type==='tag').length}),[data]);
  const visibleGroups=useMemo(()=>[...new Set(visible.nodes.map(n=>n.group))].sort(),[visible]);
  const focused=visible.nodes.find(n=>n.id===(selected||hover)),focusedPoint=points.find(p=>p.node.id===focused?.id);
  const pageCount=Math.max(1,Math.ceil(visible.nodes.length/100)),safePage=Math.min(page,pageCount-1),listed=visible.nodes.slice(safePage*100,(safePage+1)*100);
  useEffect(()=>{setHover(null);setSelected(null);setLocalFocus(null);setPage(0);setZoom(1);setResetKey(n=>n+1);},[folder,query]);
  useEffect(()=>{
    if(selected&&!visibleIds.has(selected))setSelected(null);
    if(hover&&!visibleIds.has(hover))setHover(null);
    if(localFocus&&!scoped.nodes.some(n=>n.id===localFocus))setLocalFocus(null);
  },[visibleIds,scoped,selected,hover,localFocus]);
  const reset=()=>{setResetKey(n=>n+1);setZoom(1);setHover(null);};
  const switchMode=(next:ViewMode)=>{if(next!==mode){setMode(next);setRotating(next==='spatial'&&!reducedMotion());setHover(null);reset();}};
  const focusNeighborhood=(id:string)=>{setLocalFocus(id);setSelected(id);setHover(null);setPage(0);reset();};
  const leaveNeighborhood=()=>{setLocalFocus(null);setSelected(null);setHover(null);setPage(0);reset();};
  const zoomBy=(factor:number)=>{setRotating(false);setZoom(z=>Math.max(.2,Math.min(5,z*factor)));};
  const toggleFullscreen=async()=>{
    setFullscreenError('');
    try {if(document.fullscreenElement)await document.exitFullscreen();else if(host.current?.requestFullscreen)await host.current.requestFullscreen();else setFullscreenError('当前浏览器不支持全屏，可直接放大图谱。');}
    catch {setFullscreenError('未能进入全屏，请使用浏览器全屏或继续在页面内查看。');}
  };
  return <div className="graph-view">
    <div className="graph-heading"><div><div className="eyebrow"><span className="live-dot"/> CONNECT YOUR IDEAS</div><h1>让知识之间的联系，看得见<span>。</span></h1><p>从全貌到一篇笔记，沿着真实关系继续探索。</p></div><div className="graph-view-switch" role="group" aria-label="图谱视图"><button aria-label="切换三维图谱视图" aria-pressed={mode==='spatial'} className={mode==='spatial'?'active':''} onClick={()=>switchMode('spatial')}><Orbit size={15}/>三维关系网<span>3D</span></button><button aria-label="切换关系网络视图" aria-pressed={mode==='network'} className={mode==='network'?'active':''} onClick={()=>switchMode('network')}><Network size={15}/>平面关系网<span>2D</span></button></div></div>
    <div className="graph-scope-bar"><label>探索范围<select aria-label="图谱文件夹范围" value={folder} title={folder||'全部笔记'} onChange={e=>setFolder(e.target.value)}><option value="">全部笔记</option>{folderOptions.map(group=><option key={group} value={group}>{readableFolderPath(group)}</option>)}</select></label>{currentFolder&&folder!==currentFolder&&<button onClick={()=>setFolder(currentFolder)}>聚焦当前文件夹</button>}<span className="graph-visible-count" aria-live="polite">显示 {visible.nodes.length} / {data.nodes.length} 个节点 · {edges.length} / {data.edges.length} 条关系</span></div>
    {localCenter&&<div className="graph-local-scope"><span><Focus size={14}/><strong>{localCenter.title}</strong>及其相邻笔记 · {visible.nodes.length} 篇</span><button onClick={leaveNeighborhood}><ArrowLeft size={13}/>返回全局网络</button></div>}
    {(data.nodes.length>300||dense)&&<div className="graph-scale-note">{dense?`当前范围有 ${visible.edges.length} 条已启用关系，仅绘制悬停或选中节点相连的关系；可选中节点后查看相邻笔记。`:`所有 ${visible.nodes.length} 个命中节点均可见。${showTags?'已显示共同标签关系。':'共同标签关系已隐藏，可在图例中开启。'}可按文件夹或关键词缩小范围。`}{(!rotating||mode==='network')&&<span>静止时停止绘制</span>}</div>}
    {visible.nodes.length>0&&connectedCount<visible.nodes.length&&<div className="graph-connectivity-note">当前启用的关系连接了 {connectedCount} 篇笔记；其余 {visible.nodes.length-connectedCount} 篇暂未连接。可开启共同标签，或添加 [[笔记链接]]。</div>}
    <div className={`graph-stage graph-stage-${mode}`} ref={host}>
      {mode==='network'?<NetworkCanvas points={points} edges={edges} active={active} zoom={zoom} resetKey={resetKey} onHover={setHover} onSelect={setSelected} onOpen={onOpen} onZoom={zoomBy}/>:<GraphCanvas points={points} edges={edges} active={active} rotating={rotating} onInteract={()=>setRotating(false)} zoom={zoom} resetKey={resetKey} onHover={setHover} onSelect={setSelected} onOpen={onOpen} onZoom={zoomBy}/>}
      <div className="graph-topbar"><div className="graph-search"><Search size={15}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="筛选标题、目录、标签…" aria-label="搜索图谱节点"/>{query&&<button aria-label="清空图谱搜索" onClick={()=>setQuery('')}><X size={13}/></button>}</div><span className="graph-mode"><span/>{mode==='network'?'2D · 平面关系网':rotating?'3D · 缓慢旋转':'3D · 拖动旋转'}</span></div>
      {!data.nodes.length&&<div className="graph-empty"><Network size={48}/><h2>从第一个想法开始</h2><p>创建笔记，再用 [[笔记名称]] 或共同标签连接它们。</p></div>}
      {data.nodes.length>0&&!visible.nodes.length&&<div className="graph-no-match">当前范围没有匹配节点；可清空搜索或切换文件夹。</div>}
      {visible.nodes.length>0&&visible.edges.length===0&&<div className="graph-unlinked-hint">{localCenter?'当前筛选内还没有相邻笔记。':'当前范围没有已启用的关系；可开启共同标签，或在笔记中添加 [[双向链接]]。'}</div>}
      <div className="graph-legend"><span className="legend-title">关系类型 · 全库数量</span><button className={!showLinks?'muted':''} onClick={()=>setShowLinks(v=>!v)} aria-label="笔记链接关系" aria-pressed={showLinks}><i className="line-sample"/>笔记链接 <span>{counts.links}</span></button><button className={!showTags?'muted':''} onClick={()=>setShowTags(v=>!v)} aria-label="共同标签关系" aria-pressed={showTags}><i className="line-sample dashed"/>共同标签 <span>{counts.tags}</span></button>{mode==='spatial'?<div className="legend-groups">{visibleGroups.slice(0,6).map((g,i)=><span key={g} title={g}><i style={{background:GRAPH_COLORS[i%GRAPH_COLORS.length]}}/>{g?readableFolderPath(g):'根目录'}</span>)}{visibleGroups.length>6&&<span>以及 {visibleGroups.length-6} 个分组</span>}</div>:<div className="network-size-legend"><span><i/>少</span><span><i/>多</span><small>节点大小表示连接数量</small></div>}</div>
      {focused&&<div className={`graph-node-card ${selected?'pinned':''}`}><span className="eyebrow" title={focused.group}>{focused.group?readableFolderPath(focused.group):'根目录'}</span>{selected&&<button className="graph-card-close" aria-label="取消节点选择" onClick={()=>{setSelected(null);setHover(null);}}><X size={13}/></button>}<h3>{focused.title}</h3><p>{focusedPoint?.degree||0} 条当前关系 · {focused.tags.length} 个标签</p><button onClick={()=>onOpen(focused.id)}>打开笔记 <ArrowUpRight size={14}/></button><button onClick={()=>focusNeighborhood(focused.id)}>查看相邻笔记 <Focus size={14}/></button>{!selected&&mode==='network'&&<small>单击节点可固定此卡片</small>}</div>}
      <div className="graph-controls"><button title="缩小" aria-label="缩小" onClick={()=>zoomBy(1/1.2)}><Minus size={17}/></button><span>{Math.round(zoom*100)}%</span><button title="放大" aria-label="放大" onClick={()=>zoomBy(1.2)}><Plus size={17}/></button><i/><button title="重置视角" aria-label="重置视角" onClick={()=>{setRotating(false);reset();}}><Focus size={17}/></button>{mode==='spatial'&&<button title={rotating?'暂停旋转':'自动旋转'} aria-label={rotating?'暂停旋转':'自动旋转'} onClick={()=>setRotating(v=>!v)}>{rotating?<Pause size={16}/>:<Play size={16}/>}</button>}<button title="全屏图谱" aria-label="全屏图谱" onClick={()=>void toggleFullscreen()}><Maximize2 size={16}/></button></div>
      <div className="graph-hint"><MousePointer2 size={13}/>{mode==='network'?'拖动平移 · 滚轮缩放 · 单击选中 · 双击打开':'拖动旋转（操作后暂停自动旋转） · 滚轮缩放 · 双击打开'}</div>
      {fullscreenError&&<div className="graph-fullscreen-error" role="status">{fullscreenError}</div>}
    </div>
    <div className="graph-footer"><span><span className="live-dot"/>{mode==='network'?'连线来自笔记链接与共同标签；靠近不代表语义相似':'关系仅来自笔记链接与共同标签；位置由布局算法计算'}</span><details open={listOpen} onToggle={e=>setListOpen(e.currentTarget.open)}><summary>浏览可见节点 <span>{visible.nodes.length}</span></summary>{listOpen&&<div className="graph-node-list"><div className="graph-node-pagination"><button disabled={safePage===0} onClick={()=>setPage(p=>Math.max(0,p-1))}>上一页</button><span>{safePage+1} / {pageCount} · 每页 100 个</span><button disabled={safePage+1>=pageCount} onClick={()=>setPage(p=>p+1)}>下一页</button></div>{listed.map(n=><button key={n.id} title={n.group} onClick={()=>onOpen(n.id)}><span style={{background:mode==='network'?'#ABB2BF':GRAPH_COLORS[visibleGroups.indexOf(n.group)%GRAPH_COLORS.length]}}/>{n.title}<ArrowUpRight size={13}/></button>)}{!listed.length&&<p>当前没有可见节点</p>}</div>}</details></div>
  </div>;
}
