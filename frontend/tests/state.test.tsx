import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import App from '../src/App';
import Graph from '../src/Graph';
import { Markdown } from '../src/Markdown';
import { Modal, NewNoteDialog, SettingsDialog } from '../src/Dialogs';
import { SourceBadge, SourceDetails } from '../src/SourceStatus';
import { FolderTree } from '../src/FolderTree';
import { buildFolderTree, readableFolderName, readableFolderPath } from '../src/folders';
import { layoutGraph, selectGraph } from '../src/graph-model';
import GraphCanvas from '../src/GraphCanvas';
import NetworkCanvas from '../src/NetworkCanvas';
import type { GraphData, Note } from '../src/types';

// No real network, browser, filesystem vault or model is used by this regression suite.
globalThis.window = { innerWidth: 1440, addEventListener() {}, removeEventListener() {} } as any;
const renderers: ReactTestRenderer[] = [];
afterEach(async () => { await act(async () => { renderers.splice(0).forEach(r => r.unmount()); }); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function note(id: string): Note {
  return { id, title: `笔记 ${id}`, path: `测试/${id}.md`, folder: '测试', content: `正文 ${id}`, tags: [], updatedAt: '2000-01-01T00:00:00Z', excerpt: `正文 ${id}`, wordCount: 4, revision: `v1-${id}`, backlinks: [], outgoing: [] };
}
function server() {
  const notes = new Map(['A', 'B'].map(id => [id, note(id)]));
  const queues = new Map<string, Promise<Response>[]>();
  const calls: string[] = [];
  const requests: { method: string; path: string; body?: string }[] = [];
  globalThis.fetch = async (url: any, init?: RequestInit) => {
    const method = init?.method || 'GET', path = String(url), key = `${method} ${path}`;
    calls.push(key);
    requests.push({ method, path, body: init?.body ? String(init.body) : undefined });
    const queued = queues.get(key)?.shift();
    if (queued) return queued;
    if (path === '/api/notes' && method === 'GET') return response({ notes: [...notes.values()], folders: ['测试'], stats: { notes: notes.size, links: 0, tags: 0 } });
    if (path === '/api/graph') return response({ nodes: [], edges: [] });
    if (path === '/api/settings') return response({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', configured: false, vaultPath: '/test-only' });
    if (path === '/api/trash') return response({ notes: [] });
    const id = path.match(/^\/api\/notes\/([^/]+)$/)?.[1];
    if (id && method === 'GET') return response(notes.get(id));
    throw new Error(`Unexpected test request: ${key}`);
  };
  return { notes, calls, requests, delay(method: string, path: string) {
    let resolve!: (value: Response) => void;
    const promise = new Promise<Response>(done => { resolve = done; });
    const key = `${method} ${path}`;
    queues.set(key, [...(queues.get(key) || []), promise]);
    return { resolve(value: unknown, status = 200) { resolve(response(value, status)); } };
  } };
}
async function mount(createNodeMock?: (element: any) => any) { let renderer!: ReactTestRenderer; await act(async () => { renderer = create(<App />, createNodeMock ? { createNodeMock } : undefined); await tick(); }); renderers.push(renderer); return renderer; }
async function click(renderer: ReactTestRenderer, predicate: (node: any) => boolean) { await act(async () => { const target = renderer.root.findAll(node => node.type === 'button' && predicate(node))[0]; assert.ok(target, 'Expected button'); assert.notEqual(target.props.disabled, true, 'Button must be enabled'); target.props.onClick(); await tick(); }); }
const aria = (label: string) => (node: any) => node.props['aria-label'] === label;
const css = (className: string) => (node: any) => (node.props.className || '').split(' ').includes(className);
const hasText = (text: string) => (node: any) => node.findAll((child: any) => child.type === 'span' || child.type === 'strong').some((child: any) => child.children.includes(text)) || node.children.includes(text);
async function open(renderer: ReactTestRenderer, id: string) { await click(renderer, node => css('note-card')(node) && node.findByType('h3').children.includes(`笔记 ${id}`)); }
function title(renderer: ReactTestRenderer) { return renderer.root.findAll(node => node.type === 'div' && css('document-tab')(node))[0]?.findAllByType('span')[0].children.join('') ?? null; }
async function edit(renderer: ReactTestRenderer, value: string) { await click(renderer, node => node.props.title === '编辑 Markdown'); await act(async () => { renderer.root.findByProps({ 'aria-label': 'Markdown 笔记正文' }).props.onChange({ target: { value } }); }); }
async function settle(callback: () => void) { await act(async () => { callback(); await tick(); }); }

test('late initial GET cannot replace a successfully created note', async () => {
  const mock = server(), old = mock.delay('GET', '/api/notes/A'), posted = mock.delay('POST', '/api/notes');
  const app = await mount();
  await click(app, aria('新建笔记'));
  let creation!: Promise<void>;
  await act(async () => { creation = app.root.findByType(NewNoteDialog).props.onCreate({ title: '笔记 C', folder: '测试', content: '正文 C' }); });
  mock.notes.set('C', note('C'));
  await settle(() => posted.resolve(note('C'))); await creation;
  assert.equal(title(app), '笔记 C');
  await settle(() => old.resolve(note('A')));
  assert.equal(title(app), '笔记 C');
  assert.equal(app.root.findByProps({ 'aria-label': 'Markdown 笔记正文' }).props.value, '正文 C');
});

test('closing a pending create and selecting another note preserves the newer selection', async () => {
  const mock = server(), posted = mock.delay('POST', '/api/notes'), app = await mount();
  await click(app, aria('新建笔记'));
  let creation!: Promise<void>;
  await act(async () => { creation = app.root.findByType(NewNoteDialog).props.onCreate({ title: '笔记 C', folder: '测试', content: '正文 C' }); });
  await settle(() => app.root.findByType(NewNoteDialog).props.onClose());
  await open(app, 'B');
  mock.notes.set('C', note('C'));
  await settle(() => posted.resolve(note('C'))); await creation;
  assert.equal(title(app), '笔记 B');
});

test('late reads cannot leave the graph or reopen a cleared selection', async () => {
  const mock = server(), app = await mount();
  const old = mock.delay('GET', '/api/notes/B');
  await open(app, 'B');
  await click(app, aria('知识图谱'));
  await settle(() => old.resolve(note('B')));
  assert.equal(app.root.findAllByType(Graph).length, 1);
  await click(app, aria('笔记空间'));
  assert.equal(title(app), '笔记 A');
  const late = mock.delay('GET', '/api/notes/B');
  const back = app.root.findByProps({ 'aria-label': '返回笔记列表' }).props.onClick;
  // Two user intents in the same render turn: only the final intent should win.
  await act(async () => { app.root.findAll(node => node.type === 'button' && css('note-card')(node))[1].props.onClick(); back(); await tick(); });
  await settle(() => late.resolve(note('B')));
  assert.equal(title(app), null);
});

test('a late deletion response cannot clear a newer note', async () => {
  const mock = server(), app = await mount();
  await click(app, aria('删除当前笔记'));
  const deleting = mock.delay('DELETE', '/api/notes/A');
  await click(app, css('danger'));
  await settle(() => app.root.findByType(Modal).props.onClose());
  await open(app, 'B');
  mock.notes.delete('A');
  await settle(() => deleting.resolve({ deleted: true }));
  assert.equal(title(app), '笔记 B');
});

test('deleting the active note invalidates an older read', async () => {
  const mock = server(), app = await mount();
  await click(app, aria('删除当前笔记'));
  const confirm = app.root.findAll(node => node.type === 'button' && css('danger')(node))[0].props.onClick;
  const old = mock.delay('GET', '/api/notes/B'), deleting = mock.delay('DELETE', '/api/notes/A');
  await open(app, 'B');
  await settle(() => confirm());
  mock.notes.delete('A');
  await settle(() => deleting.resolve({ deleted: true }));
  await settle(() => old.resolve(note('B')));
  assert.equal(title(app), null);
});

test('a stale save result cannot overwrite another note after a newer selection', async () => {
  const mock = server(), app = await mount();
  // This is a formerly captured, already-authorized clean navigation intent.
  const selectB = app.root.findAll(node => node.type === 'button' && css('note-card')(node))[1].props.onClick;
  await edit(app, 'A 的待保存草稿');
  const saving = mock.delay('PUT', '/api/notes/A');
  await click(app, css('save-button'));
  await settle(() => selectB());
  assert.equal(title(app), '笔记 B');
  const saved = { ...note('A'), content: 'A 的待保存草稿', revision: 'v2-A' };
  mock.notes.set('A', saved);
  await settle(() => saving.resolve(saved));
  assert.equal(title(app), '笔记 B');
  await click(app, node => node.props.title === '编辑 Markdown');
  assert.equal(app.root.findByProps({ 'aria-label': 'Markdown 笔记正文' }).props.value, '正文 B');
});

test('an error from a stale save is not attached to the newly selected note', async () => {
  const mock = server(), app = await mount();
  const selectB = app.root.findAll(node => node.type === 'button' && css('note-card')(node))[1].props.onClick;
  await edit(app, 'A 的草稿');
  const saving = mock.delay('PUT', '/api/notes/A');
  await click(app, css('save-button'));
  await settle(() => selectB());
  await settle(() => saving.resolve({ error: 'conflict' }, 409));
  assert.equal(title(app), '笔记 B');
  assert.equal(app.root.findAll(node => node.type === 'div' && css('save-error')(node)).length, 0);
});

test('edits typed during save remain dirty and are not replaced by the saved snapshot', async () => {
  const mock = server(), app = await mount();
  await edit(app, '第一版');
  const saving = mock.delay('PUT', '/api/notes/A');
  await click(app, css('save-button'));
  await act(async () => { app.root.findByProps({ 'aria-label': 'Markdown 笔记正文' }).props.onChange({ target: { value: '保存期间的新修改' } }); });
  const saved = { ...note('A'), content: '第一版', revision: 'v2-A' }; mock.notes.set('A', saved);
  await settle(() => saving.resolve(saved));
  assert.equal(app.root.findByProps({ 'aria-label': 'Markdown 笔记正文' }).props.value, '保存期间的新修改');
  assert.equal(app.root.findAll(node => node.type === 'button' && css('save-button')(node))[0].props.disabled, false);
  await open(app, 'B');
  assert.equal(title(app), '笔记 A');
  assert.equal(app.root.findByType(Modal).props.title, '先安放好这个想法');
  await click(app, hasText('放弃修改'));
  assert.equal(title(app), '笔记 B');
});

test('retrying a failed connection retains the unsaved-change confirmation', async () => {
  const mock = server(), app = await mount(), refresh = mock.delay('GET', '/api/notes');
  await click(app, aria('重新读取本地文件'));
  await settle(() => refresh.resolve({ error: 'unavailable' }, 503));
  await edit(app, '不能被重试覆盖的草稿');
  const callsBefore = mock.calls.length;
  await click(app, hasText('重试连接'));
  assert.equal(mock.calls.length, callsBefore);
  assert.equal(app.root.findByType(Modal).props.title, '先安放好这个想法');
  assert.equal(app.root.findByProps({ 'aria-label': 'Markdown 笔记正文' }).props.value, '不能被重试覆盖的草稿');
});

test('typing while a refresh is pending prevents that refresh from replacing the draft', async () => {
  const mock = server(), app = await mount(), refresh = mock.delay('GET', '/api/notes');
  await click(app, aria('重新读取本地文件'));
  await edit(app, '刷新期间的新修改');
  await settle(() => refresh.resolve({ notes: [...mock.notes.values()], folders: ['测试'], stats: { notes: 2, links: 0, tags: 0 } }));
  assert.equal(app.root.findByProps({ 'aria-label': 'Markdown 笔记正文' }).props.value, '刷新期间的新修改');
  assert.equal(app.root.findAll(node => node.type === 'button' && css('save-button')(node))[0].props.disabled, false);
});

test('save-and-continue does not leave when another edit was made during its pending save', async () => {
  const mock = server(), app = await mount();
  await edit(app, '提交版本');
  await open(app, 'B');
  const saving = mock.delay('PUT', '/api/notes/A');
  await click(app, hasText('保存并继续'));
  await act(async () => { app.root.findByProps({ 'aria-label': 'Markdown 笔记正文' }).props.onChange({ target: { value: '必须留下的新修改' } }); });
  const saved = { ...note('A'), content: '提交版本', revision: 'v2-A' }; mock.notes.set('A', saved);
  await settle(() => saving.resolve(saved));
  assert.equal(title(app), '笔记 A');
  assert.equal(app.root.findByProps({ 'aria-label': 'Markdown 笔记正文' }).props.value, '必须留下的新修改');
  assert.equal(app.root.findByType(Modal).props.title, '先安放好这个想法');
});

test('save-and-continue opens the intended note after the unchanged draft is saved', async () => {
  const mock = server(), app = await mount();
  await edit(app, '保存后可以离开');
  await open(app, 'B');
  const saving = mock.delay('PUT', '/api/notes/A');
  await click(app, hasText('保存并继续'));
  const saved = { ...note('A'), content: '保存后可以离开', revision: 'v2-A' }; mock.notes.set('A', saved);
  await settle(() => saving.resolve(saved));
  assert.equal(title(app), '笔记 B');
  assert.equal(app.root.findAllByType(Modal).length, 0);
});

test('remote-image permission and local-image failures do not carry to the next source', async () => {
  let markdown!: ReactTestRenderer;
  await act(async () => { markdown = create(<Markdown content="![A](https://example.com/a.png)" notePath="one.md" />); }); renderers.push(markdown);
  await click(markdown, css('image-consent'));
  assert.equal(markdown.root.findAllByType('img').length, 1);
  await act(async () => { markdown.update(<Markdown content="![B](https://example.com/b.png)" notePath="two.md" />); });
  assert.equal(markdown.root.findAllByType('img').length, 0);
  assert.equal(markdown.root.findAll(node => node.type === 'button' && css('image-consent')(node)).length, 1);
  await act(async () => { markdown.update(<Markdown content="![本地](../assets/old.png)" notePath="folder/one.md" />); });
  await act(async () => { markdown.root.findByType('img').props.onError(); });
  assert.equal(markdown.root.findAllByType('img').length, 0);
  await act(async () => { markdown.update(<Markdown content="![本地](../assets/new.png)" notePath="folder/two.md" />); });
  assert.equal(markdown.root.findByType('img').props.src, '/api/assets/new.png');
});

test('malformed remote images render a placeholder without crashing surrounding Markdown', () => {
  for (const url of ['https://', 'http://', 'https://[broken-host]']) {
    const html = renderToStaticMarkup(<Markdown content={`before\n\n![bad](${url})\n\nafter`} />);
    assert.match(html, /图片地址无效/); assert.match(html, /before/); assert.match(html, /after/); assert.doesNotMatch(html, /<img/);
  }
});

test('the model field permits an empty value to disable cloud answering', async () => {
  server(); let settings!: ReactTestRenderer;
  await act(async () => { settings = create(<SettingsDialog onClose={() => {}} onSaved={() => {}} />); await tick(); }); renderers.push(settings);
  const model = settings.root.findAllByType('input').find(input => input.props.placeholder === '服务商提供的模型标识');
  assert.ok(model); assert.notEqual(model.props.required, true);
});

test('import provenance distinguishes complete, cached and encrypted records and downloads original HTML safely', () => {
  const missing=renderToStaticMarkup(<SourceDetails source={{sourceId:'youdao-original-123',sourceStatus:'missing_body',sourceHtmlPath:'assets/youdao-export/中文/原文.html'}} onNotice={()=>{}}/>);
  assert.match(missing,/原始有道 ID/);assert.match(missing,/youdao-original-123/);assert.match(missing,/当前仅有缓存或占位内容/);assert.match(missing,/不代表|请勿/);assert.match(missing,/不会作为云问答/);
  assert.match(missing,/href="\/api\/assets\/youdao-export\/%E4%B8%AD%E6%96%87\/%E5%8E%9F%E6%96%87.html" download/);
  const encrypted=renderToStaticMarkup(<SourceDetails source={{sourceStatus:'encrypted'}} onNotice={()=>{}}/>);
  assert.match(encrypted,/加密笔记的占位记录/);assert.match(encrypted,/没有提供解密后的正文/);
  const complete=renderToStaticMarkup(<SourceDetails source={{sourceStatus:'ok'}} onNotice={()=>{}}/>);
  assert.match(complete,/正文已导入/);assert.doesNotMatch(complete,/source-warning/);
  for(const path of ['assets/../secret.html','https://example.com/remote.html','assets/a/../../x.html'])assert.doesNotMatch(renderToStaticMarkup(<SourceDetails source={{sourceHtmlPath:path}} onNotice={()=>{}}/>),/href=/);
});

test('original source ID can be copied without changing the note', async () => {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');let copied='',notice='';
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async(text:string)=>{copied=text;}}}});
  try {
    let source!:ReactTestRenderer;await act(async()=>{source=create(<SourceDetails source={{sourceId:'original-id'}} onNotice={text=>{notice=text;}}/>);});renderers.push(source);
    await click(source,aria('复制原始有道 ID'));assert.equal(copied,'original-id');assert.match(notice,/已复制/);
  } finally {if(previous)Object.defineProperty(globalThis,'navigator',previous);else delete (globalThis as any).navigator;}
});

test('note detail, list, search and trash show the source status returned by the API', async () => {
  const mock=server();mock.notes.set('A',{...note('A'),sourceId:'source-A',sourceStatus:'missing_body'});mock.notes.set('B',{...note('B'),sourceId:'source-B',sourceStatus:'encrypted'});
  const app=await mount();
  assert.equal(app.root.findByType(SourceDetails).props.source.sourceId,'source-A');
  const cards=app.root.findAll(node=>node.type==='button'&&css('note-card')(node));
  assert.deepEqual(cards.map(card=>card.findByType(SourceBadge).props.status),['missing_body','encrypted']);
  const search=mock.delay('GET','/api/search?q=%E7%BC%93%E5%AD%98');
  await click(app,aria('全局搜索'));
  await act(async()=>{app.root.findByProps({'aria-label':'搜索知识库'}).props.onChange({target:{value:'缓存'}});await new Promise(resolve=>setTimeout(resolve,250));});
  await settle(()=>search.resolve({results:[{id:'A',title:'缓存笔记',path:'测试/A.md',excerpt:'缓存',line:1,score:1,sourceId:'source-A',sourceStatus:'missing_body'}]}));
  assert.equal(app.root.findAll(node=>node.type==='button'&&css('search-result')(node))[0].findByType(SourceBadge).props.status,'missing_body');
  await settle(()=>app.root.findByType(Modal).props.onClose());
  const trash=mock.delay('GET','/api/trash');
  await click(app,hasText('回收站'));await settle(()=>trash.resolve({notes:[mock.notes.get('B')]}));
  assert.equal(app.root.findAll(node=>node.type==='div'&&css('trash-card')(node))[0].findByType(SourceBadge).props.status,'encrypted');
});

test('directory display removes only Youdao export suffixes while retaining distinct paths and subtree counts', () => {
  const first='有道/笔记/AI__F1E273A3/deep learning__40A9E5E4/CNN__0ac62786',second='有道/笔记/AI__AAAAAAAA';
  assert.equal(readableFolderPath(first),'有道/笔记/AI/deep learning/CNN');
  assert.equal(readableFolderName('项目/AI__F1E273A3'),'AI__F1E273A3');
  assert.equal(readableFolderName('有道/笔记/AI__nothex12'),'AI__nothex12');
  const tree=buildFolderTree([first,second,'有道/笔记/空目录__12345678'],[{...note('A'),folder:first},{...note('B'),folder:second}]);
  assert.equal(tree[0].count,2);const children=tree[0].children[0].children;
  assert.equal(children.filter(n=>n.name==='AI').length,2);
  assert.notEqual(children[0].path,children[1].path);assert.equal(children.find(n=>n.name==='空目录')?.count,0);
});

test('a large directory tree starts collapsed and search reveals matching descendants with original path tooltips', async () => {
  const folders=Array.from({length:256},(_,i)=>`有道/笔记/${i===255?'唯一目标':'目录'+i}__${i.toString(16).padStart(8,'0')}`);let tree!:ReactTestRenderer,selected='';
  await act(async()=>{tree=create(<FolderTree folders={folders} notes={[]} selected={null} onSelect={path=>{selected=path;}}/>);});renderers.push(tree);
  assert.equal(tree.root.findAll(node=>node.props.role==='treeitem').length,1);
  await act(async()=>{tree.root.findByProps({'aria-label':'筛选文件夹'}).props.onChange({target:{value:'唯一目标'}});});
  assert.equal(tree.root.findAll(node=>node.props.role==='treeitem').length,3);
  const button=tree.root.findAll(node=>node.type==='button'&&css('folder-select')(node)).find(node=>node.props.title===folders[255]);assert.ok(button);
  assert.equal(button.findByType('span').children.join(''),'唯一目标');await settle(()=>button.props.onClick());assert.equal(selected,folders[255]);
  await click(tree,hasText('全部折叠'));assert.equal(tree.root.findAll(node=>node.props.role==='treeitem').length,1);
});

function largeGraph(count=1200):GraphData {
  const nodes=Array.from({length:count},(_,i)=>({id:String(i),title:`节点 ${i}`,group:`有道/笔记/分组${i%3}__${(i%3).toString(16).padStart(8,'0')}`,tags:i%2?['Java']:['AI']}));
  return {nodes,edges:nodes.slice(1).map((node,i)=>({source:String(i),target:node.id,type:'link',label:'真实双链'})).concat(nodes.slice(0,100).map((node,i)=>({source:node.id,target:String((i+3)%count),type:'tag' as any,label:'真实标签'})))};
}
function graphCanvas(graph: ReactTestRenderer) {
  const canvases = graph.root.findAll(node => node.type === NetworkCanvas || node.type === GraphCanvas);
  assert.equal(canvases.length, 1, 'Only the selected graph mode should be mounted');
  return canvases[0];
}
function graphFixture(): GraphData {
  return {
    nodes: [
      { id: 'A', title: '核心笔记', group: '技术/Java', tags: ['AI'] },
      { id: 'B', title: '相邻实践', group: '技术/Java', tags: ['AI'] },
      { id: 'C', title: '跨目录笔记', group: '生活', tags: ['AI'] },
      { id: 'D', title: '二级联系', group: '技术/Java', tags: ['AI'] },
      { id: 'E', title: '孤立节点', group: '技术/Java', tags: ['AI'] },
      { id: 'F', title: '标签联系', group: '技术/Java', tags: ['AI'] },
    ],
    edges: [
      { source: 'A', target: 'B', type: 'link', label: '真实双链' },
      { source: 'A', target: 'C', type: 'link', label: '真实双链' },
      { source: 'B', target: 'D', type: 'link', label: '真实双链' },
      { source: 'A', target: 'F', type: 'tag', label: 'AI' },
      { source: 'B', target: 'F', type: 'link', label: '真实双链' },
      { source: 'D', target: 'E', type: 'tag', label: 'AI' },
    ],
  };
}
async function mountGraph(data = graphFixture(), onOpen: (id: string) => void = () => {}) {
  let graph!: ReactTestRenderer;
  await act(async () => { graph = create(<Graph data={data} onOpen={onOpen} />); });
  renderers.push(graph);
  return graph;
}
const visibleGraphIds = (graph: ReactTestRenderer) => graphCanvas(graph).props.points.map((point: any) => point.node.id).sort();
const graphCards = (graph: ReactTestRenderer) => graph.root.findAll(node => node.type === 'div' && css('graph-node-card')(node));
async function changeGraphFilter(graph: ReactTestRenderer, label: string, value: string) {
  await settle(() => graph.root.findByProps({ 'aria-label': label }).props.onChange({ target: { value } }));
}
test('large graph filtering keeps every matching node and only real edges with both endpoints in scope', t => {
  const data=largeGraph(),start=performance.now(),points=layoutGraph(data),elapsed=performance.now()-start;
  assert.equal(points.length,1200);assert.equal(new Set(points.map(p=>p.node.id)).size,1200);assert.ok(points.every(p=>[p.x,p.y,p.z].every(Number.isFinite)));
  const scoped=selectGraph(data,data.nodes[0].group,'',true,true),ids=new Set(scoped.nodes.map(n=>n.id));assert.equal(scoped.nodes.length,400);
  assert.ok(scoped.edges.every(edge=>data.edges.includes(edge)&&ids.has(edge.source)&&ids.has(edge.target)));
  assert.equal(selectGraph(data,'','节点 1199',true,true).nodes.length,1);
  assert.equal(selectGraph(data,'不存在的目录','',true,true).nodes.length,0);
  t.diagnostic(`1200-node layout: ${elapsed.toFixed(2)} ms; no nodes omitted`);
});

test('a large sparse graph retains its real tag edges by default and supports folder/search focus and paged node browsing', async () => {
  const data=largeGraph();let graph!:ReactTestRenderer;await act(async()=>{graph=create(<Graph data={data} onOpen={()=>{}}/>);});renderers.push(graph);
  assert.equal(graphCanvas(graph).type,GraphCanvas);assert.equal(graphCanvas(graph).props.points.length,1200);
  assert.deepEqual(graphCanvas(graph).props.edges,data.edges,'Sparse real tag edges must remain visible even in a large vault');
  assert.equal(graph.root.findByProps({'aria-label':'共同标签关系'}).props['aria-pressed'],true);
  const count=()=>graph.root.findAll(node=>node.type==='span'&&css('graph-visible-count')(node))[0].children.join('');assert.match(count(),/1200 \/ 1200/);
  await act(async()=>{graph.root.findByType('details').props.onToggle({currentTarget:{open:true}});});
  assert.equal(graph.root.findAll(node=>node.type==='div'&&css('graph-node-list')(node))[0].findAll(node=>node.type==='button'&&node.props.title!==undefined).length,100);
  await act(async()=>{graph.root.findByProps({'aria-label':'图谱文件夹范围'}).props.onChange({target:{value:data.nodes[0].group}});});assert.equal(graphCanvas(graph).props.points.length,400);assert.match(count(),/400 \/ 1200/);
  await act(async()=>{graph.root.findByProps({'aria-label':'搜索图谱节点'}).props.onChange({target:{value:'节点 1199'}});});assert.equal(graphCanvas(graph).props.points.length,0);
  await act(async()=>{graph.root.findByProps({'aria-label':'图谱文件夹范围'}).props.onChange({target:{value:''}});});assert.equal(graphCanvas(graph).props.points.length,1);
});

test('dense graph draws only explicit hovered-node relationships without dropping nodes', async () => {
  const data=largeGraph(600);data.edges=data.nodes.flatMap(node=>Array.from({length:10},(_,i)=>({source:node.id,target:String((Number(node.id)+i+1)%600),type:'tag' as const,label:'共享标签'})));
  let graph!:ReactTestRenderer;await act(async()=>{graph=create(<Graph data={data} onOpen={()=>{}}/>);});renderers.push(graph);
  await click(graph,aria('共同标签关系'));assert.equal(graphCanvas(graph).props.edges.length,0);assert.equal(graphCanvas(graph).props.points.length,600);
  assert.match(graph.root.findAll(node=>node.type==='div'&&css('graph-scale-note')(node))[0].children.join(''),/仅绘制悬停或选中节点/);
  await settle(()=>graphCanvas(graph).props.onHover('0'));
  const shown=graphCanvas(graph).props.edges;assert.ok(shown.length>0&&shown.length<6000);assert.ok(shown.every((e:any)=>data.edges.includes(e)&&(e.source==='0'||e.target==='0')));
});

test('the default 3D view rotates until interaction and stops its spatial renderer when switched to 2D', async () => {
  const graph = await mountGraph();
  assert.equal(graphCanvas(graph).type, GraphCanvas);
  assert.equal(graph.root.findByProps({ 'aria-label': '切换三维图谱视图' }).props['aria-pressed'], true);
  assert.equal(graph.root.findByProps({ 'aria-label': '切换关系网络视图' }).props['aria-pressed'], false);
  assert.equal(graphCanvas(graph).props.rotating, true);
  assert.equal(graph.root.findAllByProps({ 'aria-label': '暂停旋转' }).length, 1);
  await settle(() => graphCanvas(graph).props.onInteract());
  assert.equal(graphCanvas(graph).props.rotating, false, 'A gesture must stop automatic rotation');
  assert.equal(graph.root.findAllByProps({ 'aria-label': '自动旋转' }).length, 1);
  await click(graph, aria('自动旋转'));
  assert.equal(graphCanvas(graph).props.rotating, true);
  await click(graph, aria('切换关系网络视图'));
  assert.equal(graphCanvas(graph).type, NetworkCanvas);
  assert.equal(graph.root.findAllByType(GraphCanvas).length, 0, 'The rotating spatial canvas must be unmounted in 2D');
  assert.equal(graph.root.findAllByProps({ 'aria-label': '暂停旋转' }).length, 0);
  assert.equal(graph.root.findAllByProps({ 'aria-label': '自动旋转' }).length, 0);
  await click(graph, aria('切换三维图谱视图'));
  assert.equal(graphCanvas(graph).props.rotating, true, 'Returning to 3D restarts the gentle preview when motion is allowed');
});

test('reduced-motion preference keeps the initial and re-entered 3D view still', async () => {
  const saved = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  const queries: string[] = [];
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: (query: string) => {
    queries.push(query);
    return { matches: query === '(prefers-reduced-motion: reduce)' };
  } });
  try {
    const graph = await mountGraph();
    assert.equal(graphCanvas(graph).type, GraphCanvas);
    assert.equal(graph.root.findByProps({ 'aria-label': '切换三维图谱视图' }).props['aria-pressed'], true);
    assert.equal(graphCanvas(graph).props.rotating, false);
    assert.equal(graph.root.findAllByProps({ 'aria-label': '自动旋转' }).length, 1);
    await click(graph, aria('切换关系网络视图'));
    await click(graph, aria('切换三维图谱视图'));
    assert.equal(graphCanvas(graph).props.rotating, false);
    assert.ok(queries.includes('(prefers-reduced-motion: reduce)'));
  } finally {
    if (saved) Object.defineProperty(window, 'matchMedia', saved);
    else delete (window as any).matchMedia;
  }
});

test('switching between spatial and network views preserves the query, folder and relationship filters', async () => {
  const graph = await mountGraph();
  assert.equal(graphCanvas(graph).type, GraphCanvas);
  assert.equal(graph.root.findByProps({ 'aria-label': '切换三维图谱视图' }).props['aria-pressed'], true);
  await changeGraphFilter(graph, '图谱文件夹范围', '技术');
  await changeGraphFilter(graph, '搜索图谱节点', '相邻实践');
  await click(graph, aria('共同标签关系'));
  for (const [label, component] of [['切换关系网络视图', NetworkCanvas], ['切换三维图谱视图', GraphCanvas]] as const) {
    await click(graph, aria(label));
    assert.equal(graphCanvas(graph).type, component);
    assert.equal(graph.root.findByProps({ 'aria-label': label }).props['aria-pressed'], true);
    assert.equal(graph.root.findByProps({ 'aria-label': '搜索图谱节点' }).props.value, '相邻实践');
    assert.equal(graph.root.findByProps({ 'aria-label': '图谱文件夹范围' }).props.value, '技术');
    assert.equal(graph.root.findByProps({ 'aria-label': '共同标签关系' }).props['aria-pressed'], false);
    assert.deepEqual(visibleGraphIds(graph), ['B']);
  }
});

test('selecting a 2D node pins its card without opening the note or losing it on pointer leave', async () => {
  const opened: string[] = [], graph = await mountGraph(graphFixture(), id => opened.push(id));
  await click(graph, aria('切换关系网络视图'));
  assert.equal(graphCanvas(graph).type, NetworkCanvas);
  await settle(() => graphCanvas(graph).props.onSelect('A'));
  assert.deepEqual(opened, []);
  assert.equal(graphCards(graph).length, 1);
  assert.ok(css('pinned')(graphCards(graph)[0]));
  await settle(() => graphCanvas(graph).props.onHover('B'));
  assert.equal(graphCards(graph)[0].findByType('h3').children.join(''), '核心笔记');
  await settle(() => graphCanvas(graph).props.onHover(null));
  assert.equal(graphCards(graph)[0].findByType('h3').children.join(''), '核心笔记');
  await click(graph, hasText('打开笔记 '));
  assert.deepEqual(opened, ['A']);
  await click(graph, aria('取消节点选择'));
  assert.equal(graphCards(graph).length, 0);
  assert.deepEqual(visibleGraphIds(graph), ['A', 'B', 'C', 'D', 'E', 'F']);
});

test('neighborhood scope respects filters and real edges, survives deselection and mode changes, and returns to the filtered overview', async () => {
  const data = graphFixture(), graph = await mountGraph(data);
  await changeGraphFilter(graph, '图谱文件夹范围', '技术');
  await changeGraphFilter(graph, '搜索图谱节点', 'AI');
  await click(graph, aria('共同标签关系'));
  await settle(() => graphCanvas(graph).props.onSelect('A'));
  await click(graph, hasText('查看相邻笔记 '));
  assert.deepEqual(visibleGraphIds(graph), ['A', 'B']);
  assert.deepEqual(graphCanvas(graph).props.edges, [data.edges[0]]);
  await click(graph, aria('共同标签关系'));
  assert.deepEqual(visibleGraphIds(graph), ['A', 'B', 'F']);
  const edges = graphCanvas(graph).props.edges, visible = new Set(visibleGraphIds(graph));
  assert.deepEqual(edges, [data.edges[0], data.edges[3], data.edges[4]]);
  assert.ok(edges.every((edge: any) => data.edges.includes(edge) && visible.has(edge.source) && visible.has(edge.target)));
  await settle(() => graphCanvas(graph).props.onSelect('F'));
  await click(graph, aria('共同标签关系'));
  assert.deepEqual(visibleGraphIds(graph), ['A', 'B']);
  assert.equal(graphCards(graph).length, 0, 'A disabled relationship cannot leave a stale selected-node card');
  await settle(() => graphCanvas(graph).props.onSelect('A'));
  await click(graph, aria('取消节点选择'));
  assert.equal(graphCards(graph).length, 0);
  assert.deepEqual(visibleGraphIds(graph), ['A', 'B'], 'Deselecting must not leave the neighborhood');
  await click(graph, aria('切换关系网络视图'));
  assert.deepEqual(visibleGraphIds(graph), ['A', 'B']);
  await click(graph, aria('切换三维图谱视图'));
  assert.deepEqual(visibleGraphIds(graph), ['A', 'B']);
  await click(graph, hasText('返回全局网络'));
  assert.deepEqual(visibleGraphIds(graph), ['A', 'B', 'D', 'E', 'F']);
  assert.equal(graphCards(graph).length, 0);
  assert.equal(graph.root.findByProps({ 'aria-label': '搜索图谱节点' }).props.value, 'AI');
  assert.equal(graph.root.findByProps({ 'aria-label': '图谱文件夹范围' }).props.value, '技术');
  assert.equal(graph.root.findAll(node => node.type === 'div' && css('graph-local-scope')(node)).length, 0);
});

test('query and folder changes remove a selected-node card instead of reviving it outside the new scope', async () => {
  const graph = await mountGraph();
  await settle(() => graphCanvas(graph).props.onSelect('A'));
  await changeGraphFilter(graph, '搜索图谱节点', '相邻实践');
  assert.deepEqual(visibleGraphIds(graph), ['B']);
  assert.equal(graphCards(graph).length, 0);
  await changeGraphFilter(graph, '搜索图谱节点', '');
  assert.equal(graphCards(graph).length, 0);
  await settle(() => graphCanvas(graph).props.onSelect('A'));
  await click(graph, hasText('查看相邻笔记 '));
  await changeGraphFilter(graph, '图谱文件夹范围', '生活');
  assert.deepEqual(visibleGraphIds(graph), ['C']);
  assert.equal(graphCards(graph).length, 0);
  assert.equal(graph.root.findAll(node => node.type === 'div' && css('graph-local-scope')(node)).length, 0);
  await changeGraphFilter(graph, '图谱文件夹范围', '');
  await click(graph, aria('切换关系网络视图'));
  assert.equal(graphCards(graph).length, 0);
});

test('the native keyboard-operable node list opens notes in both graph modes', async () => {
  const opened: string[] = [], graph = await mountGraph(graphFixture(), id => opened.push(id));
  await settle(() => graph.root.findByType('details').props.onToggle({ currentTarget: { open: true } }));
  for (const [title, id, mode] of [['相邻实践', 'B', '切换关系网络视图'], ['跨目录笔记', 'C', '切换三维图谱视图']] as const) {
    await click(graph, aria(mode));
    const list = graph.root.findAll(node => node.type === 'div' && css('graph-node-list')(node))[0];
    const button = list.findAll(node => node.type === 'button' && node.children.includes(title))[0];
    assert.ok(button, 'Visible nodes need native buttons for keyboard activation');
    assert.notEqual(button.props.disabled, true);
    assert.notEqual(button.props.tabIndex, -1);
    // Native buttons dispatch click for Enter/Space. Exercise that handler without pretending to emulate browser key handling.
    await settle(() => button.props.onClick({ type: 'click', detail: 0 }));
    assert.equal(opened.at(-1), id);
  }
  assert.deepEqual(opened, ['B', 'C']);
});

test('an idle 1200-node canvas stops scheduling frames and redraws only after interaction', async () => {
  const saved=new Map(['document','ResizeObserver','requestAnimationFrame','cancelAnimationFrame'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const frames=new Map<number,FrameRequestCallback>();let sequence=0;
  const context=new Proxy({},{get:(_,key)=>key==='createRadialGradient'?()=>({addColorStop(){}}):key==='measureText'?()=>({width:60}):()=>{},set:()=>true});
  const element={parentElement:{getBoundingClientRect:()=>({width:800,height:600})},getContext:()=>context,style:{},width:0,height:0,getBoundingClientRect:()=>({left:0,top:0}),setPointerCapture(){}};
  Object.defineProperty(globalThis,'document',{configurable:true,value:{hidden:false,addEventListener(){},removeEventListener(){}}});
  Object.defineProperty(globalThis,'ResizeObserver',{configurable:true,value:class{observe(){}disconnect(){}}});
  Object.defineProperty(globalThis,'requestAnimationFrame',{configurable:true,value:(fn:FrameRequestCallback)=>{frames.set(++sequence,fn);return sequence;}});
  Object.defineProperty(globalThis,'cancelAnimationFrame',{configurable:true,value:(id:number)=>frames.delete(id)});
  let graph:ReactTestRenderer|undefined;
  try {
    await act(async()=>{graph=create(<GraphCanvas points={layoutGraph(largeGraph())} edges={[]} active={null} rotating={false} zoom={1} resetKey={0} onHover={()=>{}} onOpen={()=>{}} onZoom={()=>{}}/>,{createNodeMock:node=>node.type==='canvas'?element:null});});
    assert.equal(frames.size,1);const first=[...frames.values()];frames.clear();first.forEach(fn=>fn(0));assert.equal(frames.size,0,'Idle rendering must not schedule another animation frame');
    const canvas=graph!.root.findByType('canvas');await act(async()=>{canvas.props.onPointerDown({clientX:20,clientY:20,pointerId:1,currentTarget:element});canvas.props.onPointerMove({clientX:50,clientY:40,currentTarget:element});});assert.equal(frames.size,1);
    const redraw=[...frames.values()];frames.clear();redraw.forEach(fn=>fn(40));assert.equal(frames.size,0);
  } finally {await act(async()=>graph?.unmount());for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as any)[key];}}
});

test('a failed local asset preview preserves a same-origin download link', async () => {
  let markdown!:ReactTestRenderer;await act(async()=>{markdown=create(<Markdown content="![图](../assets/youdao/原图.svg)" notePath="笔记/one.md"/>);});renderers.push(markdown);
  await settle(()=>markdown.root.findByType('img').props.onError());const link=markdown.root.findByType('a');assert.equal(link.props.href,'/api/assets/youdao/%E5%8E%9F%E5%9B%BE.svg');assert.equal(link.props.download,true);assert.equal(link.children.join(''),'下载原始附件');
});

test('asset URLs are normalized before granting a local image or download link', () => {
  for(const path of ['/api/assets/../settings','/api/assets/%2e%2e/settings','../private.txt','%2F%2Fevil.example/assets/x.svg']) {
    const html=renderToStaticMarkup(<Markdown content={`![文件](${path})`} notePath="笔记/note.md"/>);
    assert.doesNotMatch(html,/<img|download=/);
  }
  assert.match(renderToStaticMarkup(<Markdown content="![图片](/api/assets/中文.png)"/>),/src="\/api\/assets\/%E4%B8%AD%E6%96%87.png"/);
});


test('a suggested question submits immediately, shows progress, and opens its note source', async () => {
  const mock = server(), answer = mock.delay('POST', '/api/ask'), app = await mount();
  const prompt = '有哪些关于 AI 应用的实践？';
  await click(app, node => css('suggestion')(node) && node.children.includes(prompt));
  const requests = mock.requests.filter(request => request.path === '/api/ask');
  assert.equal(requests.length, 1, 'Clicking a suggestion must send a request, not only fill the composer');
  assert.deepEqual(JSON.parse(requests[0].body!), { question: prompt });
  assert.ok(app.root.findAll(node => css('user-question')(node)).some(node => node.findByType('p').children.includes(prompt)));
  assert.equal(app.root.findByProps({ role: 'status' }).props['aria-live'], 'polite');
  await settle(() => answer.resolve({ mode: 'local', answer: '找到相关笔记 [1]', sources: [{ id: 'B', title: '笔记 B', path: '测试/B.md', excerpt: '正文 B', line: 1 }] }));
  assert.equal(app.root.findAll(node => css('assistant-thinking')(node)).length, 0);
  const source = app.root.findAll(node => css('answer-sources')(node))[0].findByType('button');
  await settle(() => source.props.onClick());
  assert.equal(title(app), '笔记 B');
  assert.equal(app.root.findByProps({ 'aria-label': 'Markdown 笔记正文' }).props.value, '正文 B');
});

test('rapid repeated suggestion clicks cannot start duplicate requests', async () => {
  const mock = server(), answer = mock.delay('POST', '/api/ask'), app = await mount();
  const suggest = app.root.findAll(node => node.type === 'button' && css('suggestion')(node))[0].props.onClick;
  await act(async () => { suggest(); suggest(); await tick(); });
  assert.equal(mock.calls.filter(call => call === 'POST /api/ask').length, 1);
  await settle(() => answer.resolve({ mode: 'local', answer: '没有匹配片段', sources: [] }));
  assert.equal(app.root.findAll(node => css('exchange')(node)).length, 1);
});

test('failed suggested questions display an error and remain available for retry', async () => {
  const mock = server(), answer = mock.delay('POST', '/api/ask'), app = await mount();
  const prompt = '如何规划我的下一步学习？';
  await click(app, node => css('suggestion')(node) && node.children.includes(prompt));
  await settle(() => answer.resolve({ error: '检索服务暂不可用' }, 503));
  assert.ok(app.root.findByProps({ role: 'alert' }).children.includes('检索服务暂不可用'));
  assert.equal(app.root.findByProps({ 'aria-label': '知识库问题' }).props.value, prompt);
  const retry = mock.delay('POST', '/api/ask');
  await click(app, aria('发送问题'));
  await settle(() => retry.resolve({ mode: 'local', answer: '检索已恢复', sources: [] }));
  assert.equal(mock.calls.filter(call => call === 'POST /api/ask').length, 2);
  assert.equal(app.root.findAllByProps({ role: 'alert' }).length, 0);
});

test('a failed earlier question does not erase the next question typed during retrieval', async () => {
  const mock = server(), answer = mock.delay('POST', '/api/ask'), app = await mount();
  await click(app, css('suggestion'));
  assert.equal(mock.calls.filter(call => call === 'POST /api/ask').length, 1);
  await act(async () => { app.root.findByProps({ 'aria-label': '知识库问题' }).props.onChange({ target: { value: '我正在写的下一问' } }); });
  await settle(() => answer.resolve({ error: '检索暂时失败' }, 503));
  assert.equal(app.root.findByProps({ 'aria-label': '知识库问题' }).props.value, '我正在写的下一问');
});


test('a suggested question keeps an unrelated unsent question in the composer', async () => {
  const mock = server(), answer = mock.delay('POST', '/api/ask'), app = await mount();
  await act(async () => { app.root.findByProps({ 'aria-label': '知识库问题' }).props.onChange({ target: { value: '尚未发送的项目问题' } }); });
  await click(app, css('suggestion'));
  assert.equal(mock.calls.filter(call => call === 'POST /api/ask').length, 1);
  assert.equal(app.root.findByProps({ 'aria-label': '知识库问题' }).props.value, '尚未发送的项目问题');
  await settle(() => answer.resolve({ mode: 'local', answer: '找到相关线索', sources: [] }));
  assert.equal(app.root.findByProps({ 'aria-label': '知识库问题' }).props.value, '尚未发送的项目问题');
});

test('reopening the assistant scrolls its own container to a reply received while hidden', async () => {
  const mock = server(), answer = mock.delay('POST', '/api/ask');
  const scrollCalls: unknown[] = [];
  const app = await mount(element => element.props.className === 'assistant-conversation'
    ? { scrollHeight: 700, scrollTo(options: unknown) { scrollCalls.push(options); } } : null);
  await click(app, css('suggestion'));
  await click(app, aria('关闭智能侧栏'));
  scrollCalls.length = 0;
  await settle(() => answer.resolve({ mode: 'local', answer: '等待期间完成的回复', sources: [] }));
  assert.equal(scrollCalls.length, 0, 'Hidden assistant must not scroll other content');
  await click(app, aria('打开智能侧栏'));
  assert.deepEqual(scrollCalls, [{ top: 700, behavior: 'smooth' }]);
  assert.equal(app.root.findAll(node => css('exchange')(node)).length, 1);
});

test('3D node selection opens once on double click and ignores a drag; legacy callers keep single-click behavior', async () => {
  const saved=new Map(['document','ResizeObserver','requestAnimationFrame','cancelAnimationFrame'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const frames=new Map<number,FrameRequestCallback>();let sequence=0;
  const circles:{x:number;y:number;radius:number}[]=[];
  const context=new Proxy({},{get:(_,key)=>key==='arc'?(x:number,y:number,radius:number)=>{circles.push({x,y,radius});}:key==='createRadialGradient'?()=>({addColorStop(){}}):key==='measureText'?()=>({width:60}):()=>{},set:()=>true});
  const element={parentElement:{getBoundingClientRect:()=>({width:800,height:600})},getContext:()=>context,style:{},width:0,height:0,getBoundingClientRect:()=>({left:0,top:0}),setPointerCapture(){}};
  Object.defineProperty(globalThis,'document',{configurable:true,value:{hidden:false,addEventListener(){},removeEventListener(){}}});
  Object.defineProperty(globalThis,'ResizeObserver',{configurable:true,value:class{observe(){}disconnect(){}}});
  Object.defineProperty(globalThis,'requestAnimationFrame',{configurable:true,value:(fn:FrameRequestCallback)=>{frames.set(++sequence,fn);return sequence;}});
  Object.defineProperty(globalThis,'cancelAnimationFrame',{configurable:true,value:(id:number)=>frames.delete(id)});
  const points=layoutGraph({nodes:[{id:'A',title:'A',group:'',tags:[]}],edges:[]}),opened:string[]=[],selected:(string|null)[]=[];
  const flush=()=>{const pending=[...frames.values()];frames.clear();circles.length=0;pending.forEach(fn=>fn(0));};
  const event=(dx=0,dy=0)=>{
    // This scene has one real node and no decorative orbits. Its sphere/glow shares a center;
    // use the drawn circle rather than assuming a projection origin or viewport ratio.
    const center=circles.reduce<typeof circles[number]|undefined>((largest,circle)=>!largest||circle.radius>largest.radius?circle:largest,undefined);
    assert.ok(center,'The canvas must render the node before pointer interaction');
    return {clientX:center.x+dx,clientY:center.y+dy,pointerId:1,currentTarget:element};
  };
  const props={points,edges:[],active:null,rotating:false,zoom:1,resetKey:0,onHover:()=>{},onOpen:(id:string)=>opened.push(id),onZoom:()=>{}};
  let renderer:ReactTestRenderer|undefined;
  try {
    await act(async()=>{renderer=create(<GraphCanvas {...props} onSelect={id=>selected.push(id)}/>,{createNodeMock:n=>n.type==='canvas'?element:null});});flush();
    let canvas=renderer!.root.findByType('canvas');
    await act(async()=>{canvas.props.onPointerDown(event());canvas.props.onPointerUp(event());});
    assert.deepEqual(selected,['A']);assert.deepEqual(opened,[]);
    await act(async()=>canvas.props.onDoubleClick(event()));assert.deepEqual(opened,['A']);
    await act(async()=>{canvas.props.onPointerDown(event());canvas.props.onPointerMove(event(50,46));canvas.props.onPointerUp(event(50,46));canvas.props.onDoubleClick(event());});
    assert.deepEqual(opened,['A'],'Dragging must not open a node');assert.deepEqual(selected,['A']);
    await act(async()=>renderer!.update(<GraphCanvas {...props}/>));flush();canvas=renderer!.root.findByType('canvas');
    await act(async()=>{canvas.props.onPointerDown(event());canvas.props.onPointerUp(event());canvas.props.onDoubleClick(event());});
    assert.deepEqual(opened,['A','A'],'Legacy pointer-up opens once without an extra double-click action');
  } finally {await act(async()=>renderer?.unmount());for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as any)[key];}}
});

test('3D wheel callbacks and visible zoom controls share the canvas 20–500 percent range', async () => {
  const graph = await mountGraph();
  await settle(() => graphCanvas(graph).props.onZoom(10));
  assert.equal(graphCanvas(graph).props.zoom,5,'The scene must reach the same zoom ceiling as its wheel controller');
  assert.equal(graphCanvas(graph).props.rotating,false);
  await click(graph,aria('放大'));assert.equal(graphCanvas(graph).props.zoom,5);
  await settle(() => graphCanvas(graph).props.onZoom(.001));
  assert.equal(graphCanvas(graph).props.zoom,.2);
  await click(graph,aria('缩小'));assert.equal(graphCanvas(graph).props.zoom,.2);
  await click(graph,aria('重置视角'));assert.equal(graphCanvas(graph).props.zoom,1);
});
