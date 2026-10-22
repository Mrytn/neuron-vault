import { AlertTriangle, Copy, LockKeyhole } from 'lucide-react';
import type { SourceInfo, SourceStatus } from './types';

export function SourceBadge({status}:{status?:SourceStatus|null}) {
  if (!status) return null;
  const label = status === 'missing_body' ? '正文缺失 · 仅缓存' : status === 'encrypted' ? '加密占位' : '正文已导入';
  return <span className={`source-badge source-${status}`} title={label}>{status === 'encrypted' && <LockKeyhole size={11}/>} {label}</span>;
}

export function SourceDetails({source,onNotice}:{source:SourceInfo;onNotice:(message:string)=>void}) {
  if (!source.sourceId && !source.sourceStatus && !source.sourceHtmlPath) return null;
  const htmlParts=source.sourceHtmlPath?.split('/');
  const originalHtml=htmlParts?.[0]==='assets'&&htmlParts.length>1&&htmlParts.every(p=>p&&p!=='.'&&p!=='..'&&!p.includes('\\'))?'/api/assets/'+htmlParts.slice(1).map(encodeURIComponent).join('/'):null;
  const incomplete = source.sourceStatus === 'missing_body' || source.sourceStatus === 'encrypted';
  async function copy() {
    try { await navigator.clipboard.writeText(source.sourceId || ''); onNotice('原始有道 ID 已复制'); }
    catch { onNotice('无法自动复制，请选中下方原始 ID 手动复制。'); }
  }
  return <div className="source-details">
    <div className="source-provenance"><SourceBadge status={source.sourceStatus}/>{source.sourceId && <span className="source-id"><span>原始有道 ID</span><code title={source.sourceId}>{source.sourceId}</code><button type="button" onClick={()=>void copy()} aria-label="复制原始有道 ID" title="复制原始有道 ID"><Copy size={13}/></button></span>}</div>
    {originalHtml&&<a className="source-html-download" href={originalHtml} download>下载原始 HTML</a>}
    {incomplete && <div className={`source-warning source-${source.sourceStatus}`} role="note"><AlertTriangle size={17}/><div><strong>{source.sourceStatus === 'encrypted' ? '这是加密笔记的占位记录' : '原始正文缺失，当前仅有缓存或占位内容'}</strong><p>{source.sourceStatus === 'encrypted' ? '本次导出没有提供解密后的正文。下面的内容不代表原始完整笔记，需从原来源恢复。' : '请勿将下面的缓存、摘要或占位文字当作完整正文；可根据原始 ID 回到来源核对和恢复。'} 此记录不会作为云问答的正文素材。</p></div></div>}
  </div>;
}
