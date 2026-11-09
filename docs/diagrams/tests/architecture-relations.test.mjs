import { createHash, webcrypto } from 'node:crypto';
import { startExternalArchitecture } from '../src/architecture-viewer.mjs';
import { testDocument } from './test-dom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchitectureRelations, createLazyObjectRelationRenderer, architectureRelationsAssets } from '../src/architecture-relations.mjs';
import { architectureUrl, resolveArchitectureSelection } from '../src/architecture-navigation.mjs';

test('relation URLs retain canonical identities and unrelated context, and clear on Schedule navigation',()=>{
  const features=[], schedules=[{id:'update',application:'main',scheduleLabel:'Update',systemCount:1}];
  const href='https://local.test/pages/view.html?workspace=D%3A%2Fdemo&theme=light&object=old&objectRelation=old&objectMode=all#keep';
  const url=new URL(architectureUrl({schedule:'update',scheduleNode:'source',object:'native:<T>',objectRelation:'relation:a->b'},href,features,schedules));
  assert.equal(url.searchParams.get('objectRelation'),'relation:a->b');assert.equal(url.searchParams.has('objectMode'),false);
  assert.equal(url.searchParams.get('workspace'),'D:/demo');assert.equal(url.searchParams.get('theme'),'light');assert.equal(url.hash,'#keep');assert.equal(url.searchParams.get('scheduleNode'),'source');
  assert.deepEqual(resolveArchitectureSelection(url.search,features,schedules),{schedule:'update',node:null,scheduleNode:'source',object:'native:<T>',objectRelation:'relation:a->b'});
  const schedule=new URL(architectureUrl({schedule:'update'},url.href,features,schedules));
  for(const key of ['object','objectRelation','objectMode'])assert.equal(schedule.searchParams.has(key),false);
});

test('relation runtime remains lazy, reuses one renderer and aborts superseded imports',async()=>{
  const loads=[],renders=[];let created=0,cancelled=0,disposed=0;
  const module={createObjectRelationRenderer:options=>{created++;assert.equal(options.limit,8);return{render:async(view,id,{signal})=>{renders.push({view,id,signal});return{id}},cancel:()=>cancelled++,dispose:()=>disposed++}}};
  const renderer=createLazyObjectRelationRenderer({loadRuntime:({signal})=>new Promise(resolve=>loads.push({signal,resolve})),registry:{},features:[],buildId:'build',document:{}});
  assert.equal(loads.length,0);
  const old=renderer.render({id:'view'},'old');assert.equal(loads.length,1);
  const next=renderer.render({id:'view'},'new');assert.equal(loads[0].signal.aborted,true);
  loads[0].resolve(module);await assert.rejects(old,{name:'AbortError'});assert.equal(created,0);
  loads[1].resolve(module);assert.deepEqual(await next,{id:'new'});assert.equal(created,1);
  assert.deepEqual(await renderer.render({id:'view'},'again'),{id:'again'});assert.equal(loads.length,2);assert.equal(created,1);
  renderer.cancel();assert.equal(renders.at(-1).signal.aborted,true);assert.ok(cancelled>0);
  renderer.dispose();assert.equal(disposed,1);await assert.rejects(renderer.render({},'x'),/disposed/);
});

test('relation runtime failed import can retry without caching a broken factory',async()=>{
  let attempts=0;
  const renderer=createLazyObjectRelationRenderer({loadRuntime:async()=>{if(!attempts++)throw new Error('load failure');return{createObjectRelationRenderer:()=>({render:async()=>({ok:true}),cancel(){}})}},registry:{},features:[]});
  await assert.rejects(renderer.render({},'a'),/load failure/);assert.deepEqual(await renderer.render({},'a'),{ok:true});assert.equal(attempts,2);
  const assets=architectureRelationsAssets();assert.match(assets.script,/const DENSE_OBJECT_RELATION_THRESHOLD=64/);assert.match(assets.markup,/完整关系列表/);assert.match(assets.style,/@media\(max-width:900px\)/);
});


test('external startup validates the relation runtime identity while keeping its module unloaded',async()=>{
  const runtime={url:'../runtime/object-relations.mjs',sha256:'a'.repeat(64),bytes:100};
  async function startup(mismatch=false){
    const data={schemaVersion:7,buildId:'b',model:{features:[]},views:[],objectRelationRuntime:runtime};
    const manifest={schemaVersion:2,buildId:'b',objectRelationRuntime:{path:'runtime/object-relations.mjs',sha256:(mismatch?'b':'a').repeat(64),bytes:100}};
    const payloads=new Map([['https://local.test/data/runtime.json',new TextEncoder().encode(JSON.stringify(data))],['https://local.test/data/manifest.json',new TextEncoder().encode(JSON.stringify(manifest))]]);
    const hash=url=>createHash('sha256').update(payloads.get(url)).digest('hex');
    const bootstrap={schemaVersion:7,buildId:'b',runtimeUrl:'../data/runtime.json',runtimeSha256:hash('https://local.test/data/runtime.json'),manifestUrl:'../data/manifest.json',manifestSha256:hash('https://local.test/data/manifest.json')};
    const document=testDocument('<div id="schedule-status"></div>'),requests=[];let options;
    const app=await startExternalArchitecture({bootstrap,document,window:{},location:new URL('https://local.test/pages/view.html'),crypto:webcrypto,fetch:async url=>{requests.push(url);const bytes=payloads.get(url);assert.ok(bytes,'startup only fetches shared metadata');return{ok:true,arrayBuffer:async()=>bytes.buffer}},createNavigation:()=>({}),createViewer:value=>{options=value;return{ready:Promise.resolve()}}});
    return{app,options,requests,document};
  }
  const success=await startup();assert.ok(success.app);assert.equal(typeof success.options.loadObjectRelationRuntime,'function');assert.equal(success.requests.length,2);
  const failed=await startup(true);assert.equal(failed.app,null);assert.match(failed.document.getElementById('schedule-status').textContent,/identity mismatch/);assert.equal(failed.options,undefined);
});


function relationPanel(links = []) {
  const assets = architectureRelationsAssets();
  const document = testDocument('<div id="canvas-wrap">' + assets.markup + '<div id="canvas"></div></div><button id="outside">Outside</button>');
  const registry = { from: { name: '完整来源名称' }, to: { name: '完整目标名称' } };
  const panel = createArchitectureRelations({ document, registry, edgeStyles: {}, onChoose() {}, onList() {}, onFull() {}, onRemember() {} });
  const view = { id: 'object:from', links };
  panel.show(view, {}, null);
  return { document, panel, view, get: id => document.getElementById(id) };
}

test('hiding a full-height relation directory restores the visible canvas before focusing it', () => {
  const page = relationPanel();
  page.get('relation-search').focus();
  assert.equal(page.get('canvas-wrap').classList.contains('relation-list-only'), true);
  const focusCalls = [];
  page.get('canvas').focus = options => {
    assert.equal(page.get('object-relations').hidden, true);
    assert.equal(page.get('canvas-wrap').classList.contains('relation-list-only'), false);
    assert.equal(page.get('canvas-wrap').classList.contains('dense-relations'), false);
    focusCalls.push(options);
    page.document.activeElement = page.get('canvas');
  };
  page.panel.hide();
  assert.deepEqual(focusCalls, [{ preventScroll: true }]);
  assert.equal(page.document.activeElement, page.get('canvas'));
  page.get('outside').focus();
  page.panel.hide();
  assert.equal(focusCalls.length, 1);
  assert.equal(page.document.activeElement, page.get('outside'));
});

test('keyboard navigation keeps the focused relation visible using nearest native scrolling', () => {
  const links = Array.from({ length: 683 }, (_, index) => ({ id: 'edge-' + index, from: 'from', to: 'to', label: '关系 ' + index }));
  const page = relationPanel(links), list = page.get('relation-list');
  list.clientHeight = 72;
  const buttons = [...list.querySelectorAll('[data-relation]')], scrollCalls = [];
  for (const [index, button] of buttons.entries()) {
    button.scrollIntoView = options => {
      assert.deepEqual(options, { block: 'nearest', inline: 'nearest' });
      assert.equal(page.document.activeElement, button, 'focus precedes the minimal scroll');
      scrollCalls.push(index);
      const top = index * 24, bottom = top + 24;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    };
  }
  function key(name, expected) {
    list.dispatch('keydown', { key: name });
    assert.equal(page.document.activeElement, buttons[expected]);
    assert.ok(expected * 24 >= list.scrollTop);
    assert.ok((expected + 1) * 24 <= list.scrollTop + list.clientHeight);
  }
  list.focus();
  key('End', 682);
  assert.ok(list.scrollTop > 16000);
  key('ArrowUp', 681);
  key('Home', 0);
  assert.equal(list.scrollTop, 0);
  key('ArrowUp', 682);
  key('ArrowDown', 0);
  assert.deepEqual(scrollCalls, [682, 681, 0, 682, 0]);
  list.dispatch('keydown', { key: 'Escape' });
  assert.equal(page.document.activeElement, page.get('relation-search'));
});

test('the visible directory shares complete search fields and prefers its full display label', () => {
  const link = {
    id: 'canonical-relation-93', from: 'from', to: 'to', label: '移除', displayLabel: '移除 / 可变访问',
    notes: ['仅满足运行条件时'], sourceEntries: [{ path: 'src/character/movement.rs', line: 123 }],
    sourceEvidence: [{ path: 'src/item_interaction/release.rs', line: 456, column: 7 }],
  };
  const page = relationPanel([link]);
  assert.equal(page.get('relation-list').querySelector('small').textContent, '移除 / 可变访问');
  for (const query of ['canonical-relation-93', 'from 完整目标名称', '可变访问', '运行条件', 'movement.rs 123', 'release.rs 456 7']) {
    page.get('relation-search').value = query;
    page.get('relation-search').dispatch('input');
    assert.equal(page.get('relation-list').querySelectorAll('[data-relation]').length, 1, query);
    assert.equal(page.get('relation-count').textContent, '1 / 1 条关系');
  }
});
