import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalLink, Image as ImageIcon } from 'lucide-react';

type AstNode = {type:string;value?:string;url?:string;children?:AstNode[]};
function remarkVault(options:{citations?:boolean}={}){
  return (tree:AstNode)=>{
    const visit=(node:AstNode)=>{if(!node.children||node.type==='link'||node.type==='code'||node.type==='inlineCode')return;node.children=node.children.flatMap(child=>{if(child.type!=='text'){visit(child);return [child];}const text=child.value||'',pattern=options.citations?/\[\[([^\]\n]+)\]\]|\[(\d+)\]/g:/\[\[([^\]\n]+)\]\]/g;const out:AstNode[]=[];let cursor=0,match:RegExpExecArray|null;while((match=pattern.exec(text))){if(match.index>cursor)out.push({type:'text',value:text.slice(cursor,match.index)});if(match[1]){const [name,label]=match[1].split('|');out.push({type:'link',url:`#wiki:${encodeURIComponent(name)}`,children:[{type:'text',value:label||name}]});}else out.push({type:'link',url:`#source:${match[2]}`,children:[{type:'text',value:match[2]}]});cursor=match.index+match[0].length;}if(cursor<text.length)out.push({type:'text',value:text.slice(cursor)});return out.length?out:[child];});};visit(tree);
  };
}
function localAsset(src:string|undefined,notePath?:string):string|null{
  if(!src||/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(src))return null;
  try{let decoded=decodeURIComponent(src).replace(/\\/g,'/');if(decoded.startsWith('/api/assets/'))decoded=decoded.slice(4);const url=new URL(decoded,'https://vault.invalid/'+(notePath||''));if(url.origin!=='https://vault.invalid'||!url.pathname.startsWith('/assets/'))return null;return '/api/assets/'+url.pathname.slice(8).split('/').map(part=>encodeURIComponent(decodeURIComponent(part))).join('/');}catch{return null;}
}
function decodeSafe(text:string){try{return decodeURIComponent(text);}catch{return text;}}
function SafeImage({src,alt,notePath}:{src?:string;alt?:string;notePath?:string}){
  const [allowed,setAllowed]=useState(false);
  const [failed,setFailed]=useState(false);const local=localAsset(src,notePath);
  if(local&&!failed)return <img src={local} alt={alt||''} loading="lazy" onError={()=>setFailed(true)}/>;
  if(local&&failed)return <span className="image-placeholder"><ImageIcon size={16}/>{alt||'图片'} <small>附件无法预览或文件未找到</small><a href={local} download>下载原始附件</a></span>;
  // Imported media is not auto-fetched. Loading a remote image is an explicit choice.
  if(!src || !/^https?:\/\//i.test(src))return <span className="image-placeholder"><ImageIcon size={16}/>{alt||'图片'} <small>{failed?'图片未找到，请检查附件文件':'图片路径未指向知识库 assets 目录'}</small></span>;
  let hostname:string;
  try{hostname=new URL(src).hostname;if(!hostname)throw new Error('Missing image host');}
  catch{return <span className="image-placeholder"><ImageIcon size={16}/>{alt||'图片'} <small>图片地址无效，请检查链接格式</small></span>;}
  return allowed?<img src={src} alt={alt||''} loading="lazy" referrerPolicy="no-referrer"/>:<button className="image-consent" onClick={()=>setAllowed(true)}><ImageIcon size={17}/><span>{alt||'外部图片'}<small>点击后从 {hostname} 加载</small></span><ExternalLink size={13}/></button>;
}

export function Markdown({content,onWiki,onSource,notePath}:{content:string;onWiki?:(title:string)=>void;onSource?:(index:number)=>void;notePath?:string}){
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm,[remarkVault,{citations:!!onSource}]]} skipHtml components={{
    img:({src,alt})=><SafeImage key={`${notePath||""}:${src||""}`} src={src} alt={alt} notePath={notePath}/>,
    a:({href,children})=>{
      const attachment=localAsset(href,notePath);if(attachment)return <a href={attachment} download>{children}</a>;
      if(href?.startsWith('#wiki:'))return <button className="wikilink" onClick={()=>onWiki?.(decodeSafe(href.slice(6)))}>{children}</button>;
      if(href?.startsWith('#source:'))return <button className="citation" onClick={()=>onSource?.(Number(href.slice(8))-1)}>{children}</button>;
      if(href?.startsWith('#'))return <span>{children}</span>;
      if(href && !/^https?:\/\//i.test(href) && !/^mailto:/i.test(href))return <button className="wikilink" onClick={()=>onWiki?.(decodeSafe(href))}>{children}</button>;
      return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
    },
    pre:({children})=><pre tabIndex={0}>{children}</pre>,
  }}>{content}</ReactMarkdown></div>;
}
