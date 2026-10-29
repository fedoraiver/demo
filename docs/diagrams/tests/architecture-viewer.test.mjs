// 使用独立语义样本执行正式查看器，不依赖尚未刷新的生成产物。
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createArchitectureViewer, renderArchitectureViewer, startExternalArchitecture } from '../src/architecture-viewer.mjs';
import { createArchitectureNavigation } from '../src/architecture-navigation.mjs';
import { createArchitectureInteraction } from '../src/architecture-interaction.mjs';
import { createArchitectureSplitter } from '../src/architecture-splitter.mjs';
import { createArchitectureGestures } from '../src/architecture-gestures.mjs';
import { createArchitectureSearch } from '../src/architecture-search.mjs';
import { NODE_STYLES, EDGE_STYLES, SELECTION_STYLE, EXTERNAL_REFERENCE_STYLE, selectedFillColor } from '../src/architecture-style.mjs';
import { SCHEDULE_LEGEND_LABELS } from '../src/schedule-legend.mjs';
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
    'set-shared':{id:'set-shared',kind:'SystemSet',name:'SharedSet',description:'集合及其真实直接成员。',feature:'item',sourceEntries:[source('definition',100),source('configure',110)]},
    'context-sync':{id:'context-sync',kind:'Synchronization',name:'ApplyDeferred',description:'应用延迟命令的同步依赖端点。',feature:'infrastructure',sourceEntries:[source('implementation',120)]},
    'constraint-missing':{id:'constraint-missing',kind:'Scheduling constraint',name:'<missing> update_shared',description:'仅由依赖引用的目标，不是本调度中的已注册系统。',feature:'infrastructure',sourceGaps:['待核实：本调度未注册目标系统']},
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
  const schedule=(id,application,scheduleLabel,systemCount)=>({id,application,scheduleLabel,systemCount,aspect:'schedule',engine:'graphviz',label:application+' · '+scheduleLabel,filename:id+'.svg',dotFilename:id+'.dot',width:1500,height:800,svg:'<svg><g class="node" id="node1"><title>update_shared</title><text>update_shared</text></g></svg>',nodes:[],links:[],scheduleLinks:[],sections:[],legendKinds:['system'],exportInfo:{bevyVersion:'0.20.0',debugdumpVersion:'0.17.0',exportedAt:'2026-10-26T00:00:00Z',target:'x86_64-pc-windows-msvc',sourceFingerprint:'abc123'},schedulePluginGroups:(application==='main'?['A','B','C','bevy_render','restored']:['render']).map(id=>({id,systemNames:id==='A'?['demo::alpha::one','demo::alpha::two','demo::alpha::one']:[id+'::system']})),scheduleGraph:{nodes:(application==='main'?['A','B','C','bevy_render','restored']:['render::draw']).map((name,index)=>({name:'sys'+index,attributes:{tooltip:name,label:name}}))}});
  const views=[schedule('schedule-startup','main','Startup',1),schedule('schedule-update','main','Update',2),schedule('schedule-render','RenderApp','Render',1)];
  for(const record of Object.values(registry).filter(record=>!record.alias_of)){
    const related=record.kind==='Entity'?[]:links.filter(link=>link.from===record.id||link.to===record.id);
    const ids=[...new Set([record.id,...related.flatMap(link=>[link.from,link.to])])];
    views.push(graph('object:'+record.id,record.feature,'object',ids,related,{objectId:record.id,centerNodeId:record.id}));
  }
  const objects=views.filter(view=>view.aspect==='object').map(view=>({id:view.objectId,viewId:view.id,feature:view.feature,kind:registry[view.objectId].kind}));
  const scheduleSamples={nodes:Object.fromEntries(['system','system_set','context'].map(kind=>[kind,'<svg data-schedule-sample="'+kind+'"></svg>'])),edges:Object.fromEntries(['order','set_membership'].map(kind=>[kind,'<svg data-schedule-sample="'+kind+'"></svg>']))};
  return{model:{features,entities:[{id:'item',components:[{id:'item.Shared'},{id:'item.Other'}]},{id:'character',components:[{id:'character.Shared'}]}]},registry,views,objects,schedulePluginCatalog,objectAliases:{'old-component-type':['item.Shared','character.Shared'],'old-function':['system-fixed','system-update']},features,infrastructureFeatures:[{id:'avian',label:'Avian',overviewNode:'plugin-physics-0'}],scheduleLegendLabels:SCHEDULE_LEGEND_LABELS,guideSamples:{schedule:scheduleSamples,nodes:Object.fromEntries(Object.keys(NODE_STYLES).map(type=>[type,'<svg data-sample="'+type+'"></svg>'])),edges:Object.fromEntries(Object.keys(EDGE_STYLES).map(type=>[type,'<svg data-sample="'+type+'"></svg>']))},styles:{nodes:NODE_STYLES,edges:EDGE_STYLES,selection:SELECTION_STYLE,externalReference:EXTERNAL_REFERENCE_STYLE}};
}

function viewer(query='?object=item.Shared',{historyUnavailable=false,width=1440,edit=()=>{},createScheduleRenderer,loadView,pinView}={}) {
  const data=fixture();edit(data);
  const html=renderArchitectureViewer({...data,features:data.features});
  const fullViews=data.views;
  if(loadView)data.views=fullViews.map(view=>({...Object.fromEntries(['id','aspect','engine','label','feature','objectId','centerNodeId','application','scheduleLabel','systemCount','width','height','filename','legendKinds'].filter(key=>view[key]!==undefined).map(key=>[key,view[key]])),...(view.schedulePluginGroups?{schedulePluginGroups:view.schedulePluginGroups.map(group=>({id:group.id,systemCount:new Set(group.systemNames).size}))}:{}),resources:{data:{url:'../data/'+view.id+'.json',sha256:'a'.repeat(64)},svg:{url:'../svg/'+view.id+'.svg',sha256:'b'.repeat(64)}}}));
  const document=testDocument(html),location=new URL('file:///D:/demo/docs/diagrams/ecs-architecture.html'+query),frames=[],events=new Map(),entries=[{href:location.href,state:null}],historyWrites=[];let index=0;
  const history={get state(){return entries[index].state},get length(){return entries.length},replaceState(state,_,href){if(historyUnavailable)throw new Error('unavailable');historyWrites.push('replace');location.href=new URL(href,location).href;entries[index]={href:location.href,state:structuredClone(state)}},pushState(state,_,href){if(historyUnavailable)throw new Error('unavailable');historyWrites.push('push');entries.splice(index+1);location.href=new URL(href,location).href;entries.push({href:location.href,state:structuredClone(state)});index++}};
  const window={innerWidth:width,innerHeight:900,addEventListener(name,listener){events.set(name,listener)}};
  const canvas=document.getElementById('canvas');canvas.clientWidth=950;canvas.clientHeight=600;
  const refreshed=[];
  const app=createArchitectureViewer({data,document,location,history,window,requestAnimationFrame:callback=>frames.push(callback),sourceEditor:{refreshLinks:scope=>refreshed.push(scope),withWorkspace:href=>href},navigation:createArchitectureNavigation(data.features,data.views.filter(view=>view.aspect==='schedule')),createSplitter:createArchitectureSplitter,createInteraction:createArchitectureInteraction,createGestures:createArchitectureGestures,createObjectSearch:createArchitectureSearch,createScheduleRenderer,loadView,pinView});
  function flush(){while(frames.length)frames.splice(0).forEach(callback=>callback())}flush();
  function click(element){assert.ok(element,'control exists');element.click();flush()}
  return{data,fullViews,app,document,location,history,historyWrites,canvas,window,emit:(name,event)=>events.get(name)?.(event),refreshed,get:id=>document.getElementById(id),click,flush,choose(id){const select=document.getElementById('view-select');select.value=id;select.dispatch('change');flush()},async settle(){await app.ready;flush()},activate(id,key='Enter'){const node=document.getElementById('diagram').querySelector('[data-id="'+id+'"]');assert.ok(node,'visible node '+id);node.dispatch('keydown',{key});flush()},back(){assert.ok(index>0);location.href=entries[--index].href;events.get('popstate')();flush()},forward(){assert.ok(index+1<entries.length);location.href=entries[++index].href;events.get('popstate')();flush()}};
}

function controlledViews(){
  const requests=[],pins=[];
  return{requests,pins,pinView:id=>pins.push(id),loadView:(ref,{signal})=>new Promise((resolve,reject)=>requests.push({ref,signal,resolve,reject})),resolve(page,index){requests[index].resolve(page.fullViews.find(view=>view.id===requests[index].ref.id))}};
}
const advance=async()=>{for(let step=0;step<8;step++)await Promise.resolve()};

test('external views defer deep-link selection until metadata arrives without hydrating the descriptor index',async()=>{
  const loader=controlledViews(),page=viewer('?object=item.Shared&node=system-fixed&workspace=E:/work',{...loader});
  assert.equal(page.app.view,undefined);assert.equal(page.canvas.getAttribute('aria-busy'),'true');
  await advance();assert.equal(loader.requests.length,1);loader.resolve(page,0);await page.settle();
  assert.equal(page.app.view.id,'object:item.Shared');assert.equal(page.app.selection.node,'system-fixed');assert.equal(page.get('details').querySelector('h2').textContent,'update_shared');
  assert.equal(page.location.searchParams.get('workspace'),'E:/work');assert.deepEqual(loader.pins,['object:item.Shared']);
  assert.ok(page.data.views.every(view=>!('svg'in view)&&!('nodes'in view)&&!('scheduleGraph'in view)));
});

test('cross-view asset requests suspend old graph selection and only the latest request can replace it',async()=>{
  const loader=controlledViews(),page=viewer('?object=item.Shared',{...loader});await advance();loader.resolve(page,0);await page.settle();
  const original=page.get('diagram').innerHTML;
  page.app.openObject('item.Other');await advance();const desired=page.location.href,writes=page.historyWrites.length;
  page.activate('system-fixed');mouseClick(page,page.canvas);assert.equal(page.location.href,desired);assert.equal(page.historyWrites.length,writes);assert.equal(page.get('diagram').innerHTML,original);
  page.app.openObject('resource.Config');await advance();assert.equal(loader.requests[1].signal.aborted,true);
  loader.resolve(page,2);await page.settle();assert.equal(page.app.view.objectId,'resource.Config');
  loader.resolve(page,1);await advance();page.flush();assert.equal(page.app.view.objectId,'resource.Config');assert.equal(page.location.searchParams.get('object'),'resource.Config');
});

test('external loading failures retain the successful graph, details and viewport and retry without adding history',async()=>{
  const loader=controlledViews(),page=viewer('?object=item.Shared&workspace=E:/work#anchor',{...loader});await advance();loader.resolve(page,0);await page.settle();
  page.activate('system-fixed');page.click(page.get('zoom-in'));const transform=page.get('diagram').style.transform,old=page.location.href,original=page.get('diagram').innerHTML;
  page.app.openObject('item.Other');await advance();loader.requests[1].reject(new Error('network unavailable'));await page.settle();
  assert.equal(page.location.href,old);assert.equal(page.app.view.objectId,'item.Shared');assert.equal(page.app.selection.node,'system-fixed');assert.equal(page.get('diagram').innerHTML,original);assert.equal(page.get('diagram').style.transform,transform);
  assert.ok(page.get('schedule-status').textContent.includes('network unavailable'));const count=page.history.length;
  page.click(page.get('retry-view'));await advance();assert.equal(page.history.length,count);loader.resolve(page,2);await page.settle();assert.equal(page.app.view.objectId,'item.Other');assert.equal(page.location.hash,'#anchor');
});

test('external Schedule filtering uses full metadata and preserves the open filter UI through asset and worker races',async()=>{
  const loader=controlledViews(),runtime=controlledSchedules(),page=viewer('?schedule=schedule-update',{...loader,edit:interactiveSchedules,createScheduleRenderer:runtime.create});
  await advance();loader.resolve(page,0);await page.settle();leftClick(page,'fixed-card');
  const checkbox=filterPlugin(page,'include','A'),menu=page.get('schedule-include-menu');page.get('schedule-include-search').value='Alpha';page.get('schedule-include-search').dispatch('input');checkbox.focus();page.get('schedule-include-options').scrollTop=33;
  await advance();loader.resolve(page,1);await advance();assert.deepEqual(runtime.requests[0].view.schedulePluginGroups.find(group=>group.id==='A').systemNames,['demo::alpha::one','demo::alpha::two','demo::alpha::one']);
  assert.equal(menu.hidden,false);assert.equal(page.get('schedule-include-search').value,'Alpha');assert.equal(page.document.activeElement,checkbox);assert.equal(page.get('schedule-include-options').scrollTop,33);
  runtime.requests[0].reject(new Error('layout failed'));await page.settle();assert.equal(page.location.searchParams.get('scheduleNode'),'fixed-card');assert.ok(page.get('details').textContent.includes('FixedUpdate'));
  page.click(page.get('schedule-clear'));await advance();loader.resolve(page,2);await page.settle();assert.equal(page.app.view.filtered,undefined);assertScheduleHighlight(page,'fixed-card');
  page.back();await advance();loader.resolve(page,3);await advance();runtime.requests[1].resolve({...filteredResult('filtered'),legendKinds:['system']});await page.settle();assert.deepEqual(page.app.selection.scheduleIncludePlugins,['A']);assert.equal(page.location.searchParams.has('scheduleNode'),false);assert.ok(page.get('details').querySelector('.guide'));
});

test('external legend resources use image references while legacy samples remain inline',()=>{
  const page=viewer('?schedule=schedule-update',{edit(data){data.guideSamples.schedule.nodes.system='../svg/legend/system.svg'}});
  assert.equal(page.get('details').querySelector('.guide-sample img').getAttribute('src'),'../svg/legend/system.svg');assert.equal(Boolean(page.get('details').querySelector('svg')),false);
});

test('external bootstrap embeds only its index and file URLs explain the local server without making requests',async()=>{
  const data=fixture(),bootstrap={schemaVersion:6,runtimeUrl:'../data/runtime.json',runtimeSha256:'a'.repeat(64),manifestUrl:'../data/manifest.json',manifestSha256:'b'.repeat(64),buildId:'build-test'},html=renderArchitectureViewer({...data,externalBootstrap:bootstrap});
  assert.deepEqual(JSON.parse(html.match(/id="architecture-data"[^>]*>([\s\S]*?)<\/script>/)[1]),bootstrap);
  assert.ok(!html.includes('完整插件说明'));assert.ok(!html.includes('data-schedule-sample='));for(const{attributes,script}of scriptsIn(html))if(!attributes.includes('application/json'))new vm.Script(script);
  const document=testDocument(html);let requests=0;
  const app=await startExternalArchitecture({bootstrap,document,window:{},location:new URL('file:///D:/demo/docs/diagrams/generated/pages/ecs-architecture.html'),fetch:()=>{requests++;throw new Error('must not fetch')}});
  assert.equal(app,null);assert.equal(requests,0);assert.ok(document.getElementById('schedule-status').textContent.includes('node docs/diagrams/serve.mjs'));
});

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

function interactiveSchedules(data) {
  const binding=(id,kind,graphName,objectId)=>({id,kind,graphName,objectId});
  const bindings=[binding('fixed-card','system','node_System(SystemKey(1v1))','system-fixed'),binding('update-card','system','node_System(SystemKey(2v1))','system-update'),binding('outer-set','set','clusternode_Set(SystemSetKey(1v1))','set-shared'),binding('inner-set','set','clusternode_Set(SystemSetKey(2v1))','set-shared'),binding('sync-card','context','ApplyDeferred','context-sync'),binding('missing-card','context','<missing> update_shared','constraint-missing')];
  const card=binding=>'<g class="node"><title>'+binding.graphName.replaceAll('<','&lt;').replaceAll('>','&gt;')+'</title>'+(binding.kind==='context'?'':'<g id="a_'+binding.id+'"><a>')+'<path fill="'+NODE_STYLES.system.fill+'" stroke="'+NODE_STYLES.system.stroke+'" stroke-width="'+NODE_STYLES.system.width+'"/><text>update_shared</text>'+(binding.kind==='context'?'':'</a></g>')+'</g>';
  const update=data.views.find(view=>view.id==='schedule-update');
  update.legendKinds=['system','system_set','context','order','set_membership'];
  const boundary='<g><a><path fill="'+NODE_STYLES.system_set.fill+'" stroke="'+NODE_STYLES.system_set.stroke+'" stroke-width="'+NODE_STYLES.system_set.width+'"/></a></g>';
  const title=binding=>'<g class="schedule-cluster-title" id="title-'+binding.id+'" data-cluster-id="native-'+binding.id+'" data-cluster-name="'+binding.graphName+'"><g><a><polygon id="title-mask-'+binding.id+'" fill="'+NODE_STYLES.system_set.fill+'" stroke="none"/><text>SharedSet</text></a></g></g>';
  const ignored='<g class="node" id="hidden-marker"><title>marker</title><path/></g><g class="edge" id="inner-edge"><path/></g><g class="label" id="inner-label"><rect/></g><g class="schedule-cluster-title" id="unbound-title"><rect/></g>';
  update.svg='<svg><g class="graph"><title>main Update</title><polygon id="schedule-background" fill="#F6F8FB" stroke="transparent"/><g class="cluster" id="native-outer-set"><title>'+bindings[2].graphName+'</title>'+boundary+'<g class="cluster" id="native-inner-set"><title>'+bindings[3].graphName+'</title>'+boundary+bindings.slice(0,2).map(card).join('')+ignored+'</g>'+title(bindings[3])+'</g>'+bindings.slice(4).map(card).join('')+'<g class="edge"><path/></g>'+title(bindings[2])+'</g></svg>';
  const render=data.views.find(view=>view.id==='schedule-render');
  const renderBinding=binding('render-card','system','node_System(SystemKey(1v1))','system-update');render.svg='<svg>'+card(renderBinding)+'</svg>';
  data.scheduleInteractions={schemaVersion:1,views:[{viewId:update.id,dotSha256:'update-hash',bindings},{viewId:render.id,dotSha256:'render-hash',bindings:[renderBinding]}]};
}

function scheduleElement(page,id,className='node') {
  return page.get('diagram').querySelectorAll('[data-schedule-node]').find(element=>element.dataset.scheduleNode===id&&element.classList.contains(className));
}

function mouseClick(page,target){
  assert.ok(target,'mouse target exists');
  page.document.elementFromPoint=(x,y)=>{assert.deepEqual([x,y],[70,60]);return target};
  target.dispatch('pointerdown',{button:0,buttons:1,pointerType:'mouse',pointerId:1,clientX:70,clientY:60});
  page.canvas.dispatch('pointerup',{button:0,buttons:0,pointerType:'mouse',pointerId:1,clientX:70,clientY:60});
  const writes=page.historyWrites.length,event=target.dispatch('click',{button:0,buttons:0,detail:1,clientX:70,clientY:60});assert.equal(event.defaultPrevented,true);assert.equal(page.historyWrites.length,writes,'synthetic mouse click must not select a second time');page.flush();return event;
}

function leftClick(page,id,className) {
  const element=scheduleElement(page,id,className);assert.ok(element,'bound Schedule element '+id);
  const target=className==='cluster'?element.querySelector('path'):element.querySelector('text');
  return mouseClick(page,target||element);
}

function assertScheduleHighlight(page,id,kind='system'){
  const part=scheduleElement(page,id,kind==='set'?'cluster':'node').querySelector('path'),style=NODE_STYLES[kind==='set'?'system_set':'system'];
  assert.equal(part.style.getPropertyValue('fill'),selectedFillColor(style.stroke));assert.ok(Number.parseFloat(part.style.getPropertyValue('stroke-width'))>style.width);assert.match(part.style.getPropertyValue('filter'),/url\(#/);
  if(kind==='set'){const mask=scheduleElement(page,id,'schedule-cluster-title').querySelector('polygon');assert.equal(mask.style.getPropertyValue('fill'),part.style.getPropertyValue('fill'));assert.equal(mask.style.getPropertyPriority('fill'),'important')}
}

test('Schedule left-click binds exact cards, nested sets, title layers and context without changing native SVGs',()=>{
  const page=viewer('?schedule=schedule-update&workspace=E:/work&keep=1#anchor',{edit:interactiveSchedules}),original=page.app.view.svg,count=page.history.length;
  assert.equal(page.get('details').hidden,false);assert.equal(page.get('details-resizer').hidden,false);
  assert.equal(page.get('diagram').querySelectorAll('[data-schedule-node]').length,8);
  const fixed=scheduleElement(page,'fixed-card');page.click(fixed);assert.equal(page.get('details').hidden,false);
  assert.equal(leftClick(page,'fixed-card').defaultPrevented,true);
  assert.equal(page.get('details').hidden,false);assert.equal(page.get('details-resizer').hidden,false);assert.equal(page.get('details').querySelector('h2').textContent,'update_shared');
  assert.ok(page.get('details').textContent.includes('FixedUpdate'));assert.ok(!page.get('details').textContent.includes('约束与说明'));
  assert.equal(page.location.searchParams.get('scheduleNode'),'fixed-card');assert.equal(page.location.searchParams.has('object'),false);assert.equal(page.history.length,count);assert.equal(page.app.view.id,'schedule-update');
  assert.equal(page.get('view-select').value,'schedule-update');assert.equal(fixed.classList.contains('selected'),true);
  leftClick(page,'update-card');assert.ok(page.get('details').textContent.includes('RunFixedMainLoop'));assert.equal(page.location.searchParams.get('scheduleNode'),'update-card');
  for(const className of ['cluster','schedule-cluster-title']){leftClick(page,'inner-set',className);assert.equal(page.get('details').querySelector('h2').textContent,'SharedSet');assert.equal(page.location.searchParams.get('scheduleNode'),'inner-set')}
  leftClick(page,'sync-card');assert.ok(page.get('details').textContent.includes('同步依赖端点'));
  leftClick(page,'missing-card');assert.ok(page.get('details').textContent.includes('不是本调度中的已注册系统'));
  for(const element of [page.get('diagram').querySelector('g.edge'),page.get('hidden-marker'),page.get('diagram')])assert.equal(element.dispatch('contextmenu').defaultPrevented,false);
  assert.equal(page.app.view.svg,original);assert.equal(page.data.views.find(view=>view.id==='schedule-update').svg,original);
  assert.equal(page.location.searchParams.get('workspace'),'E:/work');assert.equal(page.location.searchParams.get('keep'),'1');assert.equal(page.location.hash,'#anchor');
});

test('Schedule Enter and Space selection leaves native context actions untouched and clearing preserves unrelated focus',()=>{
  const page=viewer('?schedule=schedule-update',{edit:interactiveSchedules}),node=scheduleElement(page,'fixed-card'),count=page.history.length;
  node.focus();assert.equal(node.dispatch('keydown',{key:'Enter'}).defaultPrevented,true);assert.equal(page.get('details').hidden,false);page.click(page.get('clear-selection'));node.focus();
  for(const action of [{key:'ContextMenu'},{key:'F10',shiftKey:true}])assert.equal(node.dispatch('keydown',action).defaultPrevented,false);assert.equal(node.dispatch('contextmenu').defaultPrevented,false);assert.equal(page.get('details').hidden,false);assert.equal(page.document.activeElement,node);
  const set=scheduleElement(page,'outer-set','cluster');set.focus();assert.equal(set.dispatch('keydown',{key:' '}).defaultPrevented,true);assert.equal(page.location.searchParams.get('scheduleNode'),'outer-set');
  page.get('search').focus();page.click(page.get('clear-selection'));assert.equal(page.document.activeElement,page.get('search'));assert.equal(page.get('details').hidden,false);assert.equal(page.get('details-resizer').hidden,false);assert.equal(page.location.searchParams.has('scheduleNode'),false);
  leftClick(page,'fixed-card');page.get('clear-selection').focus();page.click(page.get('clear-selection'));assert.equal(page.document.activeElement,page.canvas);assert.equal(page.history.length,count);
});

test('Schedule selection uses the object outline treatment and a set title selects only its entire native boundary',()=>{
  const page=viewer('?schedule=schedule-update',{edit:interactiveSchedules}),original=page.app.view.svg;
  const system=scheduleElement(page,'fixed-card'),card=system.querySelector('path'),text=system.querySelector('text');
  const object=viewer('?object=system-fixed'),objectShape=object.get('diagram').querySelector('[data-id="system-fixed"]').querySelector('[data-shape-part]');
  leftClick(page,'fixed-card');assert.equal(card.style.getPropertyValue('fill'),objectShape.style.getPropertyValue('fill'));assert.ok(card.style.getPropertyValue('filter').includes('url(#'));assert.equal(system.style.getPropertyValue('filter'),'');assert.equal(text.style.getPropertyValue('filter'),'');
  const set=scheduleElement(page,'inner-set','cluster'),boundary=set.querySelector('path'),title=scheduleElement(page,'inner-set','schedule-cluster-title');
  assert.equal(set.getAttribute('tabindex'),'0');assert.equal(title.getAttribute('tabindex'),null);assert.equal(title.getAttribute('role'),null);assert.equal(title.getAttribute('aria-pressed'),null);
  leftClick(page,'inner-set','schedule-cluster-title');assert.equal(page.document.activeElement,set);assert.equal(set.classList.contains('selected'),true);assert.equal(title.classList.contains('selected'),false);assert.equal(title.getAttribute('aria-pressed'),null);
  assert.equal(boundary.style.getPropertyValue('fill'),selectedFillColor(NODE_STYLES.system_set.stroke));assert.ok(boundary.style.getPropertyValue('filter').includes('url(#'));assert.equal(set.style.getPropertyValue('filter'),'');assert.equal(title.style.getPropertyValue('filter'),'');assert.equal(title.querySelector('text').style.getPropertyValue('filter'),'');assert.equal(card.style.getPropertyValue('fill'),'');assert.equal(card.style.getPropertyValue('filter'),'');
  assert.ok(Number.parseFloat(boundary.style.getPropertyValue('stroke-width'))>NODE_STYLES.system_set.width);assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,1);
  for(const id of ['hidden-marker','inner-edge','inner-label','unbound-title'])for(const child of page.get(id).children)assert.equal(child.style.getPropertyValue('filter'),'');
  const before=Number.parseFloat(boundary.style.getPropertyValue('stroke-width'));page.click(page.get('zoom-out'));const after=Number.parseFloat(boundary.style.getPropertyValue('stroke-width'));assert.ok(after>before,'native scale is used to keep the extra outline width stable on screen');
  page.click(page.get('clear-selection'));assert.equal(boundary.style.getPropertyValue('fill'),'');assert.equal(boundary.style.getPropertyValue('stroke-width'),'');assert.equal(boundary.style.getPropertyValue('filter'),'');assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,0);
  assert.equal(page.app.view.svg,original);assert.equal(page.data.views.find(view=>view.id==='schedule-update').svg,original);
});

test('SystemSet title masks follow only their exact border and restore their own styles across selection and zoom',()=>{
  const page=viewer('?schedule=schedule-update',{edit:data=>{
    interactiveSchedules(data);const view=data.views.find(view=>view.id==='schedule-update');
    view.svg=view.svg.replace('id="title-mask-inner-set"','id="title-mask-inner-set" style="fill:#FAFAFA !important;stroke-width:.25px !important;filter:opacity(.8)"').replace('</svg>','<g class="schedule-cluster-title" id="mismatched-title" data-cluster-id="native-outer-set" data-cluster-name="clusternode_Set(SystemSetKey(2v1))"><polygon fill="#FFFFFF" stroke="none"/><text>SharedSet</text></g></svg>');
  }}),diagram=page.get('diagram'),original=page.app.view.svg;
  const state=element=>['fill','stroke','stroke-width','filter'].map(name=>[element.style.getPropertyValue(name),element.style.getPropertyPriority(name)]);
  const inner=page.get('title-mask-inner-set'),outer=page.get('title-mask-outer-set'),innerOriginal=state(inner),outerOriginal=state(outer),wrong=page.get('mismatched-title'),wrongOriginal=state(wrong.querySelector('polygon'));
  const text=scheduleElement(page,'inner-set','schedule-cluster-title').querySelector('text'),textOriginal=state(text),system=scheduleElement(page,'fixed-card').querySelector('path'),systemOriginal=state(system);
  assert.equal(wrong.getAttribute('data-schedule-title'),null);assert.equal(wrong.getAttribute('data-schedule-node'),null);
  for(let repeat=0;repeat<3;repeat++){
    leftClick(page,'inner-set','schedule-cluster-title');assertScheduleHighlight(page,'inner-set','set');leftClick(page,'inner-set','cluster');assertScheduleHighlight(page,'inner-set','set');
    assert.deepEqual(state(inner).slice(1),innerOriginal.slice(1));assert.deepEqual(state(outer),outerOriginal);assert.deepEqual(state(text),textOriginal);assert.deepEqual(state(system),systemOriginal);assert.deepEqual(state(wrong.querySelector('polygon')),wrongOriginal);
    const fill=inner.style.getPropertyValue('fill');page.click(page.get('zoom-out'));assert.equal(inner.style.getPropertyValue('fill'),fill);assert.deepEqual(state(inner).slice(1),innerOriginal.slice(1));assert.equal(diagram.querySelectorAll('[data-selection-filter]').length,1);
    leftClick(page,'outer-set','cluster');assertScheduleHighlight(page,'outer-set','set');assert.deepEqual(state(inner),innerOriginal);assert.deepEqual(state(system),systemOriginal);
    if(repeat%2)mouseClick(page,page.canvas);else page.click(page.get('clear-selection'));
    assert.deepEqual(state(inner),innerOriginal);assert.deepEqual(state(outer),outerOriginal);assert.equal(diagram.querySelectorAll('[data-selection-filter]').length,0);
  }
  assert.equal(page.app.view.svg,original);assert.equal(inner.getAttribute('fill'),NODE_STYLES.system_set.fill);assert.equal(inner.getAttribute('stroke'),'none');
});

test('Schedule default legend uses only native samples for the visible kinds and remains sized while details change',()=>{
  const page=viewer('?schedule=schedule-update',{edit:interactiveSchedules}),details=page.get('details'),workspace=page.get('workspace');
  const kinds=()=>details.querySelectorAll('[data-guide-schedule-kind]').map(row=>row.dataset.guideScheduleKind);
  assert.deepEqual(kinds(),['system','system_set','context','order','set_membership']);assert.deepEqual(details.querySelectorAll('[data-schedule-sample]').map(sample=>sample.dataset.scheduleSample),kinds());assert.equal(details.querySelectorAll('[data-sample]').length,0);assert.deepEqual(details.querySelectorAll('h3').map(heading=>heading.textContent),['Nodes','Edges']);
  for(const label of Object.values(SCHEDULE_LEGEND_LABELS))assert.ok(details.textContent.includes(label));assert.equal(details.hidden,false);assert.equal(page.get('details-resizer').hidden,false);assert.equal(page.get('details-resizer').getAttribute('aria-disabled'),'false');
  workspace.clientWidth=1300;Object.defineProperty(page.canvas,'clientWidth',{get:()=>1000-Number.parseFloat(workspace.style.getPropertyValue('--details-width'))-10});page.click(page.get('fit'));const viewport=page.get('diagram').style.transform;
  leftClick(page,'fixed-card');assert.equal(details.querySelector('h2').textContent,'update_shared');assert.equal(page.get('diagram').style.transform,viewport);page.click(page.get('clear-selection'));assert.deepEqual(kinds(),['system','system_set','context','order','set_membership']);assert.equal(page.get('diagram').style.transform,viewport);
  page.get('details-resizer').dispatch('keydown',{key:'ArrowLeft'});const resized=page.get('diagram').style.transform;assert.equal(workspace.style.getPropertyValue('--details-width'),'302px');leftClick(page,'inner-set','schedule-cluster-title');mouseClick(page,page.canvas);assert.equal(page.get('diagram').style.transform,resized);assert.deepEqual(kinds(),['system','system_set','context','order','set_membership']);
});

test('successful filters replace legend kinds while failures, stale responses and selected details retain the displayed view',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update',{edit:interactiveSchedules,createScheduleRenderer:runtime.create}),details=page.get('details'),kinds=()=>details.querySelectorAll('[data-guide-schedule-kind]').map(row=>row.dataset.guideScheduleKind);
  filterPlugin(page,'include','A');await Promise.resolve();runtime.requests[0].resolve(scheduleSubset(page,['fixed-card']));await page.settle();assert.deepEqual(kinds(),['system']);
  filterPlugin(page,'include','B');await Promise.resolve();runtime.requests[1].reject(new Error('layout failed'));await page.settle();assert.deepEqual(kinds(),['system']);
  filterPlugin(page,'include','C');await Promise.resolve();filterPlugin(page,'exclude','B');await Promise.resolve();runtime.requests[3].resolve({...scheduleSubset(page,['outer-set']),legendKinds:['system_set','set_membership']});await page.settle();assert.deepEqual(kinds(),['system_set','set_membership']);
  runtime.requests[2].resolve(scheduleSubset(page,['sync-card']));await Promise.resolve();await Promise.resolve();page.flush();assert.deepEqual(kinds(),['system_set','set_membership']);
  filterPlugin(page,'exclude','C');await Promise.resolve();runtime.requests[4].resolve({svg:null,width:0,height:0,systemCount:0,totalSystemCount:6,filtered:true,legendKinds:[]});await page.settle();assert.ok(details.querySelector('[data-guide-schedule-empty]'));assert.equal(details.textContent,'No visible schedule elements.');assert.equal(details.hidden,false);assert.equal(page.get('details-resizer').hidden,false);
  page.click(page.get('schedule-clear'));assert.deepEqual(kinds(),['system','system_set','context','order','set_membership']);leftClick(page,'fixed-card');
  filterPlugin(page,'include','A');await Promise.resolve();runtime.requests[5].resolve(scheduleSubset(page,['update-card']));await page.settle();assert.equal(page.location.searchParams.has('scheduleNode'),false);assert.deepEqual(kinds(),['system']);assert.equal(details.hidden,false);
});

test('mouse-release Schedule selection survives filtering and history while dependency edges, unbound figures and drags leave it unchanged',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update',{edit:interactiveSchedules,createScheduleRenderer:runtime.create}),length=page.history.length;
  leftClick(page,'fixed-card');assertScheduleHighlight(page,'fixed-card');assert.equal(page.history.length,length);
  const key=page.location.searchParams.get('scheduleNode');mouseClick(page,page.get('inner-edge').querySelector('path'));mouseClick(page,page.get('hidden-marker').querySelector('path'));assert.equal(page.location.searchParams.get('scheduleNode'),key);assertScheduleHighlight(page,'fixed-card');
  let hitTests=0;page.document.elementFromPoint=()=>{hitTests++;return scheduleElement(page,'update-card')};
  page.canvas.dispatch('pointerdown',{button:0,buttons:1,pointerType:'mouse',pointerId:44,clientX:70,clientY:60});page.canvas.dispatch('pointermove',{button:0,buttons:1,pointerType:'mouse',pointerId:44,clientX:110,clientY:105});page.canvas.dispatch('pointerup',{button:0,buttons:0,pointerType:'mouse',pointerId:44,clientX:110,clientY:105});page.canvas.dispatch('click',{button:0,detail:1,clientX:110,clientY:105});assert.equal(hitTests,0);assert.equal(page.location.searchParams.get('scheduleNode'),key);assertScheduleHighlight(page,'fixed-card');
  const context=scheduleElement(page,'update-card').querySelector('text');assert.equal(context.dispatch('contextmenu').defaultPrevented,false);assert.equal(page.location.searchParams.get('scheduleNode'),key);
  filterPlugin(page,'include','A');await Promise.resolve();runtime.requests[0].resolve(scheduleSubset(page,['fixed-card','update-card']));await page.settle();assertScheduleHighlight(page,'fixed-card');
  leftClick(page,'update-card');assertScheduleHighlight(page,'update-card');assert.equal(page.history.length,length+1);assert.equal(page.location.searchParams.get('scheduleIncludePlugin'),'A');
  page.back();assert.equal(page.location.searchParams.get('scheduleNode'),'fixed-card');assertScheduleHighlight(page,'fixed-card');page.forward();await Promise.resolve();runtime.requests[1].resolve(scheduleSubset(page,['fixed-card','update-card']));await page.settle();assert.equal(page.location.searchParams.get('scheduleNode'),'update-card');assertScheduleHighlight(page,'update-card');assert.equal(page.history.length,length+1);
});

test('SVG and outer canvas backgrounds clear object nodes and edges once while preserving their route and viewport',()=>{
  for(const selection of ['node','edge'])for(const background of ['svg','diagram','canvas']){
    const page=viewer('?object=item.Shared&schedule=schedule-update&scheduleNode=fixed-card&workspace=E:/work&keep=1#anchor',{edit:interactiveSchedules}),diagram=page.get('diagram');
    mouseClick(page,selection==='node'?diagram.querySelector('[data-id="system-fixed"]'):diagram.querySelector('[data-link-id="write"]'));page.click(page.get('zoom-in'));
    const transform=diagram.style.transform,length=page.history.length,target=background==='svg'?diagram.querySelector('svg'):page.get(background);
    assert.ok(diagram.querySelectorAll('[data-selection-filter]').length>0);mouseClick(page,target);
    assert.equal(diagram.querySelectorAll('[data-selection-filter]').length,0);assert.ok(!diagram.querySelectorAll('.node').some(node=>node.classList.contains('selected')||node.classList.contains('dim')));assert.ok(!diagram.querySelectorAll('.edge').some(edge=>edge.classList.contains('focused')||edge.classList.contains('dim')));
    assert.ok(page.get('details').querySelector('.guide'));assert.equal(page.get('details').hidden,false);assert.equal(page.get('details-resizer').hidden,false);assert.equal(diagram.style.transform,transform);assert.equal(page.history.length,length);assert.equal(page.history.state.architectureView.active.kind,'none');
    assert.equal(page.location.searchParams.get('object'),'item.Shared');assert.equal(page.location.searchParams.get('scheduleNode'),'fixed-card');assert.equal(page.location.searchParams.has('node'),false);assert.equal(page.location.searchParams.get('workspace'),'E:/work');assert.equal(page.location.searchParams.get('keep'),'1');assert.equal(page.location.hash,'#anchor');
    const writes=page.historyWrites.length;mouseClick(page,target);assert.equal(page.historyWrites.length,writes,'clearing an already clear canvas is inert');
  }
});

test('Schedule SVG backgrounds and outer canvas restore the legend and clear a selected whole set without changing filters',()=>{
  for(const background of ['svg','diagram','canvas','graph','polygon']){
    const page=viewer('?schedule=schedule-update&scheduleNode=inner-set&workspace=E:/work&keep=1#anchor',{edit:interactiveSchedules}),diagram=page.get('diagram'),length=page.history.length;
    assertScheduleHighlight(page,'inner-set','set');const transform=diagram.style.transform,target=background==='svg'?diagram.querySelector('svg'):background==='graph'?diagram.querySelector('g.graph'):background==='polygon'?page.get('schedule-background'):page.get(background);
    mouseClick(page,target);assert.equal(page.location.searchParams.has('scheduleNode'),false);assert.equal(page.history.length,length);assert.equal(page.get('details').hidden,false);assert.equal(page.get('details-resizer').hidden,false);assert.equal(diagram.querySelectorAll('[data-selection-filter]').length,0);assert.equal(diagram.style.transform,transform);assert.equal(page.location.searchParams.get('schedule'),'schedule-update');assert.equal(page.location.searchParams.get('workspace'),'E:/work');assert.equal(page.location.hash,'#anchor');
    const writes=page.historyWrites.length;mouseClick(page,target);assert.equal(page.historyWrites.length,writes);
    leftClick(page,'outer-set','cluster');assertScheduleHighlight(page,'outer-set','set');
  }
  for(const id of ['plugin-ItemPlugin','plugin-physics-0']){const page=viewer('?object='+id);page.activate(id);mouseClick(page,page.canvas);assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,0);assert.equal(page.get('details').hidden,false);assert.ok(page.get('details').querySelector('.guide'))}
});

test('blank clearing preserves graph center and scale as Schedule details return to the legend on desktop and compact screens',()=>{
  for(const width of [1440,760]){
    const page=viewer('?schedule=schedule-update',{width,edit:interactiveSchedules}),workspace=page.get('workspace');
    Object.defineProperty(page.canvas,'clientWidth',{get:()=>900-(width>900&&workspace.classList.contains('has-details')?296:0)});Object.defineProperty(page.canvas,'clientHeight',{get:()=>width<=900&&workspace.classList.contains('has-details')?495:600});
    const viewport=()=>/translate\(([-\d.e+]+)px,\s*([-\d.e+]+)px\) scale\(([-\d.e+]+)\)/.exec(page.get('diagram').style.transform).slice(1).map(Number),center=()=>{const [x,y,scale]=viewport();return[(page.canvas.clientWidth/2-x)/scale,(page.canvas.clientHeight/2-y)/scale,scale]};
    page.click(page.get('zoom-in'));const before=center();leftClick(page,'fixed-card');mouseClick(page,page.canvas);const after=center();assert.ok(before.every((value,index)=>Math.abs(value-after[index])<1e-6));assert.equal(page.get('details').hidden,false);
  }
});

test('Schedule dependencies, unknown graphics, controls, right clicks, touches and drags do not count as a blank click',()=>{
  const page=viewer('?schedule=schedule-update',{edit:interactiveSchedules}),diagram=page.get('diagram');leftClick(page,'fixed-card');const selected=page.location.searchParams.get('scheduleNode'),edge=page.get('inner-edge');
  for(const tag of ['polygon','text'])edge.appendChild(page.document.createElement(tag));const unknown=page.document.createElement('path');diagram.querySelector('svg').appendChild(unknown);
  for(const target of [...edge.children,page.get('hidden-marker').querySelector('path'),page.get('unbound-title').querySelector('rect'),unknown]){mouseClick(page,target);assert.equal(page.location.searchParams.get('scheduleNode'),selected);assertScheduleHighlight(page,'fixed-card')}
  for(const target of [null,page.get('details-resizer'),page.get('search')]){page.document.elementFromPoint=()=>target;page.canvas.dispatch('pointerdown',{button:0,pointerType:'mouse',pointerId:10,clientX:50,clientY:50});page.canvas.dispatch('pointerup',{button:0,pointerType:'mouse',pointerId:10,clientX:50,clientY:50});assert.equal(page.location.searchParams.get('scheduleNode'),selected)}
  const control=page.document.createElement('button');page.canvas.appendChild(control);mouseClick(page,control);assert.equal(page.location.searchParams.get('scheduleNode'),selected);
  page.document.elementFromPoint=()=>page.canvas;
  for(const pointerType of ['touch','pen']){page.canvas.dispatch('pointerdown',{button:0,pointerType,pointerId:11,clientX:50,clientY:50});page.canvas.dispatch('pointerup',{button:0,pointerType,pointerId:11,clientX:50,clientY:50});assert.equal(page.location.searchParams.get('scheduleNode'),selected)}
  page.canvas.dispatch('pointerdown',{button:0,pointerType:'mouse',pointerId:12,clientX:50,clientY:50});page.canvas.dispatch('pointermove',{buttons:1,pointerType:'mouse',pointerId:12,clientX:90,clientY:90});page.canvas.dispatch('pointerup',{button:0,pointerType:'mouse',pointerId:12,clientX:90,clientY:90});page.canvas.dispatch('click',{detail:1});assert.equal(page.location.searchParams.get('scheduleNode'),selected);assert.equal(page.canvas.dispatch('contextmenu').defaultPrevented,false);assertScheduleHighlight(page,'fixed-card');
});

test('blank clearing during pending filters survives success, failure and stale responses without restoring selection',async()=>{
  for(const failure of [false,true]){
    const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update&scheduleNode=fixed-card',{edit:interactiveSchedules,createScheduleRenderer:runtime.create});filterPlugin(page,'include','A');await Promise.resolve();const transform=page.get('diagram').style.transform,length=page.history.length;
    mouseClick(page,page.canvas);assert.equal(page.location.searchParams.has('scheduleNode'),false);assert.equal(page.get('details').hidden,false);assert.equal(page.get('diagram').style.transform,transform);assert.equal(page.history.state.architectureView,null);assert.equal(page.location.searchParams.get('scheduleIncludePlugin'),'A');
    failure?runtime.requests[0].reject(new Error('filter failed')):runtime.requests[0].resolve(scheduleSubset(page,['fixed-card','update-card']));await page.settle();assert.equal(page.get('details').hidden,false);assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,0);assert.equal(page.location.searchParams.has('scheduleNode'),false);assert.equal(page.history.length,length);
  }
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update&scheduleNode=fixed-card',{edit:interactiveSchedules,createScheduleRenderer:runtime.create});filterPlugin(page,'include','A');await Promise.resolve();filterPlugin(page,'include','B');await Promise.resolve();mouseClick(page,page.get('diagram').querySelector('svg'));
  runtime.requests[1].resolve(scheduleSubset(page,['fixed-card','update-card']));await page.settle();assert.equal(page.get('details').hidden,false);assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,0);
  leftClick(page,'update-card');runtime.requests[0].resolve(scheduleSubset(page,['fixed-card']));await Promise.resolve();await Promise.resolve();page.flush();assert.equal(page.location.searchParams.get('scheduleNode'),'update-card');assertScheduleHighlight(page,'update-card');
});

test('blank clearing closes the popup and preserves its query without reviving highlights on history returns',()=>{
  for(const chooseNode of [false,true]){
    const page=viewer('?object=item.Shared&schedule=schedule-update&scheduleNode=fixed-card',{edit:interactiveSchedules}),input=page.get('search'),popup=page.get('object-results');input.value='Shared';input.dispatch('input');
    if(chooseNode)mouseClick(page,page.get('diagram').querySelector('[data-id="system-fixed"]'));
    const transform=page.get('diagram').style.transform;mouseClick(page,page.canvas);assert.equal(input.value,'Shared');assert.equal(popup.hidden,true);assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,0);assert.ok(page.get('details').querySelector('.guide'));assert.equal(page.history.state.architectureSearch,'Shared');assert.equal(page.history.state.architectureSearchCleared,true);assert.equal(page.history.state.architectureView.active.kind,'none');
    page.app.openObject('character.Shared');page.flush();assert.equal(page.history.state.architectureObjectOrigin.objectSearch.query,'Shared');assert.equal(page.history.state.architectureObjectOrigin.objectSearch.cleared,true);page.back();
    assert.equal(page.app.view.objectId,'item.Shared');assert.equal(page.location.searchParams.has('node'),false);assert.equal(page.location.searchParams.get('scheduleNode'),'fixed-card');assert.equal(input.value,'Shared');assert.equal(popup.hidden,true);assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,0);assert.equal(page.get('diagram').style.transform,transform);
    page.forward();page.click(page.get('return-context'));assert.equal(page.app.view.objectId,'item.Shared');assert.equal(input.value,'Shared');assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,0);
    input.value='update_shared';input.dispatch('input');assert.equal(page.history.state.architectureSearchCleared,false);assert.ok(page.get('diagram').querySelectorAll('[data-selection-filter]').length>0);
    mouseClick(page,page.canvas);const legacy={...page.history.state};delete legacy.architectureObjectSearch;delete legacy.architectureSearchCleared;page.history.replaceState(legacy,'',page.location.href);page.app.renderSelection(true);page.flush();assert.ok(page.get('diagram').querySelectorAll('[data-selection-filter]').length>0,'history without the new marker retains the previous search behavior');
  }
});

test('cleared search histories with successful, waiting and failed filter geometry restore only their query and results',async()=>{
  for(const phase of ['successful','waiting','failed']){
    const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update&scheduleNode=fixed-card',{edit:interactiveSchedules,createScheduleRenderer:runtime.create});filterPlugin(page,'include','A');await Promise.resolve();
    if(phase==='successful'){runtime.requests[0].resolve(scheduleSubset(page,['fixed-card']));await page.settle()}else if(phase==='failed'){runtime.requests[0].reject(new Error('failed geometry'));await page.settle()}
    const input=page.get('search');input.value='Shared';input.dispatch('input');mouseClick(page,page.canvas);assert.equal(page.history.state.architectureSearch,'Shared');assert.equal(page.history.state.architectureSearchCleared,true);if(phase!=='successful')assert.equal(page.history.state.architectureView,null);
    page.app.openObject('item.Shared');page.flush();phase==='failed'?page.back():page.click(page.get('return-context'));await Promise.resolve();
    assert.equal(input.value,'Shared');assert.equal(page.get('object-results').hidden,true);assert.equal(page.location.searchParams.has('scheduleNode'),false);assert.equal(page.get('details').hidden,false);assert.equal(page.history.state.architectureSearchCleared,true);
    runtime.requests[1].resolve(scheduleSubset(page,['fixed-card']));await page.settle();assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,0);assert.equal(page.get('details').hidden,false);assert.equal(page.history.state.architectureSearch,'Shared');assert.equal(page.history.state.architectureView.active.kind,'none');
    if(phase==='waiting'){runtime.requests[0].resolve(scheduleSubset(page,['fixed-card','update-card']));await Promise.resolve();await Promise.resolve();page.flush();assert.equal(page.get('details').hidden,false);assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,0)}
  }
});

test('Schedule detail sizing preserves canvas center and zoom and shares the existing splitter width',()=>{
  const page=viewer('?schedule=schedule-update',{edit:interactiveSchedules}),workspace=page.get('workspace');
  workspace.clientWidth=1300;
  Object.defineProperty(page.canvas,'clientWidth',{get:()=>950-(workspace.classList.contains('has-details')?Number.parseFloat(workspace.style.getPropertyValue('--details-width')||'286')+10:0)});
  const viewport=()=>/translate\(([-\d.e+]+)px,\s*([-\d.e+]+)px\) scale\(([-\d.e+]+)\)/.exec(page.get('diagram').style.transform).slice(1).map(Number);
  const before=viewport(),point=(page.canvas.clientWidth/2-before[0])/before[2];
  leftClick(page,'fixed-card');let after=viewport();assert.equal(after[2],before[2]);assert.ok(Math.abs((page.canvas.clientWidth/2-after[0])/after[2]-point)<1e-6);
  page.get('details-resizer').dispatch('keydown',{key:'ArrowLeft'});after=viewport();assert.equal(after[2],before[2]);assert.ok(Math.abs((page.canvas.clientWidth/2-after[0])/after[2]-point)<1e-6);
  const width=workspace.style.getPropertyValue('--details-width'),resized=viewport();page.click(page.get('clear-selection'));assert.deepEqual(viewport(),resized);
  leftClick(page,'fixed-card');assert.equal(workspace.style.getPropertyValue('--details-width'),width);
});

test('compact Schedule details preserve the vertical center when opening and clearing after a failed filter',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update',{width:760,edit:interactiveSchedules,createScheduleRenderer:runtime.create}),workspace=page.get('workspace');
  Object.defineProperty(page.canvas,'clientHeight',{get:()=>workspace.classList.contains('has-details')?495:600});
  const viewport=()=>/translate\(([-\d.e+]+)px,\s*([-\d.e+]+)px\) scale\(([-\d.e+]+)\)/.exec(page.get('diagram').style.transform).slice(1).map(Number);
  page.click(page.get('zoom-in'));const before=viewport(),center=(page.canvas.clientHeight/2-before[1])/before[2],historyLength=page.history.length;
  const assertCenter=()=>{const after=viewport();assert.equal(after[2],before[2]);assert.ok(Math.abs((page.canvas.clientHeight/2-after[1])/after[2]-center)<1e-6)};
  leftClick(page,'fixed-card');assertCenter();assert.equal(page.get('details-resizer').hidden,true);
  const shown=page.get('diagram').innerHTML;
  filterPlugin(page,'include','A');await Promise.resolve();runtime.requests[0].reject(new Error('offline layout failed'));await page.settle();
  assert.equal(page.get('diagram').innerHTML,shown);assert.equal(page.location.searchParams.get('scheduleNode'),'fixed-card');assertCenter();
  page.click(page.get('clear-selection'));assertCenter();assert.deepEqual(viewport(),before);assert.equal(page.get('details').hidden,false);
  assert.equal(page.history.length,historyLength+1,'only the filter operation adds history');
});

test('Schedule selected deep links return from object diagrams and restore history without guessing stale identities',()=>{
  const page=viewer('?schedule=schedule-update&scheduleNode=update-card&workspace=E:/work#anchor',{edit:interactiveSchedules});
  assert.equal(page.get('details').hidden,false);assert.ok(page.get('details').textContent.includes('RunFixedMainLoop'));
  page.click(page.get('zoom-out'));const viewport=page.get('diagram').style.transform;
  page.click(page.get('details').querySelector('[data-object="system-update"]'));assert.equal(page.app.view.objectId,'system-update');assert.equal(page.location.searchParams.get('scheduleNode'),'update-card');
  page.back();assert.equal(page.app.view.id,'schedule-update');assert.equal(page.get('details').hidden,false);assert.equal(page.get('diagram').style.transform,viewport);assert.equal(page.location.searchParams.get('scheduleNode'),'update-card');
  page.forward();page.click(page.get('return-context'));assert.equal(page.app.view.id,'schedule-update');assert.equal(page.location.searchParams.get('scheduleNode'),'update-card');assert.equal(page.get('diagram').style.transform,viewport);
  page.choose('schedule-render');assert.equal(page.location.searchParams.has('scheduleNode'),false);assert.equal(page.get('details').hidden,false);leftClick(page,'render-card');assert.ok(page.get('details').textContent.includes('RunFixedMainLoop'));
  for(const query of ['?schedule=schedule-update&scheduleNode=deleted','?schedule=schedule-render&scheduleNode=fixed-card']){
    const stale=viewer(query,{edit:interactiveSchedules});assert.equal(stale.get('details').hidden,false);assert.equal(stale.location.searchParams.has('scheduleNode'),false);assert.equal(stale.history.length,1);
  }
});

function scheduleSubset(page,ids) {
  const bindings=page.data.scheduleInteractions.views.find(entry=>entry.viewId==='schedule-update').bindings.filter(binding=>ids.includes(binding.id));
  return {svg:'<svg>'+bindings.map(binding=>{const style=NODE_STYLES[binding.kind==='set'?'system_set':'system'],set=binding.kind==='set',name=binding.graphName.replaceAll('<','&lt;').replaceAll('>','&gt;');return'<g id="subset-'+binding.id+'" class="'+(set?'cluster':'node')+'"><title>'+name+'</title><g><a><path fill="'+style.fill+'" stroke="'+style.stroke+'" stroke-width="'+style.width+'"/>'+(set?'':'<text>'+binding.id+'</text>')+'</a></g></g>'+(set?'<g class="schedule-cluster-title" data-cluster-id="subset-'+binding.id+'" data-cluster-name="'+name+'"><g><a><polygon fill="'+style.fill+'" stroke="none"/><text>'+binding.id+'</text></a></g></g>':'')}).join('')+'</svg>',width:1000,height:700,systemCount:ids.length,totalSystemCount:6,filtered:true,legendKinds:['system','system_set','context'].filter(kind=>bindings.some(binding=>(binding.kind==='set'?'system_set':binding.kind)===kind))};
}

test('filtered SystemSet title fills follow successful selection and never revive after clear, removal or stale results',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update&scheduleNode=inner-set',{edit:interactiveSchedules,createScheduleRenderer:runtime.create});
  assertScheduleHighlight(page,'inner-set','set');const originalMask=page.get('title-mask-inner-set');
  filterPlugin(page,'include','A');await Promise.resolve();runtime.requests[0].resolve(scheduleSubset(page,['fixed-card','inner-set','outer-set']));await page.settle();
  assert.equal(originalMask.style.getPropertyValue('fill'),'');assertScheduleHighlight(page,'inner-set','set');
  leftClick(page,'outer-set','schedule-cluster-title');assertScheduleHighlight(page,'outer-set','set');const outerMask=scheduleElement(page,'outer-set','schedule-cluster-title').querySelector('polygon');
  assert.equal(scheduleElement(page,'inner-set','schedule-cluster-title').querySelector('polygon').style.getPropertyValue('fill'),'');
  filterPlugin(page,'include','B');await Promise.resolve();runtime.requests[1].reject(new Error('layout failed'));await page.settle();assert.ok(scheduleElement(page,'outer-set','schedule-cluster-title').querySelector('polygon')===outerMask);assertScheduleHighlight(page,'outer-set','set');
  filterPlugin(page,'include','C');await Promise.resolve();filterPlugin(page,'exclude','B');await Promise.resolve();mouseClick(page,page.canvas);assert.equal(outerMask.style.getPropertyValue('fill'),'');
  runtime.requests[3].resolve(scheduleSubset(page,['inner-set','outer-set']));await page.settle();const shown=page.get('diagram').innerHTML;
  runtime.requests[2].resolve(scheduleSubset(page,['inner-set']));await Promise.resolve();await Promise.resolve();page.flush();assert.equal(page.get('diagram').innerHTML,shown);assert.equal(page.location.searchParams.has('scheduleNode'),false);
  for(const mask of page.get('diagram').querySelectorAll('.schedule-cluster-title polygon'))assert.equal(mask.style.getPropertyValue('fill'),'');
  leftClick(page,'inner-set','cluster');assertScheduleHighlight(page,'inner-set','set');const removed=scheduleElement(page,'inner-set','schedule-cluster-title').querySelector('polygon');
  filterPlugin(page,'exclude','C');await Promise.resolve();runtime.requests[4].resolve(scheduleSubset(page,['fixed-card']));await page.settle();assert.equal(removed.style.getPropertyValue('fill'),'');assert.equal(page.location.searchParams.has('scheduleNode'),false);
  page.click(page.get('schedule-clear'));assert.equal(page.get('title-mask-inner-set').style.getPropertyValue('fill'),'');assert.equal(page.get('title-mask-outer-set').style.getPropertyValue('fill'),'');assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,0);
});

test('SystemSet title fills restore selected and cleared history through object roundtrips and filtered relayout',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update&scheduleNode=inner-set&workspace=E:/work',{edit:interactiveSchedules,createScheduleRenderer:runtime.create});
  assertScheduleHighlight(page,'inner-set','set');page.click(page.get('zoom-out'));const viewport=page.get('diagram').style.transform;
  page.click(page.get('details').querySelector('[data-object="set-shared"]'));page.back();assertScheduleHighlight(page,'inner-set','set');assert.equal(page.get('diagram').style.transform,viewport);
  page.forward();page.click(page.get('return-context'));assertScheduleHighlight(page,'inner-set','set');assert.equal(page.get('diagram').style.transform,viewport);
  page.click(page.get('clear-selection'));page.choose('schedule-render');page.back();assert.equal(page.location.searchParams.has('scheduleNode'),false);assert.equal(page.get('title-mask-inner-set').style.getPropertyValue('fill'),'');assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,0);
  leftClick(page,'outer-set','cluster');filterPlugin(page,'include','A');await Promise.resolve();runtime.requests[0].resolve(scheduleSubset(page,['inner-set','outer-set']));await page.settle();assertScheduleHighlight(page,'outer-set','set');
  leftClick(page,'inner-set','schedule-cluster-title');assertScheduleHighlight(page,'inner-set','set');page.back();assertScheduleHighlight(page,'outer-set','set');assert.equal(page.get('title-mask-inner-set').style.getPropertyValue('fill'),'');
  page.forward();await Promise.resolve();runtime.requests[1].resolve(scheduleSubset(page,['inner-set','outer-set']));await page.settle();assertScheduleHighlight(page,'inner-set','set');assert.equal(scheduleElement(page,'outer-set','schedule-cluster-title').querySelector('polygon').style.getPropertyValue('fill'),'');
  assert.equal(page.location.searchParams.get('workspace'),'E:/work');
});

test('live Schedule filtering keeps selected details, option DOM, search, focus and scroll until the card is actually removed',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update&scheduleNode=fixed-card',{edit:interactiveSchedules,createScheduleRenderer:runtime.create});
  const heading=page.get('details').querySelector('h2');page.get('details').scrollTop=127;
  page.click(page.get('schedule-include'));const menu=page.get('schedule-include-menu'),query=page.get('schedule-include-search'),options=page.get('schedule-include-options');query.value='Alpha';query.dispatch('input');options.scrollTop=38;
  const checkbox=filterPlugin(page,'include','A');checkbox.focus();await Promise.resolve();
  assert.equal(page.get('details').querySelector('h2'),heading);assert.equal(page.get('details').scrollTop,127);
  runtime.requests[0].resolve(scheduleSubset(page,['fixed-card','outer-set']));await page.settle();
  assert.equal(page.get('details').querySelector('h2'),heading);assert.equal(page.get('details').scrollTop,127);assert.equal(page.location.searchParams.get('scheduleNode'),'fixed-card');
  assert.equal(menu.hidden,false);assert.equal(query.value,'Alpha');assert.equal(options.scrollTop,38);assert.equal(page.document.activeElement,checkbox);assert.equal(options.querySelector('[value="A"]'),checkbox);
  filterPlugin(page,'include','A',false);assert.equal(page.get('details').querySelector('h2'),heading);assert.equal(page.location.searchParams.get('scheduleNode'),'fixed-card');
  filterPlugin(page,'exclude','B');await Promise.resolve();assert.equal(page.get('details').hidden,false);runtime.requests[1].resolve(scheduleSubset(page,['update-card']));await page.settle();
  assert.equal(page.get('details').hidden,false);assert.equal(page.get('details-resizer').hidden,false);assert.equal(page.location.searchParams.has('scheduleNode'),false);
  assert.equal(page.get('schedule-exclude-menu').hidden,false);assert.equal(page.get('workspace').classList.contains('schedule'),true);assert.equal(page.get('workspace').classList.contains('has-details'),true);
});

test('Schedule async failures and stale results retain the last successful card selection while newer left-clicks win',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update&scheduleNode=fixed-card',{edit:interactiveSchedules,createScheduleRenderer:runtime.create});
  filterPlugin(page,'include','A');await Promise.resolve();const svg=page.get('diagram').innerHTML,heading=page.get('details').querySelector('h2');
  runtime.requests[0].reject(new Error('offline layout failed'));await page.settle();assert.equal(page.get('diagram').innerHTML,svg);assert.equal(page.get('details').querySelector('h2'),heading);assert.equal(page.location.searchParams.get('scheduleNode'),'fixed-card');
  filterPlugin(page,'include','B');await Promise.resolve();filterPlugin(page,'include','C');await Promise.resolve();leftClick(page,'update-card');
  const newest=page.get('details').querySelector('h2');runtime.requests[2].resolve(scheduleSubset(page,['fixed-card','update-card']));await page.settle();
  runtime.requests[1].resolve(scheduleSubset(page,[]));await Promise.resolve();await Promise.resolve();page.flush();
  assert.equal(page.location.searchParams.get('scheduleNode'),'update-card');assert.equal(page.get('details').querySelector('h2'),newest);assert.equal(page.get('details').hidden,false);
  filterPlugin(page,'exclude','B');await Promise.resolve();page.click(page.get('clear-selection'));runtime.requests[3].resolve(scheduleSubset(page,['fixed-card','update-card']));await page.settle();
  assert.equal(page.location.searchParams.has('scheduleNode'),false);assert.equal(page.get('details').hidden,false);
});

test('filtered selected links clear only on successful absence and history restores their matching detail and viewport',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update&scheduleNode=fixed-card&scheduleIncludePlugin=A',{edit:interactiveSchedules,createScheduleRenderer:runtime.create});await Promise.resolve();
  assert.equal(page.get('details').hidden,false);runtime.requests[0].resolve(scheduleSubset(page,['fixed-card']));await page.settle();
  page.click(page.get('zoom-out'));const viewport=page.get('diagram').style.transform;
  page.click(page.get('details').querySelector('[data-object="system-fixed"]'));page.back();await Promise.resolve();
  runtime.requests[1].resolve(scheduleSubset(page,['fixed-card']));await page.settle();assert.equal(page.location.searchParams.get('scheduleNode'),'fixed-card');assert.equal(page.get('diagram').style.transform,viewport);assert.equal(page.get('details').hidden,false);
  filterPlugin(page,'exclude','B');await Promise.resolve();runtime.requests[2].resolve({svg:null,width:0,height:0,legendKinds:[],systemCount:0,totalSystemCount:6,filtered:true});await page.settle();
  assert.equal(page.get('details').hidden,false);assert.equal(page.location.searchParams.has('scheduleNode'),false);assert.ok(page.canvas.querySelector('.empty-state'));
  page.back();await Promise.resolve();runtime.requests[3].resolve(scheduleSubset(page,['fixed-card']));await page.settle();assert.equal(page.location.searchParams.get('scheduleNode'),'fixed-card');assert.equal(page.get('diagram').style.transform,viewport);assert.equal(page.get('details').hidden,false);
  const missing=viewer('?schedule=schedule-update&scheduleNode=fixed-card&scheduleIncludePlugin=A',{edit:interactiveSchedules,createScheduleRenderer:runtime.create});await Promise.resolve();assert.equal(missing.get('details').hidden,false);
  runtime.requests[4].resolve(scheduleSubset(missing,['update-card']));await missing.settle();assert.equal(missing.location.searchParams.has('scheduleNode'),false);assert.equal(missing.get('details').hidden,false);
});

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
  page.app.search('配置');assert.equal(page.get('object-results').querySelectorAll('[data-object]').length,0,'description text is not object identity');
  page.app.search('Config');assert.equal(page.get('object-results').querySelector('h2').textContent,'1 个匹配对象');
  page.click(page.get('object-results').querySelector('[data-object="resource.Config"]'));assert.equal(page.app.view.id,'object:resource.Config');
  assert.equal(page.app.view.nodes.length,1);assertFitted(page);
  page.back();assert.equal(page.get('object-results').querySelector('h2').textContent,'1 个匹配对象');assert.equal(page.get('search').value,'Config');
});

function searchKind(page,kind,checked=true){
  if(page.get('search-kinds').hidden)page.click(page.get('search-kinds-toggle'));
  const input=page.get('search-kinds').querySelector('[data-search-kind="'+kind+'"]');assert.ok(input,'search category '+kind);
  input.focus();input.checked=checked;input.dispatch('change');return input;
}

test('search categories filter only object identities and the same hits paint object outlines',()=>{
  const page=viewer(),popup=page.get('object-results'),input=page.get('search');
  input.value='Other';input.dispatch('input');assert.deepEqual(popup.querySelectorAll('[data-object]').map(button=>button.dataset.object),['item.Other'],'system access and registration records do not create matches');
  input.value='Shared';input.dispatch('input');assert.ok(popup.textContent.includes('Component'));assert.ok(popup.textContent.includes('System'));
  const component=searchKind(page,'Component'),panel=page.get('search-kinds');panel.scrollTop=40;
  assert.deepEqual(popup.querySelectorAll('[data-object]').map(button=>button.dataset.object),['character.Shared','item.Shared']);
  assert.deepEqual(page.get('diagram').querySelectorAll('[data-id]').filter(node=>node.classList.contains('selected')).map(node=>node.dataset.id),['item.Shared']);
  const system=searchKind(page,'System');assert.equal(page.get('search-kinds').querySelector('[data-search-kind="Component"]'),component);assert.equal(page.document.activeElement,system);assert.equal(panel.scrollTop,40);
  assert.deepEqual(new Set(popup.querySelectorAll('[data-object]').map(button=>button.dataset.object)),new Set(['character.Shared','item.Shared','system-fixed','system-update']));
  assert.deepEqual(new Set(page.get('diagram').querySelectorAll('[data-id]').filter(node=>node.classList.contains('selected')).map(node=>node.dataset.id)),new Set(['item.Shared','system-fixed','system-update']));
  assert.deepEqual(page.history.state.architectureObjectSearch.kinds,['Component','System']);
  page.click(page.get('search-kinds-all'));assert.deepEqual(page.history.state.architectureObjectSearch.kinds,[]);assert.equal(popup.hidden,false);
  input.value='';input.dispatch('input');assert.equal(popup.hidden,false);assert.equal(popup.querySelectorAll('[data-object]').length,0);assert.ok(popup.textContent.includes('输入'));
});

test('captured primary presses close search across SVG backgrounds without changing canvas gestures',()=>{
  for(const initial of ['?object=item.Shared','?schedule=schedule-update']){
    const page=viewer(initial,{edit:interactiveSchedules}),input=page.get('search'),popup=page.get('object-results'),diagram=page.get('diagram');
    const backgrounds=[page.canvas,diagram,diagram.querySelector('svg'),...(initial.includes('schedule')?[page.get('schedule-background')]:[])];
    for(const target of backgrounds){input.value='Shared';input.dispatch('input');searchKind(page,'Component');const length=page.history.length,transform=diagram.style.transform;
      target.dispatch('pointerdown',{button:2,pointerId:9,pointerType:'mouse',clientX:70,clientY:60});assert.equal(popup.hidden,false,'secondary press keeps the popup');
      mouseClick(page,target);assert.equal(popup.hidden,true);assert.equal(input.value,'Shared');assert.deepEqual(page.history.state.architectureObjectSearch.kinds,['Component']);assert.equal(diagram.style.transform,transform);assert.equal(page.history.length,length);
      input.dispatch('focus');assert.equal(popup.hidden,false,'refocusing the query reopens results');assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,0,'reopening does not restore cleared highlights');
    }
    input.value='Shared';input.dispatch('input');const selected=page.app.selection.node;
    page.canvas.dispatch('pointerdown',{button:0,pointerId:8,pointerType:'mouse',clientX:50,clientY:50});assert.equal(popup.hidden,true);
    page.canvas.dispatch('pointermove',{button:0,buttons:1,pointerId:8,pointerType:'mouse',clientX:100,clientY:80});page.canvas.dispatch('pointerup',{button:0,pointerId:8,pointerType:'mouse',clientX:100,clientY:80});
    assert.equal(page.app.selection.node,selected);assert.equal(page.canvas.dispatch('click',{button:0,detail:1}).defaultPrevented,true);
  }
});

test('query categories and a closed popup survive history and object returns while legacy states default to all kinds',()=>{
  const page=viewer(),input=page.get('search'),popup=page.get('object-results');input.value='Shared';input.dispatch('input');searchKind(page,'Component');mouseClick(page,page.canvas);
  const saved=structuredClone(page.history.state.architectureObjectSearch);assert.deepEqual(saved,{query:'Shared',kinds:['Component'],open:false,cleared:true});
  page.app.openObject('item.Other');page.flush();page.back();assert.equal(popup.hidden,true);assert.deepEqual(page.history.state.architectureObjectSearch,saved);assert.equal(input.value,'Shared');
  page.forward();page.click(page.get('return-context'));assert.equal(popup.hidden,true);assert.deepEqual(page.history.state.architectureObjectSearch,saved);assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,0);
  const legacy={...page.history.state,architectureSearch:'Shared',architectureSearchCleared:false};delete legacy.architectureObjectSearch;page.history.replaceState(legacy,'',page.location.href);page.app.renderSelection(true);page.flush();
  assert.equal(popup.hidden,false);assert.deepEqual(page.history.state.architectureObjectSearch.kinds,[]);assert.ok(popup.querySelector('[data-object="system-fixed"]'));
});

test('category changes and outside dismissal win over pending view assets and failed retries',async()=>{
  for(const failure of [false,true]){
    const loader=controlledViews(),page=viewer('?object=item.Shared',loader);await advance();loader.resolve(page,0);await page.settle();page.app.openObject('item.Other');await advance();
    const input=page.get('search');input.value='Shared';input.dispatch('input');searchKind(page,'Component');
    page.canvas.dispatch('pointerdown',{button:0,pointerId:2,pointerType:'mouse',clientX:70,clientY:60});page.canvas.dispatch('pointerup',{button:0,pointerId:2,pointerType:'mouse',clientX:70,clientY:60});
    if(failure){loader.requests[1].reject(new Error('unavailable'));await page.settle();page.click(page.get('retry-view'));await advance();loader.resolve(page,2)}else loader.resolve(page,1);
    await page.settle();assert.equal(page.get('object-results').hidden,true);assert.equal(input.value,'Shared');assert.deepEqual(page.history.state.architectureObjectSearch.kinds,['Component']);
    input.dispatch('focus');assert.deepEqual(page.get('object-results').querySelectorAll('[data-object]').map(button=>button.dataset.object),['character.Shared','item.Shared']);
  }
});

test('pending view completion preserves the focused category checkbox while search stays open',async()=>{
  const loader=controlledViews(),page=viewer('?object=item.Shared',loader);await advance();loader.resolve(page,0);await page.settle();page.app.openObject('item.Other');await advance();
  const input=page.get('search');input.value='Shared';input.dispatch('input');const category=searchKind(page,'Component');assert.equal(page.document.activeElement,category);
  loader.resolve(page,1);await page.settle();assert.equal(page.app.view.objectId,'item.Other');assert.equal(page.get('object-results').hidden,false);assert.equal(page.document.activeElement,category);assert.equal(page.get('search-kinds').querySelector('[data-search-kind="Component"]'),category);assert.equal(category.checked,true);
  assert.deepEqual(page.get('object-results').querySelectorAll('[data-object]').map(button=>button.dataset.object),['character.Shared','item.Shared']);
});

test('explicit legacy object origins restore their search ahead of the current newer search snapshot',()=>{
  const page=viewer(),origin={selection:{schedule:'schedule-update',object:'item.Shared',node:null},view:null,search:'Other',searchCleared:true,parent:null};
  page.app.navigate({schedule:'schedule-update',object:'resource.Config',node:'resource.Config'},origin);page.flush();const input=page.get('search');input.value='Config';input.dispatch('input');searchKind(page,'Resource');
  assert.deepEqual(page.history.state.architectureObjectSearch,{query:'Config',kinds:['Resource'],open:true,cleared:false});
  page.click(page.get('return-context'));assert.equal(page.app.view.objectId,'item.Shared');assert.equal(input.value,'Other');assert.deepEqual(page.history.state.architectureObjectSearch,{query:'Other',kinds:[],open:true,cleared:true});assert.equal(page.get('object-results').hidden,false);assert.deepEqual(page.get('object-results').querySelectorAll('[data-object]').map(button=>button.dataset.object),['item.Other']);assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,0);
});

test('choosing the current object from search closes results and selects it without another history entry',()=>{
  const page=viewer(),input=page.get('search');input.value='Shared';input.dispatch('input');searchKind(page,'Component');const length=page.history.length;
  const result=page.get('object-results').querySelector('[data-object="item.Shared"]');result.focus();result.dispatch('keydown',{key:'Enter'});assert.equal(page.document.activeElement,page.canvas);assert.equal(page.app.view.objectId,'item.Shared');assert.equal(page.app.selection.node,'item.Shared');assert.equal(page.get('details').querySelector('h2').textContent,'Shared');assert.equal(page.get('object-results').hidden,true);assert.equal(page.history.length,length);assert.deepEqual(page.history.state.architectureObjectSearch,{query:'Shared',kinds:['Component'],open:false,cleared:true});
});

test('pending Schedule layout success or failure cannot reopen dismissed category-filtered search',async()=>{
  for(const failure of [false,true]){
    const runtime=controlledSchedules(),page=viewer('?schedule=schedule-update',{edit:interactiveSchedules,createScheduleRenderer:runtime.create});filterPlugin(page,'include','A');await Promise.resolve();
    const input=page.get('search');input.value='Shared';input.dispatch('input');searchKind(page,'Component');mouseClick(page,page.canvas);
    failure?runtime.requests[0].reject(new Error('layout unavailable')):runtime.requests[0].resolve(scheduleSubset(page,['fixed-card']));await page.settle();
    assert.equal(page.get('object-results').hidden,true);assert.equal(input.value,'Shared');assert.deepEqual(page.history.state.architectureObjectSearch,{query:'Shared',kinds:['Component'],open:false,cleared:true});assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,0);
  }
});

test('old aggregate candidates remain complete despite restrictive search categories',()=>{
  const page=viewer(),input=page.get('search');input.value='Shared';input.dispatch('input');searchKind(page,'Resource');assert.equal(page.get('object-results').querySelectorAll('[data-object]').length,0);
  page.app.openObject('old-component-type');page.flush();assert.deepEqual(page.get('object-results').querySelectorAll('[data-object]').map(button=>button.dataset.object),['item.Shared','character.Shared']);
  assert.ok(page.get('object-results').textContent.includes('此旧入口'));
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

function bodyOperationDetails(data){
  const system=data.registry['system-fixed'];system.reads=['resource.Config'];system.writes=['resource.Config'];
  system.bodyOperations=[
    {objectId:'item.Other',operation:'insert',via:'commands',method:'insert',deferred:true,scope:'current',condition:'目标缺少 <Other> 时',helper:'prepare::<Other>',sourceEntries:[{role:'operation',path:'src/item.rs',line:141,label:'实际延迟添加'}]},
    {objectId:'item.Shared',operation:'remove',via:'commands',method:'remove',deferred:true,scope:'current',sourceEntries:[{role:'operation',path:'src/item.rs',line:142}]},
    {objectId:'resource.Config',operation:'initialize',via:'world',method:'init_resource',deferred:false,scope:'main',sourceEntries:[{role:'operation',path:'src/lib.rs',line:143,dependency:{name:'example',version:'0.20.0',root:'example-root'}}]},
    {objectId:'non_send.Native',operation:'read',via:'world',method:'non_send_resource',deferred:false,scope:'current',sourceEntries:[{role:'operation',path:'src/item.rs',line:144}]},
    {objectId:'resource.Config',operation:'mutable_access',via:'world',method:'resource_mut',deferred:false,scope:'current',sourceEntries:[{role:'operation',path:'src/item.rs',line:145}]},
    {objectId:'context-sync',operation:'trigger',via:'commands',method:'trigger',deferred:true,scope:'current',sourceEntries:[{role:'operation',path:'src/item.rs',line:146}]},
    {objectId:'local.State',operation:'publish',via:'message_writer',method:'write',deferred:false,scope:'current',sourceEntries:[{role:'operation',path:'src/item.rs',line:147}]},
    {objectId:'set-shared',operation:'reference',via:'world',method:'query_filtered',deferred:false,scope:'current',sourceEntries:[{role:'operation',path:'src/item.rs',line:148}]},
  ];
  Object.assign(data.registry['context-sync'],{kind:'EntityEvent',name:'ReadyEvent'});
  Object.assign(data.registry['local.State'],{kind:'Messages<T>',name:'Messages<Ready>'});
  Object.assign(data.registry['set-shared'],{kind:'QueryData',name:'ReadyQuery'});
}

test('system details separate reviewed body-only operations from parameter Write and retain exact targets and evidence',()=>{
  const page=viewer('?object=system-fixed',{edit:bodyOperationDetails}),details=page.get('details'),body=details.querySelector('[data-access="body"]');
  assert.equal(body.querySelector('h3').textContent,'函数体操作');
  assert.deepEqual(body.querySelectorAll('[data-body-operation]').map(item=>item.dataset.bodyOperation),['insert','remove','initialize','read','mutable_access','trigger','publish','reference']);
  assert.deepEqual(details.querySelector('[data-access="Write"]').querySelectorAll('[data-open]').map(button=>button.dataset.open),['resource.Config']);
  assert.deepEqual(details.querySelector('[data-access="Read"]').querySelectorAll('[data-open]').map(button=>button.dataset.open),['resource.Config']);
  assert.deepEqual(body.querySelectorAll('strong').map(label=>label.textContent),['添加','移除','初始化','只读访问','可变访问（不表示实际修改）','触发事件','发布消息','查询接口']);
  const inserted=body.querySelector('[data-body-operation="insert"]');assert.ok(inserted.textContent.includes('Commands · 延迟应用 · 当前应用世界'));assert.ok(inserted.textContent.includes('目标缺少 <Other> 时'));assert.ok(inserted.textContent.includes('prepare::<Other>'));assert.equal(inserted.querySelector('Other'),null);
  assert.ok(body.querySelector('[data-body-operation="initialize"]').textContent.includes('World · 直接调用 · 主应用世界'));
  assert.ok(body.querySelector('[data-body-operation="publish"]').textContent.includes('MessageWriter · 直接调用 · 当前应用世界'));
  const dependency=body.querySelector('[data-vscode-line="143"]');assert.equal(dependency.dataset.vscodeDependencyName,'example');assert.equal(dependency.dataset.vscodeDependencyVersion,'0.20.0');
  assert.deepEqual(body.querySelectorAll('[data-vscode-line]').map(anchor=>anchor.dataset.vscodeLine),['141','142','143','144','145','146','147','148']);
  assert.equal(page.refreshed.at(-1),details);
  page.click(inserted.querySelector('[data-open="item.Other"]'));assert.equal(page.app.view.objectId,'item.Other');
  page.back();assert.equal(page.app.view.objectId,'system-fixed');assert.equal(page.get('details').querySelectorAll('[data-body-operation]').length,8);
  page.app.openObject('system-update');page.flush();assert.equal(page.get('details').querySelector('[data-access="body"]'),null);
});

test('Schedule left-click and object roundtrip expose body-only access without altering the displayed schedule',()=>{
  const page=viewer('?schedule=schedule-update',{edit:data=>{interactiveSchedules(data);bodyOperationDetails(data)}}),svg=page.app.view.svg;
  leftClick(page,'fixed-card');assert.equal(page.get('details').querySelectorAll('[data-body-operation]').length,8);
  const body=page.get('details').querySelector('[data-access="body"]');page.click(body.querySelector('[data-open="item.Other"]'));
  assert.equal(page.app.view.objectId,'item.Other');page.click(page.get('return-context'));
  assert.equal(page.app.view.id,'schedule-update');assert.equal(page.app.view.svg,svg);assert.equal(page.location.searchParams.get('scheduleNode'),'fixed-card');assert.equal(page.get('details').querySelectorAll('[data-body-operation]').length,8);
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
  mouseClick(page,label.querySelector('text'));assert.deepEqual(page.get('details').querySelectorAll('[data-open]').map(button=>button.dataset.open),['system-fixed','item.Shared']);assert.equal(page.get('details').querySelector('[data-vscode-line]').dataset.vscodeLine,'80');
  for(const key of ['Enter',' ']){label.dispatch('keydown',{key});assert.equal(page.get('details').querySelector('.badge').textContent,EDGE_STYLES.write.label)}
  page.click(page.get('details').querySelector('[data-open="system-fixed"]'));assert.equal(page.app.view.id,'object:system-fixed');
});

test('object SVG nodes and edges select on mouse release while native context actions and HTML links retain their behavior',()=>{
  const page=viewer('?object=item.Shared'),diagram=page.get('diagram'),node=diagram.querySelector('[data-id="system-fixed"]'),label=node.querySelector('text'),edge=diagram.querySelector('[data-link-id="write"]');
  const initial=page.get('details').innerHTML;
  for(const target of [label,edge,diagram]){assert.equal(target.dispatch('contextmenu').defaultPrevented,false);for(const action of [{key:'ContextMenu'},{key:'F10',shiftKey:true}])assert.equal(target.dispatch('keydown',action).defaultPrevented,false)}assert.equal(page.get('details').innerHTML,initial);
  mouseClick(page,label);assert.equal(page.get('details').querySelector('h2').textContent,'update_shared');mouseClick(page,edge);assert.equal(page.get('details').querySelector('.badge').textContent,EDGE_STYLES.write.label);
  mouseClick(page,diagram);assert.ok(page.get('details').querySelector('.guide'));assert.equal(page.location.searchParams.has('node'),false);
  for(const action of [{key:'Enter'},{key:' '}]){assert.equal(label.dispatch('keydown',action).defaultPrevented,true);assert.equal(page.get('details').querySelector('h2').textContent,'update_shared');assert.equal(edge.dispatch('keydown',action).defaultPrevented,true);assert.equal(page.get('details').querySelector('.badge').textContent,EDGE_STYLES.write.label)}
  assert.equal(label.dispatch('keydown',{key:'F10'}).defaultPrevented,false);
  page.click(page.get('details').querySelector('[data-open="system-fixed"]'));assert.equal(page.app.view.objectId,'system-fixed');
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

test('native Schedule SVG keeps its guide panel and receives no Mermaid selection or edge binding',()=>{
  const page=viewer('?schedule=schedule-render',{edit:data=>{
    const view=data.views.find(view=>view.id==='schedule-render');
    view.svg=view.svg.replace('</svg>','<g class="edgeLabel" data-mermaid-native-id="sc0"><text>native label</text></g><g class="edge focused dim" id="edge1"><path d="M0 0L20 20"/></g></svg>');
  }});
  assert.ok(page.get('details').querySelector('.guide'));
  assert.equal(page.get('details').hidden,false);assert.equal(page.get('details').querySelectorAll('[data-guide-schedule-kind]').length,1);assert.equal(page.get('details-resizer').hidden,false);assert.equal(page.get('workspace').classList.contains('schedule'),true);
  assert.equal(page.get('section'),null);assert.equal(page.get('diagram').querySelector('[data-link-label-id]'),null);
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

test('pointer focus, drag and panel resize retain their interaction contracts without the group locator',()=>{
  const page=viewer();page.document.elementFromPoint=()=>page.get('diagram').querySelector('[data-id="system-fixed"]');
  page.canvas.dispatch('pointerdown',{button:0,pointerId:1,clientX:50,clientY:50});assert.equal(page.document.activeElement,page.canvas);
  page.canvas.dispatch('pointerup',{button:0,pointerId:1,clientX:50,clientY:50});assert.equal(page.app.view.id,'object:item.Shared');assert.equal(page.get('details').querySelector('h2').textContent,'update_shared');
  assert.equal(page.get('diagram').querySelector('[data-id="system-fixed"]').dispatch('contextmenu').defaultPrevented,false);assert.equal(page.get('details').querySelector('h2').textContent,'update_shared');
  const before=page.get('diagram').style.transform;page.canvas.dispatch('pointerdown',{button:0,pointerId:2,clientX:50,clientY:50});page.canvas.dispatch('pointermove',{pointerId:2,clientX:80,clientY:100});page.canvas.dispatch('pointerup',{pointerId:2,clientX:80,clientY:100});assert.notEqual(page.get('diagram').style.transform,before);
  assert.equal(page.get('section'),null);assert.equal(page.get('details').querySelector('h2').textContent,'update_shared');
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
  const embedded=JSON.parse(/<script id="architecture-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);assert.equal(embedded.schemaVersion,5);assert.ok(embedded.objects.length);assert.ok(embedded.objectAliases['old-function']);assert.equal(embedded.registry['system-fixed'].filters[0],'Query<&mut Shared>');assert.deepEqual(embedded.schedulePluginCatalog,fixture().schedulePluginCatalog);assert.equal(embedded.scheduleInteractions.schemaVersion,1);
});

test('generated embedded scripts execute their search factory and category handlers without module globals',()=>{
  const data=fixture(),html=renderArchitectureViewer(data),document=testDocument(html),location=new URL('file:///D:/demo/docs/diagrams/generated/pages/ecs-architecture.html?object=item.Shared&workspace=D:/demo'),frames=[],events=new Map();
  document.getElementById('architecture-data').textContent=JSON.stringify(data);
  const history={state:null,replaceState(state,_,href){this.state=state;location.href=href},pushState(state,_,href){this.state=state;location.href=href}},window={innerWidth:1440,innerHeight:900,addEventListener(name,listener){events.set(name,listener)}};
  const context=vm.createContext({document,location,history,window,requestAnimationFrame:callback=>frames.push(callback),URL,URLSearchParams,AbortController,setTimeout,clearTimeout});
  for(const{attributes,script}of scriptsIn(html))if(!attributes.includes('application/json'))new vm.Script(script).runInContext(context);
  while(frames.length)frames.splice(0).forEach(callback=>callback());
  const input=document.getElementById('search');input.value='Shared';input.dispatch('input');document.getElementById('search-kinds-toggle').click();const component=document.querySelector('[data-search-kind="Component"]');component.checked=true;component.dispatch('change');
  assert.deepEqual(document.getElementById('object-results').querySelectorAll('[data-object]').map(button=>button.dataset.object),['character.Shared','item.Shared']);
  assert.equal(document.getElementById('section'),null);assert.equal(document.getElementById('object-results').hidden,false);
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

test('Plugin and PluginGroup show details only while selected and return to their native object legends',()=>{
  for(const id of ['plugin-ItemPlugin','plugin-physics-0']){
    const page=viewer('?object='+id);assert.equal(page.get('details').hidden,false);
    const description=page.data.registry[id].description;
    assert.ok(page.get('details').querySelector('.guide'));assert.equal(page.location.searchParams.has('node'),false);page.activate(id);assert.ok(page.get('details').textContent.includes(description));
    assert.ok(!page.get('details').textContent.includes('公开契约'));assert.deepEqual(page.data.model.features[0].contracts,['Shared public contract']);
    page.click(page.get('clear-selection'));
    assert.ok(page.get('details').querySelector('.guide'));assert.ok(!page.get('details').textContent.includes(description));
    assert.equal(page.get('view-select').value,'object:'+id);assert.equal(page.get('schedule-filter').hidden,true);
    page.choose('schedule-update');page.emit('resize');assert.equal(page.get('details').hidden,false);assert.equal(page.get('details-resizer').hidden,false);
    page.choose('object:'+id);assert.equal(page.get('details').hidden,false);assert.equal(page.get('details-resizer').hidden,false);
  }
});

test('ordinary Plugin entry points default to an unselected card while explicit valid deep links remain selected',()=>{
  const entries=[['plugin-ItemPlugin','item'],['plugin-physics-0','avian']];
  function unselected(page,id){assert.equal(page.app.view.objectId,id);assert.equal(page.location.searchParams.has('node'),false);assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,0);assert.ok(page.get('details').querySelector('.guide'));assert.deepEqual(page.get('details').querySelectorAll('[data-guide-node-type]').map(row=>row.dataset.guideNodeType),[id==='plugin-physics-0'?'plugin_group':'plugin']);assert.equal(page.get('details').hidden,false)}
  for(const [id,feature]of entries){
    for(const query of ['?object='+id,'?object='+id+'&node=deleted','?feature='+feature,'?feature='+feature+'&node=deleted'])unselected(viewer(query),id);
    for(const query of ['?object='+id+'&node='+id,'?node='+id,'?feature='+feature+'&node='+id]){const page=viewer(query);assert.equal(page.location.searchParams.get('node'),id);assert.equal(page.get('details').querySelector('h2').textContent,page.data.registry[id].name);assert.ok(page.get('diagram').querySelectorAll('[data-selection-filter]').length>0)}
    for(const entry of ['menu','search','owner','api']){
      const page=viewer('?object=system-fixed',{edit:data=>{if(feature==='avian')data.registry['system-fixed'].feature='avian'}});
      if(entry==='menu')page.choose('object:'+id);else if(entry==='search'){page.app.search(page.data.registry[id].name);page.click(page.get('object-results').querySelector('[data-object="'+id+'"]'))}else if(entry==='owner')page.click(page.get('details').querySelector('[data-owner]'));else{page.app.openObject(id);page.flush()}
      unselected(page,id);page.activate(id);const length=page.history.length;page.app.openObject(id);page.flush();unselected(page,id);assert.equal(page.history.length,length);
    }
    const alias=viewer('?object=old-plugin',{edit:data=>data.objectAliases['old-plugin']=[id]});unselected(alias,id);
  }
  const ordinary=viewer('?object=item.Shared');assert.equal(ordinary.location.searchParams.get('node'),'item.Shared');assert.equal(ordinary.get('details').querySelector('h2').textContent,'Shared');
});

test('Plugin history restores selected details or an unselected legend without changing Schedule origin or search state',()=>{
  for(const id of ['plugin-ItemPlugin','plugin-physics-0']){
    const page=viewer('?schedule=schedule-update&scheduleNode=fixed-card&workspace=E:/work',{edit:interactiveSchedules});page.app.openObject(id);page.flush();assert.ok(page.get('details').querySelector('.guide'));page.activate(id);const selected=page.get('diagram').style.transform;
    page.app.openObject('item.Shared');page.flush();page.back();assert.equal(page.app.view.objectId,id);assert.equal(page.location.searchParams.get('node'),id);assert.equal(page.get('details').querySelector('h2').textContent,page.data.registry[id].name);assert.equal(page.get('diagram').style.transform,selected);
    const input=page.get('search');input.value=page.data.registry[id].name;input.dispatch('input');mouseClick(page,page.canvas);assert.ok(page.get('details').querySelector('.guide'));assert.equal(page.history.state.architectureSearchCleared,true);assert.equal(page.location.searchParams.get('scheduleNode'),'fixed-card');
    page.app.openObject('item.Shared');page.flush();page.back();assert.equal(page.app.view.objectId,id);assert.equal(page.location.searchParams.has('node'),false);assert.ok(page.get('details').querySelector('.guide'));assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,0);assert.equal(input.value,page.data.registry[id].name);assert.equal(page.history.state.architectureSearchCleared,true);
    page.forward();page.click(page.get('return-context'));assert.equal(page.app.view.objectId,id);assert.ok(page.get('details').querySelector('.guide'));assert.equal(page.location.searchParams.get('scheduleNode'),'fixed-card');assert.equal(page.location.searchParams.get('workspace'),'E:/work');
  }
});

test('independent search and alias results support keyboard navigation alongside the Schedule legend',()=>{
  const page=viewer('?schedule=schedule-update'),input=page.get('search');
  input.value='Shared';input.focus();input.dispatch('input');
  assert.equal(page.get('object-results').hidden,false);assert.equal(page.get('details').hidden,false);
  input.dispatch('keydown',{key:'ArrowUp'});assert.equal(page.document.activeElement,page.get('object-results').querySelectorAll('[data-object]').at(-1));
  page.document.activeElement.dispatch('keydown',{key:'ArrowDown'});
  const first=page.document.activeElement;assert.ok(first.dataset.object);
  first.dispatch('keydown',{key:'ArrowDown'});assert.notEqual(page.document.activeElement,first);
  page.document.activeElement.dispatch('keydown',{key:'ArrowUp'});assert.equal(page.document.activeElement,first);
  first.dispatch('keydown',{key:'Enter'});page.flush();assert.equal(page.app.view.objectId,first.dataset.object);
  assert.equal(page.get('object-results').hidden,true);assert.equal(page.document.activeElement,page.canvas);
  page.back();assert.equal(input.value,'Shared');assert.equal(page.get('object-results').hidden,false);
  input.dispatch('keydown',{key:'Escape'});assert.equal(page.get('object-results').hidden,true);assert.equal(page.document.activeElement,input);
  input.dispatch('focus');input.dispatch('keydown',{key:'ArrowDown'});
  const focus=input.focus.bind(input);input.focus=()=>{const changed=page.document.activeElement!==input;focus();if(changed)input.dispatch('focus',{bubbles:false})};
  page.document.activeElement.dispatch('keydown',{key:'Escape'});assert.equal(page.get('object-results').hidden,true,'returning focus from a result must not reopen the dismissed popup');assert.equal(page.document.activeElement,input);
  const alias=viewer('?object=old-component-type');assert.equal(alias.get('details').hidden,false);
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
    assert.equal(page.history.state.architectureView,null);assert.equal(input.value,'Shared');assert.equal(page.get('object-results').hidden,false);
    input.value='Other';input.focus();input.dispatch('input');const results=page.get('object-results'),html=results.innerHTML;
    runtime.requests[1].resolve({...filteredResult('restored A'),width:800,height:1100});await page.settle();
    assert.equal(input.value,'Other');assert.equal(results.hidden,false);assert.equal(results.innerHTML,html);assert.equal(page.document.activeElement,input);assertFitted(page);
    if(!fails){runtime.requests[0].resolve(filteredResult('stale'));await Promise.resolve();await Promise.resolve();page.flush()}
  }
});

test('filtered deep links retain static fallback and zero matches produce an empty state without invalid geometry',async()=>{
  const runtime=controlledSchedules(),page=viewer('?schedule=schedule-render&scheduleInclude=Missing',{createScheduleRenderer:runtime.create});
  assert.equal(page.app.view.id,'schedule-render');assert.ok(page.get('diagram').innerHTML.includes('update_shared'));
  await Promise.resolve();runtime.requests[0].resolve({svg:null,width:0,height:0,legendKinds:[],systemCount:0,totalSystemCount:8,filtered:true});await page.settle();
  assert.equal(page.get('diagram').innerHTML,'');assert.ok(page.canvas.querySelector('.empty-state'));assert.ok(!/NaN|Infinity/.test(page.get('diagram').style.transform));
  page.click(page.get('zoom-out'));page.emit('resize');assert.ok(!/NaN|Infinity/.test(page.get('diagram').style.transform));assert.equal(page.get('details').hidden,false);
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
  page.click(page.get('return-overview'));await Promise.resolve();assert.equal(page.app.view.id,'schedule-update');assert.equal(page.get('details').hidden,false);assert.equal(page.get('details-resizer').hidden,false);
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
