import { sourceEditorAssets } from './source-editor.mjs';
import { architectureShellStyle } from './architecture-shell.mjs';
import { architectureNavigationAssets } from './architecture-navigation.mjs';
import { INFRASTRUCTURE_FEATURES } from './architecture-infrastructure.mjs';
import { architectureSplitterAssets } from './architecture-splitter.mjs';
import { architectureInteractionAssets } from './architecture-interaction.mjs';
import { NODE_STYLES, EDGE_STYLES, SELECTION_STYLE, EXTERNAL_REFERENCE_STYLE } from './architecture-style.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createArchitectureViewer({ data: DATA, document, location, history, window, requestAnimationFrame, sourceEditor, navigation, createSplitter, createInteraction }) {
  const canvas=document.getElementById('canvas'),diagram=document.getElementById('diagram'),details=document.getElementById('details');
  const interaction=createInteraction({diagram,nodeStyles:DATA.styles.nodes,selectionStyle:DATA.styles.selection});
  const safe=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const componentEntities=new Map(DATA.model.entities.flatMap(entity=>entity.components.map(component=>[component.id,entity.canonical_entity||'entity-'+entity.id])));
  const componentViews=DATA.views.filter(candidate=>candidate.aspect==='component');
  let selection=navigation.resolve(location.search),view,scale=1,panX=0,panY=0,drag=null,activeSelection={kind:'none'};
  const canonical=id=>DATA.registry[id]?.alias_of||id;
  const featureLabel=id=>DATA.model.features.find(feature=>feature.id===id)?.label||DATA.infrastructureFeatures.find(feature=>feature.id===id)?.label||id;
  const componentView=id=>componentViews.find(candidate=>candidate.projectionIds?.includes(canonical(id))||candidate.componentTypeId===id||candidate.componentNodeId===canonical(id));
  const isComponent=id=>DATA.registry[canonical(id)]?.kind==='Component';
  function visibleNode(id){
    id=canonical(id);
    if(view.nodes.some(node=>node.id===id))return id;
    if(view.aspect==='component'&&view.projectionIds?.includes(id))return view.componentNodeId||view.projectionIds[0];
    const aggregate=view.nodes.find(node=>DATA.registry[node.id]?.registrationIds?.includes(id));
    return aggregate?.id||componentEntities.get(id)||id;
  }
  function transform(){diagram.style.transform='translate('+panX+'px,'+panY+'px) scale('+scale+')';interaction.setScale(scale);document.getElementById('zoom-label').textContent=Math.round(scale*100)+'%'}
  function fit(readable=false){if(!view.svg)return;scale=readable?Math.min((canvas.clientWidth-28)/Math.min(view.width,900),1):Math.min((canvas.clientWidth-28)/view.width,(canvas.clientHeight-28)/view.height,1);panX=readable?14:(canvas.clientWidth-view.width*scale)/2;panY=readable?14:(canvas.clientHeight-view.height*scale)/2;transform()}
  const splitter=createSplitter({workspace:document.getElementById('workspace'),separator:document.getElementById('details-resizer'),canvas,window,onResize:delta=>{panX+=delta/2;transform()}});
  function updateUrl(){try{history.replaceState(history.state,'',navigation.url(selection,location.href))}catch{/* 文件页仍保留当前导航。 */}}
  function rememberView(){try{history.replaceState({...history.state,architectureView:{id:view.id,scale,panX,panY,active:activeSelection}},'',navigation.url(selection,location.href))}catch{/* 本地浏览器可禁用 History API。 */}}
  function navigate(next){const origin=next.component?(selection.component?history.state?.architectureComponentOrigin:{...selection}):null;rememberView();const href=navigation.url(next,location.href);selection=navigation.resolve(new URL(href).search);try{history.pushState({...history.state,architectureView:null,architectureComponentOrigin:origin},'',href)}catch{/* 导航不依赖文件页的历史权限。 */}renderSelection()}
  function list(title,items,level=3){
    if(!items?.length)return '';
    return'<h'+level+'>'+safe(title)+'</h'+level+'><ul>'+items.map(item=>{const value=typeof item==='string'?item:item?.id||JSON.stringify(item),key=DATA.registry[value]?value:String(value).split(' ')[0],record=DATA.registry[key];return'<li>'+(record?'<button class="data-link" data-open="'+safe(key)+'">'+safe(record.name)+' '+safe(String(value).slice(key.length))+'</button>':'<code>'+safe(value)+'</code>')+'</li>'}).join('')+'</ul>';
  }
  function accessList(title,items){
    if(!items?.length)return '';
    const labels={Entity:'Entity',Resource:'Resource',Local:'Local<T>',NonSend:'NonSend<T>'},groups=new Map(Object.keys(labels).map(kind=>[kind,new Set()]));
    for(const item of items){const id=componentEntities.get(canonical(item))||canonical(item),kind=DATA.registry[id]?.kind||'其他';if(!groups.has(kind))groups.set(kind,new Set());groups.get(kind).add(id)}
    return'<section class="access-section" data-access="'+safe(title)+'"><h3>'+safe(title)+'</h3>'+[...groups].filter(([,ids])=>ids.size).map(([kind,ids])=>'<div class="access-group" data-access-kind="'+safe(kind)+'">'+list(labels[kind]||kind,[...ids],4)+'</div>').join('')+'</section>';
  }
  function registrationList(registrations){
    if(!registrations?.length)return '';
    const text=value=>typeof value==='object'&&value!==null?JSON.stringify(value):String(value);
    return'<section class="schedule-registrations"><h3>Schedule</h3>'+registrations.map((registration,index)=>'<div class="schedule-registration" data-registration-index="'+index+'"><dl>'+Object.entries(registration).map(([key,value])=>'<div class="registration-field" data-registration-field="'+safe(key)+'"><dt>'+safe(key)+'</dt><dd>'+(Array.isArray(value)?(value.length?value:['[]']):[value]).map(item=>'<div class="registration-value"><code>'+safe(text(item))+'</code></div>').join('')+'</dd></div>').join('')+'</dl></div>').join('')+'</section>';
  }
  function sourcesList(entries){
    if(!entries?.length)return '';
    const labels={definition:'定义位置',registration:'注册位置',create:'创建位置',destroy:'销毁位置',initialize:'初始化位置',insert:'插入位置',remove:'移除位置',parameter:'参数位置',cleanup:'清理实现',message_definition:'消息类型定义',action_definition:'动作类型定义',build:'构建实现',install:'安装位置',assembly:'装配位置',run:'运行入口',configure:'配置位置',implementation:'实际实现',close:'关闭位置',related:'相关实现',operation:'操作位置',...DATA.sourceRoleLabels},groups=new Map();
    for(const entry of entries){if(!entry.path||!Number.isSafeInteger(entry.line)||entry.line<1)continue;const role=entry.role||'related';if(!groups.has(role))groups.set(role,[]);groups.get(role).push(entry)}
    if(!groups.size)return '';
    return'<section class="source-section"><h3>源码位置</h3>'+[...groups].map(([role,sources])=>'<h4 class="source-group-label">'+safe(labels[role]||role)+'</h4>'+sources.map(source=>{const dependency=source.dependency;return'<div class="source-entry"><p class="source-entry-label">'+safe(source.label||labels[role]||'查看实现')+'</p><div class="source-actions"><a class="source" data-vscode-path="'+safe(source.path)+'" data-vscode-line="'+source.line+'"'+(source.column?' data-vscode-column="'+safe(source.column)+'"':'')+(dependency?' data-vscode-dependency-name="'+safe(dependency.name)+'" data-vscode-dependency-version="'+safe(dependency.version)+'" data-vscode-dependency-root="'+safe(dependency.root)+'"':'')+'>在 VS Code 中打开</a></div></div>'}).join('')).join('')+'</section>';
  }
  function guide(){
    const nodes=[];
    for(const[type,style]of Object.entries(DATA.styles.nodes))if(view.nodes.some(node=>node.visualType===type))nodes.push('<div class="guide-row" data-guide-node-type="'+safe(type)+'"><span class="guide-sample">'+DATA.guideSamples.nodes[type]+'</span><span>'+safe(style.legendLabel)+'</span></div>');
    const external=view.nodes.some(node=>node.role==='external')?'<div class="guide-reference" data-guide-external-reference>'+safe(DATA.styles.externalReference.legendLabel)+'</div>':'';
    const semantics=new Set([...view.links,...view.scheduleLinks].map(link=>link.edgeSemantic));
    const edges=Object.entries(DATA.styles.edges).filter(([semantic])=>semantics.has(semantic)).map(([semantic,style])=>'<div class="guide-row" data-guide-edge-semantic="'+safe(semantic)+'"><span class="guide-sample">'+DATA.guideSamples.edges[semantic]+'</span><span>'+safe(style.legendLabel)+'</span></div>');
    details.innerHTML='<div class="guide" lang="en" aria-label="Legend">'+(nodes.length?'<h3>Nodes</h3>'+nodes.join('')+external:'')+(edges.length?'<h3>Edges</h3>'+edges.join(''):'')+'</div>';details.scrollTop=0;
  }
  function showDetail(id){
    id=canonical(id);if(!DATA.registry[id]){guide();return}const record={...DATA.registry[id],...(view.aspect==='component'&&id===(view.componentNodeId||view.projectionIds?.[0])?view.componentDetails:{})};
    const plugin=DATA.model.features.find(feature=>feature.plugin===record.name),owners=record.owners||(view.aspect==='component'&&id===(view.componentNodeId||view.projectionIds?.[0])?view.ownerEntityIds:null);
    details.innerHTML='<h2>'+safe(record.name||id)+'</h2><p>'+safe(record.description||'')+'</p>'+(record.feature?'<p>功能归属：'+safe(featureLabel(record.feature))+'</p><button data-owner="'+safe(record.feature)+'" data-target="'+safe(id)+'">打开所属插件 ↗</button>':'')+(record.registered_by?'<p>注册功能：'+safe(featureLabel(record.registered_by))+'</p>':'')+(record.defined_in?'<p>定义归属：'+safe(featureLabel(record.defined_in))+'</p>':'')+(record.assembled_by?'<p>装配来源：'+safe(record.assembled_by.map(featureLabel).join(' / '))+'</p>':'')+(owners?.length?list('所属实体',owners):(record.owner?'<p>所属实体：'+safe(record.owner)+'</p>':''))+list('公开契约',plugin?.contracts)+registrationList(record.registrations)+accessList('Read',record.reads)+accessList('Write',record.writes)+list('Query',record.filters)+list('事件 / 消息',record.events)+list('字段',record.fields)+list('约束与说明',[...(record.notes||[]),...(record.sourceGaps||[])])+(record.components?list('完整实体组件',record.components.map(component=>component.id||component)):'')+sourcesList(record.sourceEntries)+'<button class="reset" id="clear-selection">清除选择</button>';
    sourceEditor.refreshLinks(details);details.scrollTop=0;
  }
  function releaseDiagramFocus(){const active=document.activeElement;if(active?.closest('#diagram')||active?.id==='clear-selection')canvas.focus({preventScroll:true})}
  function select(id){
    id=id?visibleNode(id):null;activeSelection=id?{kind:'node',id}:{kind:'none'};if(!id)releaseDiagramFocus();
    const record=DATA.registry[id],selectedNodes=new Set(id?[id]:[]),relevant=new Set([id,...(record?.reads||[]),...(record?.writes||[]),...view.links.filter(link=>link.from===id||link.to===id||link.displayFrom===id||link.displayTo===id).flatMap(link=>[link.from,link.to])].map(visibleNode));
    const focused=new Set(id?view.links.filter(link=>relevant.has(link.displayFrom||link.from)||relevant.has(link.displayTo||link.to)).map(link=>link.id):[]);
    interaction.paint({selectedNodes,dimNodes:new Set(id?view.nodes.filter(node=>!relevant.has(node.id)).map(node=>node.id):[]),focusedEdges:focused,dimEdges:new Set(id?[...view.links,...view.scheduleLinks].filter(link=>!focused.has(link.id)).map(link=>link.id):[])});
    selection={...selection,node:id};updateUrl();id?showDetail(id):guide();
  }
  function focusNode(id){id=visibleNode(id);const node=view.nodes.find(candidate=>candidate.id===id);if(!node?.position)return;const box=node.position;scale=Math.min((canvas.clientWidth-28)/Math.max(400,box.width*1.3),1);panX=canvas.clientWidth/2-(box.x+box.width/2-(view.bounds?.x||0))*scale;panY=canvas.clientHeight/2-(box.y+box.height/2-(view.bounds?.y||0))*scale;transform();select(id)}
  function scheduleDetail(id){const group=view.scheduleGroups.find(item=>item.id===id);if(!group)return;details.innerHTML='<h2>'+safe(group.label)+'</h2>'+list('运行说明',group.notes);details.scrollTop=0}
  function focusSection(section){if(!section)return;select(null);fit(true);panX=18-(section.x-(view.bounds?.x||0))*scale;panY=18-(section.y-(view.bounds?.y||0))*scale;transform();if(section.schedule)scheduleDetail(section.schedule);else{details.innerHTML='<h2>'+safe(section.label)+'</h2>';details.scrollTop=0}}
  function focusSchedule(id){if(id)focusSection(view.sections.find(section=>section.schedule===id))}
  function relationshipValue(value){return value===null?'无':typeof value==='boolean'?(value?'是':'否'):typeof value==='object'?JSON.stringify(value):String(value)}
  function edgeEndpoint(id,schedule){const entry=schedule?view.scheduleGroups.find(group=>group.id===id):DATA.registry[id];return'<button class="data-link" '+(schedule?'data-schedule':'data-open')+'="'+safe(id)+'">'+safe(entry?.name||entry?.label||id)+'</button>'}
  function showEdgeDetail(link,schedule){
    const record=DATA.registry[link.id]||{},style=DATA.styles.edges[link.edgeSemantic],properties={...record,...link};
    details.innerHTML='<span class="badge">'+safe(style?.label||link.edgeSemantic||link.kind)+'</span><h2>'+safe(record.name||link.displayLabel||style?.label||'关系')+'</h2><p>来源：'+edgeEndpoint(link.from,schedule)+'</p><p>目标：'+edgeEndpoint(link.to,schedule)+'</p>'+(link.label?'<h3>完整契约与约束</h3><p>'+safe(link.label)+'</p>':'')+((link.description||record.description)?'<p>'+safe(link.description||record.description)+'</p>':'')+['cardinality','reverse','linked_spawn'].filter(key=>Object.hasOwn(properties,key)).map(key=>'<h3>'+({cardinality:'数量约束',reverse:'反向关系',linked_spawn:'连带生命周期'}[key])+'</h3><p>'+safe(relationshipValue(properties[key]))+'</p>').join('')+list('约束与说明',[...(link.notes||record.notes||[]),...(link.sourceGaps||record.sourceGaps||[])])+sourcesList(link.sourceEntries||record.sourceEntries)+'<button class="reset" id="clear-selection">清除选择</button>';
    sourceEditor.refreshLinks(details);details.scrollTop=0;
  }
  function paintEdge(id,schedule=false){const link=(schedule?view.scheduleLinks:view.links).find(candidate=>candidate.id===id);if(!link)return;activeSelection={kind:'edge',id,schedule};const endpoints=new Set([link.displayFrom||link.from,link.displayTo||link.to]);interaction.paint({selectedNodes:schedule?new Set():endpoints,dimNodes:new Set(view.nodes.filter(node=>!endpoints.has(node.id)).map(node=>node.id)),selectedSchedules:schedule?endpoints:new Set(),focusedEdges:new Set([id]),dimEdges:new Set([...view.links,...view.scheduleLinks].filter(edge=>edge.id!==id).map(edge=>edge.id))});showEdgeDetail(link,schedule)}
  function internalOwnerView(feature,id,aspect){const record=DATA.registry[id],target=record?.targetNodeId||record?.registrationIds?.[0]||id,candidates=DATA.views.filter(candidate=>candidate.aspect!=='component'&&candidate.feature===feature&&candidate.nodes.some(node=>node.id===target&&node.role==='internal'));return{view:candidates.find(candidate=>candidate.aspect===aspect)||candidates[0],node:target}}
  function openOwner(feature,id){id=canonical(id);const target=internalOwnerView(feature,id,selection.aspect);navigate({feature,aspect:target.view?.aspect||'systems',node:target.view?target.node:null})}
  function openComponent(id){id=canonical(id);const target=componentView(id);if(!target){openOwner(DATA.registry[id]?.feature,id);return}if(view.id===target.id){focusNode(target.componentNodeId||target.projectionIds[0]);return}navigate({...selection,component:id,node:id})}
  function openNode(id){id=canonical(id);if(isComponent(id)){openComponent(id);return}const visible=visibleNode(id);if(view.nodes.some(node=>node.id===visible))focusNode(visible);else openOwner(DATA.registry[id]?.feature,id)}
  function normalizeSelection(){
    if(selection.component&&!componentView(selection.component)){const next={...selection};delete next.component;selection=next;updateUrl()}
    if(!selection.component&&isComponent(selection.node)&&componentView(selection.node)){const target=componentView(selection.node),legacy=selection.feature==='third_party'||(selection.feature==='infrastructure'&&target.feature!=='infrastructure');selection={...selection,...(legacy?{feature:target.feature,aspect:'data'}:{}),component:canonical(selection.node)};updateUrl()}
    if(selection.component)return;
    const merged=selection.feature==='third_party';if(!merged&&selection.feature!=='infrastructure')return;
    const id=canonical(selection.node),current=DATA.views.find(candidate=>candidate.feature===selection.feature&&candidate.aspect===selection.aspect);
    if(!merged&&(!id||current?.nodes.some(node=>node.id===id)))return;
    const target=internalOwnerView(DATA.registry[id]?.feature,id,selection.aspect);
    if(!merged&&!target.view)return;
    selection=target.view?{feature:target.view.feature,aspect:target.view.aspect,node:id}:{feature:'overview',aspect:'overview',node:null};updateUrl();
  }
  function bindEdgeLabels(){
    const links=[...view.links,...view.scheduleLinks];
    for(const label of diagram.querySelectorAll('g.edgeLabel')){
      const ids=new Set([label.dataset.mermaidNativeId,...[...label.querySelectorAll('[data-mermaid-native-id]')].map(item=>item.dataset.mermaidNativeId)].filter(Boolean)),matches=links.filter(link=>ids.has(link.mermaidId));
      if(matches.length!==1)continue;
      const link=matches[0],schedule=view.scheduleLinks.includes(link);label.setAttribute('data-link-label-id',link.id);label.setAttribute(schedule?'data-schedule-link-id':'data-link-id',link.id);label.setAttribute(schedule?'data-schedule-connect':'data-connect',(link.displayFrom||link.from)+'|'+(link.displayTo||link.to));label.classList.add('edge');label.setAttribute('tabindex','0');label.setAttribute('role','button');label.setAttribute('aria-label',(link.displayLabel||link.label||DATA.styles.edges[link.edgeSemantic]?.label||'关系')+' · '+link.from+' → '+link.to);
    }
  }
  function renderDiagram(){interaction.paint();diagram.innerHTML=view.svg||'';bindEdgeLabels();canvas.querySelector('.empty-state')?.remove();if(!view.svg){const empty=document.createElement('div');empty.className='empty-state';empty.innerHTML='<h3>当前页签没有相关节点</h3>';canvas.appendChild(empty)}document.getElementById('section').innerHTML='<option value="">定位分组</option>'+(view.sections||[]).map((section,index)=>'<option value="'+index+'">'+safe(section.label)+'</option>').join('')}
  function renderSelection(restore=false){
    normalizeSelection();view=(selection.component?componentView(selection.component):DATA.views.find(candidate=>selection.feature==='overview'?candidate.id==='overview':candidate.feature===selection.feature&&candidate.aspect===selection.aspect))||DATA.views[0];activeSelection={kind:'none'};
    document.querySelectorAll('.navigation [data-feature]').forEach(button=>button.classList.toggle('active',button.dataset.feature===selection.feature));document.querySelector('.tabs').hidden=selection.feature==='overview'||view.aspect==='component';document.querySelectorAll('[data-aspect]').forEach(button=>button.classList.toggle('active',button.dataset.aspect===selection.aspect));
    const feature=DATA.model.features.find(candidate=>candidate.id===selection.feature)||DATA.infrastructureFeatures.find(candidate=>candidate.id===selection.feature),head=document.getElementById('feature-head'),center=view.componentNodeId||view.projectionIds?.[0];
    head.innerHTML=view.aspect==='component'?'<h1>'+safe(DATA.registry[center]?.name||view.label)+'<span class="identifier">Component</span></h1>':feature?'<h1>'+safe(feature.label)+'<span class="identifier">'+safe(feature.plugin||feature.identifier)+'</span></h1>':'<h1>功能模块与依赖总览</h1>';
    document.getElementById('return-context').hidden=view.aspect!=='component';document.getElementById('return-overview').disabled=view.id==='overview';document.getElementById('search').value='';renderDiagram();guide();
    const rendered=view,snapshot=restore?history.state?.architectureView:null;requestAnimationFrame(()=>{if(view!==rendered)return;if(snapshot?.id===view.id){scale=snapshot.scale;panX=snapshot.panX;panY=snapshot.panY;transform();if(snapshot.active?.kind==='edge')paintEdge(snapshot.active.id,snapshot.active.schedule);else if(snapshot.active?.kind==='node')select(snapshot.active.id)}else{fit(true);const id=selection.node||(view.aspect==='component'?center:null);if(id)focusNode(id)}});
  }
  function activateEdge(element){paintEdge(element.dataset.scheduleLinkId||element.dataset.linkId,element.dataset.scheduleLinkId!==undefined)}
  function diagramTarget(target){for(let item=target;item&&item!==diagram;item=item.parentElement)if(item.dataset.id!==undefined||item.dataset.linkId!==undefined||item.dataset.scheduleLinkId!==undefined)return item;return null}
  function activateNode(element){const id=element?.dataset.id;if(id&&isComponent(id)&&view.aspect!=='component')openComponent(id);else select(id||null)}
  document.addEventListener('click',event=>{
    const feature=event.target.closest('button[data-feature]');if(feature){navigate({feature:feature.dataset.feature,aspect:'systems',node:null});return}
    const aspect=event.target.closest('[data-aspect]');if(aspect){navigate({feature:selection.feature,aspect:aspect.dataset.aspect,node:null});return}
    const clear=event.target.closest('#clear-selection');if(clear){select(null);return}
    const edge=event.target.closest('[data-link-id]')||event.target.closest('[data-schedule-link-id]');if(edge){activateEdge(edge);return}
    const schedule=event.target.closest('[data-schedule]');if(schedule){focusSchedule(schedule.dataset.schedule);return}
    const owner=event.target.closest('[data-owner]');if(owner){openOwner(owner.dataset.owner,owner.dataset.target);return}
    const open=event.target.closest('[data-open]');if(open)openNode(open.dataset.open);
  });
  function zoom(factor,x=canvas.clientWidth/2,y=canvas.clientHeight/2){if(!view.svg)return;const previous=scale;scale=Math.min(2.4,Math.max(.08,scale*factor));panX=x-(x-panX)*scale/previous;panY=y-(y-panY)*scale/previous;transform()}
  document.getElementById('return-context').onclick=()=>{const origin=history.state?.architectureComponentOrigin,node=componentEntities.get(canonical(selection.component));navigate(origin?{...origin,component:null}:{feature:selection.feature,aspect:selection.aspect,node:node||null})};
  document.getElementById('return-overview').onclick=()=>navigate({feature:'overview',aspect:'systems',node:null});document.getElementById('fit').onclick=()=>fit();document.getElementById('readable').onclick=()=>fit(true);document.getElementById('zoom-in').onclick=()=>zoom(1.2);document.getElementById('zoom-out').onclick=()=>zoom(1/1.2);document.getElementById('section').onchange=event=>{if(event.target.value!=='')focusSection(view.sections[Number(event.target.value)])};
  canvas.addEventListener('wheel',event=>{event.preventDefault();const rect=canvas.getBoundingClientRect();zoom(event.deltaY<0?1.12:1/1.12,event.clientX-rect.left,event.clientY-rect.top)},{passive:false});
  canvas.addEventListener('pointerdown',event=>{if(event.button!==0||!view.svg)return;event.preventDefault();canvas.focus({preventScroll:true});drag={x:event.clientX,y:event.clientY,px:panX,py:panY,moved:false};canvas.setPointerCapture(event.pointerId)});
  canvas.addEventListener('pointermove',event=>{if(!drag)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>4)drag.moved=true;if(drag.moved){panX=drag.px+dx;panY=drag.py+dy;canvas.classList.add('dragging');transform()}});
  canvas.addEventListener('pointerup',event=>{if(drag&&!drag.moved){const target=diagramTarget(document.elementFromPoint(event.clientX,event.clientY));if(target?.dataset.linkId!==undefined||target?.dataset.scheduleLinkId!==undefined)activateEdge(target);else activateNode(target)}drag=null;canvas.classList.remove('dragging')});canvas.addEventListener('pointercancel',()=>{drag=null;canvas.classList.remove('dragging')});
  diagram.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){const target=diagramTarget(event.target);if(target){event.preventDefault();target.dataset.linkId!==undefined||target.dataset.scheduleLinkId!==undefined?activateEdge(target):activateNode(target)}}});
  function searchableIds(){return[...new Set([...view.nodes.map(node=>node.id),...(view.aspect==='data'?view.nodes.flatMap(node=>(DATA.registry[node.id]?.components||[]).map(component=>canonical(component.id||component))):[])])]}
  function search(query){query=query.trim().toLowerCase();if(!query){select(null);return}const hits=new Set(searchableIds().filter(id=>JSON.stringify(DATA.registry[id]||{}).toLowerCase().includes(query))),shown=new Set([...hits].map(visibleNode));activeSelection={kind:'search',hits:[...hits]};interaction.paint({selectedNodes:shown,dimNodes:new Set(view.nodes.filter(node=>!shown.has(node.id)).map(node=>node.id))});details.innerHTML='<h2>'+hits.size+' 个匹配节点</h2>'+[...hits].map(id=>'<button class="result" data-open="'+safe(id)+'">'+safe(DATA.registry[id]?.name||id)+'</button>').join('');details.scrollTop=0}
  document.getElementById('search').addEventListener('input',event=>search(event.target.value));window.addEventListener('popstate',()=>{selection=navigation.resolve(location.search);renderSelection(true)});window.addEventListener('resize',()=>{splitter.refresh();fit(true)});renderSelection();
  return{navigate,select,openNode,openComponent,search,renderSelection,get view(){return view},get selection(){return selection}};
}

export function renderArchitectureViewer({ model, registry, views, features, guideSamples, componentTypes = [], sourceRoleLabels = {} }) {
  const state = JSON.stringify({ schemaVersion: 2, model, registry, views, guideSamples, componentTypes, sourceRoleLabels, infrastructureFeatures: INFRASTRUCTURE_FEATURES, styles: { nodes: NODE_STYLES, edges: EDGE_STYLES, selection: SELECTION_STYLE, externalReference: EXTERNAL_REFERENCE_STYLE } }).replace(/</g, '\\u003c');
  const editor = sourceEditorAssets(), navigation = architectureNavigationAssets(features), splitter = architectureSplitterAssets(), interaction = architectureInteractionAssets();
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Crect width='10' height='10' rx='2' fill='%232563EB'/%3E%3C/svg%3E"><title>demo · 插件架构</title><style>
${architectureShellStyle}
${editor.style}
</style></head><body><header><span class="brand">DEMO / ARCHITECTURE</span><button type="button" data-workspace-config>配置工作区</button></header><div class="shell"><nav class="navigation" aria-label="功能插件"><p>阅读入口</p><button data-feature="overview">功能总览</button><div class="nav-divider"></div><p>项目插件</p>${features.map(feature => `<button data-feature="${escape(feature.id)}">${escape(feature.label)}<small>${escape(feature.plugin)}</small></button>`).join('')}<div class="nav-divider"></div><p id="third-party-heading">第三方插件</p><div class="third-party-navigation" role="group" aria-labelledby="third-party-heading">${INFRASTRUCTURE_FEATURES.filter(feature => feature.section === 'third_party').map(feature => `<button data-feature="${escape(feature.id)}">${escape(feature.label)}<small>${escape(feature.identifier)}</small></button>`).join('')}</div>${INFRASTRUCTURE_FEATURES.filter(feature => !feature.section).map(feature => `<button data-feature="${escape(feature.id)}">${escape(feature.label)}<small>${escape(feature.identifier)}</small></button>`).join('')}</nav><main class="main"><section id="feature-head" class="feature-head"></section><div class="tabs-toolbar"><nav class="tabs" aria-label="插件详情"><button data-aspect="systems">系统与调度</button><button data-aspect="data">数据与实体</button><button data-aspect="events">事件与协作</button></nav><div class="tools"><button id="return-context" hidden>返回原视图</button><button id="return-overview">返回总览</button><input id="search" type="search" placeholder="搜索当前页签" aria-label="搜索架构节点"><button id="zoom-out" aria-label="缩小">−</button><span id="zoom-label">100%</span><button id="zoom-in" aria-label="放大">＋</button><button id="readable">阅读大小</button><button id="fit">适合窗口</button></div></div><section id="workspace" class="workspace"><section class="canvas-wrap"><div class="caption"><select id="section" aria-label="定位图内分组"><option value="">定位分组</option></select></div><div id="canvas" class="canvas" tabindex="-1" role="region" aria-label="架构图画布"><div id="diagram" class="diagram"></div></div></section><div id="details-resizer" class="details-resizer" tabindex="0" role="separator" aria-orientation="vertical" aria-label="调整详情宽度" aria-controls="details"></div><aside id="details" class="side" aria-live="polite"></aside></section></main></div>${editor.markup}<script id="architecture-data" type="application/json">${state}</script><script>${editor.script}</script><script>${navigation.script}</script><script>${splitter.script}</script><script>${interaction.script}</script><script>const architectureViewer=(${createArchitectureViewer.toString()})({data:JSON.parse(document.getElementById("architecture-data").textContent),document,location,history,window,requestAnimationFrame,sourceEditor,navigation:architectureNavigation,createSplitter:createArchitectureSplitter,createInteraction:createArchitectureInteraction});</script></body></html>`;
}
