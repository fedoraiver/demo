// 使用独立语义样本执行正式查看器，不依赖尚未刷新的生成产物。
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createArchitectureViewer, renderArchitectureViewer } from './architecture-viewer.mjs';
import { createArchitectureNavigation } from './architecture-navigation.mjs';
import { createArchitectureInteraction } from './architecture-interaction.mjs';
import { createArchitectureSplitter } from './architecture-splitter.mjs';
import { createArchitectureGestures } from './architecture-gestures.mjs';
import { NODE_STYLES, EDGE_STYLES, SELECTION_STYLE, EXTERNAL_REFERENCE_STYLE } from './architecture-style.mjs';
import { testDocument, scriptsIn } from './test-dom.mjs';

function fixture() {
  const features=[{id:'item',label:'物品交互',plugin:'ItemPlugin'},{id:'character',label:'人物',plugin:'CharacterPlugin'}];
  const source=(role,line,label=role)=>({role,label,path:'src/item.rs',line});
  const registry={
    'plugin-ItemPlugin':{id:'plugin-ItemPlugin',kind:'Plugin',name:'ItemPlugin',description:'完整插件说明',feature:'item'},
    'entity-item':{id:'entity-item',kind:'Entity',name:'物品',description:'实体完整说明',feature:'item',assembled_by:['item'],components:[{id:'item.Shared'},{id:'item.Other'}],sourceEntries:[source('create',10),source('destroy',20)]},
    'entity-character':{id:'entity-character',kind:'Entity',name:'人物',description:'另一实体',feature:'character',components:[{id:'character.Shared'}]},
    'item.Shared':{id:'item.Shared',kind:'Component',name:'Shared',owner:'物品',description:'物品组件的完整说明',feature:'item',defined_in:'item',fields:['value: f32'],sourceEntries:[source('definition',30)],source:{path:'forbidden-legacy.rs',line:1}},
    'character.Shared':{id:'character.Shared',kind:'Component',name:'Shared',owner:'人物',description:'同一真实类型的另一投影说明',feature:'item',sourceEntries:[source('definition',30)]},
    'item.Other':{id:'item.Other',kind:'Component',name:'Other',description:'另一类型',feature:'item',sourceGaps:['待核实：没有类型定义证据'],source:{path:'not-a-definition.rs',line:9}},
    'item.Legacy':{id:'item.Legacy',alias_of:'item.Shared'},
    'resource.Config':{id:'resource.Config',kind:'Resource',name:'Config',description:'配置',feature:'item'},
    'local.State':{id:'local.State',kind:'Local',name:'State',description:'局部状态',feature:'item'},
    'non_send.Native':{id:'non_send.Native',kind:'NonSend',name:'Native',description:'主线程状态',feature:'item'},
  };
  const system={kind:'System',name:'update_shared',description:'完整系统说明，保留所有组件和资源访问。',feature:'item',reads:['item.Shared','item.Other','character.Shared','resource.Config','local.State','non_send.Native'],writes:['item.Shared','resource.Config'],filters:['Query<&mut Shared>','With<Pickable>'],events:['消息记录'],notes:['具体运行约束'],registrationFamilyIds:['system-fixed','system-update']};
  registry['system-fixed']={...system,id:'system-fixed',registrations:[{schedule:'FixedUpdate',scope:'runtime',sets:['Target','Other'],run_if:['running']}],sourceEntries:[source('definition',40),source('registration',50,'固定步注册')]};
  registry['system-update']={...system,id:'system-update',registrations:[{schedule:'RunFixedMainLoop',scope:'runtime',driver_set:'AfterFixedMainLoop',after:[]}],sourceEntries:[source('definition',40),source('registration',60,'逐帧注册')]};
  function graph(id,feature,aspect,ids,links=[],extra={}) {
    const nodes=ids.map((nodeId,index)=>{const kind=registry[nodeId].kind;return{id:nodeId,instance:id+'--'+index,visualType:kind==='Entity'?'entity':kind==='Component'?'component':kind==='Resource'?'resource':kind==='Plugin'?'plugin':'system',role:registry[nodeId].feature===feature?'internal':'external',position:{x:40+index*220,y:40,width:180,height:80}}});
    const svg='<svg id="'+id+'">'+nodes.map(node=>'<g class="node" data-id="'+node.id+'" data-instance="'+node.instance+'" data-visual-type="'+node.visualType+'" role="button" tabindex="0"><rect data-shape-part="'+node.instance+'" style="fill:'+NODE_STYLES[node.visualType].fill+';stroke:'+NODE_STYLES[node.visualType].stroke+';stroke-width:1.6px !important"/><g class="label"><text>'+registry[node.id].name+'</text></g></g>').join('')+links.map(link=>'<path class="edge" data-link-id="'+link.id+'" tabindex="0" role="button"/>').join('')+'</svg>';
    return{id,feature,aspect,label:id,nodes,links,scheduleLinks:[],scheduleGroups:[],sections:[{label:'全部节点',x:40,y:40,width:900,height:80}],bounds:{x:0,y:0,width:1000,height:300},width:ids.length?1000:0,height:ids.length?300:0,svg:ids.length?svg:null,...extra};
  }
  const links=[{id:'contains',from:'item.Shared',to:'entity-item',kind:'reference',edgeSemantic:'reference',label:'可选挂载',sourceEntries:[source('related',70)]},{id:'write',from:'system-fixed',to:'item.Shared',kind:'write',edgeSemantic:'write',label:'更新字段',notes:['直接写入'],sourceEntries:[source('operation',80)]},{id:'read-update',from:'item.Shared',to:'system-update',kind:'read',edgeSemantic:'read',label:'读取字段',sourceEntries:[source('operation',90)]}];
  const views=[graph('overview',null,'overview',['plugin-ItemPlugin']),graph('plugin-item-systems','item','systems',['system-fixed','system-update']),graph('plugin-character-systems','character','systems',[])];
  for(const record of Object.values(registry).filter(record=>!record.alias_of)){
    const related=record.kind==='Entity'?[]:links.filter(link=>link.from===record.id||link.to===record.id);
    const ids=[...new Set([record.id,...related.flatMap(link=>[link.from,link.to])])];
    views.push(graph('object:'+record.id,record.feature,'object',ids,related,{objectId:record.id,centerNodeId:record.id}));
  }
  const objects=views.filter(view=>view.aspect==='object').map(view=>({id:view.objectId,viewId:view.id,feature:view.feature,kind:registry[view.objectId].kind}));
  return{model:{features,entities:[{id:'item',components:[{id:'item.Shared'},{id:'item.Other'}]},{id:'character',components:[{id:'character.Shared'}]}]},registry,views,objects,objectAliases:{'old-component-type':['item.Shared','character.Shared'],'old-function':['system-fixed','system-update']},features,infrastructureFeatures:[],guideSamples:{nodes:Object.fromEntries(Object.keys(NODE_STYLES).map(type=>[type,'<svg data-sample="'+type+'"></svg>'])),edges:Object.fromEntries(Object.keys(EDGE_STYLES).map(type=>[type,'<svg data-sample="'+type+'"></svg>']))},styles:{nodes:NODE_STYLES,edges:EDGE_STYLES,selection:SELECTION_STYLE,externalReference:EXTERNAL_REFERENCE_STYLE}};
}

function viewer(query='?feature=item&tab=systems',{historyUnavailable=false,width=1440,edit=()=>{}}={}) {
  const data=fixture();edit(data);
  const html=renderArchitectureViewer({...data,features:data.features});
  const document=testDocument(html),location=new URL('file:///D:/demo/docs/diagrams/ecs-architecture.html'+query),frames=[],events=new Map(),entries=[{href:location.href,state:null}];let index=0;
  const history={get state(){return entries[index].state},get length(){return entries.length},replaceState(state,_,href){if(historyUnavailable)throw new Error('unavailable');location.href=new URL(href,location).href;entries[index]={href:location.href,state:structuredClone(state)}},pushState(state,_,href){if(historyUnavailable)throw new Error('unavailable');entries.splice(index+1);location.href=new URL(href,location).href;entries.push({href:location.href,state:structuredClone(state)});index++}};
  const window={innerWidth:width,addEventListener(name,listener){events.set(name,listener)}};
  const canvas=document.getElementById('canvas');canvas.clientWidth=950;canvas.clientHeight=600;
  const refreshed=[];
  const app=createArchitectureViewer({data,document,location,history,window,requestAnimationFrame:callback=>frames.push(callback),sourceEditor:{refreshLinks:scope=>refreshed.push(scope),withWorkspace:href=>href},navigation:createArchitectureNavigation(data.features),createSplitter:createArchitectureSplitter,createInteraction:createArchitectureInteraction,createGestures:createArchitectureGestures});
  function flush(){while(frames.length)frames.splice(0).forEach(callback=>callback())}flush();
  function click(element){assert.ok(element,'control exists');element.click();flush()}
  return{data,app,document,location,history,canvas,window,emit:name=>events.get(name)?.(),refreshed,get:id=>document.getElementById(id),click,flush,activate(id,key='Enter'){const node=document.getElementById('diagram').querySelector('[data-id="'+id+'"]');assert.ok(node,'visible node '+id);node.dispatch('keydown',{key});flush()},back(){assert.ok(index>0);location.href=entries[--index].href;events.get('popstate')();flush()},forward(){assert.ok(index+1<entries.length);location.href=entries[++index].href;events.get('popstate')();flush()}};
}

function assertFitted(page) {
  const match=/translate\(([-\d.e+]+)px,\s*([-\d.e+]+)px\) scale\(([-\d.e+]+)\)/.exec(page.get('diagram').style.transform);
  assert.ok(match,'finite viewport transform');
  const [x,y,scale]=match.slice(1).map(Number),view=page.app.view;
  assert.ok(scale>0&&scale<=1);
  assert.ok(x>=14-.001&&y>=14-.001,'whole diagram has canvas margins');
  assert.ok(x+view.width*scale<=page.canvas.clientWidth-14+.001);
  assert.ok(y+view.height*scale<=page.canvas.clientHeight-14+.001);
  assert.ok(Math.abs(x+view.width*scale/2-page.canvas.clientWidth/2)<.001);
  assert.ok(Math.abs(y+view.height*scale/2-page.canvas.clientHeight/2)<.001);
  const transform=page.get('diagram').style.transform;
  page.click(page.get('fit'));assert.equal(page.get('diagram').style.transform,transform,'entry uses the existing Fit action');
}

test('first entry fits overview, systems and exact object diagrams with deep-linked selection',()=>{
  for(const query of ['?feature=overview','?feature=item','?feature=item&node=system-fixed','?feature=item&object=item.Shared','?feature=item&object=item.Shared&node=system-update']){
    const page=viewer(query,{edit:data=>{for(const view of data.views){view.width=2400;view.height=6000;view.bounds={x:-8,y:-8,width:view.width,height:view.height}}}});
    assertFitted(page);
    if(query.includes('node=system'))assert.equal(page.get('details').querySelector('h2').textContent,'update_shared');
  }
});

test('ordinary cards select their own details and the explicit action enters their object view',()=>{
  const page=viewer();page.activate('system-fixed');
  assert.equal(page.app.view.id,'plugin-item-systems');
  assert.equal(page.get('details').querySelectorAll('.schedule-registration').length,1);
  page.click(page.get('details').querySelector('[data-object="system-fixed"]'));
  assert.equal(page.app.view.id,'object:system-fixed');assertFitted(page);
  assert.equal(page.location.searchParams.get('object'),'system-fixed');
  assert.equal(page.get('details').querySelector('[data-object="system-fixed"]'),null);
  const before=page.history.length;page.activate('system-fixed');assert.equal(page.history.length,before);
  page.click(page.get('return-context'));assert.equal(page.app.view.id,'plugin-item-systems');assertFitted(page);
  assert.equal(page.location.searchParams.get('node'),'system-fixed');
  page.click(page.document.querySelector('[data-feature="character"]'));assert.equal(page.app.view.svg,null);
  page.click(page.get('return-overview'));assertFitted(page);
});

test('legacy component, data and events links migrate exact projections without losing URL state',()=>{
  for(const id of ['item.Shared','character.Shared'])for(const parameter of ['component='+id,'node='+id]){
    const page=viewer('?feature=item&tab=data&'+parameter+'&workspace=E%3A%2Fwork&keep=1#anchor');
    assert.equal(page.app.view.id,'object:'+id);assert.equal(page.history.length,1);
    assert.equal(page.location.searchParams.get('object'),id);assert.equal(page.location.searchParams.has('component'),false);
    assert.equal(page.location.searchParams.get('tab'),'systems');assert.equal(page.location.searchParams.get('workspace'),'E:/work');assert.equal(page.location.searchParams.get('keep'),'1');assert.equal(page.location.hash,'#anchor');
  }
  const events=viewer('?feature=item&tab=events&node=system-update');assert.equal(events.app.view.id,'object:system-update');
  const alias=viewer('?feature=item&tab=data&node=item.Legacy');assert.equal(alias.app.view.id,'object:item.Shared');
  for(const tab of ['data','events'])for(const node of ['','&node=deleted']){
    const page=viewer('?feature=item&tab='+tab+node);assert.equal(page.app.view.id,'plugin-item-systems');assert.equal(page.location.searchParams.get('node'),null);
  }
});

test('legacy provider links normalize ownership while explicit object routes retain context',()=>{
  for(const feature of ['third_party','infrastructure']){
    const page=viewer('?feature='+feature+'&tab=data&node=item.Shared');
    assert.equal(page.app.view.id,'object:item.Shared');assert.equal(page.location.searchParams.get('feature'),'item');
  }
  assert.equal(viewer('?feature=infrastructure&object=item.Shared').location.searchParams.get('feature'),'infrastructure');
  const merged=viewer('?feature=third_party&node=deleted');assert.equal(merged.app.view.id,'overview');
});

test('old aggregate aliases offer every original projection or registration without choosing one',()=>{
  for(const [old,ids]of [['old-component-type',['item.Shared','character.Shared']],['old-function',['system-fixed','system-update']]]){
    const page=viewer('?feature=item&object='+old+'&keep=1');
    assert.equal(page.get('details').querySelector('h2').textContent,'选择原对象');
    assert.deepEqual(page.get('details').querySelectorAll('[data-object]').map(button=>button.dataset.object),ids);
    assert.equal(page.history.length,1);
    page.click(page.get('details').querySelector('[data-object="'+ids[1]+'"]'));assert.equal(page.app.view.id,'object:'+ids[1]);
  }
  const nodeAlias=viewer('?feature=item&component=item.Shared&node=old-function');
  assert.equal(nodeAlias.app.view.id,'object:item.Shared');assert.equal(nodeAlias.location.searchParams.get('node'),'old-function');
  assert.deepEqual(nodeAlias.get('details').querySelectorAll('[data-object]').map(button=>button.dataset.object),['system-fixed','system-update']);
  const standalone=viewer('?feature=item&node=old-function');assert.equal(standalone.get('details').querySelector('h2').textContent,'选择原对象');
});

test('each projection and registration retains its own description, fields, sources and family links',()=>{
  const page=viewer('?feature=item&object=item.Shared');
  assert.ok(page.get('details').textContent.includes('物品组件的完整说明'));
  assert.ok(!page.get('details').textContent.includes('另一投影说明'));
  page.app.openObject('character.Shared');page.flush();
  assert.equal(page.app.view.id,'object:character.Shared');assert.ok(page.get('details').textContent.includes('另一投影说明'));
  assert.ok(!page.get('details').textContent.includes('value: f32'));
  page.app.openObject('system-fixed');page.flush();
  assert.equal(page.get('details').querySelectorAll('.schedule-registration').length,1);
  assert.deepEqual(page.get('details').querySelectorAll('[data-vscode-line]').map(anchor=>anchor.dataset.vscodeLine),['40','50']);
  const family=page.get('details').querySelector('[data-open="system-update"]');assert.ok(family.textContent.includes('RunFixedMainLoop'));
  page.click(family);assert.equal(page.app.view.id,'object:system-update');
  assert.equal(page.get('details').querySelectorAll('.schedule-registration').length,1);
  assert.deepEqual(page.get('details').querySelectorAll('[data-vscode-line]').map(anchor=>anchor.dataset.vscodeLine),['40','60']);
});

test('global search reaches isolated objects and distinguishes same names by owner and Schedule',()=>{
  const page=viewer('?feature=overview');page.app.search('Shared');
  const results=page.get('details').querySelectorAll('[data-object]');
  assert.ok(results.some(button=>button.dataset.object==='item.Shared'&&button.textContent.includes('物品')));
  assert.ok(results.some(button=>button.dataset.object==='character.Shared'&&button.textContent.includes('人物')));
  assert.ok(results.some(button=>button.dataset.object==='system-fixed'&&button.textContent.includes('FixedUpdate')));
  assert.ok(results.some(button=>button.dataset.object==='system-update'&&button.textContent.includes('RunFixedMainLoop')));
  page.app.search('配置');assert.equal(page.get('details').querySelector('h2').textContent,'1 个匹配对象');
  page.click(page.get('details').querySelector('[data-object="resource.Config"]'));assert.equal(page.app.view.id,'object:resource.Config');
  assert.equal(page.app.view.nodes.length,1);assertFitted(page);
  page.back();assert.equal(page.get('details').querySelector('h2').textContent,'1 个匹配对象');assert.equal(page.get('search').value,'配置');
});

test('Entity details keep all components and related links enter exact object views',()=>{
  const page=viewer('?feature=item&object=entity-item');
  assert.equal(page.document.querySelector('[data-entity-toggle]'),null);
  for(const id of ['item.Shared','item.Other'])assert.equal(page.get('diagram').querySelector('[data-id="'+id+'"]'),null);
  assert.deepEqual(page.app.view.nodes.map(node=>node.id),['entity-item']);
  assert.deepEqual(page.get('details').querySelectorAll('[data-open]').map(button=>button.dataset.open),['item.Shared','item.Other']);
  page.click(page.get('details').querySelector('[data-open="item.Shared"]'));
  assert.equal(page.app.view.id,'object:item.Shared');
  page.activate('entity-item');assert.equal(page.app.view.id,'object:item.Shared');
  page.click(page.get('details').querySelector('[data-object="entity-item"]'));assert.equal(page.app.view.id,'object:entity-item');
});

test('back and forward restore node and edge selection, viewport and original systems context',()=>{
  const page=viewer();page.activate('system-fixed');page.click(page.get('zoom-out'));const original=page.get('diagram').style.transform;
  page.app.openObject('item.Shared');page.flush();page.click(page.get('zoom-in'));page.get('diagram').querySelector('[data-link-id="write"]').dispatch('keydown',{key:'Enter'});const object=page.get('diagram').style.transform;
  page.app.navigate({feature:'character',aspect:'systems',node:null});page.flush();
  page.back();assert.equal(page.get('diagram').style.transform,object);assert.equal(page.get('details').querySelector('.badge').textContent,EDGE_STYLES.write.label);
  page.back();assert.equal(page.app.view.id,'plugin-item-systems');assert.equal(page.get('diagram').style.transform,original);assert.equal(page.location.searchParams.get('node'),'system-fixed');
  page.forward();assert.equal(page.get('diagram').style.transform,object);
  page.click(page.get('return-context'));assert.equal(page.app.view.id,'plugin-item-systems');assert.equal(page.location.searchParams.get('node'),'system-fixed');
});

test('unavailable local-file history, invalid object IDs and mismatched object node selections remain usable',()=>{
  const page=viewer(undefined,{historyUnavailable:true});page.activate('system-fixed');page.app.openObject('item.Shared');page.flush();assert.equal(page.app.view.id,'object:item.Shared');
  page.click(page.get('return-context'));assert.equal(page.app.view.id,'plugin-item-systems');assert.equal(page.app.selection.node,'system-fixed');
  const stale=viewer('?feature=item&object=deleted');assert.equal(stale.app.view.id,'plugin-item-systems');assert.equal(stale.location.searchParams.has('object'),false);
  const unrelated=viewer('?feature=item&object=item.Shared&node=resource.Config');assert.equal(unrelated.app.selection.node,'item.Shared');
  const empty=viewer('?feature=character');assert.equal(empty.get('diagram').innerHTML,'');assert.doesNotMatch(empty.get('diagram').style.transform,/NaN|Infinity/);
});

test('node details preserve canonical Read/Write summaries, full query and authoritative source entries',()=>{
  const page=viewer('?feature=item&object=system-fixed');const details=page.get('details');
  const read=details.querySelector('[data-access="Read"]');assert.deepEqual(read.querySelectorAll('[data-access-kind]').map(group=>group.dataset.accessKind),['Entity','Resource','Local','NonSend']);
  assert.deepEqual(read.querySelector('[data-access-kind="Entity"]').querySelectorAll('[data-open]').map(button=>button.dataset.open),['entity-item','entity-character']);
  assert.ok(details.textContent.includes('Query<&mut Shared>'));
  page.click(details.querySelector('[data-owner]'));assert.equal(page.app.view.id,'plugin-item-systems');assert.equal(page.location.searchParams.has('object'),false);
  page.app.openObject('item.Other');page.flush();assert.equal(details.querySelector('[data-vscode-path]'),null);assert.ok(details.textContent.includes('待核实'));assert.ok(!details.textContent.includes('not-a-definition.rs'));
});

test('clear returns actual view legend and releases only graph or disappearing-button focus',()=>{
  const page=viewer('?feature=item&object=item.Shared');page.get('search').focus();page.app.select(null);assert.equal(page.document.activeElement,page.get('search'));
  assert.equal(page.get('details').querySelector('.guide').getAttribute('aria-label'),'Legend');
  assert.deepEqual(page.get('details').querySelectorAll('[data-guide-node-type]').map(row=>row.dataset.guideNodeType),['system','entity','component']);
  assert.deepEqual(page.get('details').querySelectorAll('[data-guide-edge-semantic]').map(row=>row.dataset.guideEdgeSemantic),['read','write','reference']);
  page.activate('item.Shared');page.get('clear-selection').focus();page.click(page.get('clear-selection'));assert.equal(page.document.activeElement,page.canvas);
  assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,0);
  page.activate('item.Shared');page.get('diagram').querySelector('[data-id="item.Shared"]').focus();page.app.select(null);assert.equal(page.document.activeElement,page.canvas);
});

test('edge details and native labels preserve exact endpoint and operation source identity',()=>{
  const page=viewer('?feature=item&object=item.Shared',{edit:data=>{
    const view=data.views.find(view=>view.objectId==='item.Shared');view.links.forEach((link,index)=>link.mermaidId='e'+index);
    view.svg=view.svg.replace('</svg>',view.links.map(link=>'<g class="edgeLabel"><g data-mermaid-native-id="'+link.mermaidId+'"><text>'+link.label+'</text></g></g>').join('')+'</svg>');
  }});
  const label=page.get('diagram').querySelector('[data-link-label-id="write"]');assert.equal(label.getAttribute('data-connect'),'system-fixed|item.Shared');
  page.click(label.querySelector('text'));assert.deepEqual(page.get('details').querySelectorAll('[data-open]').map(button=>button.dataset.open),['system-fixed','item.Shared']);assert.equal(page.get('details').querySelector('[data-vscode-line]').dataset.vscodeLine,'80');
  for(const key of ['Enter',' ']){label.dispatch('keydown',{key});assert.equal(page.get('details').querySelector('.badge').textContent,EDGE_STYLES.write.label)}
  page.click(page.get('details').querySelector('[data-open="system-fixed"]'));assert.equal(page.app.view.id,'object:system-fixed');
});

test('Observer 触发线显示事件入口、真实操作证据和条件，并能返回原系统图',()=>{
  const page=viewer('?feature=item&keep=1&workspace=E%3A%2Fwork#anchor',{edit:data=>{
    data.registry['item.Shared'].kind='EntityEvent';data.registry['item.Shared'].name='Fire<MoveAction>';
    const view=data.views.find(view=>view.id==='plugin-item-systems');
    view.links=[{id:'observer-trigger-example',mermaidId:'e0',from:'system-fixed',to:'system-update',kind:'trigger',edgeSemantic:'observe',projection:'observer-trigger',eventId:'item.Shared',originalLinkIds:['emit','observe'],label:'Fire<MoveAction>',notes:['Commands 应用后触发'],sourceEntries:[{path:'src/item.rs',line:88,role:'operation',label:'实际事件发出位置'}]}];
    view.svg=view.svg.replace('</svg>','<path class="edge" data-link-id="observer-trigger-example" tabindex="0" role="button"/></svg>');
  }});
  page.get('diagram').querySelector('[data-link-id="observer-trigger-example"]').dispatch('keydown',{key:'Enter'});
  const details=page.get('details');
  assert.equal(details.querySelector('h2').textContent,EDGE_STYLES.observe.label);
  assert.deepEqual(details.querySelectorAll('[data-open]').map(button=>button.dataset.open),['system-fixed','system-update','item.Shared']);
  assert.ok(details.textContent.includes('Commands 应用后触发'));
  assert.equal(details.querySelector('[data-vscode-line]').dataset.vscodeLine,'88');
  page.click(details.querySelector('[data-open="item.Shared"]'));assert.equal(page.app.view.objectId,'item.Shared');
  assert.equal(page.location.searchParams.get('workspace'),'E:/work');assert.equal(page.location.searchParams.get('keep'),'1');assert.equal(page.location.hash,'#anchor');
  page.back();assert.equal(page.app.view.id,'plugin-item-systems');assert.ok(page.get('details').textContent.includes('Fire<MoveAction>'));
});

test('native Schedule labels retain Schedule identity and never become object endpoints',()=>{
  const page=viewer(undefined,{edit:data=>{const view=data.views.find(view=>view.id==='plugin-item-systems');view.scheduleLinks=[{id:'schedule-next',mermaidId:'sc0',from:'First',to:'Update',edgeSemantic:'schedule',label:'阶段契约'}];view.svg=view.svg.replace('</svg>','<g class="edgeLabel" data-mermaid-native-id="sc0"><text>阶段契约</text></g></svg>')}});
  const label=page.get('diagram').querySelector('[data-link-label-id="schedule-next"]');assert.equal(label.dataset.scheduleLinkId,'schedule-next');label.dispatch('keydown',{key:'Enter'});
  assert.deepEqual(page.get('details').querySelectorAll('[data-schedule]').map(button=>button.dataset.schedule),['First','Update']);
});

test('pointer focus, drag, section zero and panel resize retain their interaction contracts',()=>{
  const page=viewer();page.document.elementFromPoint=()=>page.get('diagram').querySelector('[data-id="system-fixed"]');
  page.canvas.dispatch('pointerdown',{button:0,pointerId:1,clientX:50,clientY:50});assert.equal(page.document.activeElement,page.canvas);
  page.canvas.dispatch('pointerup',{pointerId:1,clientX:50,clientY:50});assert.equal(page.app.view.id,'plugin-item-systems');assert.equal(page.get('details').querySelector('h2').textContent,'update_shared');
  const before=page.get('diagram').style.transform;page.canvas.dispatch('pointerdown',{button:0,pointerId:2,clientX:50,clientY:50});page.canvas.dispatch('pointermove',{pointerId:2,clientX:80,clientY:100});page.canvas.dispatch('pointerup',{pointerId:2,clientX:80,clientY:100});assert.notEqual(page.get('diagram').style.transform,before);
  page.get('section').value='0';page.get('section').dispatch('change');assert.equal(page.get('details').querySelector('h2').textContent,'全部节点');
  page.get('details-resizer').dispatch('keydown',{key:'ArrowLeft'});assert.equal(page.get('details-resizer').getAttribute('aria-valuenow'),'302');
});

test('touch pinch, compact wheel scrolling and height-only resize preserve existing behavior',()=>{
  const page=viewer(undefined,{width:390}),diagram=page.get('diagram'),point=(pointerId,clientX)=>({button:0,pointerType:'touch',pointerId,clientX,clientY:180});
  page.document.elementFromPoint=()=>diagram.querySelector('[data-id="system-fixed"]');const scale=()=>Number(/scale\(([^)]+)\)/.exec(diagram.style.transform)[1]),before=scale();
  page.canvas.dispatch('pointerdown',point(1,100));page.canvas.dispatch('pointerdown',point(2,200));page.canvas.dispatch('pointermove',point(1,50));page.canvas.dispatch('pointermove',point(2,250));assert.equal(scale(),before*2);
  page.canvas.dispatch('pointerup',point(1,50));page.canvas.dispatch('pointerup',point(2,250));assert.equal(page.app.selection.node,null);
  const transform=diagram.style.transform;assert.equal(page.canvas.dispatch('wheel',{deltaY:-100,clientX:100,clientY:180}).defaultPrevented,false);
  page.canvas.clientHeight=530;page.emit('resize');assert.equal(diagram.style.transform,transform);
  page.window.innerWidth=1440;assert.equal(page.canvas.dispatch('wheel',{deltaY:-100,clientX:100,clientY:180}).defaultPrevented,true);
});

test('rendered HTML has only systems navigation and embeds offline object state with valid scripts',()=>{
  const html=renderArchitectureViewer(fixture());for(const{attributes,script}of scriptsIn(html))if(!attributes.includes('application/json'))new vm.Script(script);
  assert.doesNotMatch(html,/data-aspect="(?:data|events)"|data-entity-toggle|createArchitectureEntities|mermaid\.run|cdn\./);
  const embedded=JSON.parse(/<script id="architecture-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);assert.equal(embedded.schemaVersion,3);assert.ok(embedded.objects.length);assert.ok(embedded.objectAliases['old-function']);assert.equal(embedded.componentTypes,undefined);
});

test('overview system details, owner navigation and history preserve registration and workspace',()=>{
  const page=viewer('?workspace=D%3A%2Fdemo&feature=overview',{edit:data=>{const overview=data.views[0],systems=data.views.find(view=>view.id==='plugin-item-systems');Object.assign(overview,{layout:'app-schedule',label:'App 系统调度总览',nodes:structuredClone(systems.nodes),svg:systems.svg})}});
  page.activate('system-fixed');assert.equal(page.app.view.id,'overview');assert.equal(page.get('details').querySelectorAll('.schedule-registration').length,1);
  page.click(page.get('details').querySelector('[data-owner]'));assert.equal(page.app.view.id,'plugin-item-systems');page.back();assert.equal(page.app.view.id,'overview');assert.equal(page.app.selection.node,'system-fixed');assert.equal(page.location.searchParams.get('workspace'),'D:/demo');
});

test('legacy overview plugin links resolve to owner systems after overview becomes a schedule',()=>{
  const page=viewer('?feature=overview&node=plugin-ItemPlugin',{edit:data=>data.views[0].layout='app-schedule'});assert.equal(page.app.view.id,'plugin-item-systems');assert.equal(page.location.searchParams.get('feature'),'item');
});
