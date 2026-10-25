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
    'item.Shared':{id:'item.Shared',kind:'Component',name:'Shared',description:'组件的完整说明',feature:'item',defined_in:'item',fields:['value: f32'],sourceEntries:[source('definition',30)],source:{path:'forbidden-legacy.rs',line:1}},
    'character.Shared':{id:'character.Shared',kind:'Component',name:'Shared',description:'同一真实类型的第二投影',feature:'item',sourceEntries:[source('definition',30)]},
    'item.Other':{id:'item.Other',kind:'Component',name:'Other',description:'另一类型',feature:'item',sourceGaps:['待核实：没有类型定义证据'],source:{path:'not-a-definition.rs',line:9}},
    'item.Legacy':{id:'item.Legacy',alias_of:'item.Shared'},
    'resource.Config':{id:'resource.Config',kind:'Resource',name:'Config',description:'配置',feature:'item'},
    'local.State':{id:'local.State',kind:'Local',name:'State',description:'局部状态',feature:'item'},
    'non_send.Native':{id:'non_send.Native',kind:'NonSend',name:'Native',description:'主线程状态',feature:'item'},
  };
  const system={kind:'system',name:'update_shared',description:'完整系统说明，保留所有组件和资源访问。',feature:'item',reads:['item.Shared','item.Other','character.Shared','resource.Config','local.State','non_send.Native'],writes:['item.Shared','resource.Config'],filters:['Query<&mut Shared>','With<Pickable>'],events:['消息记录'],notes:['具体运行约束'],sourceEntries:[source('definition',40),source('registration',50,'固定步注册'),source('registration',60,'逐帧注册')],registrations:[{schedule:'FixedUpdate',scope:'runtime',sets:['Target','Other'],run_if:['running']},{schedule:'RunFixedMainLoop',scope:'runtime',driver_set:'AfterFixedMainLoop',after:[]}]};
  registry['system-fixed']={...system,id:'system-fixed'};
  registry['system-update']={...system,id:'system-update'};
  registry['system-function']={...system,id:'system-function',registrationIds:['system-fixed','system-update'],targetNodeId:'system-fixed'};
  function graph(id,feature,aspect,ids,links=[],extra={}) {
    const nodes=ids.map((nodeId,index)=>{const kind=registry[nodeId].kind;return{id:nodeId,instance:id+'--'+index,visualType:kind==='Entity'?'entity':kind==='Component'?'component':kind==='Resource'?'resource':kind==='Plugin'?'plugin':'system',role:registry[nodeId].feature===feature?'internal':'external',position:{x:40+index*220,y:40,width:180,height:80}}});
    const svg='<svg id="'+id+'">'+nodes.map(node=>'<g class="node" data-id="'+node.id+'" data-instance="'+node.instance+'" data-visual-type="'+node.visualType+'" role="button" tabindex="0"><rect data-shape-part="'+node.instance+'" style="fill:'+NODE_STYLES[node.visualType].fill+';stroke:'+NODE_STYLES[node.visualType].stroke+';stroke-width:1.6px !important"/><g class="label"><text>'+registry[node.id].name+'</text></g></g>').join('')+links.map(link=>'<path class="edge" data-link-id="'+link.id+'" tabindex="0" role="button"/>').join('')+'</svg>';
    return{id,feature,aspect,label:id,nodes,links,scheduleLinks:[],scheduleGroups:[],sections:[{label:'全部节点',x:40,y:40,width:900,height:80}],bounds:{x:0,y:0,width:1000,height:300},width:1000,height:300,svg,...extra};
  }
  const links=[{id:'contains',from:'item.Shared',to:'entity-item',kind:'reference',edgeSemantic:'reference',label:'可选挂载',sourceEntries:[source('related',70)]},{id:'write',from:'system-function',to:'item.Shared',kind:'write',edgeSemantic:'write',label:'更新字段',notes:['直接写入'],sourceEntries:[source('operation',80)]}];
  const views=[graph('overview','overview','overview',['plugin-ItemPlugin']),graph('plugin-item-data','item','data',['entity-item','resource.Config']),graph('plugin-item-systems','item','systems',['system-fixed','system-update','item.Shared']),graph('plugin-item-events','item','events',[]),graph('plugin-character-data','character','data',['entity-character']),graph('plugin-character-systems','character','systems',[])];
  views.push(graph('component:shared','item','component',['entity-item','entity-character','item.Shared','system-function'],links,{componentTypeId:'type-shared',componentNodeId:'item.Shared',projectionIds:['item.Shared','character.Shared'],ownerEntityIds:['entity-item','entity-character']}));
  views.push(graph('component:other','item','component',['entity-item','item.Other'],[],{componentTypeId:'type-other',componentNodeId:'item.Other',projectionIds:['item.Other'],ownerEntityIds:['entity-item']}));
  return{model:{features,entities:[{id:'item',components:[{id:'item.Shared'},{id:'item.Other'}]},{id:'character',components:[{id:'character.Shared'}]}]},registry,views,features,infrastructureFeatures:[],guideSamples:{nodes:Object.fromEntries(Object.keys(NODE_STYLES).map(type=>[type,'<svg data-sample="'+type+'"></svg>'])),edges:Object.fromEntries(Object.keys(EDGE_STYLES).map(type=>[type,'<svg data-sample="'+type+'"></svg>']))},styles:{nodes:NODE_STYLES,edges:EDGE_STYLES,selection:SELECTION_STYLE,externalReference:EXTERNAL_REFERENCE_STYLE}};
}

function viewer(query='?feature=item&tab=data',{historyUnavailable=false,width=1440,edit=()=>{}}={}) {
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

test('two touch points zoom around their midpoint without selecting a node on release',()=>{
  const page=viewer('?feature=item&tab=data',{width:390}),diagram=page.get('diagram');
  page.document.elementFromPoint=()=>diagram.querySelector('[data-id="entity-item"]');
  const point=(pointerId,clientX,clientY=180)=>({button:0,pointerType:'touch',pointerId,clientX,clientY});
  const scale=()=>Number(/scale\(([^)]+)\)/.exec(diagram.style.transform)[1]),before=scale();
  page.canvas.dispatch('pointerdown',point(1,100));page.canvas.dispatch('pointerdown',point(2,200));
  page.canvas.dispatch('pointermove',point(1,50));page.canvas.dispatch('pointermove',point(2,250));
  assert.equal(scale(),before*2);
  page.canvas.dispatch('pointerup',point(1,50));page.canvas.dispatch('pointerup',point(2,250));
  assert.equal(page.location.searchParams.get('node'),null);
});

test('mobile height-only resizing retains the user zoom and pan',()=>{
  const page=viewer('?feature=item&tab=data',{width:390});page.click(page.get('zoom-in'));
  const before=page.get('diagram').style.transform;page.canvas.clientHeight=530;page.emit('resize');
  assert.equal(page.get('diagram').style.transform,before);
});

test('navigation and layout breakpoint changes discard in-progress touch captures',()=>{
  for(const change of ['navigate','resize']){
    const page=viewer(),point={button:0,pointerType:'touch',pointerId:5,clientX:100,clientY:180};
    page.canvas.dispatch('pointerdown',point);assert.equal(page.canvas.hasPointerCapture(5),true);
    if(change==='navigate'){page.app.navigate({feature:'character',aspect:'data',node:null});page.flush()}
    else{page.window.innerWidth=390;page.emit('resize')}
    const before=page.get('diagram').style.transform;
    assert.equal(page.canvas.hasPointerCapture(5),false);
    page.canvas.dispatch('pointermove',{...point,clientX:200});page.canvas.dispatch('pointerup',point);
    assert.equal(page.get('diagram').style.transform,before);assert.equal(page.location.searchParams.get('node'),null);
  }
});

test('narrow-screen wheel scrolling reaches the page while desktop wheels zoom the diagram',()=>{
  for(const width of [390,1440]){
    const page=viewer('?feature=item&tab=data',{width}),before=page.get('diagram').style.transform;
    const event=page.canvas.dispatch('wheel',{deltaY:-100,clientX:100,clientY:180});
    assert.equal(event.defaultPrevented,width>900);
    assert.equal(page.get('diagram').style.transform===before,width<=900);
  }
});

test('Entity cards have no expansion controls and their complete component list opens a dedicated type view',()=>{
  const page=viewer();page.activate('entity-item');
  assert.equal(page.get('details').children[0].tagName,'h2');
  assert.equal(page.get('details').querySelector('.badge'),null);
  assert.ok(page.get('details').textContent.includes('实体完整说明'));
  assert.equal(page.get('diagram').querySelector('[data-id="item.Shared"]'),null);
  assert.equal(page.document.querySelector('[data-entity-toggle]'),null);
  page.click(page.get('details').querySelector('[data-open="item.Shared"]'));
  assert.equal(page.app.view.id,'component:shared');
  assert.equal(page.location.searchParams.get('feature'),'item');
  assert.equal(page.location.searchParams.get('tab'),'data');
  assert.equal(page.location.searchParams.get('component'),'item.Shared');
  assert.equal(page.get('details').querySelector('h2').textContent,'Shared');
  assert.equal(page.get('return-context').hidden,false);
  const before=page.history.length;page.activate('item.Shared');assert.equal(page.history.length,before);
});

test('component type details merge all projection text and fields only at the dedicated center',()=>{
  const page=viewer('?feature=item&tab=data&component=item.Shared',{edit:data=>{data.views.find(view=>view.id==='component:shared').componentDetails={name:'Shared<f32>',description:'同类型各实体的完整说明',fields:['value: f32','optional_owner: Entity'],notes:['完整类型约束']}}});
  const details=page.get('details');
  assert.equal(details.querySelector('h2').textContent,'Shared<f32>');
  for(const value of ['同类型各实体的完整说明','optional_owner: Entity','完整类型约束'])assert.ok(details.textContent.includes(value));
  assert.equal(page.data.registry['item.Shared'].name,'Shared');
  page.activate('entity-item');assert.equal(details.querySelector('h2').textContent,'物品');
});

test('legacy component links and same-type projections use replaceState without losing workspace or fragments',()=>{
  const page=viewer('?feature=item&tab=data&node=item.Legacy&workspace=E%3A%2Fwork&keep=1#anchor');
  assert.equal(page.app.view.id,'component:shared');assert.equal(page.history.length,1);
  assert.equal(page.location.searchParams.get('component'),'item.Shared');assert.equal(page.location.searchParams.get('workspace'),'E:/work');assert.equal(page.location.hash,'#anchor');
  const other=viewer('?feature=character&tab=data&component=character.Shared');
  assert.equal(other.app.view.id,'component:shared');assert.equal(other.get('details').querySelector('h2').textContent,'Shared');
  assert.equal(other.location.searchParams.get('component'),'character.Shared');
});

test('old provider Component links normalize ownership while explicit component routes retain their origin context',()=>{
  for(const feature of ['third_party','infrastructure']){
    const page=viewer('?feature='+feature+'&tab=data&node=item.Shared&workspace=D%3A%2Fdemo');
    assert.equal(page.app.view.id,'component:shared');assert.equal(page.location.searchParams.get('feature'),'item');assert.equal(page.history.length,1);
  }
  const explicit=viewer('?feature=infrastructure&tab=data&component=item.Shared');
  assert.equal(explicit.location.searchParams.get('feature'),'infrastructure');
});

test('component navigation restores the original Entity and viewport through browser history',()=>{
  const page=viewer();page.activate('entity-item');page.click(page.get('zoom-out'));
  const transform=page.get('diagram').style.transform;
  page.click(page.get('details').querySelector('[data-open="item.Shared"]'));
  page.back();assert.equal(page.app.view.id,'plugin-item-data');assert.equal(page.get('details').querySelector('h2').textContent,'物品');assert.equal(page.get('diagram').style.transform,transform);
  page.forward();assert.equal(page.app.view.id,'component:shared');
  page.click(page.get('return-context'));assert.equal(page.app.view.id,'plugin-item-data');assert.equal(page.location.searchParams.has('component'),false);
});

test('return-to-origin retains a System source selection instead of substituting a component owner',()=>{
  const page=viewer('?feature=item&tab=systems');page.activate('system-fixed');
  page.app.openComponent('item.Shared');page.flush();
  page.click(page.get('return-context'));
  assert.equal(page.app.view.id,'plugin-item-systems');
  assert.equal(page.location.searchParams.get('node'),'system-fixed');
  assert.equal(page.get('details').querySelector('h2').textContent,'update_shared');
});

test('data search still finds components absent from the canvas and result navigation has no layout compilation',()=>{
  const page=viewer();page.app.search('组件的完整说明');
  assert.equal(page.get('details').querySelector('h2').textContent,'1 个匹配节点');
  const result=page.get('details').querySelector('[data-open="item.Shared"]');assert.ok(result);
  assert.equal(page.get('diagram').querySelector('[data-id="item.Shared"]'),null);
  page.click(result);assert.equal(page.app.view.id,'component:shared');
});

test('one function card retains every Schedule, complete Read/Write/Query and canonical Entity summaries',()=>{
  const page=viewer('?feature=item&tab=data&component=item.Shared&node=system-fixed');
  assert.equal(page.app.view.nodes.filter(node=>node.id==='system-function').length,1);
  assert.equal(page.get('details').querySelector('h2').textContent,'update_shared');
  assert.ok(page.get('details').textContent.includes('完整系统说明'));
  assert.equal(page.get('details').querySelectorAll('.schedule-registration').length,2);
  assert.ok(page.get('details').textContent.includes('AfterFixedMainLoop'));
  const read=page.get('details').querySelector('[data-access="Read"]');
  assert.deepEqual(read.querySelectorAll('[data-access-kind]').map(group=>group.dataset.accessKind),['Entity','Resource','Local','NonSend']);
  assert.deepEqual(read.querySelector('[data-access-kind="Entity"]').querySelectorAll('[data-open]').map(button=>button.dataset.open),['entity-item','entity-character']);
  assert.equal(read.querySelector('[data-open="item.Shared"]'),null);
  assert.ok(page.get('details').textContent.includes('Query<&mut Shared>'));
  assert.equal(page.get('details').querySelectorAll('[data-vscode-path]').length,3);
  assert.equal(page.get('details').querySelectorAll('h3').filter(heading=>heading.textContent==='源码位置').length,1);
  page.click(page.get('details').querySelector('[data-owner]'));assert.equal(page.app.view.id,'plugin-item-systems');assert.equal(page.location.searchParams.get('node'),'system-fixed');assert.equal(page.location.searchParams.has('component'),false);
});

test('source entries are authoritative and legacy source is never exposed as a definition',()=>{
  const page=viewer('?feature=item&tab=data&component=item.Shared');
  assert.deepEqual(page.get('details').querySelectorAll('[data-vscode-path]').map(anchor=>anchor.dataset.vscodePath),['src/item.rs']);
  assert.equal(page.get('details').querySelector('.source-group-label').textContent,'定义位置');
  page.app.openComponent('item.Other');page.flush();
  assert.equal(page.get('details').querySelector('[data-vscode-path]'),null);
  assert.ok(page.get('details').textContent.includes('待核实'));
  assert.ok(!page.get('details').textContent.includes('not-a-definition.rs'));
});

test('component owners and other component buttons navigate without inventing pages',()=>{
  const page=viewer('?feature=item&tab=data&component=item.Shared');
  page.click(page.get('details').querySelector('[data-open="entity-character"]'));assert.equal(page.get('details').querySelector('h2').textContent,'人物');
  page.click(page.get('details').querySelector('[data-open="character.Shared"]'));assert.equal(page.app.view.id,'component:shared');assert.equal(page.get('details').querySelector('h2').textContent,'Shared');
  page.app.openNode('entity-item');page.flush();page.click(page.get('details').querySelector('[data-open="item.Other"]'));assert.equal(page.app.view.id,'component:other');
});

test('clear returns the actual view legend and only releases graph or disappearing-button focus',()=>{
  const page=viewer('?feature=item&tab=data&component=item.Shared');
  page.get('search').focus();page.app.select(null);assert.equal(page.document.activeElement,page.get('search'));
  assert.equal(page.get('details').querySelector('.guide').getAttribute('aria-label'),'Legend');
  assert.deepEqual(page.get('details').querySelectorAll('[data-guide-node-type]').map(row=>row.dataset.guideNodeType),['system','entity','component']);
  assert.deepEqual(page.get('details').querySelectorAll('[data-guide-edge-semantic]').map(row=>row.dataset.guideEdgeSemantic),['write','reference']);
  page.activate('item.Shared');page.get('clear-selection').focus();page.click(page.get('clear-selection'));assert.equal(page.document.activeElement,page.canvas);
  assert.equal(page.get('diagram').querySelectorAll('[data-selection-filter]').length,0);
  assert.equal(page.get('diagram').querySelectorAll('.selected').length,0);
  page.activate('item.Shared');page.get('diagram').querySelector('[data-id="item.Shared"]').focus();page.app.select(null);assert.equal(page.document.activeElement,page.canvas);
});

test('edge details use real endpoints and reviewed operation sources with keyboard activation',()=>{
  const page=viewer('?feature=item&tab=data&component=item.Shared');
  page.get('diagram').querySelector('[data-link-id="write"]').dispatch('keydown',{key:' '});
  assert.equal(page.get('details').querySelector('.badge').textContent,EDGE_STYLES.write.label);
  assert.deepEqual(page.get('details').querySelectorAll('[data-open]').map(button=>button.dataset.open),['system-function','item.Shared']);
  assert.equal(page.get('details').querySelector('[data-vscode-line]').dataset.vscodeLine,'80');
  page.click(page.get('details').querySelector('[data-open="item.Shared"]'));assert.equal(page.get('details').querySelector('h2').textContent,'Shared');
});

test('native edge labels activate the same relationship by nested click, pointer and keyboard after every render',()=>{
  const page=viewer('?feature=item&tab=data&component=item.Shared',{edit:data=>{
    const view=data.views.find(view=>view.id==='component:shared');
    view.links.forEach((link,index)=>{link.mermaidId='e'+index});
    view.svg=view.svg.replace('</svg>',view.links.map(link=>'<g class="edgeLabel"><g class="label" data-mermaid-native-id="'+link.mermaidId+'"><text>'+link.label+'</text></g></g>').join('')+'<g class="edgeLabel" data-test="unknown" data-mermaid-native-id="missing"><text>Unknown</text></g><g class="edgeLabel" data-test="ambiguous"><g data-mermaid-native-id="e0"></g><g data-mermaid-native-id="e1"></g></g></svg>');
  }});
  const diagram=page.get('diagram'),label=id=>diagram.querySelector('g[data-link-label-id="'+id+'"]');
  assert.equal(label('write').getAttribute('role'),'button');assert.equal(label('write').getAttribute('tabindex'),'0');
  assert.equal(label('write').getAttribute('data-connect'),'system-function|item.Shared');
  assert.equal(diagram.querySelector('[data-test="unknown"]').getAttribute('data-link-label-id'),null);
  assert.equal(diagram.querySelector('[data-test="ambiguous"]').getAttribute('data-link-label-id'),null);
  assert.equal(diagram.querySelectorAll('[data-id]').length,4);
  assert.doesNotMatch(page.app.view.svg,/data-link-label-id/);
  page.click(label('write').querySelector('text'));assert.equal(page.get('details').querySelector('[data-vscode-line]').dataset.vscodeLine,'80');
  assert.equal(label('write').classList.contains('focused'),true);assert.equal(label('contains').classList.contains('dim'),true);
  for(const key of ['Enter',' ']){label('contains').dispatch('keydown',{key});assert.equal(page.get('details').querySelector('.badge').textContent,EDGE_STYLES.reference.label)}
  page.document.elementFromPoint=()=>label('write').querySelector('text');
  page.canvas.dispatch('pointerdown',{button:0,pointerId:7,clientX:50,clientY:50});page.canvas.dispatch('pointerup',{pointerId:7,clientX:50,clientY:50});
  assert.equal(page.get('details').querySelector('.badge').textContent,EDGE_STYLES.write.label);
  page.app.navigate({feature:'item',aspect:'data',node:null});page.flush();page.app.openComponent('item.Shared');page.flush();
  assert.equal(diagram.querySelectorAll('[data-link-label-id]').length,2);
  label('write').dispatch('keydown',{key:'Enter'});assert.equal(page.get('details').querySelector('[data-vscode-line]').dataset.vscodeLine,'80');
});

test('native Schedule labels retain Schedule relationship identity instead of opening a business edge',()=>{
  const page=viewer('?feature=item&tab=systems',{edit:data=>{
    const view=data.views.find(view=>view.id==='plugin-item-systems');
    view.scheduleLinks=[{id:'schedule-next',mermaidId:'sc0',from:'First',to:'Update',edgeSemantic:'schedule',label:'阶段契约'}];
    view.svg=view.svg.replace('</svg>','<g class="edgeLabel" data-mermaid-native-id="sc0"><text>阶段契约</text></g></svg>');
  }});
  const label=page.get('diagram').querySelector('[data-link-label-id="schedule-next"]');
  assert.equal(label.dataset.scheduleLinkId,'schedule-next');assert.equal(label.dataset.linkId,undefined);
  label.dispatch('keydown',{key:'Enter'});assert.equal(page.get('details').querySelector('.badge').textContent,EDGE_STYLES.schedule.label);
  assert.deepEqual(page.get('details').querySelectorAll('[data-schedule]').map(button=>button.dataset.schedule),['First','Update']);
});

test('pointer focus, drag, section zero and panel resize retain their existing interaction contracts',()=>{
  const page=viewer();const node=page.get('diagram').querySelector('[data-id="entity-item"]');page.document.elementFromPoint=()=>node;
  page.canvas.dispatch('pointerdown',{button:0,pointerId:1,clientX:50,clientY:50});assert.equal(page.document.activeElement,page.canvas);
  page.canvas.dispatch('pointerup',{pointerId:1,clientX:50,clientY:50});assert.equal(page.get('details').querySelector('h2').textContent,'物品');
  const before=page.get('diagram').style.transform;page.canvas.dispatch('pointerdown',{button:0,pointerId:2,clientX:50,clientY:50});page.canvas.dispatch('pointermove',{pointerId:2,clientX:80,clientY:100});page.canvas.dispatch('pointerup',{pointerId:2,clientX:80,clientY:100});assert.notEqual(page.get('diagram').style.transform,before);
  const selector=page.get('section');selector.value='0';selector.dispatch('change');assert.equal(page.get('details').querySelector('h2').textContent,'全部节点');
  const resizer=page.get('details-resizer');resizer.dispatch('keydown',{key:'ArrowLeft'});assert.equal(resizer.getAttribute('aria-valuenow'),'302');
});

test('component entry works with unavailable local-file History APIs and stale component IDs fall back',()=>{
  const page=viewer('?feature=item&tab=data',{historyUnavailable:true});page.activate('entity-item');page.click(page.get('details').querySelector('[data-open="item.Shared"]'));assert.equal(page.app.view.id,'component:shared');
  const stale=viewer('?feature=item&tab=data&component=deleted');assert.equal(stale.app.view.id,'plugin-item-data');assert.equal(stale.location.searchParams.has('component'),false);
});

test('rendered HTML embeds valid scripts and no obsolete expansion or Mermaid runtime assets',()=>{
  const data=fixture(),html=renderArchitectureViewer(data);
  for(const{attributes,script}of scriptsIn(html))if(!attributes.includes('application/json'))new vm.Script(script);
  assert.doesNotMatch(html,/data-entity-toggle|architectureEntityModes|architectureEntityRuntime|entity-layout-status|createArchitectureEntities/);
  const embedded=JSON.parse(/<script id="architecture-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.deepEqual(Object.keys(embedded.styles),['nodes','edges','selection','externalReference']);
});

test('App overview system details, plugin navigation and history retain their original registration and workspace',()=>{
  const page=viewer('?workspace=D%3A%2Fdemo&feature=overview',{edit:data=>{
    const overview=data.views[0],systemView=data.views.find(view=>view.id==='plugin-item-systems');
    Object.assign(overview,{feature:null,layout:'app-schedule',label:'App 系统调度总览',nodes:structuredClone(systemView.nodes.slice(0,2)),svg:systemView.svg});
    overview.nodes.forEach(node=>node.role='internal');
  }});
  assert.equal(page.get('feature-head').querySelector('h1').textContent,'App 系统调度总览');
  page.activate('system-fixed');
  assert.equal(page.app.view.id,'overview');
  assert.equal(page.get('details').querySelectorAll('.schedule-registration').length,2);
  assert.equal(page.location.searchParams.get('workspace'),'D:/demo');
  page.click(page.get('details').querySelector('[data-owner]'));
  assert.equal(page.app.view.id,'plugin-item-systems');
  page.back();assert.equal(page.app.view.id,'overview');
  assert.equal(page.location.searchParams.get('node'),'system-fixed');
  assert.equal(page.get('details').querySelector('h2').textContent,'update_shared');
  page.click(page.get('clear-selection'));assert.equal(page.get('details').querySelector('.guide').getAttribute('aria-label'),'Legend');
});

test('legacy overview plugin links resolve to the existing owner page after the overview becomes a schedule',()=>{
  const page=viewer('?workspace=D%3A%2Fdemo&feature=overview&node=plugin-ItemPlugin',{edit:data=>{data.views[0].layout='app-schedule'}});
  assert.equal(page.app.view.id,'plugin-item-systems');
  assert.equal(page.location.searchParams.get('feature'),'item');
  assert.equal(page.location.searchParams.get('workspace'),'D:/demo');
});
