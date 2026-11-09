import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { isDenseObjectView, projectObjectRelation, objectRelationRenderKey, relationRows } from '../src/architecture-object-relations.mjs';
const {createObjectRelationRenderer,compileObjectRelationNative}=await import('../src/object-relation-runtime-browser.mjs');
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/object-relations.json',import.meta.url)));
const full=fixture.view,links=full.links,registry=fixture.registry,views=[full],data={model:{features:fixture.features}},manifest={buildId:fixture.provenance.buildId};
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function rendererOptions(overrides={}) {
  return { registry,features:data.model.features,buildId:manifest.buildId,
    compileNative:async view=>view.mermaid,
    normalize:(view,svg)=>({...view,svg,width:600,height:100}),
    route:async(view,records,compile)=>compile(view,records),
    validateSvg:()=>{},checkLabels:()=>[],checkGeometry:()=>{},...overrides };
}

test('density comes from exact count and threshold, including descriptor metadata',()=>{
  assert.equal(isDenseObjectView(full), false);
  assert.equal(isDenseObjectView({aspect:'object',relationCount:63}),false);
  assert.equal(isDenseObjectView({aspect:'object',relationCount:64}),true);
  assert.equal(isDenseObjectView({aspect:'schedule',relationCount:1000}),false);
  assert.equal(isDenseObjectView({aspect:'object'}),false);
  assert.equal(isDenseObjectView({aspect:'object',relationCount:100,visualEdgeCount:1}),false);
});

test('display groups project both directions and resolve existing canonical relation links', () => {
  const read = { id: 'read-original', from: 'data', to: 'system', sourceEntries: [{ path: 'src/read.rs', line: 8 }] };
  const write = { id: 'write-original', from: 'system', to: 'data', sourceEntries: [{ path: 'src/write.rs', line: 9 }] };
  const group = { id: 'visual-access', from: 'data', to: 'system', forwardIds: [read.id], backwardIds: [write.id], displayLabel: '读写访问' };
  const view = { aspect: 'object', objectId: 'data', nodes: [{ id: 'data' }, { id: 'system' }], links: [read, write], visualEdgeGroups: [group] };
  for (const id of [group.id, read.id, write.id]) {
    const projection = projectObjectRelation(view, id);
    assert.deepEqual(projection.links, [read, write]);
    assert.deepEqual(projection.visualEdgeGroups, [group]);
    assert.equal(projection.nodes.length, 2);
  }
  const rows = relationRows(view, { data: { name: '数据' }, system: { name: '处理函数' } }, 'write.rs');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, group.id);
  assert.equal(rows[0].bidirectional, true);
});

test('every real visible relation retains exact link, canonical endpoints, evidence and display nodes',()=>{
  let count=0;
  for(const view of views)for(const link of view.links){
    const graph=projectObjectRelation(view,link.id),ids=new Set([link.displayFrom??link.from,link.displayTo??link.to]);
    assert.equal(graph.links[0],link);
    assert.deepEqual(new Set(graph.nodes.map(node=>node.id)),ids);
    assert.equal(graph.nodes.length,ids.size);
    assert.equal(graph.centerNodeId,view.centerNodeId||view.objectId);
    count++;
  }
  assert.equal(count, links.length);
});

test('list search is complete and does not change source relation order or evidence',()=>{
  const rows=relationRows(full,registry),before=JSON.stringify(full);
  assert.equal(rows.length,links.length);assert.deepEqual(rows.map(row=>row.id),links.map(link=>link.id));
  const link=links.find(link=>(link.sourceEntries||[]).some(source=>source.path));
  if(link){const source=link.sourceEntries.find(source=>source.path);assert.ok(relationRows(full,registry,source.path).some(row=>row.id===link.id));}
  assert.equal(relationRows(full,registry,'definitely-no-such-relation-94637').length,0);
  assert.equal(JSON.stringify(full),before);
});

test('unknown, duplicate and incomplete endpoint views fail instead of fabricating relationships',()=>{
  assert.throws(()=>projectObjectRelation(full,'unknown'),/Unknown/);
  assert.throws(()=>projectObjectRelation({...full,links:[links[0],links[0]]},links[0].id),/duplicate/);
  assert.throws(()=>projectObjectRelation({...full,nodes:[]},links[0].id),/endpoint/);
});

test('native view keeps business identity and exact original relation data',async()=>{
  const renderer=createObjectRelationRenderer(rendererOptions());
  const view=await renderer.render(full,links[0].id);
  assert.equal(view.id,full.id);assert.notEqual(view.nativeRenderId,full.id);assert.equal(view.presentation,'relation');
  assert.equal(view.renderKey,objectRelationRenderKey(manifest.buildId,full.id,links[0].id));
  assert.equal(view.links[0].id,links[0].id);assert.equal(view.links[0].from,links[0].from);assert.equal(view.links[0].to,links[0].to);
  for(const field of ['sourceEntries','sourceEvidence','notes','sourceGaps'])assert.deepEqual(view.links[0][field],links[0][field]);
  renderer.dispose();
});

test('new selection cancels active result and only latest pending relation is compiled',async()=>{
  const gate=defer(),started=[],renderer=createObjectRelationRenderer(rendererOptions({compileNative:async view=>{started.push(view.links[0].id);if(started.length===1)await gate.promise;return view.mermaid}}));
  const first=renderer.render(full,links[0].id),firstRejected=assert.rejects(first,{name:'AbortError'});
  const middle=renderer.render(full,links[1].id),middleRejected=assert.rejects(middle,{name:'AbortError'});
  const last=renderer.render(full,links[2].id);gate.resolve();
  await Promise.all([firstRejected,middleRejected,last]);
  assert.deepEqual(started,[links[0].id,links[2].id]);assert.equal((await last).relationId,links[2].id);
  renderer.dispose();
});

test('abort removes queued result and prevents cache pollution after a native compile',async()=>{
  const gate=defer(),controller=new AbortController();let calls=0;
  const renderer=createObjectRelationRenderer(rendererOptions({compileNative:async view=>{calls++;if(calls===1)await gate.promise;return view.mermaid}}));
  const rendering=renderer.render(full,links[0].id,{signal:controller.signal}),rejected=assert.rejects(rendering,{name:'AbortError'});
  controller.abort();gate.resolve();await rejected;await flush();
  await renderer.render(full,links[0].id);assert.equal(calls,2);renderer.dispose();
});

test('failed native or validation results are never cached',async()=>{
  let calls=0,fail=true;
  const renderer=createObjectRelationRenderer(rendererOptions({compileNative:async view=>{calls++;if(fail)throw new Error('real compile failure');return view.mermaid}}));
  await assert.rejects(renderer.render(full,links[0].id),/real compile failure/);fail=false;
  await renderer.render(full,links[0].id);await renderer.render(full,links[0].id);assert.equal(calls,2);renderer.dispose();
});

test('LRU is bounded to eight successful relationship renders',async()=>{
  let calls=0;const renderer=createObjectRelationRenderer(rendererOptions({compileNative:async view=>{calls++;return view.mermaid}}));
  for(const link of links.slice(0,9))await renderer.render(full,link.id);
  assert.equal(calls,9);await renderer.render(full,links[8].id);assert.equal(calls,9);
  await renderer.render(full,links[0].id);assert.equal(calls,10);renderer.dispose();
});

test('dispose cancels in-flight result, clears cache and rejects future rendering',async()=>{
  const gate=defer(),renderer=createObjectRelationRenderer(rendererOptions({compileNative:async view=>{await gate.promise;return view.mermaid}}));
  const rendering=renderer.render(full,links[0].id),rejected=assert.rejects(rendering,{name:'AbortError'});renderer.dispose();gate.resolve();await rejected;
  await assert.rejects(renderer.render(full,links[0].id),/disposed/);renderer.dispose();
});

test('native compiler always removes its isolated measurement container',async()=>{
  for(const fail of [false,true]){
    const elements=[],document={body:{appendChild:element=>elements.push(element)},createElement:()=>({style:{},setAttribute(){},remove(){elements.splice(elements.indexOf(this),1)}})};
    const engine={initialize(config){assert.equal(config.securityLevel,'strict');},async render(id,text,container){assert.equal(elements[0],container);if(fail)throw new Error('native failure');return{svg:'<svg />'}}};
    const result=compileObjectRelationNative({id:'private-native',mermaid:'flowchart LR',links:[]},{document,engine});
    if(fail)await assert.rejects(result,/native failure/);else assert.equal(await result,'<svg />');assert.equal(elements.length,0);
  }
});

test('different renderer instances use distinct native DOM IDs',async()=>{
  const one=createObjectRelationRenderer(rendererOptions()),two=createObjectRelationRenderer(rendererOptions());
  const [first,second]=await Promise.all([one.render(full,links[0].id),two.render(full,links[0].id)]);
  assert.notEqual(first.nativeRenderId,second.nativeRenderId);assert.equal(first.id,second.id);one.dispose();two.dispose();
});

test('a newer selection suppresses a cached result before its promise delivers',async()=>{
  const renderer=createObjectRelationRenderer(rendererOptions());await renderer.render(full,links[0].id);await renderer.render(full,links[1].id);
  const first=renderer.render(full,links[0].id),rejected=assert.rejects(first,{name:'AbortError'}),second=renderer.render(full,links[1].id);
  await rejected;assert.equal((await second).relationId,links[1].id);renderer.dispose();
});

test('native initialize/render is serial across instances and abort waits for measurement cleanup',async()=>{
  const gate=defer(),events=[],elements=[],controller=new AbortController();
  const document={body:{appendChild:element=>elements.push(element)},createElement:()=>({style:{},setAttribute(){},remove(){elements.splice(elements.indexOf(this),1)}})};
  const engine={initialize(){events.push('initialize')},async render(id){events.push(id);if(id==='first')await gate.promise;return{svg:'<svg />'}}};
  const first=compileObjectRelationNative({id:'first',mermaid:'flowchart LR',links:[]},{document,engine,signal:controller.signal}),rejected=assert.rejects(first,{name:'AbortError'});
  const second=compileObjectRelationNative({id:'second',mermaid:'flowchart LR',links:[]},{document,engine});
  await flush();assert.deepEqual(events,['initialize','first']);assert.equal(elements.length,1);
  controller.abort();await flush();assert.equal(elements.length,1);assert.deepEqual(events,['initialize','first']);
  gate.resolve();await rejected;assert.equal(await second,'<svg />');assert.deepEqual(events,['initialize','first','initialize','second']);assert.equal(elements.length,0);
});


test('shared rows search only explicit relation presentation and source fields without mutating evidence', () => {
  const link = {
    id: 'canonical-edge', from: 'from-id', to: 'to-id', label: '移除', displayLabel: '移除 / 可变访问',
    description: '满足时释放', notes: ['仅在角色存活时'], sourceGaps: ['外部条件由调用方决定'],
    sourceEntries: [{ path: 'src/character/jump.rs', line: 21, column: 3, label: '条件位置' }],
    sourceEvidence: [{ path: 'src/item_interaction/release.rs', line: 42, mir: { body: 'must-not-index-mir-payload' } }],
  };
  const records = { 'from-id': { name: '完整来源' }, 'to-id': { name: '完整目标' } };
  const view = { links: [link] }, before = JSON.stringify(view);
  for (const query of ['canonical-edge', 'from-id to-id', '完整来源 完整目标', '移除 可变访问', '满足时释放', '角色存活', '外部条件', 'jump.rs 21 3 条件位置', 'release.rs 42']) {
    const rows = relationRows(view, records, query);
    assert.equal(rows.length, 1, query);
    assert.equal(rows[0].link, link);
    assert.equal(rows[0].label, '移除 / 可变访问');
  }
  assert.equal(relationRows(view, records, 'must-not-index-mir-payload').length, 0);
  assert.equal(JSON.stringify(view), before);
});


test('real exported source and body condition expressions remain independently searchable', () => {
  // object-18491622f1815e99 的真实边只保留本回归需要的表达式与定位字段。
  const link = {
    "id": "relation-05301c0c77053a0fd2e8b746",
    "from": "registration-d3be59eada17577d0c06b203",
    "to": "type-d23f957b2cedf35188f16860",
    "kind": "emit",
    "label": "触发事件",
    "displayLabel": "触发事件",
    "sourceEntries": [
      {
        "path": "src/events.rs",
        "line": 1085,
        "column": 13,
        "expression": "PointerAction::Release(button)"
      }
    ],
    "bodyOperations": [
      {
        "conditions": [
          {
            "expression": "action"
          }
        ]
      }
    ]
  };
  const view = { links: [link] }, before = JSON.stringify(view);
  const sourceOnly = { links: [{ ...link, bodyOperations: [] }] };
  const conditionOnly = { links: [{ ...link, sourceEntries: [] }] };
  assert.equal(relationRows(sourceOnly, {}, 'Release(button)')[0]?.id, link.id);
  assert.equal(relationRows(conditionOnly, {}, 'action')[0]?.id, link.id);
  assert.equal(relationRows(view, {}, 'Release(button) action')[0]?.link, link);
  assert.equal(relationRows({ links: [{ ...link, sourceEntries: [], bodyOperations: [] }] }, {}, 'action').length, 0);
  assert.equal(JSON.stringify(view), before);
});
