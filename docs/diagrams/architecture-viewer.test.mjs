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
  const features=[{id:'item',label:'物品交互',plugin:'ItemPlugin',contracts:['Shared public contract']},{id:'character',label:'人物',plugin:'CharacterPlugin'}];
  const source=(role,line,label=role)=>({role,label,path:'src/item.rs',line});
  const registry={
    'plugin-ItemPlugin':{id:'plugin-ItemPlugin',kind:'Plugin',name:'ItemPlugin',description:'完整插件说明',feature:'item'},
    'plugin-CharacterPlugin':{id:'plugin-CharacterPlugin',kind:'Plugin',name:'CharacterPlugin',description:'人物插件',feature:'character'},
    'plugin-physics-0':{id:'plugin-physics-0',kind:'PluginGroup',name:'PhysicsPlugins',description:'Avian插件',feature:'avian'},
    'plugin-DefaultPlugins':{id:'plugin-DefaultPlugins',kind:'PluginGroup',name:'DefaultPlugins',description:'引擎插件组',feature:'infrastructure'},
    'plugin-inspector-0':{id:'plugin-inspector-0',kind:'Plugin',name:'EguiPlugin',description:'Egui',feature:'egui'},
    'plugin-inspector-1':{id:'plugin-inspector-1',kind:'Plugin',name:'WorldInspectorPlugin',description:'World inspector',feature:'egui'},
    'plugin-physics-1':{id:'plugin-physics-1',kind:'Plugin',name:'LogPlugin',description:'日志插件',feature:'infrastructure'},
    'plugin-ButtonPlugin':{id:'plugin-ButtonPlugin',kind:'Plugin',name:'ButtonPlugin',description:'按钮插件',feature:'infrastructure'},
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
    const nodes=ids.map((nodeId,index)=>{const kind=registry[nodeId].kind;return{id:nodeId,instance:id+'--'+index,visualType:kind==='Entity'?'entity':kind==='Component'?'component':kind==='Resource'?'resource':kind==='Plugin'?'plugin':kind==='PluginGroup'?'plugin_group':'system',role:registry[nodeId].feature===feature?'internal':'external',position:{x:40+index*220,y:40,width:180,height:80}}});
    const svg='<svg id="'+id+'">'+nodes.map(node=>'<g class="node" data-id="'+node.id+'" data-instance="'+node.instance+'" data-visual-type="'+node.visualType+'" role="button" tabindex="0"><rect data-shape-part="'+node.instance+'" style="fill:'+NODE_STYLES[node.visualType].fill+';stroke:'+NODE_STYLES[node.visualType].stroke+';stroke-width:1.6px !important"/><g class="label"><text>'+registry[node.id].name+'</text></g></g>').join('')+links.map(link=>'<path class="edge" data-link-id="'+link.id+'" tabindex="0" role="button"/>').join('')+'</svg>';
    return{id,feature,aspect,label:id,nodes,links,scheduleLinks:[],scheduleGroups:[],sections:[{label:'全部节点',x:40,y:40,width:900,height:80}],bounds:{x:0,y:0,width:1000,height:300},width:ids.length?1000:0,height:ids.length?300:0,svg:ids.length?svg:null,...extra};
  }
  const links=[{id:'contains',from:'item.Shared',to:'entity-item',kind:'reference',edgeSemantic:'reference',label:'可选挂载',sourceEntries:[source('related',70)]},{id:'write',from:'system-fixed',to:'item.Shared',kind:'write',edgeSemantic:'write',label:'更新字段',notes:['直接写入'],sourceEntries:[source('operation',80)]},{id:'read-update',from:'item.Shared',to:'system-update',kind:'read',edgeSemantic:'read',label:'读取字段',sourceEntries:[source('operation',90)]}];
  const schedulePluginCatalog=[{id:'A',label:'AlphaPlugin',description:'demo::alpha 模块'},{id:'B',label:'BetaPlugin',description:'demo::beta 模块'},{id:'C',label:'CharacterPlugin',description:'demo::character 模块'},{id:'bevy_render',label:'bevy_render',description:'引擎渲染模块'},{id:'restored',label:'RestorePlugin',description:'恢复模块'},{id:'render',label:'RendererPlugin',description:'渲染子应用模块'}];
  const schedule=(id,application,scheduleLabel,systemCount)=>({id,application,scheduleLabel,systemCount,aspect:'schedule',engine:'graphviz',label:application+' · '+scheduleLabel,filename:id+'.svg',dotFilename:id+'.dot',width:1500,height:800,svg:'<svg><g class="node" id="node1"><title>update_shared</title><text>update_shared</text></g></svg>',nodes:[],links:[],scheduleLinks:[],sections:[],exportInfo:{bevyVersion:'0.20.0',debugdumpVersion:'0.17.0',exportedAt:'2026-10-26T00:00:00Z',target:'x86_64-pc-windows-msvc',sourceFingerprint:'abc123'},schedulePluginGroups:(application==='main'?['A','B','C','bevy_render','restored']:['render']).map(id=>({id,systemNames:id==='A'?['demo::alpha::one','demo::alpha::two','demo::alpha::one']:[id+'::system']})),scheduleGraph:{nodes:(application==='main'?['A','B','C','bevy_render','restored']:['render::draw']).map((name,index)=>({name:'sys'+index,attributes:{tooltip:name,label:name}}))}});
  const views=[schedule('schedule-startup','main','Startup',1),schedule('schedule-update','main','Update',2),schedule('schedule-render','RenderApp','Render',1)];
  for(const record of Object.values(registry).filter(record=>!record.alias_of)){
    const related=record.kind==='Entity'?[]:links.filter(link=>link.from===record.id||link.to===record.id);
    const ids=[...new Set([record.id,...related.flatMap(link=>[link.from,link.to])])];
    views.push(graph('object:'+record.id,record.feature,'object',ids,related,{objectId:record.id,centerNodeId:record.id}));
  }
  const objects=views.filter(view=>view.aspect==='object').map(view=>({id:view.objectId,viewId:view.id,feature:view.feature,kind:registry[view.objectId].kind}));
  return{model:{features,entities:[{id:'item',components:[{id:'item.Shared'},{id:'item.Other'}]},{id:'character',components:[{id:'character.Shared'}]}]},registry,views,objects,schedulePluginCatalog,objectAliases:{'old-component-type':['item.Shared','character.Shared'],'old-function':['system-fixed','system-update']},features,infrastructureFeatures:[{id:'avian',label:'Avian',overviewNode:'plugin-physics-0'}],guideSamples:{nodes:Object.fromEntries(Object.keys(NODE_STYLES).map(type=>[type,'<svg data-sample="'+type+'"></svg>'])),edges:Object.fromEntries(Object.keys(EDGE_STYLES).map(type=>[type,'<svg data-sample="'+type+'"></svg>']))},styles:{nodes:NODE_STYLES,edges:EDGE_STYLES,selection:SELECTION_STYLE,externalReference:EXTERNAL_REFERENCE_STYLE}};
}

function viewer(query='?object=item.Shared',{historyUnavailable=false,width=1440,edit=()=>{},createScheduleRenderer}={}) {
  const data=fixture();edit(data);
  const html=renderArchitectureViewer({...data,features:data.features});
  const document=testDocument(html),location=new URL('file:///D:/demo/docs/diagrams/ecs-architecture.html'+query),frames=[],events=new Map(),entries=[{href:location.href,state:null}];let index=0;
  const history={get state(){return entries[index].state},get length(){return entries.length},replaceState(state,_,href){if(historyUnavailable)throw new Error('unavailable');location.href=new URL(href,location).href;entries[index]={href:location.href,state:structuredClone(state)}},pushState(state,_,href){if(historyUnavailable)throw new Error('unavailable');entries.splice(index+1);location.href=new URL(href,location).href;entries.push({href:location.href,state:structuredClone(state)});index++}};
  const window={innerWidth:width,innerHeight:900,addEventListener(name,listener){events.set(name,listener)}};
  const canvas=document.getElementById('canvas');canvas.clientWidth=950;canvas.clientHeight=600;
  const refreshed=[];
  const app=createArchitectureViewer({data,document,location,history,window,requestAnimationFrame:callback=>frames.push(callback),sourceEditor:{refreshLinks:scope=>refreshed.push(scope),withWorkspace:href=>href},navigation:createArchitectureNavigation(data.features,data.views.filter(view=>view.aspect==='schedule')),createSplitter:createArchitectureSplitter,createInteraction:createArchitectureInteraction,createGestures:createArchitectureGestures,createScheduleRenderer});
  function flush(){while(frames.length)frames.splice(0).forEach(callback=>callback())}flush();
  function click(element){assert.ok(element,'control exists');element.click();flush()}
  return{data,app,document,location,history,canvas,window,emit:(name,event)=>events.get(name)?.(event),refreshed,get:id=>document.getElementById(id),click,flush,choose(id){const select=document.getElementById('view-select');select.value=id;select.dispatch('change');flush()},async settle(){await app.ready;flush()},activate(id,key='Enter'){const node=document.getElementById('diagram').querySelector('[data-id="'+id+'"]');assert.ok(node,'visible node '+id);node.dispatch('keydown',{key});flush()},back(){assert.ok(index>0);location.href=entries[--index].href;events.get('popstate')();flush()},forward(){assert.ok(index+1<entries.length);location.href=entries[++index].href;events.get('popstate')();flush()}};
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

test('first entry fits exported schedules and exact objects including legacy deep links',()=>{
  for(const query of ['', '?feature=overview','?feature=item','?feature=item&node=system-fixed','?object=item.Shared','?object=item.Shared&node=system-update']){
    const page=viewer(query,{edit:data=>{for(const view of data.views){view.width=2400;view.height=6000;view.bounds={x:-8,y:-8,width:view.width,height:view.height}}}});
    assertFitted(page);
    if(query.includes('node=system'))assert.equal(page.get('details').querySelector('h2').textContent,'update_shared');
  }
});

test('huge diagrams shrink below Fit without reversing, keep zoom anchors and restore their viewport',()=>{
  const viewport=page=>{const values=/translate\(([-\d.e+]+)px,\s*([-\d.e+]+)px\) scale\(([-\d.e+]+)\)/.exec(page.get('diagram').style.transform).slice(1).map(Number);return{x:values[0],y:values[1],scale:values[2]}};
  const graphPoint=(state,x,y)=>[(x-state.x)/state.scale,(y-state.y)/state.scale];
  const assertPoint=(before,after)=>before.forEach((value,index)=>assert.ok(Math.abs(value-after[index])<1e-6));
  for(const query of ['?schedule=schedule-update','?object=item.Shared']){
    const page=viewer(query,{edit:data=>{for(const view of data.views){view.width=1800000;view.height=900000}}});
    const initial=viewport(page);assert.ok(initial.scale<.001);assert.notEqual(page.get('zoom-label').textContent,'0%');
    const center=[page.canvas.clientWidth/2,page.canvas.clientHeight/2];
    page.click(page.get('zoom-out'));let current=viewport(page);
    assert.ok(current.scale<initial.scale);assertPoint(graphPoint(initial,...center),graphPoint(current,...center));
    page.canvas.getBoundingClientRect=()=>({left:70,top:50,width:950,height:600});
    const before=current;page.canvas.dispatch('wheel',{deltaY:100,clientX:260,clientY:180});current=viewport(page);
    assert.ok(current.scale<before.scale);assertPoint(graphPoint(before,190,130),graphPoint(current,190,130));
    for(let index=0;index<30;index++)page.click(page.get('zoom-out'));
    current=viewport(page);assert.ok(Math.abs(current.scale-initial.scale/4)<1e-12);
    const transform=page.get('diagram').style.transform;page.app.openObject('resource.Config');page.flush();page.back();
    assert.equal(page.get('diagram').style.transform,transform);
    page.click(page.get('zoom-in'));assert.ok(viewport(page).scale>current.scale);assert.ok(viewport(page).scale<.08);
    page.click(page.get('fit'));const fitted=viewport(page);
    const touch=(pointerId,clientX)=>({button:0,pointerType:'touch',pointerId,clientX,clientY:230});
    page.canvas.dispatch('pointerdown',touch(1,170));page.canvas.dispatch('pointerdown',touch(2,370));
    page.canvas.dispatch('pointermove',touch(1,220));page.canvas.dispatch('pointermove',touch(2,320));
    current=viewport(page);assert.ok(Math.abs(current.scale-fitted.scale/2)<1e-12);assertPoint(graphPoint(fitted,200,180),graphPoint(current,200,180));
    page.canvas.dispatch('pointerup',touch(1,220));page.canvas.dispatch('pointerup',touch(2,320));
    page.canvas.clientWidth*=8;page.canvas.clientHeight*=8;page.emit('resize');const resized=viewport(page);
    page.click(page.get('zoom-out'));assert.ok(viewport(page).scale<=resized.scale,'a larger canvas cannot reverse a shrink action');
  }
});

test('object cards preserve details and explicit navigation returns through object and Schedule origins',()=>{
  const page=viewer('');
  assert.equal(page.app.view.id,'schedule-update');
  page.app.openObject('item.Shared');page.flush();page.activate('system-fixed');
  assert.equal(page.get('details').querySelectorAll('.schedule-registration').length,1);
  page.click(page.get('details').querySelector('[data-object="system-fixed"]'));
  assert.equal(page.app.view.id,'object:system-fixed');assertFitted(page);
  assert.equal(page.location.searchParams.get('object'),'system-fixed');
  const before=page.history.length;page.activate('system-fixed');assert.equal(page.history.length,before);
  page.click(page.get('return-context'));assert.equal(page.app.view.id,'object:item.Shared');
  assert.equal(page.location.searchParams.get('node'),'system-fixed');
  page.click(page.get('return-context'));assert.equal(page.app.view.id,'schedule-update');
  page.choose('object:plugin-CharacterPlugin');assert.equal(page.app.view.id,'object:plugin-CharacterPlugin');
  page.click(page.get('return-overview'));assert.equal(page.app.view.id,'schedule-update');assertFitted(page);
});

test('legacy component, data and events routes migrate precise objects and retain workspace',()=>{
  for(const id of ['item.Shared','character.Shared'])for(const parameter of ['component='+id,'node='+id]){
    const page=viewer('?feature=item&tab=data&'+parameter+'&workspace=E%3A%2Fwork&keep=1#anchor');
    assert.equal(page.app.view.id,'object:'+id);assert.equal(page.history.length,1);
    assert.equal(page.location.searchParams.get('object'),id);
    for(const key of ['component','tab','feature'])assert.equal(page.location.searchParams.has(key),false);
    assert.equal(page.location.searchParams.get('workspace'),'E:/work');assert.equal(page.location.searchParams.get('keep'),'1');assert.equal(page.location.hash,'#anchor');
  }
  assert.equal(viewer('?feature=item&tab=events&node=system-update').app.view.id,'object:system-update');
  assert.equal(viewer('?feature=item&tab=data&node=item.Legacy').app.view.id,'object:item.Shared');
  for(const tab of ['data','events'])for(const node of ['','&node=deleted'])assert.equal(viewer('?feature=item&tab='+tab+node).app.view.id,'object:plugin-ItemPlugin');
});

test('legacy plugin and infrastructure entries open Plugin objects or the default Schedule',()=>{
  for(const feature of ['third_party','infrastructure']){
    const page=viewer('?feature='+feature+'&tab=data&node=item.Shared');
    assert.equal(page.app.view.id,'object:item.Shared');assert.equal(page.location.searchParams.has('feature'),false);
  }
  assert.equal(viewer('?feature=avian').app.view.id,'object:plugin-physics-0');
  assert.equal(viewer('?feature=third_party&node=deleted').app.view.id,'schedule-update');
  assert.equal(viewer('?feature=overview').app.view.id,'schedule-update');
  assert.equal(viewer('?feature=overview&node=plugin-ItemPlugin').app.view.id,'object:plugin-ItemPlugin');
  const hidden=viewer('?object=plugin-physics-1&workspace=E:/work');
  assert.equal(hidden.app.view.objectId,'plugin-physics-1');assert.ok(hidden.get('current-object-option').textContent.includes('LogPlugin'));
  hidden.app.search('ButtonPlugin');hidden.click(hidden.get('object-results').querySelector('[data-object="plugin-ButtonPlugin"]'));
  assert.equal(hidden.app.view.objectId,'plugin-ButtonPlugin');hidden.back();assert.equal(hidden.app.view.objectId,'plugin-physics-1');assert.equal(hidden.location.searchParams.get('workspace'),'E:/work');
});

test('old aggregate aliases offer every original projection or registration without choosing one',()=>{
  for(const [old,ids]of [['old-component-type',['item.Shared','character.Shared']],['old-function',['system-fixed','system-update']]]){
    const page=viewer('?feature=item&object='+old+'&keep=1');
    assert.equal(page.get('object-results').querySelector('h2').textContent,'选择原对象');
    assert.deepEqual(page.get('object-results').querySelectorAll('[data-object]').map(button=>button.dataset.object),ids);
    assert.equal(page.history.length,1);
    page.click(page.get('object-results').querySelector('[data-object="'+ids[1]+'"]'));assert.equal(page.app.view.id,'object:'+ids[1]);
  }
  const nodeAlias=viewer('?feature=item&component=item.Shared&node=old-function');
  assert.equal(nodeAlias.app.view.id,'object:item.Shared');assert.equal(nodeAlias.location.searchParams.get('node'),'old-function');
  assert.deepEqual(nodeAlias.get('object-results').querySelectorAll('[data-object]').map(button=>button.dataset.object),['system-fixed','system-update']);
  const standalone=viewer('?feature=item&node=old-function');assert.equal(standalone.get('object-results').querySelector('h2').textContent,'选择原对象');
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
  const results=page.get('object-results').querySelectorAll('[data-object]');
  assert.ok(results.some(button=>button.dataset.object==='item.Shared'&&button.textContent.includes('物品')));
  assert.ok(results.some(button=>button.dataset.object==='character.Shared'&&button.textContent.includes('人物')));
  assert.ok(results.some(button=>button.dataset.object==='system-fixed'&&button.textContent.includes('FixedUpdate')));
  assert.ok(results.some(button=>button.dataset.object==='system-update'&&button.textContent.includes('RunFixedMainLoop')));
  page.app.search('配置');assert.equal(page.get('object-results').querySelector('h2').textContent,'1 个匹配对象');
  page.click(page.get('object-results').querySelector('[data-object="resource.Config"]'));assert.equal(page.app.view.id,'object:resource.Config');
  assert.equal(page.app.view.nodes.length,1);assertFitted(page);
  page.back();assert.equal(page.get('object-results').querySelector('h2').textContent,'1 个匹配对象');assert.equal(page.get('search').value,'配置');
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

test('back and forward restore object selection, edge details, zoom and Schedule context',()=>{
  const page=viewer('?schedule=schedule-render');page.click(page.get('zoom-out'));const original=page.get('diagram').style.transform;
  page.app.openObject('item.Shared');page.flush();page.click(page.get('zoom-in'));page.get('diagram').querySelector('[data-link-id="write"]').dispatch('keydown',{key:'Enter'});const object=page.get('diagram').style.transform;
  page.app.navigate({schedule:'schedule-startup',node:null});page.flush();
  page.back();assert.equal(page.get('diagram').style.transform,object);assert.equal(page.get('details').querySelector('.badge').textContent,EDGE_STYLES.write.label);
  page.back();assert.equal(page.app.view.id,'schedule-render');assert.equal(page.get('diagram').style.transform,original);
  page.forward();assert.equal(page.get('diagram').style.transform,object);
  page.click(page.get('return-context'));assert.equal(page.app.view.id,'schedule-render');
  const direct=viewer('');direct.app.openObject('item.Shared');direct.flush();direct.activate('system-fixed');
  direct.back();direct.forward();assert.equal(direct.app.selection.node,'system-fixed');assert.equal(direct.get('details').querySelector('h2').textContent,'update_shared');
  direct.get('diagram').querySelector('[data-link-id="write"]').dispatch('keydown',{key:'Enter'});
  direct.back();direct.forward();assert.equal(direct.get('details').querySelector('.badge').textContent,EDGE_STYLES.write.label);
});

test('unavailable local history and stale object routes retain working navigation',()=>{
  const page=viewer('?schedule=schedule-update',{historyUnavailable:true});page.app.openObject('item.Shared');page.flush();assert.equal(page.app.view.id,'object:item.Shared');
  page.click(page.get('return-context'));assert.equal(page.app.view.id,'schedule-update');
  const stale=viewer('?feature=item&object=deleted');assert.equal(stale.app.view.id,'object:plugin-ItemPlugin');
  assert.equal(viewer('?object=deleted').app.view.id,'schedule-update');
  const unrelated=viewer('?object=item.Shared&node=resource.Config');assert.equal(unrelated.app.selection.node,'item.Shared');
});

test('node details preserve canonical Read/Write summaries, full query and authoritative source entries',()=>{
  const page=viewer('?feature=item&object=system-fixed');const details=page.get('details');
  const read=details.querySelector('[data-access="Read"]');assert.deepEqual(read.querySelectorAll('[data-access-kind]').map(group=>group.dataset.accessKind),['Entity','Resource','Local','NonSend']);
  assert.deepEqual(read.querySelector('[data-access-kind="Entity"]').querySelectorAll('[data-open]').map(button=>button.dataset.open),['entity-item','entity-character']);
  assert.ok(details.textContent.includes('Query<&mut Shared>'));
  page.click(details.querySelector('[data-owner]'));assert.equal(page.app.view.id,'object:plugin-ItemPlugin');assert.equal(page.location.searchParams.get('object'),'plugin-ItemPlugin');
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

test('object event edges retain original trigger evidence and exact event navigation',()=>{
  const page=viewer('?object=system-fixed&keep=1&workspace=E%3A%2Fwork#anchor',{edit:data=>{
    data.registry['item.Shared'].kind='EntityEvent';data.registry['item.Shared'].name='Fire<MoveAction>';
    const view=data.views.find(view=>view.objectId==='system-fixed');
    view.links=[{id:'observer-example',from:'system-fixed',to:'item.Shared',kind:'trigger',edgeSemantic:'observe',eventId:'item.Shared',label:'Fire<MoveAction>',notes:['Commands 应用后触发'],sourceEntries:[{path:'src/item.rs',line:88,role:'operation',label:'实际事件发出位置'}]}];
    view.svg=view.svg.replace('</svg>','<path class="edge" data-link-id="observer-example" tabindex="0" role="button"/></svg>');
  }});
  page.get('diagram').querySelector('[data-link-id="observer-example"]').dispatch('keydown',{key:'Enter'});
  const details=page.get('details');assert.ok(details.textContent.includes('Commands 应用后触发'));assert.equal(details.querySelector('[data-vscode-line]').dataset.vscodeLine,'88');
  page.click(details.querySelector('[data-open="item.Shared"]'));assert.equal(page.app.view.objectId,'item.Shared');
  assert.equal(page.location.searchParams.get('workspace'),'E:/work');assert.equal(page.location.searchParams.get('keep'),'1');assert.equal(page.location.hash,'#anchor');
  page.back();assert.equal(page.app.view.id,'object:system-fixed');assert.ok(page.get('details').textContent.includes('Fire<MoveAction>'));
});

test('native Schedule SVG has no side panel and receives no object selection or edge binding',()=>{
  const page=viewer('?schedule=schedule-render',{edit:data=>{
    const view=data.views.find(view=>view.id==='schedule-render');
    view.svg=view.svg.replace('</svg>','<g class="edgeLabel" data-mermaid-native-id="sc0"><text>native label</text></g><g class="edge focused dim" id="edge1"><path d="M0 0L20 20"/></g></svg>');
  }});
  assert.equal(page.get('details').querySelector('.guide'),null);
  assert.equal(page.get('details').hidden,true);assert.equal(page.get('details').innerHTML,'');assert.equal(page.get('details-resizer').hidden,true);assert.equal(page.get('workspace').classList.contains('schedule'),true);
  assert.equal(page.get('section').hidden,true);assert.equal(page.get('diagram').querySelector('[data-link-label-id]'),null);
  const before=page.get('details').innerHTML;
  page.get('diagram').querySelector('#node1').dispatch('keydown',{key:'Enter'});assert.equal(page.get('details').innerHTML,before);
  page.document.elementFromPoint=()=>page.get('diagram').querySelector('#node1');
  page.canvas.dispatch('pointerdown',{button:0,pointerId:1,clientX:50,clientY:50});page.canvas.dispatch('pointerup',{pointerId:1,clientX:50,clientY:50});assert.equal(page.get('details').innerHTML,before);
  const svg=page.get('diagram').innerHTML;page.app.search('Shared');assert.equal(page.get('diagram').innerHTML,svg);
  page.app.search('');assert.equal(page.get('details').innerHTML,before);
  const nativeEdge=page.get('diagram').querySelector('#edge1'),classes=nativeEdge.getAttribute('class');
  page.click(page.get('zoom-out'));assert.equal(nativeEdge.getAttribute('class'),classes);
  nativeEdge.dispatch('keydown',{key:'Enter'});page.click(nativeEdge);assert.equal(page.get('details').innerHTML,before);
  page.app.openObject('item.Shared');page.flush();assert.equal(nativeEdge.getAttribute('class'),classes,'leaving a Schedule does not run object edge styling on Graphviz groups');
});

test('pointer focus, drag, section zero and panel resize retain their interaction contracts',()=>{
  const page=viewer();page.document.elementFromPoint=()=>page.get('diagram').querySelector('[data-id="system-fixed"]');
  page.canvas.dispatch('pointerdown',{button:0,pointerId:1,clientX:50,clientY:50});assert.equal(page.document.activeElement,page.canvas);
  page.canvas.dispatch('pointerup',{pointerId:1,clientX:50,clientY:50});assert.equal(page.app.view.id,'object:item.Shared');assert.equal(page.get('details').querySelector('h2').textContent,'update_shared');
  const before=page.get('diagram').style.transform;page.canvas.dispatch('pointerdown',{button:0,pointerId:2,clientX:50,clientY:50});page.canvas.dispatch('pointermove',{pointerId:2,clientX:80,clientY:100});page.canvas.dispatch('pointerup',{pointerId:2,clientX:80,clientY:100});assert.notEqual(page.get('diagram').style.transform,before);
  page.get('section').value='0';page.get('section').dispatch('change');assert.equal(page.get('details').querySelector('h2').textContent,'全部节点');
  page.get('details-resizer').dispatch('keydown',{key:'ArrowLeft'});assert.equal(page.get('details-resizer').getAttribute('aria-valuenow'),'302');
});

test('touch pinch, compact wheel scrolling and height-only resize preserve existing behavior',()=>{
  const page=viewer(undefined,{width:390}),diagram=page.get('diagram'),point=(pointerId,clientX)=>({button:0,pointerType:'touch',pointerId,clientX,clientY:180});
  page.document.elementFromPoint=()=>diagram.querySelector('[data-id="system-fixed"]');const scale=()=>Number(/scale\(([^)]+)\)/.exec(diagram.style.transform)[1]),before=scale();
  page.canvas.dispatch('pointerdown',point(1,100));page.canvas.dispatch('pointerdown',point(2,200));page.canvas.dispatch('pointermove',point(1,50));page.canvas.dispatch('pointermove',point(2,250));assert.equal(scale(),before*2);
  page.canvas.dispatch('pointerup',point(1,50));page.canvas.dispatch('pointerup',point(2,250));assert.equal(page.app.selection.node,'item.Shared');
  const transform=diagram.style.transform;assert.equal(page.canvas.dispatch('wheel',{deltaY:-100,clientX:100,clientY:180}).defaultPrevented,false);
  page.canvas.clientHeight=530;page.emit('resize');assert.equal(diagram.style.transform,transform);
  page.window.innerWidth=1440;assert.equal(page.canvas.dispatch('wheel',{deltaY:-100,clientX:100,clientY:180}).defaultPrevented,true);
});

test('rendered HTML groups exported Schedules by application and embeds mixed offline state',()=>{
  const html=renderArchitectureViewer(fixture());for(const{attributes,script}of scriptsIn(html))if(!attributes.includes('application/json'))new vm.Script(script);
  assert.doesNotMatch(html,/data-aspect=|data-entity-toggle|createArchitectureEntities|mermaid\.run|cdn\.|功能总览|返回总览/);
  const document=testDocument(html);assert.equal(document.querySelectorAll('optgroup').filter(group=>group.getAttribute('label')?.endsWith(' Schedule')).flatMap(group=>group.querySelectorAll('option')).length,3);
  const groups=document.querySelectorAll('optgroup').map(group=>group.getAttribute('label'));
  assert.ok(groups.includes('main Schedule'));assert.ok(groups.includes('RenderApp Schedule'));
  const embedded=JSON.parse(/<script id="architecture-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);assert.equal(embedded.schemaVersion,4);assert.ok(embedded.objects.length);assert.ok(embedded.objectAliases['old-function']);assert.equal(embedded.registry['system-fixed'].filters[0],'Query<&mut Shared>');assert.deepEqual(embedded.schedulePluginCatalog,fixture().schedulePluginCatalog);
});

test('object owner action opens the matching Plugin object and preserves history and workspace',()=>{
  const page=viewer('?workspace=D%3A%2Fdemo&object=system-fixed');
  page.click(page.get('details').querySelector('[data-owner]'));assert.equal(page.app.view.id,'object:plugin-ItemPlugin');
  page.back();assert.equal(page.app.view.id,'object:system-fixed');assert.equal(page.app.selection.node,'system-fixed');assert.equal(page.location.searchParams.get('workspace'),'D:/demo');
});

test('top view picker selects native exports and object return retains the selected Schedule',()=>{
  const page=viewer(''),picker=page.get('view-select'),groups=picker.querySelectorAll('optgroup');
  assert.ok(!groups.some(group=>group.getAttribute('label')==='其他插件'));
  const infrastructure=groups.find(group=>group.getAttribute('label')==='基础设施插件').querySelectorAll('option'),egui=infrastructure.findIndex(option=>option.value==='object:plugin-inspector-0');
  assert.ok(egui>=0);assert.equal(infrastructure[egui+1].value,'object:plugin-inspector-1');
  assert.equal(infrastructure[egui].textContent,'Egui / Inspector · EguiPlugin');assert.equal(infrastructure[egui+1].textContent,'Egui / Inspector · WorldInspectorPlugin');
  assert.ok(!picker.querySelectorAll('option').some(option=>['object:plugin-physics-1','object:plugin-ButtonPlugin'].includes(option.value)));
  page.choose('schedule-render');assert.equal(page.app.view.id,'schedule-render');
  page.choose('object:plugin-ItemPlugin');assert.equal(page.app.view.id,'object:plugin-ItemPlugin');
  page.click(page.get('return-overview'));assert.equal(page.app.view.id,'schedule-render');
  assert.equal(page.get('return-overview').disabled,true);
});

test('Plugin and PluginGroup retain their complete details when selection is cleared',()=>{
  for(const id of ['plugin-ItemPlugin','plugin-physics-0']){
    const page=viewer('?object='+id);assert.equal(page.get('details').hidden,false);
    const description=page.data.registry[id].description;
    assert.ok(page.get('details').textContent.includes(description));
    assert.ok(!page.get('details').textContent.includes('公开契约'));assert.deepEqual(page.data.model.features[0].contracts,['Shared public contract']);
    page.click(page.get('clear-selection'));
    assert.ok(page.get('details').textContent.includes(description));assert.equal(page.get('details').querySelector('.guide'),null);
    assert.equal(page.get('view-select').value,'object:'+id);assert.equal(page.get('schedule-filter').hidden,true);
    page.choose('schedule-update');page.emit('resize');assert.equal(page.get('details').hidden,true);assert.equal(page.get('details-resizer').hidden,true);
    page.choose('object:'+id);assert.equal(page.get('details').hidden,false);assert.equal(page.get('details-resizer').hidden,false);
  }
});

test('independent search and alias results support keyboard navigation without opening a Schedule sidebar',()=>{
  const page=viewer('?schedule=schedule-update'),input=page.get('search');
  input.value='Shared';input.focus();input.dispatch('input');
  assert.equal(page.get('object-results').hidden,false);assert.equal(page.get('details').hidden,true);
  input.dispatch('keydown',{key:'ArrowUp'});assert.equal(page.document.activeElement,page.get('object-results').querySelectorAll('[data-object]').at(-1));
  page.document.activeElement.dispatch('keydown',{key:'ArrowDown'});
  const first=page.document.activeElement;assert.ok(first.dataset.object);
  first.dispatch('keydown',{key:'ArrowDown'});assert.notEqual(page.document.activeElement,first);
  page.document.activeElement.dispatch('keydown',{key:'ArrowUp'});assert.equal(page.document.activeElement,first);
  first.dispatch('keydown',{key:'Enter'});page.flush();assert.equal(page.app.view.objectId,first.dataset.object);
  assert.equal(page.get('object-results').hidden,true);assert.equal(page.document.activeElement,page.canvas);
  page.back();assert.equal(input.value,'shared');assert.equal(page.get('object-results').hidden,false);
  input.dispatch('keydown',{key:'Escape'});assert.equal(page.get('object-results').hidden,true);assert.equal(page.document.activeElement,input);
  const alias=viewer('?object=old-component-type');assert.equal(alias.get('details').hidden,true);
  alias.get('search').dispatch('keydown',{key:'ArrowDown'});alias.document.activeElement.dispatch('keydown',{key:'Enter'});alias.flush();
  assert.equal(alias.app.view.objectId,'item.Shared');
});

function controlledSchedules(){
  const requests=[];let cancelled=0;
  return{requests,get cancelled(){return cancelled},create:()=>({cancel(){cancelled++},render(view,filters){return new Promise((resolve,reject)=>requests.push({view,filters,resolve,reject}))}})};
}
const filteredResult=(label,count=1)=>({svg:'<svg><text>'+label+'</text></svg>',width:1200,height:700,systemCount:count,totalSystemCount:8,filtered:true});
function filterPlugin(page,side,id,checked=true){
  if(page.get('schedule-'+side+'-menu').hidden)page.click(page.get('schedule-'+side));
  const input=page.get('schedule-'+side+'-options').querySelectorAll('[data-filter-choice]').find(input=>input.value===id);
  assert.ok(input,'available Plugin group '+id);input.checked=checked;input.dispatch('change');page.flush();return input;
}

test('filters change immediately without form submission and retain menu DOM, search, focus and scrolling',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update&workspace=E:/work#anchor',{createScheduleRenderer:runtime.create});
  assert.equal(page.get('schedule-apply'),null);assert.equal(page.get('schedule-filter').tagName.toLowerCase(),'section');
  assert.equal(page.get('schedule-filter').getAttribute('role'),'group');assert.equal(page.document.querySelector('.filter-hint'),null);
  page.click(page.get('schedule-include'));const menu=page.get('schedule-include-menu'),options=page.get('schedule-include-options'),query=page.get('schedule-include-search');
  query.value='Alpha';query.dispatch('input');query.focus();options.scrollTop=78;
  const input=options.querySelector('[value="A"]'),initialHistory=page.history.length,original=page.get('diagram').innerHTML;
  assert.equal(runtime.requests.length,0);assert.equal(page.history.length,initialHistory);
  input.focus();input.checked=true;input.dispatch('change');page.flush();
  assert.deepEqual(page.location.searchParams.getAll('scheduleIncludePlugin'),['A']);assert.equal(page.history.length,initialHistory+1);
  assert.equal(menu.hidden,false);assert.equal(query.value,'Alpha');assert.equal(options.scrollTop,78);
  assert.equal(options.querySelector('[value="A"]'),input);assert.equal(input.parentElement.parentElement,options);assert.equal(page.document.activeElement,input);
  await Promise.resolve();assert.equal(runtime.requests.length,1);assert.equal(page.get('diagram').innerHTML,original);
  const enter=query.dispatch('keydown',{key:'Enter'});assert.equal(enter.defaultPrevented,false);assert.equal(page.history.length,initialHistory+1);
  runtime.requests[0].resolve(filteredResult('A'));await page.settle();
  assert.equal(menu.hidden,false);assert.equal(query.value,'Alpha');assert.equal(options.scrollTop,78);assert.equal(page.document.activeElement,input);assert.equal(options.querySelector('[value="A"]'),input);
  input.dispatch('change');page.flush();await Promise.resolve();assert.equal(page.history.length,initialHistory+1);assert.equal(runtime.requests.length,1);
  page.click(page.get('schedule-include-select'));await Promise.resolve();assert.equal(page.history.length,initialHistory+1);assert.equal(runtime.requests.length,1);
  page.click(page.get('schedule-include-clear'));assert.equal(page.history.length,initialHistory+2);assert.equal(menu.hidden,false);assert.equal(query.value,'Alpha');assert.equal(options.scrollTop,78);assert.equal(options.querySelector('[value="A"]'),input);assert.equal(input.checked,false);assert.equal(page.get('diagram').innerHTML,original);
  assert.equal(page.location.searchParams.get('workspace'),'E:/work');assert.equal(page.location.hash,'#anchor');
});

test('realtime failure preserves the last successful SVG and viewport and all-clear restores the static graph',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update',{createScheduleRenderer:runtime.create}),original=page.get('diagram').innerHTML;
  filterPlugin(page,'include','A');await Promise.resolve();runtime.requests[0].resolve(filteredResult('A'));await page.settle();page.click(page.get('zoom-out'));
  const lastSvg=page.get('diagram').innerHTML,lastTransform=page.get('diagram').style.transform;
  filterPlugin(page,'include','B');await Promise.resolve();assert.equal(page.get('diagram').innerHTML,lastSvg);
  runtime.requests[1].reject(new Error('worker timeout'));await page.settle();
  assert.equal(page.get('diagram').innerHTML,lastSvg);assert.equal(page.get('diagram').style.transform,lastTransform);assert.ok(page.get('schedule-status').textContent.includes('worker timeout'));assert.equal(page.get('schedule-include-menu').hidden,false);
  page.get('schedule-clear').focus();page.get('schedule-clear').dispatch('focusin');
  page.click(page.get('schedule-clear'));assert.equal(page.get('diagram').innerHTML,original);assert.equal(page.location.searchParams.has('scheduleIncludePlugin'),false);
  assert.equal(page.get('schedule-include-menu').hidden,false);assert.equal(page.document.activeElement,page.get('schedule-clear'));
  page.get('schedule-clear').dispatch('keydown',{key:'Escape'});assert.equal(page.get('schedule-include-menu').hidden,true);assert.equal(page.document.activeElement,page.get('schedule-include'));
  assertFitted(page);
  const count=page.history.length;page.click(page.get('schedule-clear'));assert.equal(page.history.length,count);
});

test('late realtime responses cannot overwrite newer conditions, object navigation or a different Schedule',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update',{createScheduleRenderer:runtime.create});
  filterPlugin(page,'include','A');await Promise.resolve();filterPlugin(page,'include','B');await Promise.resolve();
  runtime.requests[1].resolve(filteredResult('latest AB'));await page.settle();runtime.requests[0].resolve(filteredResult('stale A'));await Promise.resolve();await Promise.resolve();page.flush();assert.ok(page.get('diagram').innerHTML.includes('latest AB'));
  filterPlugin(page,'exclude','B');await Promise.resolve();page.app.openObject('item.Shared');page.flush();runtime.requests[2].resolve(filteredResult('late object'));await Promise.resolve();await Promise.resolve();page.flush();assert.equal(page.app.view.objectId,'item.Shared');
  assert.deepEqual(page.location.searchParams.getAll('scheduleIncludePlugin'),['A','B']);assert.deepEqual(page.location.searchParams.getAll('scheduleExcludePlugin'),['B']);
  page.click(page.get('return-context'));await Promise.resolve();assert.equal(runtime.requests[3].view.id,'schedule-update');
  page.choose('schedule-render');await Promise.resolve();assert.equal(runtime.requests[4].view.id,'schedule-render');
  runtime.requests[4].resolve(filteredResult('Render AB'));await page.settle();runtime.requests[3].resolve(filteredResult('late Update'));await Promise.resolve();await Promise.resolve();page.flush();assert.equal(page.app.view.id,'schedule-render');assert.ok(page.get('diagram').innerHTML.includes('Render AB'));
});

test('realtime and full-navigation layouts preserve a global object search opened while they are pending',async()=>{
  for(const initial of ['?schedule=schedule-update','?schedule=schedule-update&scheduleIncludePlugin=A']){
    const runtime=controlledSchedules(),page=viewer(initial,{createScheduleRenderer:runtime.create});
    if(!initial.includes('scheduleIncludePlugin'))filterPlugin(page,'include','A');await Promise.resolve();
    const input=page.get('search');input.value='Shared';input.focus();input.dispatch('input');const results=page.get('object-results'),html=results.innerHTML;
    runtime.requests[0].resolve(filteredResult('A'));await page.settle();
    assert.equal(input.value,'Shared');assert.equal(page.document.activeElement,input);assert.equal(results.hidden,false);assert.equal(results.innerHTML,html);
  }
});

test('search history is independent of in-flight or failed viewport snapshots and newer typing wins',async()=>{
  for(const fails of [false,true]){
    const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update&scheduleIncludePlugin=A',{createScheduleRenderer:runtime.create});await Promise.resolve();
    if(fails){runtime.requests[0].reject(new Error('failed'));await page.settle()}
    const input=page.get('search');input.value='Shared';input.dispatch('input');
    page.click(page.get('object-results').querySelector('[data-object="item.Shared"]'));page.back();await Promise.resolve();
    assert.equal(page.history.state.architectureView,null);assert.equal(input.value,'shared');assert.equal(page.get('object-results').hidden,false);
    input.value='Other';input.focus();input.dispatch('input');const results=page.get('object-results'),html=results.innerHTML;
    runtime.requests[1].resolve({...filteredResult('restored A'),width:800,height:1100});await page.settle();
    assert.equal(input.value,'Other');assert.equal(results.hidden,false);assert.equal(results.innerHTML,html);assert.equal(page.document.activeElement,input);assertFitted(page);
    if(!fails){runtime.requests[0].resolve(filteredResult('stale'));await Promise.resolve();await Promise.resolve();page.flush()}
  }
});

test('filtered deep links retain static fallback and zero matches produce an empty state without invalid geometry',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-render&scheduleInclude=Missing',{createScheduleRenderer:runtime.create});
  assert.equal(page.app.view.id,'schedule-render');assert.ok(page.get('diagram').innerHTML.includes('update_shared'));
  await Promise.resolve();runtime.requests[0].resolve({svg:null,width:0,height:0,systemCount:0,totalSystemCount:8,filtered:true});await page.settle();
  assert.equal(page.get('diagram').innerHTML,'');assert.ok(page.canvas.querySelector('.empty-state'));assert.ok(!/NaN|Infinity/.test(page.get('diagram').style.transform));
  page.click(page.get('zoom-out'));page.emit('resize');assert.ok(!/NaN|Infinity/.test(page.get('diagram').style.transform));assert.equal(page.get('details').hidden,true);
});

test('history restores completed filter viewports but never assigns old geometry to an in-flight condition',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update',{createScheduleRenderer:runtime.create});
  filterPlugin(page,'include','A');await Promise.resolve();runtime.requests[0].resolve(filteredResult('A'));await page.settle();page.click(page.get('zoom-out'));const transformA=page.get('diagram').style.transform;
  filterPlugin(page,'include','B');await Promise.resolve();page.choose('schedule-render');await Promise.resolve();
  runtime.requests[2].resolve(filteredResult('Render AB'));await page.settle();page.back();await Promise.resolve();
  assert.equal(page.history.state.architectureView,null);runtime.requests[3].resolve({...filteredResult('AB'),width:840,height:1100});await page.settle();assertFitted(page);assert.notEqual(page.get('diagram').style.transform,transformA);
  page.back();await Promise.resolve();runtime.requests[4].resolve(filteredResult('A'));await page.settle();assert.equal(page.get('diagram').style.transform,transformA);assert.deepEqual(page.app.selection.scheduleIncludePlugins,['A']);
  runtime.requests[1].resolve(filteredResult('stale AB'));await Promise.resolve();await Promise.resolve();page.flush();assert.ok(!page.get('diagram').innerHTML.includes('stale'));
});

test('browser back and forward retain user zoom, pan and Fit without another internal navigation',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update',{createScheduleRenderer:runtime.create});
  filterPlugin(page,'include','A');await Promise.resolve();runtime.requests[0].resolve(filteredResult('A'));await page.settle();
  page.click(page.get('zoom-out'));page.canvas.dispatch('pointerdown',{pointerId:1,button:0,clientX:200,clientY:150});page.canvas.dispatch('pointermove',{pointerId:1,buttons:1,clientX:280,clientY:190});page.canvas.dispatch('pointerup',{pointerId:1,button:0,clientX:280,clientY:190});
  const viewport=page.get('diagram').style.transform;page.back();page.forward();await Promise.resolve();runtime.requests[1].resolve(filteredResult('A'));await page.settle();assert.equal(page.get('diagram').style.transform,viewport);
  page.click(page.get('fit'));const fit=page.get('diagram').style.transform;page.back();page.forward();await Promise.resolve();runtime.requests[2].resolve(filteredResult('A'));await page.settle();assert.equal(page.get('diagram').style.transform,fit);
});

test('failed and not-yet-presented filter states return by rendering and fitting their own conditions',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update',{createScheduleRenderer:runtime.create});
  filterPlugin(page,'include','A');await Promise.resolve();runtime.requests[0].resolve(filteredResult('A'));await page.settle();page.click(page.get('zoom-out'));
  filterPlugin(page,'include','B');await Promise.resolve();runtime.requests[1].reject(new Error('failed B'));await page.settle();
  page.app.openObject('item.Shared');page.flush();page.back();await Promise.resolve();assert.equal(page.history.state.architectureView,null);runtime.requests[2].resolve({...filteredResult('AB restored'),width:800,height:1000});await page.settle();assertFitted(page);
  filterPlugin(page,'include','C');await Promise.resolve();runtime.requests[3].resolve(filteredResult('ABC'));
  await page.app.ready;
  // 不执行排版完成后的 RAF，模拟下一次操作早于新图适合窗口。
  page.app.openObject('item.Shared');page.flush();page.back();await Promise.resolve();assert.equal(page.history.state.architectureView,null);
  runtime.requests[4].resolve({...filteredResult('ABC restored'),width:900,height:1300});await page.settle();assertFitted(page);
});

test('a different filtered Schedule shows its own fallback and all-clear remains recoverable after failure',async()=>{
  const runtime=controlledSchedules(),page=viewer('?object=item.Shared&scheduleInclude=character',{createScheduleRenderer:runtime.create});
  page.click(page.get('return-overview'));await Promise.resolve();assert.equal(page.app.view.id,'schedule-update');assert.equal(page.get('details').hidden,true);assert.equal(page.get('details-resizer').hidden,true);
  runtime.requests[0].reject(new Error('layout failed'));await page.settle();page.click(page.get('schedule-clear'));assertFitted(page);
  filterPlugin(page,'include','A');await Promise.resolve();runtime.requests[1].resolve(filteredResult('Update A'));await page.settle();
  page.choose('schedule-render');await Promise.resolve();assert.equal(page.get('diagram').innerHTML,page.data.views.find(view=>view.id==='schedule-render').svg);
  runtime.requests[2].reject(new Error('render failed'));await page.settle();page.click(page.get('schedule-clear'));assert.equal(page.app.view.id,'schedule-render');assertFitted(page);
});

test('BFCache resumes a cancelled pending filter without a new history entry and reuses completed views',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update',{createScheduleRenderer:runtime.create});
  filterPlugin(page,'include','A');await Promise.resolve();runtime.requests[0].resolve(filteredResult('A'));await page.settle();page.click(page.get('zoom-out'));const transformA=page.get('diagram').style.transform;
  page.emit('pageshow',{persisted:false});await Promise.resolve();assert.equal(runtime.requests.length,1);
  page.emit('pagehide');page.emit('pageshow',{persisted:true});await Promise.resolve();assert.equal(runtime.requests.length,1);assert.equal(page.get('diagram').style.transform,transformA);
  filterPlugin(page,'include','B');await Promise.resolve();const count=page.history.length,input=page.get('schedule-include-options').querySelector('[value="B"]');
  page.emit('pagehide');runtime.requests[1].resolve(filteredResult('cancelled AB'));await Promise.resolve();await Promise.resolve();page.flush();assert.ok(!page.get('diagram').innerHTML.includes('cancelled'));
  page.emit('pageshow',{persisted:true});await Promise.resolve();assert.equal(page.history.length,count);assert.equal(runtime.requests.length,3);assert.deepEqual(runtime.requests[2].filters.includePlugins,['A','B']);
  runtime.requests[2].resolve(filteredResult('resumed AB'));await page.settle();assert.ok(page.get('diagram').innerHTML.includes('resumed AB'));assert.equal(page.get('schedule-include-options').querySelector('[value="B"]'),input);assert.equal(page.get('schedule-include-menu').hidden,false);
});

test('search and alias popups stay within viewport margins when the toolbar wraps and resizes',()=>{
  const page=viewer('?schedule=schedule-update',{width:800}),input=page.get('search'),popup=page.get('object-results');
  let rect={left:350,top:10,width:210,height:30};input.getBoundingClientRect=()=>rect;
  page.app.search('Shared');
  const check=()=>{const left=Number.parseFloat(popup.style.left),width=Number.parseFloat(popup.style.width),top=Number.parseFloat(popup.style.top),maxHeight=Number.parseFloat(popup.style.maxHeight);assert.ok(left>=12);assert.ok(left+width<=page.window.innerWidth-12);assert.equal(top,rect.top+rect.height+8);assert.ok(top+maxHeight<=page.window.innerHeight-12)};
  check();assert.equal(popup.style.left,'308px');
  // 搜索框换到第二行后，浮层仍锚定输入框，而非顶栏的固定行高。
  rect={left:145,top:72,width:190,height:32};page.window.innerWidth=390;page.emit('resize');check();assert.equal(popup.style.left,'12px');
  rect={left:8,top:14,width:210,height:30};page.window.innerWidth=1000;page.emit('resize');check();assert.equal(popup.style.left,'12px');
  const alias=viewer('?object=old-component-type',{width:800});alias.get('search').getBoundingClientRect=()=>({left:600,top:50,width:180,height:30});alias.emit('resize');
  assert.equal(alias.get('object-results').style.left,'308px');assert.equal(alias.get('object-results').style.top,'88px');
});

test('searchable Plugin multiselects keep groups and counts and batch selection applies once',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update',{createScheduleRenderer:runtime.create});
  page.click(page.get('schedule-include'));const options=page.get('schedule-include-options');
  assert.deepEqual(options.querySelectorAll('[data-filter-choice]').map(input=>input.value).sort(),page.data.schedulePluginCatalog.map(plugin=>plugin.id).sort());
  assert.ok(!options.textContent.includes('demo::alpha::one'));assert.ok(options.querySelector('[value="A"]').parentElement.textContent.includes('2 个系统'));
  const inactive=options.querySelector('[value="render"]');assert.ok(inactive.parentElement.textContent.includes('0 个系统'));assert.ok(inactive.parentElement.textContent.includes('不在当前 Schedule'));
  page.get('schedule-include-search').value='demo::';page.get('schedule-include-search').dispatch('input');const a=options.querySelector('[value="A"]'),before=page.history.length;
  page.click(page.get('schedule-include-select'));await Promise.resolve();assert.equal(runtime.requests.length,1);assert.equal(page.history.length,before+1);assert.deepEqual(new Set(runtime.requests[0].filters.includePlugins),new Set(['A','B','C']));
  assert.equal(options.querySelector('[value="A"]'),a);assert.equal(a.checked,true);assert.equal(page.get('schedule-include-menu').hidden,false);
  page.click(page.get('schedule-include-select'));await Promise.resolve();assert.equal(runtime.requests.length,1);assert.equal(page.history.length,before+1);
  filterPlugin(page,'exclude','B');await Promise.resolve();assert.deepEqual(runtime.requests[1].filters.excludePlugins,['B']);runtime.requests[1].resolve(filteredResult('batch'));await page.settle();runtime.requests[0].resolve(filteredResult('stale batch'));await Promise.resolve();await Promise.resolve();page.flush();
});

test('selections remain removable on another Schedule and side-clear immediately restores its static graph',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update',{createScheduleRenderer:runtime.create});
  filterPlugin(page,'include','A');await Promise.resolve();runtime.requests[0].resolve(filteredResult('A on Update'));await page.settle();
  page.choose('schedule-render');await Promise.resolve();assert.deepEqual(runtime.requests[1].filters.includePlugins,['A']);page.click(page.get('schedule-include'));
  const input=page.get('schedule-include-options').querySelector('[value="A"]');assert.equal(input.checked,true);assert.ok(input.parentElement.textContent.includes('不在当前 Schedule'));
  page.get('schedule-include-search').value='Alpha';page.get('schedule-include-search').dispatch('input');const retained=page.get('schedule-include-options').querySelector('[value="A"]');
  page.click(page.get('schedule-include-clear'));assert.equal(page.location.searchParams.has('scheduleIncludePlugin'),false);assert.equal(page.app.view.id,'schedule-render');assert.equal(page.get('schedule-include-options').querySelector('[value="A"]'),retained);assert.equal(retained.checked,false);
  const count=page.history.length;page.click(page.get('schedule-include-select'));assert.equal(page.history.length,count);assert.equal(page.get('schedule-include-menu').hidden,false);
  runtime.requests[1].resolve(filteredResult('stale'));await Promise.resolve();await Promise.resolve();page.flush();assert.ok(!page.get('diagram').innerHTML.includes('stale'));
  page.back();await Promise.resolve();runtime.requests[2].resolve(filteredResult('A on Render'));await page.settle();assert.deepEqual(page.app.selection.scheduleIncludePlugins,['A']);
});

test('legacy text conditions apply immediately but their candidates remain available through async updates',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update&scheduleInclude=character,ui&scheduleExclude=bevy',{createScheduleRenderer:runtime.create});await Promise.resolve();
  page.click(page.get('schedule-include'));const options=page.get('schedule-include-options'),legacy=options.querySelector('[data-filter-legacy]');assert.equal(legacy.checked,true);
  legacy.focus();legacy.checked=false;legacy.dispatch('change');await Promise.resolve();assert.equal(page.location.searchParams.has('scheduleInclude'),false);assert.equal(options.querySelector('[data-filter-legacy]'),legacy);
  runtime.requests[1].resolve(filteredResult('without legacy include'));await page.settle();assert.equal(page.document.activeElement,legacy);assert.equal(options.querySelector('[data-filter-legacy]'),legacy);
  legacy.checked=true;legacy.dispatch('change');await Promise.resolve();assert.equal(page.location.searchParams.get('scheduleInclude'),'character,ui');
  page.click(page.get('schedule-clear'));assert.equal(page.app.view.filtered,undefined);for(const request of runtime.requests)request.resolve(filteredResult('stale'));await Promise.resolve();await Promise.resolve();page.flush();
});

test('unknown Plugin and full system candidates survive unchecking, searching and side-clear',async()=>{
  const runtime=controlledSchedules(),system='demo::generic::<(Foo, Bar), "value&x">',unknown='plugin-Unknown<&T>';
  const params=new URLSearchParams({schedule:'schedule-update',scheduleIncludePlugin:unknown,scheduleIncludeSystem:system,scheduleExcludeSystem:'A'});
  const page=viewer('?'+params,{createScheduleRenderer:runtime.create});await Promise.resolve();page.click(page.get('schedule-include'));
  const options=page.get('schedule-include-options'),missing=options.querySelectorAll('[data-filter-choice]').find(input=>input.value===unknown),legacy=options.querySelector('[data-filter-system]');
  missing.checked=false;missing.dispatch('change');legacy.checked=false;legacy.dispatch('change');await Promise.resolve();
  assert.equal(options.querySelectorAll('[data-filter-choice]').find(input=>input.value===unknown),missing);assert.equal(options.querySelector('[data-filter-system]'),legacy);assert.equal(page.location.searchParams.has('scheduleIncludePlugin'),false);assert.equal(page.location.searchParams.has('scheduleIncludeSystem'),false);
  page.get('schedule-include-search').value='Unknown';page.get('schedule-include-search').dispatch('input');const recovered=options.querySelectorAll('[data-filter-choice]').find(input=>input.value===unknown);assert.ok(recovered);assert.equal(recovered.checked,false);
  recovered.checked=true;recovered.dispatch('change');await Promise.resolve();assert.equal(page.location.searchParams.get('scheduleIncludePlugin'),unknown);
  page.get('schedule-include-search').value='generic';page.get('schedule-include-search').dispatch('input');const full=options.querySelector('[data-filter-system]');assert.equal(full.value,system);assert.equal(full.checked,false);full.checked=true;full.dispatch('change');await Promise.resolve();assert.equal(page.location.searchParams.get('scheduleIncludeSystem'),system);
  page.click(page.get('schedule-exclude'));const exclude=page.get('schedule-exclude-options'),old=exclude.querySelector('[data-filter-system]');assert.equal(old.value,'A');page.click(page.get('schedule-exclude-clear'));await Promise.resolve();assert.equal(old.checked,false);assert.equal(exclude.querySelector('[data-filter-system]'),old);assert.equal(page.location.searchParams.has('scheduleExcludeSystem'),false);
  page.click(page.get('schedule-clear'));for(const request of runtime.requests)request.resolve(filteredResult('stale'));await Promise.resolve();await Promise.resolve();page.flush();
});

test('filter menus clamp to the viewport, allow Tab, and close mutually with object results, Escape or outside focus',()=>{
  const page=viewer('?schedule=schedule-update',{width:800});let rect={left:350,top:72,width:160,height:30};page.get('schedule-include').getBoundingClientRect=()=>rect;
  page.app.search('Shared');assert.equal(page.get('object-results').hidden,false);page.click(page.get('schedule-include'));assert.equal(page.get('object-results').hidden,true);assert.equal(page.get('schedule-include-menu').style.left,'308px');assert.equal(page.get('schedule-include-menu').style.top,'110px');
  assert.equal(page.get('schedule-include-search').dispatch('keydown',{key:'Tab'}).defaultPrevented,false);
  rect={left:145,top:120,width:180,height:30};page.window.innerWidth=390;page.emit('resize');const menu=page.get('schedule-include-menu');assert.equal(menu.style.left,'12px');assert.equal(menu.style.width,'366px');assert.equal(menu.style.top,'158px');
  page.get('schedule-include-search').dispatch('keydown',{key:'Escape'});assert.equal(menu.hidden,true);assert.equal(page.document.activeElement,page.get('schedule-include'));
  page.click(page.get('schedule-include'));page.click(page.get('schedule-exclude'));assert.equal(menu.hidden,true);assert.equal(page.get('schedule-exclude-menu').hidden,false);
  page.get('view-select').focus();page.get('view-select').dispatch('focusin');assert.equal(page.get('schedule-exclude-menu').hidden,true);assert.equal(page.document.activeElement,page.get('view-select'));
  page.click(page.get('schedule-exclude'));page.click(page.canvas);assert.equal(page.get('schedule-exclude-menu').hidden,true);
  page.click(page.get('schedule-include'));page.app.search('Shared');assert.equal(menu.hidden,true);assert.equal(page.get('object-results').hidden,false);
});
