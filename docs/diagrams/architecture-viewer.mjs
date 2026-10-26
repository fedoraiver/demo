import { sourceEditorAssets } from './source-editor.mjs';
import { architectureShellStyle } from './architecture-shell.mjs';
import { architectureNavigationAssets } from './architecture-navigation.mjs';
import { INFRASTRUCTURE_FEATURES } from './architecture-infrastructure.mjs';
import { architectureSplitterAssets } from './architecture-splitter.mjs';
import { architectureInteractionAssets } from './architecture-interaction.mjs';
import { architectureGestureAssets } from './architecture-gestures.mjs';
import { NODE_STYLES, EDGE_STYLES, SELECTION_STYLE, EXTERNAL_REFERENCE_STYLE } from './architecture-style.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createArchitectureViewer({ data: DATA, document, location, history, window, requestAnimationFrame, sourceEditor, navigation, createSplitter, createInteraction, createGestures }) {
  const canvas=document.getElementById('canvas'),diagram=document.getElementById('diagram'),details=document.getElementById('details');
  const interaction=createInteraction({diagram,nodeStyles:DATA.styles.nodes,selectionStyle:DATA.styles.selection});
  const safe=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const componentEntities=new Map(DATA.model.entities.flatMap(entity=>entity.components.map(component=>[component.id,entity.canonical_entity||'entity-'+entity.id])));
  const objectViews=DATA.views.filter(candidate=>candidate.aspect==='object');
  const objects=DATA.objects?.length?DATA.objects:objectViews.map(candidate=>({id:candidate.objectId,viewId:candidate.id,feature:candidate.feature}));
  let selection=navigation.resolve(location.search),view,scale=1,panX=0,panY=0,activeSelection={kind:'none'},canvasSize,objectOrigin=history.state?.architectureObjectOrigin||null,aliasCandidates=[];
  const canonical=id=>DATA.registry[id]?.alias_of||id;
  const featureLabel=id=>DATA.model.features.find(feature=>feature.id===id)?.label||DATA.infrastructureFeatures.find(feature=>feature.id===id)?.label||id;
  const objectView=id=>objectViews.find(candidate=>candidate.objectId===canonical(id));
  const visibleNode=id=>canonical(id);
  function objectContext(id){const record=DATA.registry[id]||{},owner=componentEntities.get(id),schedules=(record.registrations||[]).map(registration=>registration.schedule).filter(Boolean);return[record.owner||DATA.registry[owner]?.name,...new Set(schedules),id].filter(Boolean).join(' · ')}
  function objectResults(ids){return ids.map(id=>'<button class="result" data-object="'+safe(id)+'">'+safe(DATA.registry[id]?.name||id)+'<small>'+safe(objectContext(id))+'</small></button>').join('')}
  function transform(){diagram.style.transform='translate('+panX+'px,'+panY+'px) scale('+scale+')';interaction.setScale(scale);document.getElementById('zoom-label').textContent=Math.round(scale*100)+'%'}
  function fit(readable=false){if(!view.svg)return;scale=readable?Math.min((canvas.clientWidth-28)/Math.min(view.width,900),1):Math.min((canvas.clientWidth-28)/view.width,(canvas.clientHeight-28)/view.height,1);panX=readable?14:(canvas.clientWidth-view.width*scale)/2;panY=readable?14:(canvas.clientHeight-view.height*scale)/2;transform()}
  const measureCanvas=()=>({width:canvas.clientWidth,height:canvas.clientHeight,compact:window.innerWidth<=900});
  const splitter=createSplitter({workspace:document.getElementById('workspace'),separator:document.getElementById('details-resizer'),canvas,window,onResize:delta=>{panX+=delta/2;canvasSize=measureCanvas();transform()}});
  function updateUrl(){try{history.replaceState(history.state,'',navigation.url(selection,location.href))}catch{/* 文件页仍保留当前导航。 */}}
  function rememberView(){try{history.replaceState({...history.state,architectureView:{id:view.id,scale,panX,panY,active:activeSelection}},'',navigation.url(selection,location.href))}catch{/* 本地浏览器可禁用 History API。 */}}
  function navigate(next){objectOrigin=next.object?(selection.object?objectOrigin:{...selection}):null;rememberView();const href=navigation.url(next,location.href);selection=navigation.resolve(new URL(href).search);try{history.pushState({...history.state,architectureView:null,architectureObjectOrigin:objectOrigin},'',href)}catch{/* 导航不依赖文件页的历史权限。 */}renderSelection()}
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
    id=canonical(id);if(!DATA.registry[id]){guide();return}const record=DATA.registry[id];
    const plugin=DATA.model.features.find(feature=>feature.plugin===record.name),owners=record.owners;
    details.innerHTML='<h2>'+safe(record.name||id)+'</h2><p>'+safe(record.description||'')+'</p>'+(objectView(id)&&view.objectId!==id?'<button data-object="'+safe(id)+'">打开对象关系图 ↗</button>':'')+(record.feature?'<p>功能归属：'+safe(featureLabel(record.feature))+'</p><button data-owner="'+safe(record.feature)+'" data-target="'+safe(id)+'">打开所属插件 ↗</button>':'')+(record.registered_by?'<p>注册功能：'+safe(featureLabel(record.registered_by))+'</p>':'')+(record.defined_in?'<p>定义归属：'+safe(featureLabel(record.defined_in))+'</p>':'')+(record.assembled_by?'<p>装配来源：'+safe(record.assembled_by.map(featureLabel).join(' / '))+'</p>':'')+(owners?.length?list('所属实体',owners):(record.owner?'<p>所属实体：'+safe(record.owner)+'</p>':''))+list('公开契约',plugin?.contracts)+registrationList(record.registrations)+list('同函数其他注册',(record.registrationFamilyIds||[]).filter(other=>other!==id).map(other=>other+' '+objectContext(other)))+accessList('Read',record.reads)+accessList('Write',record.writes)+list('Query',record.filters)+list('事件 / 消息',record.events)+list('字段',record.fields)+list('约束与说明',[...(record.notes||[]),...(record.sourceGaps||[])])+(record.components?list('完整实体组件',record.components.map(component=>component.id||component)):'')+sourcesList(record.sourceEntries)+'<button class="reset" id="clear-selection">清除选择</button>';
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
  function scheduleDetail(id){const group=view.scheduleGroups.find(item=>item.id===id);if(!group)return;details.innerHTML='<h2>'+safe(group.label)+'</h2>'+list('运行说明',group.notes)+list('约束与说明',group.sourceGaps)+sourcesList(group.sourceEntries)+'<button class="reset" id="clear-selection">清除选择</button>';sourceEditor.refreshLinks(details);details.scrollTop=0}
  function focusSection(section){if(!section)return;select(null);fit(true);panX=18-(section.x-(view.bounds?.x||0))*scale;panY=18-(section.y-(view.bounds?.y||0))*scale;transform();if(section.schedule)scheduleDetail(section.schedule);else{details.innerHTML='<h2>'+safe(section.label)+'</h2>';details.scrollTop=0}}
  function focusSchedule(id){if(id)focusSection(view.sections.find(section=>section.schedule===id))}
  function relationshipValue(value){return value===null?'无':typeof value==='boolean'?(value?'是':'否'):typeof value==='object'?JSON.stringify(value):String(value)}
  function edgeEndpoint(id,schedule){const entry=schedule?view.scheduleGroups.find(group=>group.id===id):DATA.registry[id];return'<button class="data-link" '+(schedule?'data-schedule':'data-open')+'="'+safe(id)+'">'+safe(entry?.name||entry?.label||id)+'</button>'}
  function showEdgeDetail(link,schedule){
    const record=DATA.registry[link.id]||{},style=DATA.styles.edges[link.edgeSemantic],properties={...record,...link};
    details.innerHTML='<span class="badge">'+safe(style?.label||link.edgeSemantic||link.kind)+'</span><h2>'+safe(record.name||link.displayLabel||style?.label||'关系')+'</h2><p>来源：'+edgeEndpoint(link.from,schedule)+'</p><p>目标：'+edgeEndpoint(link.to,schedule)+'</p>'+(link.eventId?'<h3>触发事件</h3><p>'+edgeEndpoint(link.eventId,false)+'</p>':'')+(link.label?'<h3>完整契约与约束</h3><p>'+safe(link.label)+'</p>':'')+((link.description||record.description)?'<p>'+safe(link.description||record.description)+'</p>':'')+['cardinality','reverse','linked_spawn'].filter(key=>Object.hasOwn(properties,key)).map(key=>'<h3>'+({cardinality:'数量约束',reverse:'反向关系',linked_spawn:'连带生命周期'}[key])+'</h3><p>'+safe(relationshipValue(properties[key]))+'</p>').join('')+list('约束与说明',[...(link.notes||record.notes||[]),...(link.sourceGaps||record.sourceGaps||[])])+sourcesList(link.sourceEntries||record.sourceEntries)+'<button class="reset" id="clear-selection">清除选择</button>';
    sourceEditor.refreshLinks(details);details.scrollTop=0;
  }
  function paintEdge(id,schedule=false){const link=(schedule?view.scheduleLinks:view.links).find(candidate=>candidate.id===id);if(!link)return;activeSelection={kind:'edge',id,schedule};const endpoints=new Set([link.displayFrom||link.from,link.displayTo||link.to]);interaction.paint({selectedNodes:schedule?new Set():endpoints,dimNodes:new Set(view.nodes.filter(node=>!endpoints.has(node.id)).map(node=>node.id)),selectedSchedules:schedule?endpoints:new Set(),focusedEdges:new Set([id]),dimEdges:new Set([...view.links,...view.scheduleLinks].filter(edge=>edge.id!==id).map(edge=>edge.id))});showEdgeDetail(link,schedule)}
  function internalOwnerView(feature,id){const target=DATA.views.find(candidate=>candidate.aspect==='systems'&&candidate.feature===feature);return{view:target,node:target?.nodes.some(node=>node.id===id)?id:null}}
  function openOwner(feature,id){id=canonical(id);const target=internalOwnerView(feature,id);navigate({feature,aspect:'systems',node:target.node})}
  function openObject(id){id=canonical(id);const target=objectView(id);if(!target){if(DATA.objectAliases?.[id]?.length){navigate({...selection,object:id,node:null});return}openOwner(DATA.registry[id]?.feature,id);return}if(view.id===target.id){focusNode(target.centerNodeId||id);return}navigate({...selection,object:id,node:target.centerNodeId||id})}
  function openNode(id){id=canonical(id);if(objectView(id)){openObject(id);return}if(view.nodes.some(node=>node.id===id))focusNode(id);else openOwner(DATA.registry[id]?.feature,id)}
  function normalizeSelection(){
    aliasCandidates=[];
    const legacy=selection.legacyAspect;delete selection.legacyAspect;
    if(!selection.object&&selection.node&&(legacy&&objectView(selection.node)||DATA.objectAliases?.[selection.node]))selection.object=canonical(selection.node);
    if(selection.object){
      const requested=canonical(selection.object),aliases=DATA.objectAliases?.[requested]||[];
      const target=objectView(requested)||aliases.length===1&&objectView(aliases[0]);
      if(target){
        const selected=canonical(selection.node),nodeAliases=(DATA.objectAliases?.[selected]||[]).filter(id=>objectView(id));
        aliasCandidates=nodeAliases.length>1?nodeAliases:[];
        const node=nodeAliases.length===1?nodeAliases[0]:selected;
        selection={...selection,...(selection.feature==='third_party'||legacy&&selection.feature==='infrastructure'?{feature:target.feature,aspect:'systems'}:{}),object:target.objectId,node:aliasCandidates.length?selected:target.nodes.some(candidate=>candidate.id===node)?node:target.centerNodeId||target.objectId};updateUrl();return;
      }
      aliasCandidates=aliases.filter(id=>objectView(id));
      if(aliasCandidates.length){selection={...selection,node:null};updateUrl();return}
      delete selection.object;
    }
    const id=canonical(selection.node),record=DATA.registry[id];
    if(legacy&&objectView(id)){selection={...selection,...(['third_party','infrastructure'].includes(selection.feature)?{feature:record.feature,aspect:'systems'}:{}),object:id,node:id};updateUrl();return}
    if(selection.feature==='overview'&&DATA.views.find(candidate=>candidate.id==='overview')?.layout==='app-schedule'){
      if(['Plugin','PluginGroup'].includes(record?.kind)){const target=internalOwnerView(record.feature,id);selection={feature:record.feature,aspect:'systems',node:target.node};updateUrl();return}
    }
    const current=DATA.views.find(candidate=>selection.feature==='overview'?candidate.id==='overview':candidate.feature===selection.feature&&candidate.aspect==='systems');
    if(selection.feature==='third_party'){
      const target=internalOwnerView(record?.feature,id);selection=target.view?{feature:target.view.feature,aspect:'systems',node:target.node}:{feature:'overview',aspect:'overview',node:null};
    }else if(id&&!current?.nodes.some(node=>node.id===id)){
      if(objectView(id))selection={...selection,object:id,node:id};else selection={...selection,node:null};
    }else if(id)selection={...selection,node:id};
    updateUrl();
  }
  function bindEdgeLabels(){
    const links=[...view.links,...view.scheduleLinks];
    for(const label of diagram.querySelectorAll('g.edgeLabel')){
      const ids=new Set([label.dataset.mermaidNativeId,...[...label.querySelectorAll('[data-mermaid-native-id]')].map(item=>item.dataset.mermaidNativeId)].filter(Boolean)),matches=links.filter(link=>ids.has(link.mermaidId));
      if(matches.length!==1)continue;
      const link=matches[0],schedule=view.scheduleLinks.includes(link);label.setAttribute('data-link-label-id',link.id);label.setAttribute(schedule?'data-schedule-link-id':'data-link-id',link.id);label.setAttribute(schedule?'data-schedule-connect':'data-connect',(link.displayFrom||link.from)+'|'+(link.displayTo||link.to));label.classList.add('edge');label.setAttribute('tabindex','0');label.setAttribute('role','button');label.setAttribute('aria-label',(link.displayLabel||link.label||DATA.styles.edges[link.edgeSemantic]?.label||'关系')+' · '+link.from+' → '+link.to);
    }
  }
  function renderDiagram(){gestures.reset();interaction.paint();diagram.innerHTML=view.svg||'';bindEdgeLabels();canvas.querySelector('.empty-state')?.remove();if(!view.svg){const empty=document.createElement('div');empty.className='empty-state';empty.innerHTML='<h3>当前页签没有相关节点</h3>';canvas.appendChild(empty)}document.getElementById('section').innerHTML='<option value="">定位分组</option>'+(view.sections||[]).map((section,index)=>'<option value="'+index+'">'+safe(section.label)+'</option>').join('')}
  function renderSelection(restore=false){
    normalizeSelection();view=objectView(selection.object)||DATA.views.find(candidate=>selection.feature==='overview'?candidate.id==='overview':candidate.feature===selection.feature&&candidate.aspect==='systems')||DATA.views[0];activeSelection={kind:'none'};
    document.querySelectorAll('.navigation [data-feature]').forEach(button=>button.classList.toggle('active',button.dataset.feature===selection.feature));document.querySelector('.tabs').hidden=selection.feature==='overview'||view.aspect==='object';document.querySelectorAll('[data-aspect]').forEach(button=>button.classList.toggle('active',button.dataset.aspect===selection.aspect));
    const feature=DATA.model.features.find(candidate=>candidate.id===selection.feature)||DATA.infrastructureFeatures.find(candidate=>candidate.id===selection.feature),head=document.getElementById('feature-head'),center=view.centerNodeId||view.objectId;
    head.innerHTML=view.aspect==='object'?'<h1>'+safe(DATA.registry[center]?.name||view.label)+'<span class="identifier">'+safe(objectContext(center))+'</span></h1>':feature?'<h1>'+safe(feature.label)+'<span class="identifier">'+safe(feature.plugin||feature.identifier)+'</span></h1>':'<h1>'+safe(view.label)+'</h1>';
    document.getElementById('return-context').hidden=view.aspect!=='object'&&!aliasCandidates.length;document.getElementById('return-overview').disabled=view.id==='overview';document.getElementById('search').value='';renderDiagram();guide();
    const rendered=view,snapshot=restore?history.state?.architectureView:null;requestAnimationFrame(()=>{if(view!==rendered)return;if(snapshot?.id===view.id){scale=snapshot.scale;panX=snapshot.panX;panY=snapshot.panY;transform();if(snapshot.active?.kind==='edge')paintEdge(snapshot.active.id,snapshot.active.schedule);else if(snapshot.active?.kind==='node')select(snapshot.active.id);else if(snapshot.active?.kind==='search'){document.getElementById('search').value=snapshot.active.query;search(snapshot.active.query)}}else{fit();const id=selection.node||(view.aspect==='object'?center:null);if(id&&!aliasCandidates.length)select(id)}if(aliasCandidates.length)details.innerHTML='<h2>选择原对象</h2><p>此旧入口包含多个投影或注册，请选择对应对象。</p>'+objectResults(aliasCandidates)});
  }
  function activateEdge(element){paintEdge(element.dataset.scheduleLinkId||element.dataset.linkId,element.dataset.scheduleLinkId!==undefined)}
  function diagramTarget(target){for(let item=target;item&&item!==diagram;item=item.parentElement)if(item.dataset.id!==undefined||item.dataset.linkId!==undefined||item.dataset.scheduleLinkId!==undefined)return item;return null}
  function activateNode(element){select(element?.dataset.id||null)}
  document.addEventListener('click',event=>{
    const feature=event.target.closest('button[data-feature]');if(feature){navigate({feature:feature.dataset.feature,aspect:'systems',node:null});return}
    const aspect=event.target.closest('[data-aspect]');if(aspect){navigate({feature:selection.feature,aspect:aspect.dataset.aspect,node:null});return}
    const clear=event.target.closest('#clear-selection');if(clear){select(null);return}
    const edge=event.target.closest('[data-link-id]')||event.target.closest('[data-schedule-link-id]');if(edge){activateEdge(edge);return}
    const schedule=event.target.closest('[data-schedule]');if(schedule){focusSchedule(schedule.dataset.schedule);return}
    const owner=event.target.closest('[data-owner]');if(owner){openOwner(owner.dataset.owner,owner.dataset.target);return}
    const object=event.target.closest('[data-object]');if(object){openObject(object.dataset.object);return}
    const open=event.target.closest('[data-open]');if(open)openNode(open.dataset.open);
  });
  function zoom(factor,x=canvas.clientWidth/2,y=canvas.clientHeight/2){if(!view.svg)return;const previous=scale;scale=Math.min(2.4,Math.max(.08,scale*factor));panX=x-(x-panX)*scale/previous;panY=y-(y-panY)*scale/previous;transform()}
  document.getElementById('return-context').onclick=()=>{const target=internalOwnerView(selection.feature,view.objectId);navigate(objectOrigin?{...objectOrigin,object:null}:{feature:selection.feature,aspect:'systems',node:target.node})};
  document.getElementById('return-overview').onclick=()=>navigate({feature:'overview',aspect:'systems',node:null});document.getElementById('fit').onclick=()=>fit();document.getElementById('readable').onclick=()=>fit(true);document.getElementById('zoom-in').onclick=()=>zoom(1.2);document.getElementById('zoom-out').onclick=()=>zoom(1/1.2);document.getElementById('section').onchange=event=>{if(event.target.value!=='')focusSection(view.sections[Number(event.target.value)])};
  const gestures=createGestures({canvas,window,hasDiagram:()=>Boolean(view?.svg),getViewport:()=>({scale,x:panX,y:panY}),setViewport:next=>{scale=next.scale;panX=next.x;panY=next.y;transform()},activate:(x,y)=>{const target=diagramTarget(document.elementFromPoint(x,y));if(target?.dataset.linkId!==undefined||target?.dataset.scheduleLinkId!==undefined)activateEdge(target);else activateNode(target)}});
  canvas.addEventListener('wheel',event=>{if(window.innerWidth<=900||!view.svg)return;event.preventDefault();const rect=canvas.getBoundingClientRect();zoom(event.deltaY<0?1.12:1/1.12,event.clientX-rect.left,event.clientY-rect.top)},{passive:false});
  diagram.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){const target=diagramTarget(event.target);if(target){event.preventDefault();target.dataset.linkId!==undefined||target.dataset.scheduleLinkId!==undefined?activateEdge(target):activateNode(target)}}});
  function search(query){query=query.trim().toLowerCase();if(!query){select(null);return}const hits=new Set(objects.map(object=>object.id).filter(id=>JSON.stringify(DATA.registry[id]||{}).toLowerCase().includes(query))),shown=new Set([...hits].filter(id=>view.nodes.some(node=>node.id===id)));activeSelection={kind:'search',query,hits:[...hits]};interaction.paint({selectedNodes:shown,dimNodes:new Set(view.nodes.filter(node=>!shown.has(node.id)).map(node=>node.id))});details.innerHTML='<h2>'+hits.size+' 个匹配对象</h2>'+objectResults([...hits]);details.scrollTop=0}
  document.getElementById('search').addEventListener('input',event=>search(event.target.value));window.addEventListener('popstate',()=>{selection=navigation.resolve(location.search);objectOrigin=history.state?.architectureObjectOrigin||null;renderSelection(true)});canvasSize=measureCanvas();
  window.addEventListener('resize',()=>{splitter.refresh();const next=measureCanvas();
    // 手机地址栏和软键盘只改变高度时，不重置用户缩放或平移。
    if(!(canvasSize.compact&&next.compact&&next.width===canvasSize.width)){gestures.reset();panX+=(next.width-canvasSize.width)/2;panY+=(next.height-canvasSize.height)/2;transform()}
    canvasSize=next;
  });renderSelection();
  return{navigate,select,openNode,openObject,search,renderSelection,get view(){return view},get selection(){return selection}};
}

export function renderArchitectureViewer({ model, registry, views, features, guideSamples, objects = [], objectAliases = {}, sourceRoleLabels = {} }) {
  const state = JSON.stringify({ schemaVersion: 3, model, registry, views, guideSamples, objects, objectAliases, sourceRoleLabels, infrastructureFeatures: INFRASTRUCTURE_FEATURES, styles: { nodes: NODE_STYLES, edges: EDGE_STYLES, selection: SELECTION_STYLE, externalReference: EXTERNAL_REFERENCE_STYLE } }).replace(/</g, '\\u003c');
  const editor = sourceEditorAssets(), navigation = architectureNavigationAssets(features), splitter = architectureSplitterAssets(), interaction = architectureInteractionAssets(), gestures = architectureGestureAssets();
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Crect width='10' height='10' rx='2' fill='%232563EB'/%3E%3C/svg%3E"><title>demo · 插件架构</title><style>
${architectureShellStyle}
${editor.style}
</style></head><body><header><span class="brand">DEMO / ARCHITECTURE</span><button type="button" data-workspace-config>配置工作区</button></header><div class="shell"><nav class="navigation" aria-label="功能插件"><p>阅读入口</p><button data-feature="overview">功能总览</button><div class="nav-divider"></div><p>项目插件</p>${features.map(feature => `<button data-feature="${escape(feature.id)}">${escape(feature.label)}<small>${escape(feature.plugin)}</small></button>`).join('')}<div class="nav-divider"></div><p id="third-party-heading">第三方插件</p><div class="third-party-navigation" role="group" aria-labelledby="third-party-heading">${INFRASTRUCTURE_FEATURES.filter(feature => feature.section === 'third_party').map(feature => `<button data-feature="${escape(feature.id)}">${escape(feature.label)}<small>${escape(feature.identifier)}</small></button>`).join('')}</div>${INFRASTRUCTURE_FEATURES.filter(feature => !feature.section).map(feature => `<button data-feature="${escape(feature.id)}">${escape(feature.label)}<small>${escape(feature.identifier)}</small></button>`).join('')}</nav><main class="main"><section id="feature-head" class="feature-head"></section><div class="tabs-toolbar"><nav class="tabs" aria-label="插件详情"><button data-aspect="systems">系统与调度</button></nav><div class="tools"><button id="return-context" hidden>返回原视图</button><button id="return-overview">返回总览</button><input id="search" type="search" placeholder="搜索全部对象" aria-label="搜索全部架构对象"><button id="zoom-out" aria-label="缩小">−</button><span id="zoom-label">100%</span><button id="zoom-in" aria-label="放大">＋</button><button id="readable">阅读大小</button><button id="fit">适合窗口</button></div></div><section id="workspace" class="workspace"><section class="canvas-wrap"><div class="caption"><select id="section" aria-label="定位图内分组"><option value="">定位分组</option></select></div><div id="canvas" class="canvas" tabindex="-1" role="region" aria-label="架构图画布"><div id="diagram" class="diagram"></div></div></section><div id="details-resizer" class="details-resizer" tabindex="0" role="separator" aria-orientation="vertical" aria-label="调整详情宽度" aria-controls="details"></div><aside id="details" class="side" aria-live="polite"></aside></section></main></div>${editor.markup}<script id="architecture-data" type="application/json">${state}</script><script>${editor.script}</script><script>${navigation.script}</script><script>${splitter.script}</script><script>${interaction.script}</script><script>${gestures.script}</script><script>const architectureViewer=(${createArchitectureViewer.toString()})({data:JSON.parse(document.getElementById("architecture-data").textContent),document,location,history,window,requestAnimationFrame,sourceEditor,navigation:architectureNavigation,createSplitter:createArchitectureSplitter,createInteraction:createArchitectureInteraction,createGestures:createArchitectureGestures});</script></body></html>`;
}
