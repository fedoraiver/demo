import { sourceEditorAssets } from './source-editor.mjs';
import { architectureShellStyle } from './architecture-shell.mjs';
import { architectureNavigationAssets, defaultArchitectureSchedule, resolveArchitectureSelection, architectureUrl, createArchitectureNavigation } from './architecture-navigation.mjs';
import { INFRASTRUCTURE_FEATURES } from './architecture-infrastructure.mjs';
import { architectureSplitterAssets } from './architecture-splitter.mjs';
import { architectureInteractionAssets } from './architecture-interaction.mjs';
import { architectureGestureAssets } from './architecture-gestures.mjs';
import { NODE_STYLES, EDGE_STYLES, SELECTION_STYLE, EXTERNAL_REFERENCE_STYLE } from './architecture-style.mjs';
import { SCHEDULE_LEGEND_LABELS } from './schedule-legend.mjs';
import { assetLoaderAssets, readArchitectureResource, createArchitectureAssetLoader } from './architecture-asset-loader.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createArchitectureViewer({ data: DATA, document, location, history, window, requestAnimationFrame, sourceEditor, navigation, createSplitter, createInteraction, createGestures, createScheduleRenderer, loadView, pinView }) {
  const canvas=document.getElementById('canvas'),diagram=document.getElementById('diagram'),details=document.getElementById('details');
  const results=document.getElementById('object-results'),picker=document.getElementById('view-select'),workspace=document.getElementById('workspace');
  const scheduleRenderer=createScheduleRenderer?.();
  const interaction=createInteraction({diagram,nodeStyles:DATA.styles.nodes,selectionStyle:DATA.styles.selection});
  const safe=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const componentEntities=new Map(DATA.model.entities.flatMap(entity=>entity.components.map(component=>[component.id,entity.canonical_entity||'entity-'+entity.id])));
  const objectViews=DATA.views.filter(candidate=>candidate.aspect==='object');
  const scheduleViews=DATA.views.filter(candidate=>candidate.aspect==='schedule');
  const scheduleBindings=new Map((DATA.scheduleInteractions?.views||[]).map(entry=>[entry.viewId,new Map(entry.bindings.map(binding=>[binding.id,binding]))]));
  const scheduleElements=new Map();let selectedScheduleId=null;
  const objects=DATA.objects?.length?DATA.objects:objectViews.map(candidate=>({id:candidate.objectId,viewId:candidate.id,feature:candidate.feature}));
  let desiredViewId=null,viewLoading=null,loadAbort=null,lastSuccessful=null,retryTarget=null,searchRevision=0;
  let selection=navigation.resolve(location.search),view,scale=1,panX=0,panY=0,activeSelection={kind:'none'},clearedSearchQuery=null,canvasSize,objectOrigin=history.state?.architectureObjectOrigin||null,aliasCandidates=[],renderedObject=false,renderRequest=0,pendingRender=Promise.resolve(),displayedScheduleKey=null,pageSuspended=false,resultIndex=-1,openFilter=null,filterState={includePlugins:[],excludePlugins:[],includeNames:[],excludeNames:[],include:'',exclude:''},filterLegacy={include:'',exclude:'',includeNames:[],excludeNames:[],includePlugins:[],excludePlugins:[]};
  const canonical=id=>DATA.registry[id]?.alias_of||id;
  const featureLabel=id=>DATA.model.features.find(feature=>feature.id===id)?.label||DATA.infrastructureFeatures.find(feature=>feature.id===id)?.label||id;
  const objectView=id=>objectViews.find(candidate=>candidate.objectId===canonical(id));
  const pluginView=target=>['Plugin','PluginGroup'].includes(DATA.registry[target?.objectId]?.kind);
  const ownerObject=feature=>{const entry=DATA.model.features.find(entry=>entry.id===feature)||DATA.infrastructureFeatures.find(entry=>entry.id===feature);return canonical(entry?.overviewNode||(entry?.plugin?'plugin-'+entry.plugin:null))};
  const visibleNode=id=>canonical(id);
  function objectContext(id){const record=DATA.registry[id]||{},owner=componentEntities.get(id),schedules=(record.registrations||[]).map(registration=>registration.schedule).filter(Boolean);return[record.owner||DATA.registry[owner]?.name,...new Set(schedules),id].filter(Boolean).join(' · ')}
  function objectResults(ids){return ids.map(id=>'<button class="result" data-object="'+safe(id)+'">'+safe(DATA.registry[id]?.name||id)+'<small>'+safe(objectContext(id))+'</small></button>').join('')}
  function transform(){diagram.style.transform='translate('+panX+'px,'+panY+'px) scale('+scale+')';interaction.setScale(scale);const percent=scale*100;document.getElementById('zoom-label').textContent=(percent<1?Number(percent.toPrecision(2)):Math.round(percent))+'%'}
  const fittedScale=()=>Math.min((canvas.clientWidth-28)/view.width,(canvas.clientHeight-28)/view.height,1);
  // 超大图在适合窗口后仍可缩小四倍；画布扩大时不把既有的小比例突然放大。
  const clampScale=value=>Math.min(2.4,Math.max(Math.min(.08,fittedScale()/4,scale),value));
  function fit(readable=false){if(!view?.svg)return;scale=readable?Math.min((canvas.clientWidth-28)/Math.min(view.width,900),1):fittedScale();panX=readable?14:(canvas.clientWidth-view.width*scale)/2;panY=readable?14:(canvas.clientHeight-view.height*scale)/2;transform()}
  const measureCanvas=()=>({width:canvas.clientWidth,height:canvas.clientHeight,compact:window.innerWidth<=900});
  const splitter=createSplitter({workspace,enabled:()=>Boolean(view),separator:document.getElementById('details-resizer'),canvas,window,onResize:delta=>{panX+=delta/2;canvasSize=measureCanvas();transform();rememberView()}});
  const scheduleBinding=(id,viewId=view?.id)=>scheduleBindings.get(viewId)?.get(id);
  function scheduleOutlineParts(element){
    const parts=[];
    function visit(parent){for(const child of parent.children){if(['node','cluster','edge','schedule-cluster-title','label'].some(name=>child.classList.contains(name)))continue;const tag=child.tagName.toLowerCase();if(['path','polygon','ellipse','rect','circle','polyline','line'].includes(tag))parts.push(child);else if(tag==='g'||tag==='a')visit(child)}}
    visit(element);return parts;
  }
  function scheduleTitleFillParts(elements,binding){
    const [owner,...titles]=elements,id=owner.getAttribute('id');
    if(binding?.kind!=='set'||!id)return[];
    return titles.filter(title=>title.dataset.scheduleTitle===binding.id&&title.dataset.clusterId===id&&title.dataset.clusterName===binding.graphName).flatMap(title=>[...title.querySelectorAll('polygon')].filter(part=>part.closest('[data-schedule-title]')===title&&part.getAttribute('stroke')==='none'));
  }
  function detailVisibility(visible,preserveCenter=false){const before=measureCanvas();workspace.classList.toggle('has-details',visible);details.hidden=!visible;splitter.refresh();if(preserveCenter){panX+=(canvas.clientWidth-before.width)/2;panY+=(canvas.clientHeight-before.height)/2;transform()}canvasSize=measureCanvas()}
  function selectSchedule(id,{remember=true,preserveCenter=true}={}){
    const previous=selectedScheduleId,binding=scheduleElements.has(id)&&scheduleBinding(id);
    selectedScheduleId=binding?id:null;
    if(binding)clearedSearchQuery=null;
    if(binding)selection={...selection,scheduleNode:id};else{selection={...selection};delete selection.scheduleNode}
    const selectedOutlines=[];
    for(const [key,elements]of scheduleElements){const [element]=elements,selected=key===selectedScheduleId;element.classList.toggle('selected',selected);element.setAttribute('aria-pressed',String(selected));if(selected){const fillOnlyParts=scheduleTitleFillParts(elements,scheduleBinding(key));for(const [index,part]of scheduleOutlineParts(element).entries())selectedOutlines.push({target:part,parts:[part],fillOnlyParts:index===0?fillOnlyParts:[]})}}
    interaction.paint({selectedOutlines,nativeOnly:true});
    if(!selectedScheduleId)releaseDiagramFocus();
    detailVisibility(true,preserveCenter);
    if(binding){if(previous!==id||!details.children.length)showDetail(binding.objectId)}else guide();
    updateUrl();if(remember)rememberView();
  }
  function updateUrl(){try{history.replaceState(history.state,'',navigation.url(selection,location.href))}catch{/* 文件页仍保留当前导航。 */}}
  function scheduleKey(value=selection){return JSON.stringify([value.schedule,value.scheduleInclude||'',value.scheduleExclude||'',...['scheduleIncludePlugins','scheduleExcludePlugins','scheduleIncludeSystems','scheduleExcludeSystems'].map(key=>[...new Set(value[key]||[])].sort())])}
  const interactionPaused=()=>Boolean(viewLoading&&viewLoading.id!==view?.id);
  function viewSnapshot(){const key=scheduleKey();return !view||loadView&&view.id!==desiredViewId||view.aspect==='schedule'&&displayedScheduleKey!==key?null:{id:view.id,scale,panX,panY,active:activeSelection,...(view.aspect==='schedule'?{filterKey:key}:{})}}
  const searchQuery=()=>activeSelection.kind==='search'?activeSelection.query:clearedSearchQuery;
  function rememberView(){if(!view)return;const state={...history.state,architectureView:viewSnapshot(),architectureSearch:searchQuery(),architectureSearchCleared:clearedSearchQuery!==null},href=navigation.url(selection,location.href);try{history.replaceState(state,'',href)}catch{/* 本地浏览器可禁用 History API。 */}if(loadView&&!interactionPaused()&&view.id===desiredViewId)lastSuccessful={selection:{...selection},objectOrigin,state,href,view}}
  function liveFilterSelection(){return{scheduleInclude:filterState.include,scheduleExclude:filterState.exclude,scheduleIncludeSystems:[...filterState.includeNames],scheduleExcludeSystems:[...filterState.excludeNames],scheduleIncludePlugins:[...filterState.includePlugins],scheduleExcludePlugins:[...filterState.excludePlugins]}}
  function appliedFilterSelection(){return{scheduleInclude:selection.scheduleInclude||'',scheduleExclude:selection.scheduleExclude||'',scheduleIncludeSystems:[...(selection.scheduleIncludeSystems||[])],scheduleExcludeSystems:[...(selection.scheduleExcludeSystems||[])],scheduleIncludePlugins:[...(selection.scheduleIncludePlugins||[])],scheduleExcludePlugins:[...(selection.scheduleExcludePlugins||[])]}}
  // 筛选选择即时进入链接；完整导航继续携带当前条件。
  function navigate(next,origin,restore=null){next={...appliedFilterSelection(),...next};rememberView();objectOrigin=origin!==undefined?origin:next.object?{selection:{...selection,...appliedFilterSelection()},view:viewSnapshot(),search:searchQuery(),searchCleared:clearedSearchQuery!==null,parent:objectOrigin}:null;const href=navigation.url(next,location.href);selection=navigation.resolve(new URL(href).search);try{history.pushState({...history.state,architectureView:restore?.view||null,architectureSearch:restore?.search||null,architectureSearchCleared:restore?.searchCleared===true,architectureObjectOrigin:objectOrigin},'',href)}catch{/* 导航不依赖文件页的历史权限。 */}renderSelection(Boolean(restore),restore)}
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
  function bodyOperationsList(operations){
    if(!operations?.length)return '';
    const labels={insert:'添加',remove:'移除',initialize:'初始化',read:'只读访问',mutable_access:'可变访问（不表示实际修改）',trigger:'触发事件',publish:'发布消息',reference:'查询接口'},interfaces={commands:'Commands',world:'World',message_writer:'MessageWriter'};
    return'<section class="body-operations" data-access="body"><h3>函数体操作</h3><ul>'+operations.map(operation=>'<li data-body-operation="'+safe(operation.operation)+'" data-body-object="'+safe(operation.objectId)+'"><p><strong>'+safe(labels[operation.operation]||operation.operation)+'</strong> '+edgeEndpoint(operation.objectId,false)+'</p><p>'+safe(interfaces[operation.via]||operation.via)+' · '+(operation.deferred?'延迟应用':'直接调用')+' · '+(operation.scope==='main'?'主应用世界':'当前应用世界')+'</p><p><code>'+safe(operation.method)+'</code></p>'+(operation.condition?'<p>条件：'+safe(operation.condition)+'</p>':'')+(operation.helper?'<p>经 helper：<code>'+safe(operation.helper)+'</code></p>':'')+sourcesList(operation.sourceEntries)+'</li>').join('')+'</ul></section>';
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
    if(view.aspect==='schedule'){
      const binding=scheduleBinding(selectedScheduleId);if(binding){showDetail(binding.objectId);return}
      const samples=DATA.guideSamples.schedule||{nodes:{},edges:{}},labels=DATA.scheduleLegendLabels||{},kinds=new Set(view.legendKinds||[]),row=(kind,sample)=>'<div class="guide-row" data-guide-schedule-kind="'+kind+'"><span class="guide-sample">'+guideSample(sample)+'</span><span>'+safe(labels[kind]||kind)+'</span></div>';
      const nodes=['system','system_set','context'].filter(kind=>kinds.has(kind)).map(kind=>row(kind,samples.nodes[kind])).join(''),edges=['order','set_membership'].filter(kind=>kinds.has(kind)).map(kind=>row(kind,samples.edges[kind])).join('');
      details.innerHTML='<div class="guide" lang="en" aria-label="Legend">'+(nodes?'<h3>Nodes</h3>'+nodes:'')+(edges?'<h3>Edges</h3>'+edges:'')+(!nodes&&!edges?'<p data-guide-schedule-empty>No visible schedule elements.</p>':'')+'</div>';details.scrollTop=0;return;
    }
    const nodes=[];
    for(const[type,style]of Object.entries(DATA.styles.nodes))if(view.nodes.some(node=>node.visualType===type))nodes.push('<div class="guide-row" data-guide-node-type="'+safe(type)+'"><span class="guide-sample">'+guideSample(DATA.guideSamples.nodes[type])+'</span><span>'+safe(style.legendLabel)+'</span></div>');
    const external=view.nodes.some(node=>node.role==='external')?'<div class="guide-reference" data-guide-external-reference>'+safe(DATA.styles.externalReference.legendLabel)+'</div>':'';
    const semantics=new Set([...view.links,...view.scheduleLinks].map(link=>link.edgeSemantic));
    const edges=Object.entries(DATA.styles.edges).filter(([semantic])=>semantics.has(semantic)).map(([semantic,style])=>'<div class="guide-row" data-guide-edge-semantic="'+safe(semantic)+'"><span class="guide-sample">'+guideSample(DATA.guideSamples.edges[semantic])+'</span><span>'+safe(style.legendLabel)+'</span></div>');
    details.innerHTML='<div class="guide" lang="en" aria-label="Legend">'+(nodes.length?'<h3>Nodes</h3>'+nodes.join('')+external:'')+(edges.length?'<h3>Edges</h3>'+edges.join(''):'')+'</div>';details.scrollTop=0;
  }
  function guideSample(value){if(!value)return '';return value.trim().startsWith('<svg')?value:'<img src="'+safe(value)+'" alt="" loading="lazy" decoding="async">'}
  function showDetail(id){
    id=canonical(id);if(!DATA.registry[id]){guide();return}const record=DATA.registry[id];
    const owners=record.owners;
    details.innerHTML='<h2>'+safe(record.name||id)+'</h2><p>'+safe(record.description||'')+'</p>'+(objectView(id)&&view.objectId!==id?'<button data-object="'+safe(id)+'">打开对象关系图 ↗</button>':'')+(record.feature?'<p>功能归属：'+safe(featureLabel(record.feature))+'</p><button data-owner="'+safe(record.feature)+'" data-target="'+safe(id)+'">打开所属插件 ↗</button>':'')+(record.registered_by?'<p>注册功能：'+safe(featureLabel(record.registered_by))+'</p>':'')+(record.defined_in?'<p>定义归属：'+safe(featureLabel(record.defined_in))+'</p>':'')+(record.assembled_by?'<p>装配来源：'+safe(record.assembled_by.map(featureLabel).join(' / '))+'</p>':'')+(owners?.length?list('所属实体',owners):(record.owner?'<p>所属实体：'+safe(record.owner)+'</p>':''))+registrationList(record.registrations)+list('同函数其他注册',(record.registrationFamilyIds||[]).filter(other=>other!==id).map(other=>other+' '+objectContext(other)))+accessList('Read',record.reads)+accessList('Write',record.writes)+bodyOperationsList(record.bodyOperations)+list('Query',record.filters)+list('事件 / 消息',record.events)+list('字段',record.fields)+(record.kind==='System'?'':list('约束与说明',[...(record.notes||[]),...(record.sourceGaps||[])]))+(record.components?list('完整实体组件',record.components.map(component=>component.id||component)):'')+sourcesList(record.sourceEntries)+'<button class="reset" id="clear-selection">清除选择</button>';
    sourceEditor.refreshLinks(details);details.scrollTop=0;
  }
  function releaseDiagramFocus(){const active=document.activeElement;if(active?.closest('#diagram')||active?.id==='clear-selection')canvas.focus({preventScroll:true})}
  function select(id){
    if(!view||interactionPaused())return;
    if(view.aspect==='schedule'){selection={...selection,node:null};selectSchedule(null);return}
    id=id?visibleNode(id):null;if(id)clearedSearchQuery=null;activeSelection=id?{kind:'node',id}:{kind:'none'};if(!id)releaseDiagramFocus();
    const record=DATA.registry[id],selectedNodes=new Set(id?[id]:[]),relevant=new Set([id,...(record?.reads||[]),...(record?.writes||[]),...view.links.filter(link=>link.from===id||link.to===id||link.displayFrom===id||link.displayTo===id).flatMap(link=>[link.from,link.to])].map(visibleNode));
    const focused=new Set(id?view.links.filter(link=>relevant.has(link.displayFrom||link.from)||relevant.has(link.displayTo||link.to)).map(link=>link.id):[]);
    interaction.paint({selectedNodes,dimNodes:new Set(id?view.nodes.filter(node=>!relevant.has(node.id)).map(node=>node.id):[]),focusedEdges:focused,dimEdges:new Set(id?[...view.links,...view.scheduleLinks].filter(link=>!focused.has(link.id)).map(link=>link.id):[])});
    selection={...selection,node:id};updateUrl();id?showDetail(id):guide();rememberView();
  }
  function focusNode(id){id=visibleNode(id);const node=view.nodes.find(candidate=>candidate.id===id);if(!node?.position)return;const box=node.position;scale=Math.min((canvas.clientWidth-28)/Math.max(400,box.width*1.3),1);panX=canvas.clientWidth/2-(box.x+box.width/2-(view.bounds?.x||0))*scale;panY=canvas.clientHeight/2-(box.y+box.height/2-(view.bounds?.y||0))*scale;transform();select(id)}
  function scheduleDetail(id){const group=view.scheduleGroups.find(item=>item.id===id);if(!group)return;details.innerHTML='<h2>'+safe(group.label)+'</h2>'+list('运行说明',group.notes)+list('约束与说明',group.sourceGaps)+sourcesList(group.sourceEntries)+'<button class="reset" id="clear-selection">清除选择</button>';sourceEditor.refreshLinks(details);details.scrollTop=0}
  function focusSection(section){if(!section)return;select(null);fit(true);panX=18-(section.x-(view.bounds?.x||0))*scale;panY=18-(section.y-(view.bounds?.y||0))*scale;transform();if(section.schedule)scheduleDetail(section.schedule);else{details.innerHTML='<h2>'+safe(section.label)+'</h2>';details.scrollTop=0}rememberView()}
  function focusSchedule(id){if(id)focusSection(view.sections.find(section=>section.schedule===id))}
  function relationshipValue(value){return value===null?'无':typeof value==='boolean'?(value?'是':'否'):typeof value==='object'?JSON.stringify(value):String(value)}
  function edgeEndpoint(id,schedule){const entry=schedule?view.scheduleGroups.find(group=>group.id===id):DATA.registry[id];return'<button class="data-link" '+(schedule?'data-schedule':'data-open')+'="'+safe(id)+'">'+safe(entry?.name||entry?.label||id)+'</button>'}
  function showEdgeDetail(link,schedule){
    const record=DATA.registry[link.id]||{},style=DATA.styles.edges[link.edgeSemantic],properties={...record,...link};
    details.innerHTML='<span class="badge">'+safe(style?.label||link.edgeSemantic||link.kind)+'</span><h2>'+safe(record.name||link.displayLabel||style?.label||'关系')+'</h2><p>来源：'+edgeEndpoint(link.from,schedule)+'</p><p>目标：'+edgeEndpoint(link.to,schedule)+'</p>'+(link.eventId?'<h3>触发事件</h3><p>'+edgeEndpoint(link.eventId,false)+'</p>':'')+(link.label?'<h3>完整契约与约束</h3><p>'+safe(link.label)+'</p>':'')+((link.description||record.description)?'<p>'+safe(link.description||record.description)+'</p>':'')+['cardinality','reverse','linked_spawn'].filter(key=>Object.hasOwn(properties,key)).map(key=>'<h3>'+({cardinality:'数量约束',reverse:'反向关系',linked_spawn:'连带生命周期'}[key])+'</h3><p>'+safe(relationshipValue(properties[key]))+'</p>').join('')+list('约束与说明',[...(link.notes||record.notes||[]),...(link.sourceGaps||record.sourceGaps||[])])+sourcesList(link.sourceEntries||record.sourceEntries)+'<button class="reset" id="clear-selection">清除选择</button>';
    sourceEditor.refreshLinks(details);details.scrollTop=0;
  }
  function paintEdge(id,schedule=false){if(!view||interactionPaused())return;const link=(schedule?view.scheduleLinks:view.links).find(candidate=>candidate.id===id);if(!link)return;clearedSearchQuery=null;activeSelection={kind:'edge',id,schedule};const endpoints=new Set([link.displayFrom||link.from,link.displayTo||link.to]);interaction.paint({selectedNodes:schedule?new Set():endpoints,dimNodes:new Set(view.nodes.filter(node=>!endpoints.has(node.id)).map(node=>node.id)),selectedSchedules:schedule?endpoints:new Set(),focusedEdges:new Set([id]),dimEdges:new Set([...view.links,...view.scheduleLinks].filter(edge=>edge.id!==id).map(edge=>edge.id))});showEdgeDetail(link,schedule);rememberView()}
  function openOwner(feature){const id=ownerObject(feature);if(objectView(id))openObject(id);else navigate({schedule:selection.schedule,node:null})}
  function openObject(id){id=canonical(id);const target=objectView(id);if(!target){if(DATA.objectAliases?.[id]?.length){navigate({...selection,object:id,node:null});return}openOwner(DATA.registry[id]?.feature,id);return}if(view?.id===target.id&&!interactionPaused()){pluginView(target)?select(null):focusNode(target.centerNodeId||id);return}navigate({...selection,object:id,node:pluginView(target)?null:target.centerNodeId||id})}
  function openNode(id){id=canonical(id);if(objectView(id)){openObject(id);return}if(view.nodes.some(node=>node.id===id))focusNode(id);else openOwner(DATA.registry[id]?.feature,id)}
  function normalizeSelection(loaded=null){
    aliasCandidates=[];
    if(selection.scheduleNode&&!scheduleBinding(selection.scheduleNode,selection.schedule)){selection={...selection};delete selection.scheduleNode}
    const feature=selection.legacyFeature;delete selection.legacyFeature;delete selection.legacyAspect;
    if(!selection.object&&selection.node&&(objectView(selection.node)||DATA.objectAliases?.[selection.node]))selection.object=canonical(selection.node);
    if(selection.object){
      const requested=canonical(selection.object),aliases=DATA.objectAliases?.[requested]||[];
      const ref=objectView(requested)||aliases.length===1&&objectView(aliases[0]),target=loaded?.id===ref?.id?loaded:ref;
      if(target){
        const selected=canonical(selection.node),nodeAliases=(DATA.objectAliases?.[selected]||[]).filter(id=>objectView(id));
        aliasCandidates=nodeAliases.length>1?nodeAliases:[];
        const node=nodeAliases.length===1?nodeAliases[0]:selected;
        selection={...selection,object:target.objectId,node:aliasCandidates.length?selected:(target.nodes?target.nodes.some(candidate=>candidate.id===node):Boolean(DATA.registry[node]))?node:pluginView(target)?null:target.centerNodeId||target.objectId};updateUrl();return;
      }
      aliasCandidates=aliases.filter(id=>objectView(id));
      if(aliasCandidates.length){selection={...selection,node:null};updateUrl();return}
      delete selection.object;
    }
    const plugin=ownerObject(feature);
    if(feature&&feature!=='overview'&&objectView(plugin)){selection={...selection,object:plugin,node:null};updateUrl();return}
    selection={...selection,node:null};
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
  function bindScheduleObjects(){
    const bindings=[...(scheduleBindings.get(view.id)?.values()||[])],byGraphName=new Map(bindings.map(binding=>[binding.kind+'|'+binding.graphName,binding])),titles=[];
    for(const element of diagram.querySelectorAll('g')){
      if(element.classList.contains('schedule-cluster-title')){titles.push(element);continue}
      const classes=element.classList,title=[...element.children].find(child=>child.tagName.toLowerCase()==='title')?.textContent;
      const set=classes.contains('cluster'),name=set?title:classes.contains('node')?title:null;
      if(!name)continue;
      const binding=set?byGraphName.get('set|'+name):byGraphName.get('system|'+name)||byGraphName.get('context|'+name);
      if(!binding||!DATA.registry[binding.objectId]||!objectView(binding.objectId))continue;
      element.setAttribute('data-schedule-node',binding.id);element.setAttribute('role','button');element.setAttribute('tabindex','0');element.setAttribute('aria-label',DATA.registry[binding.objectId].name+' · 查看说明');
      if(!scheduleElements.has(binding.id))scheduleElements.set(binding.id,[]);scheduleElements.get(binding.id).push(element);
    }
    for(const element of titles){const binding=byGraphName.get('set|'+element.dataset.clusterName),owner=binding&&scheduleElements.get(binding.id)?.[0];if(!owner||!owner.getAttribute('id')||element.dataset.clusterId!==owner.getAttribute('id'))continue;element.setAttribute('data-schedule-node',binding.id);element.setAttribute('data-schedule-title',binding.id);element.setAttribute('aria-hidden','true');scheduleElements.get(binding.id).push(element)}
  }
  function renderDiagram(){const focused=document.activeElement?.closest('[data-schedule-node]')?.dataset.scheduleNode;gestures.reset();interaction.paint({nativeOnly:!renderedObject});scheduleElements.clear();diagram.innerHTML=view.svg||'';renderedObject=view.aspect==='object';if(renderedObject)bindEdgeLabels();else bindScheduleObjects();if(focused)(scheduleElements.get(focused)?.[0]||canvas).focus({preventScroll:true});canvas.querySelector('.empty-state')?.remove();if(!view.svg){const empty=document.createElement('div');empty.className='empty-state';empty.innerHTML='<h3>'+(view.aspect==='schedule'?'当前筛选没有匹配系统':'当前视图没有相关节点')+'</h3>';canvas.appendChild(empty)}document.getElementById('section').hidden=view.aspect==='schedule'||['Plugin','PluginGroup'].includes(DATA.registry[view.objectId]?.kind);document.getElementById('section').innerHTML='<option value="">定位分组</option>'+(view.sections||[]).map((section,index)=>'<option value="'+index+'">'+safe(section.label)+'</option>').join('')}
  function closeResults(){results.hidden=true;document.getElementById('search').setAttribute('aria-expanded','false');resultIndex=-1}
  function positionPopup(element,anchor){
    if(element.hidden)return;
    const rect=anchor.getBoundingClientRect(),width=Math.min(480,Math.max(0,window.innerWidth-24));
    const left=Math.max(12,Math.min(rect.left,window.innerWidth-width-12)),top=Math.max(12,Math.min(rect.top+rect.height+8,window.innerHeight-12));
    element.style.width=width+'px';element.style.left=left+'px';element.style.top=top+'px';element.style.maxHeight=Math.max(0,Math.min(window.innerHeight*.65,window.innerHeight-top-12))+'px';
  }
  function positionResults(){positionPopup(results,document.getElementById('search'))}
  function closeFilterMenu(restoreFocus=false){if(!openFilter)return;const side=openFilter;document.getElementById('schedule-'+side+'-menu').hidden=true;document.getElementById('schedule-'+side).setAttribute('aria-expanded','false');openFilter=null;if(restoreFocus)document.getElementById('schedule-'+side).focus()}
  function filterOptions(side){
    const target=scheduleViews.find(view=>view.id===selection.schedule),groups=new Map((target?.schedulePluginGroups||[]).map(group=>[group.id,group.systemCount??new Set(group.systemNames).size])),options=new Map();
    for(const plugin of DATA.schedulePluginCatalog||[])options.set(plugin.id,{id:plugin.id,label:plugin.label,description:plugin.description||'',systemCount:groups.get(plugin.id)||0,current:Boolean(groups.get(plugin.id))});
    for(const id of [...(filterLegacy[side+'Plugins']||[]),...filterState[side+'Plugins']])if(!options.has(id))options.set(id,{id,label:id,description:'已保存的未知 Plugin 分组',systemCount:0,current:false});
    const query=document.getElementById('schedule-'+side+'-search').value.trim().toLowerCase();
    return [...options.values()].filter(option=>(option.label+' '+option.description+' '+option.id).toLowerCase().includes(query)).sort((a,b)=>Number(b.current)-Number(a.current)||a.label.localeCompare(b.label)||a.id.localeCompare(b.id));
  }
  function updateFilterSummary(){for(const side of ['include','exclude']){const count=filterState[side+'Plugins'].length+filterState[side+'Names'].length+Number(Boolean(filterState[side]));document.getElementById('schedule-'+side).textContent=(side==='include'?'包含 Plugin':'排除 Plugin')+' · '+(count?'已选 '+count:side==='include'?'全部':'无')}}
  function renderFilterOptions(side){
    const target=document.getElementById('schedule-'+side+'-options'),label=side==='include'?'包含':'排除',legacy=filterLegacy[side],query=document.getElementById('schedule-'+side+'-search').value.trim().toLowerCase();
    target.innerHTML=filterOptions(side).map(option=>'<label class="filter-choice" title="'+safe(option.label+' · '+option.description)+'"><input type="checkbox" data-filter-choice="'+side+'" value="'+safe(option.id)+'" aria-label="'+label+' Plugin '+safe(option.label)+'"><span class="filter-option-text"><span class="filter-option-name">'+safe(option.label)+'</span><small>'+safe(option.description)+'</small><small>'+option.systemCount+' 个系统</small>'+(!option.current?'<small class="filter-missing">不在当前 Schedule</small>':'')+'</span></label>').join('')+(filterLegacy[side+'Names']||[]).filter(name=>('已保存的系统条件 '+name).toLowerCase().includes(query)).map(name=>'<label class="filter-choice" title="'+safe(name)+'"><input type="checkbox" data-filter-system="'+side+'" value="'+safe(name)+'" aria-label="'+label+'：已保存的系统条件 '+safe(name)+'"><span class="filter-option-text"><span class="filter-option-name">已保存的系统条件</span><small>'+safe(name)+'</small></span></label>').join('')+(legacy&&('已保存的旧条件 '+legacy).toLowerCase().includes(query)?'<label class="filter-choice" title="'+safe(legacy)+'"><input type="checkbox" data-filter-legacy="'+side+'" aria-label="'+label+'：已保存的旧条件 '+safe(legacy)+'"><span class="filter-option-text"><span class="filter-option-name">已保存的旧条件</span><small>'+safe(legacy)+'</small></span></label>':'');
    syncFilterChoices(side);
    if(!target.children.length)target.innerHTML='<p class="filter-empty">没有匹配选项</p>';
  }
  function syncFilterChoices(onlySide){
    for(const side of onlySide?[onlySide]:['include','exclude']){
      const target=document.getElementById('schedule-'+side+'-options'),plugins=new Set(filterState[side+'Plugins']),systems=new Set(filterState[side+'Names']);
      for(const input of target.querySelectorAll('[data-filter-choice]'))input.checked=plugins.has(input.value);
      for(const input of target.querySelectorAll('[data-filter-system]'))input.checked=systems.has(input.value);
      for(const input of target.querySelectorAll('[data-filter-legacy]'))input.checked=Boolean(filterState[side]);
    }
  }
  function openFilterMenu(side){if(openFilter===side){closeFilterMenu();return}closeFilterMenu();closeResults();openFilter=side;const menu=document.getElementById('schedule-'+side+'-menu');menu.hidden=false;document.getElementById('schedule-'+side).setAttribute('aria-expanded','true');renderFilterOptions(side);positionPopup(menu,document.getElementById('schedule-'+side));document.getElementById('schedule-'+side+'-search').focus()}
  function showResults(title,ids,alias=false){closeFilterMenu();results.innerHTML='<h2>'+safe(title)+'</h2>'+(alias?'<p>此旧入口包含多个投影或注册，请选择对应对象。</p>':'')+objectResults(ids);results.hidden=false;positionResults();document.getElementById('search').setAttribute('aria-expanded','true');resultIndex=-1}
  function syncPicker(target){const current=document.getElementById('current-object-option');current.innerHTML='';if(![...picker.querySelectorAll('option')].some(option=>option.value===target.id))current.innerHTML='<option value="'+safe(target.id)+'">'+safe(DATA.registry[target.objectId]?.name||target.label)+' · '+safe(target.objectId||'')+'</option>';picker.value=target.id}
  function status(message,error=false){const element=document.getElementById('schedule-status');element.textContent=message;element.hidden=!message;element.classList.toggle('error',error)}
  const restoresViewport=(snapshot,target,key)=>snapshot?.id===target.id&&(target.aspect!=='schedule'||snapshot.filterKey===key);
  function prepareView(target){
    if(document.activeElement?.closest('#object-results'))canvas.focus({preventScroll:true});
    const object=target.aspect==='object';
    workspace.classList.toggle('schedule',!object);detailVisibility(true);document.getElementById('schedule-filter').hidden=object;
    document.getElementById('return-context').hidden=!object&&!aliasCandidates.length;document.getElementById('return-overview').disabled=!object;document.getElementById('search').value='';closeResults();syncPicker(target);canvasSize=measureCanvas();
  }
  function restoreSearch(query,cleared=false){if(query!==null){document.getElementById('search').value=query;search(query,{highlight:!cleared})}if(aliasCandidates.length)showResults('选择原对象',aliasCandidates,true)}
  function applyView(target,snapshot,request,key=null,query=null,searchCleared=false){
    view=target;displayedScheduleKey=null;activeSelection={kind:'none'};clearedSearchQuery=null;selectedScheduleId=null;const object=view.aspect==='object';
    prepareView(view);renderDiagram();if(!object)selectSchedule(selection.scheduleNode,{remember:false,preserveCenter:false});guide();restoreSearch(query,searchCleared);const rendered=view,center=view.centerNodeId||view.objectId;
    requestAnimationFrame(()=>{if(request!==renderRequest||view!==rendered)return;if(restoresViewport(snapshot,view,key)){scale=snapshot.scale;panX=snapshot.panX;panY=snapshot.panY;transform();if(query===null){if(snapshot.active?.kind==='edge')paintEdge(snapshot.active.id,snapshot.active.schedule);else if(snapshot.active?.kind==='node')select(snapshot.active.id)}}else{fit();const id=selection.node||(object&&!pluginView(view)?center:null);if(id&&!aliasCandidates.length&&query===null)select(id)}displayedScheduleKey=object?null:key;rememberView()});
  }
  function presentSchedule(target,snapshot,request,key){
    view=target;displayedScheduleKey=null;renderDiagram();selectSchedule(selection.scheduleNode,{remember:false,preserveCenter:false});canvasSize=measureCanvas();
    requestAnimationFrame(()=>{if(request!==renderRequest||view!==target)return;if(restoresViewport(snapshot,target,key)){scale=snapshot.scale;panX=snapshot.panX;panY=snapshot.panY;transform()}else fit();displayedScheduleKey=key;rememberView()});
  }
  function renderSchedule(target,snapshot,request,preserveUi=false,query=null,searchCleared=false){
    scheduleRenderer?.cancel?.();canvas.setAttribute('aria-busy','false');
    const include=selection.scheduleInclude||'',exclude=selection.scheduleExclude||'',includeNames=[...(selection.scheduleIncludeSystems||[])],excludeNames=[...(selection.scheduleExcludeSystems||[])],includePlugins=[...(selection.scheduleIncludePlugins||[])],excludePlugins=[...(selection.scheduleExcludePlugins||[])];
    const key=scheduleKey();
    if(!include&&!exclude&&!includeNames.length&&!excludeNames.length&&!includePlugins.length&&!excludePlugins.length){status('');preserveUi?presentSchedule(target,snapshot,request,key):applyView(target,snapshot,request,key,query,searchCleared);pendingRender=Promise.resolve();return pendingRender}
    if(view?.id!==target.id||view.aspect!=='schedule')applyView(target,null,request,scheduleKey({schedule:target.id}),query,searchCleared);
    else if(!preserveUi){activeSelection={kind:'none'};clearedSearchQuery=null;prepareView(target);guide();restoreSearch(query,searchCleared);rememberView()}
    status('正在生成筛选图，保留上次图…');canvas.setAttribute('aria-busy','true');
    // 旧请求即使晚于新导航完成，也不能覆盖图、错误状态或历史视口。
    pendingRender=Promise.resolve().then(()=>{if(request!==renderRequest)return null;if(!scheduleRenderer)throw new Error('Schedule filtering is unavailable');return scheduleRenderer.render(target,{includePlugins,excludePlugins,includeNames,excludeNames,include,exclude})}).then(rendered=>{
      if(request!==renderRequest||!rendered)return;canvas.setAttribute('aria-busy','false');presentSchedule({...target,...rendered},snapshot,request,key);status('显示 '+rendered.systemCount+' / '+(rendered.totalSystemCount??target.systemCount)+' 个系统');
    }).catch(error=>{if(request!==renderRequest)return;canvas.setAttribute('aria-busy','false');status('筛选图生成失败，保留上次图：'+error.message,true)});
    return pendingRender;
  }
  function selectionFilters(){
    const include=selection.scheduleInclude||'',exclude=selection.scheduleExclude||'',includeNames=[...(selection.scheduleIncludeSystems||[])],excludeNames=[...(selection.scheduleExcludeSystems||[])],includePlugins=[...(selection.scheduleIncludePlugins||[])],excludePlugins=[...(selection.scheduleExcludePlugins||[])];
    filterState={include,exclude,includeNames,excludeNames,includePlugins,excludePlugins};filterLegacy={include,exclude,includeNames:[...includeNames],excludeNames:[...excludeNames],includePlugins:[...includePlugins],excludePlugins:[...excludePlugins]};closeFilterMenu();for(const side of ['include','exclude'])document.getElementById('schedule-'+side+'-search').value='';updateFilterSummary();
  }
  function renderLoadedSelection(restore=false,restored=null,loaded=null,requestId=null,preserveUi=false){
    normalizeSelection(loaded);const target=loaded||objectView(selection.object)||scheduleViews.find(candidate=>candidate.id===selection.schedule)||scheduleViews[0]||objectViews[0],request=requestId??++renderRequest,snapshot=restore?(restored?restored.view:history.state?.architectureView):null,query=restore?(restored?restored.search:history.state?.architectureSearch??(snapshot?.active?.kind==='search'?snapshot.active.query:null)):null,searchCleared=restore&&(restored?restored.searchCleared:history.state?.architectureSearchCleared)===true;
    desiredViewId=target.id;
    if(restore&&target.aspect==='object'&&snapshot?.id===target.id&&snapshot.active?.kind==='none'){selection={...selection,node:null};updateUrl()}
    if(!loadView)selectionFilters();
    if(target.aspect==='schedule')return renderSchedule(target,snapshot,request,preserveUi,query,searchCleared);
    scheduleRenderer?.cancel?.();canvas.setAttribute('aria-busy','false');status('');applyView(target,snapshot,request,null,query,searchCleared);pendingRender=Promise.resolve();return pendingRender;
  }
  function renderSelection(restore=false,restored=null,preserveUi=false){
    if(!loadView)return renderLoadedSelection(restore,restored);
    normalizeSelection();const ref=objectView(selection.object)||scheduleViews.find(candidate=>candidate.id===selection.schedule)||scheduleViews[0]||objectViews[0],request=++renderRequest;
    const restoration=restore?(restored||{view:history.state?.architectureView||null,search:history.state?.architectureSearch??null,searchCleared:history.state?.architectureSearchCleared===true}):null;
    const revision=searchRevision,previous=lastSuccessful;loadAbort?.abort();scheduleRenderer?.cancel?.();const controller=new AbortController();loadAbort=controller;desiredViewId=ref.id;viewLoading={id:ref.id,request};retryTarget=null;
    if(!preserveUi)selectionFilters();canvas.setAttribute('aria-busy','true');status('正在加载 '+ref.label+'…');syncPicker(ref);
    const task=Promise.resolve().then(()=>request===renderRequest?loadView(ref,{signal:controller.signal}):null).then(loaded=>{
      if(!loaded||request!==renderRequest||pageSuspended)return;
      viewLoading=null;loadAbort=null;pinView?.(loaded.id);canvas.setAttribute('aria-busy','false');
      const state=searchRevision!==revision?{view:restoration?.view||null,search:document.getElementById('search').value||null,searchCleared:clearedSearchQuery!==null}:restoration;
      return renderLoadedSelection(Boolean(state),state,loaded,request,preserveUi);
    }).catch(error=>{
      if(request!==renderRequest||pageSuspended)return;
      retryTarget={selection:{...selection},objectOrigin,restoration,preserveUi};viewLoading=null;loadAbort=null;canvas.setAttribute('aria-busy','false');
      if(previous){selection={...previous.selection};objectOrigin=previous.objectOrigin;desiredViewId=previous.view.id;try{history.replaceState(previous.state,'',previous.href)}catch{}selectionFilters();syncPicker(previous.view);rememberView()}
      status('图形加载失败，已保留上一张图：'+error.message,true);const retry=document.createElement('button');retry.id='retry-view';retry.type='button';retry.textContent='重试';retry.onclick=()=>{const failed=retryTarget;if(!failed)return;selection={...failed.selection};objectOrigin=failed.objectOrigin;try{history.replaceState({...history.state,architectureObjectOrigin:objectOrigin,architectureView:failed.restoration?.view||null,architectureSearch:failed.restoration?.search||null,architectureSearchCleared:failed.restoration?.searchCleared===true},'',navigation.url(selection,location.href))}catch{}renderSelection(Boolean(failed.restoration),failed.restoration,failed.preserveUi)};document.getElementById('schedule-status').appendChild(retry);
    });
    pendingRender=task;return task;
  }
  function changeFilters(){
    syncFilterChoices();updateFilterSummary();if((objectView(selection.object)||scheduleViews.find(candidate=>candidate.id===selection.schedule))?.aspect!=='schedule')return;
    const next={schedule:selection.schedule,node:null,...(selection.scheduleNode?{scheduleNode:selection.scheduleNode}:{}),...liveFilterSelection()};
    if(scheduleKey(next)===scheduleKey())return;
    rememberView();const href=navigation.url(next,location.href);selection=navigation.resolve(new URL(href).search);objectOrigin=null;aliasCandidates=[];document.getElementById('return-context').hidden=true;
    try{history.pushState({...history.state,architectureView:null,architectureSearch:searchQuery(),architectureSearchCleared:clearedSearchQuery!==null,architectureObjectOrigin:null},'',href)}catch{/* 本地页面禁用历史时仍即时筛选。 */}
    if(loadView)return renderSelection(false,null,true);
    return renderSchedule(scheduleViews.find(candidate=>candidate.id===selection.schedule),null,++renderRequest,true);
  }
  function activateEdge(element){paintEdge(element.dataset.scheduleLinkId||element.dataset.linkId,element.dataset.scheduleLinkId!==undefined)}
  function diagramTarget(target){if(view.aspect!=='object')return null;for(let item=target;item&&item!==diagram;item=item.parentElement)if(item.dataset.id!==undefined||item.dataset.linkId!==undefined||item.dataset.scheduleLinkId!==undefined)return item;return null}
  function activateNode(element){select(element?.dataset.id||null)}
  function activateDiagram(target){
    if(interactionPaused()||target?.closest('#diagram')!==diagram)return false;
    if(view.aspect==='schedule'){const element=target.closest('[data-schedule-node]');if(!element||!scheduleElements.get(element.dataset.scheduleNode)?.includes(element))return false;for(let item=target;item!==element;item=item.parentElement)if(['node','cluster','edge','schedule-cluster-title'].some(name=>item.classList.contains(name)))return false;if(element.dataset.scheduleTitle!==undefined)scheduleElements.get(element.dataset.scheduleNode)[0].focus({preventScroll:true});selectSchedule(element.dataset.scheduleNode);return true}
    const element=diagramTarget(target);if(!element)return false;element.dataset.linkId!==undefined||element.dataset.scheduleLinkId!==undefined?activateEdge(element):activateNode(element);return true;
  }
  function clearCanvasSelection(){
    const selected=view.aspect==='schedule'?selectedScheduleId||selection.scheduleNode||selection.node:selection.node;
    if(!selected&&activeSelection.kind==='none')return;
    const query=document.getElementById('search').value;clearedSearchQuery=query.trim()?query:searchQuery();activeSelection={kind:'none'};select(null);
  }
  function activateCanvas(x,y){
    if(interactionPaused())return;
    const target=document.elementFromPoint(x,y);if(target?.closest('#canvas')!==canvas)return;
    for(let item=target;item!==canvas;item=item.parentElement){const tag=item.tagName.toLowerCase();if(['button','input','select','textarea','option','summary'].includes(tag)||tag==='a'&&item.closest('foreignObject'))return}
    if(activateDiagram(target))return;
    for(let item=target;item!==canvas;item=item.parentElement)if(['node','cluster','edge','edgeLabel','edgeLabels','schedule-cluster-title','label'].some(name=>item.classList.contains(name)))return;
    const svg=diagram.querySelector('svg'),graph=target.parentElement,tag=target.tagName.toLowerCase(),rootGraph=graph?.classList.contains('graph')&&graph.parentElement===svg;
    if(target===canvas||target===diagram||target===svg||tag==='g'&&target.classList.contains('graph')&&target.parentElement===svg||tag==='polygon'&&rootGraph&&[...graph.children].find(child=>child.tagName.toLowerCase()==='polygon')===target)clearCanvasSelection();
  }
  document.addEventListener('click',event=>{
    if(!event.target.closest('.object-search')&&!event.target.closest('#return-context'))closeResults();
    // 全部清空仍属于筛选操作，保留正在使用的下拉。
    if(!event.target.closest('.schedule-multiselect')&&!event.target.closest('#schedule-clear'))closeFilterMenu();
    const clear=event.target.closest('#clear-selection');if(clear){select(null);return}
    const schedule=event.target.closest('[data-schedule]');if(schedule){focusSchedule(schedule.dataset.schedule);return}
    const owner=event.target.closest('[data-owner]');if(owner){openOwner(owner.dataset.owner,owner.dataset.target);return}
    const object=event.target.closest('[data-object]');if(object){openObject(object.dataset.object);return}
    const open=event.target.closest('[data-open]');if(open)openNode(open.dataset.open);
  });
  function zoom(factor,x=canvas.clientWidth/2,y=canvas.clientHeight/2){if(!view?.svg)return;const previous=scale;scale=clampScale(scale*factor);panX=x-(x-panX)*scale/previous;panY=y-(y-panY)*scale/previous;transform();rememberView()}
  document.getElementById('return-context').onclick=()=>{const origin=objectOrigin;navigate(origin?.selection||{schedule:selection.schedule,node:null},origin?.parent||null,origin?{view:origin.view||null,search:origin.search||null,searchCleared:origin.searchCleared===true}:null)};
  document.getElementById('return-overview').onclick=()=>navigate({schedule:selection.schedule,node:null});document.getElementById('fit').onclick=()=>{fit();rememberView()};document.getElementById('readable').onclick=()=>{fit(true);rememberView()};document.getElementById('zoom-in').onclick=()=>zoom(1.2);document.getElementById('zoom-out').onclick=()=>zoom(1/1.2);document.getElementById('section').onchange=event=>{if(event.target.value!=='')focusSection(view.sections[Number(event.target.value)])};
  const gestures=createGestures({canvas,window,hasDiagram:()=>Boolean(view?.svg),clampScale,getViewport:()=>({scale,x:panX,y:panY}),setViewport:next=>{scale=next.scale;panX=next.x;panY=next.y;transform();rememberView()},activate:activateCanvas});
  canvas.addEventListener('wheel',event=>{if(window.innerWidth<=900||!view?.svg)return;event.preventDefault();const rect=canvas.getBoundingClientRect();zoom(event.deltaY<0?1.12:1/1.12,event.clientX-rect.left,event.clientY-rect.top)},{passive:false});
  diagram.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&activateDiagram(event.target))event.preventDefault()});
  function search(query,{highlight=true}={}){searchRevision++;const original=query;query=query.trim().toLowerCase();clearedSearchQuery=null;if(!query){closeResults();if(view?.aspect==='object')select(null);else activeSelection={kind:'none'};rememberView();return}const hits=new Set(objects.map(object=>object.id).filter(id=>JSON.stringify(DATA.registry[id]||{}).toLowerCase().includes(query))),shown=new Set([...hits].filter(id=>(view?.nodes||[]).some(node=>node.id===id)));activeSelection=highlight?{kind:'search',query,hits:[...hits]}:{kind:'none'};if(!highlight)clearedSearchQuery=original;if(view?.aspect==='object'&&!interactionPaused())interaction.paint(highlight?{selectedNodes:shown,dimNodes:new Set(view.nodes.filter(node=>!shown.has(node.id)).map(node=>node.id))}:{});showResults(hits.size+' 个匹配对象',[...hits]);rememberView()}
  const searchInput=document.getElementById('search');
  searchInput.addEventListener('input',event=>search(event.target.value));
  function resultKey(event){const buttons=[...results.querySelectorAll('[data-object]')];if(event.key==='Escape'){event.preventDefault();closeResults();searchInput.focus();return}if(event.key==='ArrowDown'||event.key==='ArrowUp'){if(!buttons.length||results.hidden)return;event.preventDefault();const current=buttons.indexOf(event.target),start=current>=0?current:event.key==='ArrowDown'?-1:0;resultIndex=(start+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons.forEach((button,index)=>button.classList.toggle('active',index===resultIndex));buttons[resultIndex].focus();return}if((event.key==='Enter'||event.key===' ')&&event.target.dataset.object){event.preventDefault();openObject(event.target.dataset.object)}}
  searchInput.addEventListener('keydown',resultKey);results.addEventListener('keydown',resultKey);
  picker.addEventListener('change',event=>{const target=DATA.views.find(view=>view.id===event.target.value);if(!target)return;if(target.aspect==='schedule')navigate({schedule:target.id,node:null});else openObject(target.objectId)});
  for(const side of ['include','exclude']){
    const menu=document.getElementById('schedule-'+side+'-menu');
    document.getElementById('schedule-'+side).onclick=()=>openFilterMenu(side);
    document.getElementById('schedule-'+side+'-search').addEventListener('input',()=>renderFilterOptions(side));
    document.getElementById('schedule-'+side+'-select').onclick=()=>{filterState[side+'Plugins']=[...new Set([...filterState[side+'Plugins'],...filterOptions(side).filter(option=>option.current).map(option=>option.id)])];changeFilters()};
    document.getElementById('schedule-'+side+'-clear').onclick=()=>{filterState[side+'Plugins']=[];filterState[side+'Names']=[];filterState[side]='';changeFilters()};
    menu.addEventListener('change',event=>{const input=event.target;if(input.dataset.filterChoice===side||input.dataset.filterSystem===side){const key=side+(input.dataset.filterChoice===side?'Plugins':'Names'),names=new Set(filterState[key]);input.checked?names.add(input.value):names.delete(input.value);filterState[key]=[...names]}else if(input.dataset.filterLegacy===side)filterState[side]=input.checked?filterLegacy[side]:'';else return;changeFilters()});
  }
  document.getElementById('schedule-filter').addEventListener('keydown',event=>{if(event.key==='Escape'&&openFilter){event.preventDefault();closeFilterMenu(true)}});
  document.addEventListener('focusin',event=>{if(!event.target.closest('.schedule-multiselect')&&!event.target.closest('#schedule-clear'))closeFilterMenu()});
  document.getElementById('schedule-clear').onclick=()=>{filterState={includePlugins:[],excludePlugins:[],includeNames:[],excludeNames:[],include:'',exclude:''};changeFilters()};
  // BFCache 会复用本页实例；中止活动任务，不永久销毁后续筛选所需的 renderer。
  window.addEventListener('pagehide',()=>{pageSuspended=true;renderRequest++;loadAbort?.abort();scheduleRenderer?.cancel?.();canvas.setAttribute('aria-busy','false');status('')});
  window.addEventListener('pageshow',event=>{if(!pageSuspended||!event?.persisted)return;pageSuspended=false;if(loadView&&(viewLoading||view?.id!==desiredViewId||view?.aspect==='schedule'&&displayedScheduleKey!==scheduleKey()))renderSelection(true,null,view?.id===desiredViewId);else if(view?.aspect==='schedule'&&displayedScheduleKey!==scheduleKey())renderSchedule(scheduleViews.find(candidate=>candidate.id===selection.schedule),null,++renderRequest,true)});
  window.addEventListener('popstate',()=>{selection=navigation.resolve(location.search);objectOrigin=history.state?.architectureObjectOrigin||null;renderSelection(true)});canvasSize=measureCanvas();
  window.addEventListener('resize',()=>{splitter.refresh();positionResults();if(openFilter)positionPopup(document.getElementById('schedule-'+openFilter+'-menu'),document.getElementById('schedule-'+openFilter));const next=measureCanvas();
    // 手机地址栏和软键盘只改变高度时，不重置用户缩放或平移。
    if(!(canvasSize.compact&&next.compact&&next.width===canvasSize.width)){gestures.reset();panX+=(next.width-canvasSize.width)/2;panY+=(next.height-canvasSize.height)/2;transform()}
    canvasSize=next;
    rememberView();
  });renderSelection();
  return{navigate,select,openNode,openObject,search,renderSelection,get view(){return view},get selection(){return selection},get ready(){return pendingRender}};
}

export async function startExternalArchitecture(options) {
  const { bootstrap, document, window, location, createNavigation, createViewer, fetch: fetcher = globalThis.fetch, crypto = globalThis.crypto, DOMParser = globalThis.DOMParser } = options;
  const status = document.getElementById('schedule-status');
  status.hidden = false; status.textContent = '正在加载架构数据…';
  if (location.protocol === 'file:') { status.textContent = '请从项目根目录运行 node docs/diagrams/serve.mjs，再打开终端显示的本地地址。'; return null; }
  try {
    if (bootstrap.schemaVersion !== 6) throw new Error('Unsupported architecture bootstrap');
    const request = { baseUrl: location.href, fetch: fetcher, crypto };
    const [data, manifest] = await Promise.all([
      readArchitectureResource({ url: bootstrap.runtimeUrl, sha256: bootstrap.runtimeSha256 }, { ...request, json: true }),
      readArchitectureResource({ url: bootstrap.manifestUrl, sha256: bootstrap.manifestSha256 }, { ...request, json: true }),
    ]);
    if (data.schemaVersion !== 6 || manifest.schemaVersion !== 1 || data.buildId && data.buildId !== bootstrap.buildId || manifest.buildId !== bootstrap.buildId) throw new Error('Architecture build identity mismatch');
    const loader = createArchitectureAssetLoader({ ...request, DOMParser });
    const navigation = createNavigation(data.model.features, data.views.filter(view => view.aspect === 'schedule'));
    const app = createViewer({ ...options, data, navigation, loadView: loader.loadView, pinView: loader.pin });
    window.architectureViewer = app; await app.ready; return app;
  } catch (error) {
    status.hidden = false; status.textContent = '架构数据加载失败：' + error.message;
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试'; retry.onclick = () => { window.architectureReady = startExternalArchitecture(options); }; status.appendChild(retry);
    return null;
  }
}

export function renderArchitectureViewer({ model, registry, views, features, guideSamples, objects = [], objectAliases = {}, sourceRoleLabels = {}, schedulePluginCatalog = [], scheduleInteractions = { schemaVersion: 1, views: [] }, runtimeAssets = { script: '' }, externalBootstrap = null }) {
  const scheduleViews = views.filter(view => view.aspect === 'schedule');
  const objectViews = views.filter(view => view.aspect === 'object');
  const option = (view, label) => `<option value="${escape(view.id)}">${escape(label || view.label)}</option>`;
  const scheduleOptions = [...new Set(scheduleViews.map(view => view.application))].map(application => `<optgroup label="${escape(application)} Schedule">${scheduleViews.filter(view => view.application === application).map(view => option(view, `${view.scheduleLabel} · ${view.systemCount} systems`)).join('')}</optgroup>`).join('');
  const usedPlugins = new Set();
  const pluginOptions = (entries, label) => {
    const options = entries.map(entry => {
      const id = registry[entry.overviewNode]?.alias_of || entry.overviewNode || `plugin-${entry.plugin}`;
      const view = objectViews.find(view => view.objectId === id);
      if (!view || usedPlugins.has(id)) return '';
      usedPlugins.add(id); return option(view, `${entry.label} · ${registry[id].name}`);
    }).join('');
    return options ? `<optgroup label="${escape(label)}">${options}</optgroup>` : '';
  };
  const projectOptions = pluginOptions(features, '项目插件');
  const infrastructureOptions = pluginOptions(INFRASTRUCTURE_FEATURES.flatMap(entry => entry.id === 'egui' ? [entry, { label: entry.label, overviewNode: 'plugin-inspector-1' }] : [entry]), '基础设施插件');
  const filterMenu = side => `<div class="schedule-multiselect"><button id="schedule-${side}" class="filter-toggle" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="schedule-${side}-menu">${side === 'include' ? '包含 Plugin · 全部' : '排除 Plugin · 无'}</button><section id="schedule-${side}-menu" class="filter-menu" role="dialog" aria-label="${side === 'include' ? '包含 Plugin' : '排除 Plugin'}" hidden><input id="schedule-${side}-search" type="search" placeholder="搜索 Plugin 名称或分组说明" aria-label="搜索${side === 'include' ? '包含' : '排除'}选项" autocomplete="off"><div class="filter-actions"><button id="schedule-${side}-select" type="button">全选当前搜索结果</button><button id="schedule-${side}-clear" type="button">清空${side === 'include' ? '包含' : '排除'}</button></div><div id="schedule-${side}-options" class="filter-options"></div></section></div>`;
  const state = JSON.stringify(externalBootstrap || { schemaVersion: 5, model, registry, views, guideSamples, scheduleLegendLabels: SCHEDULE_LEGEND_LABELS, objects, objectAliases, sourceRoleLabels, schedulePluginCatalog, scheduleInteractions, infrastructureFeatures: INFRASTRUCTURE_FEATURES, styles: { nodes: NODE_STYLES, edges: EDGE_STYLES, selection: SELECTION_STYLE, externalReference: EXTERNAL_REFERENCE_STYLE } }).replace(/</g, '\\u003c');
  const editor = sourceEditorAssets(), navigation = architectureNavigationAssets(features, scheduleViews), splitter = architectureSplitterAssets(), interaction = architectureInteractionAssets(), gestures = architectureGestureAssets();
  const navigationScript = externalBootstrap ? `const architectureNavigationFactory=(()=>{const infrastructureIds=${JSON.stringify(INFRASTRUCTURE_FEATURES.map(feature => feature.id))};\n${[defaultArchitectureSchedule,resolveArchitectureSelection,architectureUrl,createArchitectureNavigation].map(fn=>fn.toString()).join('\n')}\nreturn createArchitectureNavigation;})();` : navigation.script;
  const dependencies = 'document,location,history,window,requestAnimationFrame,sourceEditor,createSplitter:createArchitectureSplitter,createInteraction:createArchitectureInteraction,createGestures:createArchitectureGestures,createScheduleRenderer:window.createScheduleRenderer';
  const startup = externalBootstrap ? `${assetLoaderAssets().script}\n${startExternalArchitecture.toString()}\nwindow.architectureReady=startExternalArchitecture({bootstrap:JSON.parse(document.getElementById("architecture-data").textContent),${dependencies},createNavigation:architectureNavigationFactory,createViewer:(${createArchitectureViewer.toString()})});` : `const architectureViewer=(${createArchitectureViewer.toString()})({data:JSON.parse(document.getElementById("architecture-data").textContent),${dependencies},navigation:architectureNavigation});`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Crect width='10' height='10' rx='2' fill='%232563EB'/%3E%3C/svg%3E"><title>demo · ECS 架构</title><style>
${architectureShellStyle}
${editor.style}
</style></head><body><header><span class="brand">DEMO</span><select id="view-select" class="view-picker" aria-label="选择架构图">${scheduleOptions}${projectOptions}${infrastructureOptions}<optgroup id="current-object-option" label="当前对象"></optgroup></select><div class="object-search"><input id="search" type="search" placeholder="搜索全部对象" aria-label="搜索全部架构对象" aria-controls="object-results" aria-expanded="false" autocomplete="off"><section id="object-results" class="object-results" aria-label="对象搜索结果" hidden></section></div><div class="tools"><button id="return-context" hidden>返回原视图</button><button id="return-overview">返回调度图</button><select id="section" aria-label="定位图内分组"><option value="">定位分组</option></select><button id="zoom-out" aria-label="缩小">−</button><span id="zoom-label">100%</span><button id="zoom-in" aria-label="放大">＋</button><button id="readable">阅读大小</button><button id="fit">适合窗口</button><button type="button" data-workspace-config>配置工作区</button></div></header><main class="main"><section id="schedule-filter" class="schedule-filter" role="group" aria-label="筛选 Schedule">${filterMenu('include')}${filterMenu('exclude')}<button type="button" id="schedule-clear">清空</button></section><div id="schedule-status" class="schedule-status" role="status" aria-live="polite" hidden></div><section id="workspace" class="workspace"><section class="canvas-wrap"><div id="canvas" class="canvas" tabindex="-1" role="region" aria-label="架构图画布"><div id="diagram" class="diagram"></div></div></section><div id="details-resizer" class="details-resizer" tabindex="0" role="separator" aria-orientation="vertical" aria-label="调整详情宽度" aria-controls="details"></div><aside id="details" class="side" aria-live="polite"></aside></section></main>${editor.markup}<script id="architecture-data" type="application/json">${state}</script><script>${editor.script}</script><script>${navigationScript}</script><script>${splitter.script}</script><script>${interaction.script}</script><script>${gestures.script}</script><script>${runtimeAssets.script}</script><script>${startup}</script></body></html>`;
}
