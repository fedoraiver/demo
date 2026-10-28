// 调度名称只用于定位锁定源码；参数声明与操作证据分别保存，不从 DOT 推断数据访问。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { maskRustSource } from './architecture-components.mjs';
import { REVIEWED_SCHEDULE_SETS } from '../catalog/schedule-source-set-mappings.mjs';
import { TYPE_PACKAGES } from './architecture-source-evidence.mjs';
import { createScheduleTypePurposeResolver } from './schedule-type-purposes.mjs';
import { reviewedScheduleSystemPurpose, REVIEWED_SCHEDULE_SYSTEM_PURPOSES } from './schedule-system-purposes.mjs';
import { reviewedScheduleSetPurpose } from './schedule-set-purposes.mjs';
import { createScheduleBodyOperationCatalog } from './schedule-body-operations.mjs';

export const SCHEDULE_SOURCE_VERSION = 1;
const unique = values => [...new Set(values)];
const nominal = name => name.replace(/\s+/g, '').split('::').at(-1);
// 常用 prelude 类型由已审阅的包归属定位；仍须在锁定包及实际 cfg 下存在唯一声明。
const REVIEWED_PRELUDE_PACKAGES=Object.freeze({...TYPE_PACKAGES,
  Commands:'bevy_ecs',World:'bevy_ecs',Entity:'bevy_ecs',Name:'bevy_ecs',Children:'bevy_ecs',ChildOf:'bevy_ecs',
  Transform:'bevy_transform',GlobalTransform:'bevy_transform',PrimaryWindow:'bevy_window',Disabled:'bevy_ecs',
  MainWorld:'bevy_extract',MainEntity:'bevy_render',RenderEntity:'bevy_render',Mesh2d:'bevy_mesh',Mesh3d:'bevy_mesh',
  RemovedComponents:'bevy_ecs',
  Node:'bevy_ui',ComputedNode:'bevy_ui',UiGlobalTransform:'bevy_ui',Text:'bevy_ui',AnimationPlayer:'bevy_animation',
  Position:'avian3d',Rotation:'avian3d',LinearVelocity:'avian3d',AngularVelocity:'avian3d',Collider:'avian3d',
});
const TUPLE_IMPLEMENTATIONS=Object.freeze({
  '3ce73d70048cb6765a9fbe549095655d0f03ca99acf159e018d01081a6c49527':'update',
  'ad51a3eae045fee8a6fec43daca3b55d50b24c8c70a0c6345e7989a971336ea3':'trigger',
  'eeddfb107fddbd2edaac07130c942c363eb353716e7535ac1e3b4ec65b4f3213':'apply',
});

export function splitRustArguments(text) {
  const result = []; let start = 0, depth = 0;
  for (let index = 0; index < text.length; index++) {
    if ('<([{'.includes(text[index])) depth++;
    else if ('>)]}'.includes(text[index]) && text[index - 1] !== '-') depth--;
    else if (text[index] === ',' && depth === 0) { result.push(text.slice(start, index).trim()); start = index + 1; }
  }
  return [...result, text.slice(start).trim()].filter(Boolean);
}

function parameterType(text) {
  let depth=0;
  for(let index=0;index<text.length;index++) {
    if('(<[{'.includes(text[index]))depth++;
    else if(')>]}'.includes(text[index])&&text[index-1]!=='-')depth--;
    else if(text[index]===':'&&depth===0&&text[index-1]!==':'&&text[index+1]!==':')return text.slice(index+1).trim();
  }
  return text;
}

function withoutConfigurationTargets(text) {
  const characters=text.split('');
  for(const match of text.matchAll(/\.(?:before|after|in_set|run_if|distributive_run_if|ambiguous_with|ambiguous_with_all)\s*\(/g)) {
    const open=text.indexOf('(',match.index),end=endOf(text,open,'(',')');
    if(end>=0)for(let index=open+1;index<end;index++)if(characters[index]!=='\n')characters[index]=' ';
  }
  return characters.join('');
}

export function stripRustGenerics(text) {
  let depth = 0, result = '';
  for (const char of text) {
    if (char === '<') depth++;
    else if (char === '>') depth--;
    else if (!depth) result += char;
  }
  return result.replace(/::::/g, '::');
}

function endOf(text, start, open = '{', close = '}') {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === open) depth++;
    else if (text[index] === close && --depth === 0) return index;
  }
  return -1;
}

function moduleFor(filename) {
  return filename.replace(/^src\//, '').replace(/(?:^|\/)(?:lib|main|mod)\.rs$/, '').replace(/\.rs$/, '').split('/').filter(Boolean);
}

function sourceAt(file, offset, role, label) {
  return { path: file.path, line: file.text.slice(0, offset).split('\n').length, column: 1,
    ...(file.dependency ? { dependency: file.dependency } : {}), role, label };
}

function importedPaths(text, accept = () => true) {
  const result = new Map(), wildcards = [];
  const walk = (body, prefix = '') => {
    for (const value of splitRustArguments(body)) {
      const open = value.indexOf('{');
      if (open >= 0) { walk(value.slice(open + 1, value.lastIndexOf('}')), prefix + value.slice(0, open).replace(/::$/, '') + '::'); continue; }
      const [original, alias] = value.split(/\s+as\s+/), full = prefix + original.trim();
      if (full.endsWith('::*')) { wildcards.push(full.slice(0, -3)); continue; }
      result.set(alias?.trim() || full.split('::').at(-1), full.replace(/::self$/, ''));
    }
  };
  for (const match of maskRustSource(text).matchAll(/\buse\s+([^;]+);/g)) if(accept(match.index))walk(text.slice(match.index + match[0].indexOf(match[1]), match.index + match[0].length - 1).trim());
  return { names: result, wildcards };
}

const specialDescriptions = {
  apply_deferred: '在调度建立的同步点应用前序系统暂存的 Commands 等延迟操作，使后续系统可以观察到结构变化；此卡片是 ApplyDeferred 的 System 实现。',
  message_update_system: '轮换所有已登记消息缓冲区的当前批次并清理超出保留窗口的消息，保留读者的独立读取游标。',
  signal_message_update_system: '标记消息缓冲在当前固定步中需要更新，使消息轮换与固定步执行协调。',
  time_system: '从渲染侧时间通道或系统时钟获取本帧时刻，更新 Real、Virtual 与当前通用 Time。',
  run_main: '依据 MainScheduleOrder 依次运行主应用调度；首次调用时先执行启动调度。',
  run_fixed_main: '依据 FixedMainScheduleOrder 顺序运行当前固定步的子调度。',
  run_fixed_main_schedule: '累积虚拟时间并按固定时钟步长重复运行 FixedMain，保存剩余 overstep。',
  run_render_schedule: '运行渲染子应用的 Render 调度，交由其原生阶段提交和呈现当前帧。',
  render_system: '执行当前渲染图并向 GPU 提交本帧命令，在表面仍有效时呈现交换链图像。',
  extract_resource: '从主世界读取指定资源，将变化后的值提取到渲染世界；具体资源由本卡片的泛型实参决定。',
  extract_components: '读取主世界中符合提取条件的实体组件，经 ExtractComponent 转换后写入对应渲染实体。',
  extract_all: '通过 ExtractInstance 实现将本帧所有需要的实例数据从主世界提取到渲染世界。',
  prepare_assets: '消费提取后的资产队列，调用 RenderAsset::prepare_asset 创建 GPU 侧资产；未满足依赖的资产留待后续重试。',
  extract_render_asset: '收集新增、修改与移除的源资产，准备可发送到渲染世界的提取结果和删除记录。',
  init_gpu_resource: '通过 FromWorld 构建指定的 GPU 资源，并将初始化结果插入当前世界。',
  asset_events: '将 Assets 中暂存的资产变化发布到对应 AssetEvent 消息缓冲，供独立读者消费。',
  track_assets: '处理资产句柄引用计数与未使用资产，追踪强句柄并安排释放不再被持有的资产。',
  reset_action: '对需要重置的输入动作清空上一阶段的绑定与触发状态，避免输入上下文切换继承旧输入。',
  dispatch_focused_input: '读取对应输入消息并向当前焦点实体派发可冒泡的 FocusedInput；焦点无效时回退到主窗口。',
  update_pending: '整理待处理的输入绑定，更新输入忽略及重置状态，供动作评估阶段使用。',
  apply_extract_commands: '应用提取阶段积累的延迟命令，使渲染世界中同步的实体和组件对后续阶段可见。',
  reset: '清零当前物理诊断类型的计数及耗时采样，准备记录下一次物理步。',
};

const verbs = { init: '初始化', initialize: '初始化', prepare: '准备', extract: '提取', update: '更新', sync: '同步', synchronize: '同步', queue: '排入待处理队列：', write: '写入', upload: '上传', collect: '收集', clear: '清理', cleanup: '清理', reset: '重置', reset_all: '重置', check: '检查', validate: '校验', expire: '移除已过期的', remove: '移除', despawn: '销毁', delete: '删除', mark: '标记', set: '设置', add: '添加', insert: '插入', load: '加载', free: '释放', create: '创建', run: '运行', render: '绘制', draw: '绘制', compute: '计算', calculate: '计算', generate: '生成', build: '构建', sort: '排序', batch: '批处理', specialize: '为当前视图或资产创建专用版本：', apply: '应用', advance: '推进', trigger: '触发', propagate: '传播', track: '追踪', process: '处理', handle: '处理', poll: '接收', receive: '接收', signal: '发送状态信号：', send: '发送', split: '拆分', solve: '求解', optimize: '优化', finish: '完成', complete: '完成', store: '保存', assign: '分配', map: '映射', trim: '裁减', detect: '检测', configure: '配置', position: '定位', begin: '开始', end: '结束', start: '启动', stop: '停止', wake: '唤醒', sleep: '休眠', warn: '报告', assert: '校验', filter: '过滤', allocate: '分配', unload: '卸载', merge: '合并', append: '追加', unpack: '解包', downsample: '降采样', downsampling: '降采样', filtering: '过滤', bloom: '执行 Bloom 泛光', tonemapping: '执行色调映射', fxaa: '执行 FXAA 抗锯齿', smaa: '执行 SMAA 抗锯齿', ssao: '计算屏幕空间环境光遮蔽', ssr: '计算屏幕空间反射', camera: '驱动相机', compensate: '补偿' };
const terms = { meshes: '网格', mesh: '网格', assets: '资产', asset: '资产', material: '材质', materials: '材质', camera: '相机', cameras: '相机', view: '视图', views: '视图', buffer: '缓冲', buffers: '缓冲', pipeline: '管线', pipelines: '管线', bind: '绑定', group: '组', groups: '组', texture: '纹理', textures: '纹理', depth: '深度', light: '光源', lights: '光源', shadow: '阴影', shadows: '阴影', visibility: '可见性', frusta: '视锥', frustum: '视锥', bounds: '包围范围', uniforms: 'Uniform', uniform: 'Uniform', targets: '目标', target: '目标', transform: '变换', transforms: '变换', translation: '位移', rotation: '旋转', scale: '缩放', easing: '平滑插值', interpolation: '插值', extrapolation: '外推', sprites: '精灵', sprite: '精灵', text: '文本', ui: 'UI', uinodes: 'UI 节点', input: '输入', inputs: '输入', events: '事件', event: '事件', motion: '移动', keyboard: '键盘', mouse: '鼠标', gamepad: '手柄', touch: '触摸', window: '窗口', windows: '窗口', cursor: '光标', screenshot: '截图', screenshots: '截图', animation: '动画', animations: '动画', transitions: '过渡', transition: '过渡', joints: '关节', joint: '关节', collider: '碰撞体', collision: '碰撞', collisions: '碰撞', forces: '力', torque: '扭矩', torques: '扭矩', acceleration: '加速度', velocity: '速度', velocities: '速度', position: '位置', bodies: '刚体', body: '刚体', mass: '质量', properties: '属性', constraints: '约束', contact: '接触', contacts: '接触', islands: '物理岛', island: '物理岛', particles: '粒子', global: '全局', local: '局部', previous: '上一帧', current: '当前', removed: '已移除', changed: '已变化', pending: '待处理', empty: '空', unused: '未使用', data: '数据', state: '状态', states: '状态', render: '渲染', rendering: '渲染', extracted: '已提取', scene: '场景', scenes: '场景', instances: '实例', instance: '实例', resources: '资源', resource: '资源', lines: '线', line: '线', gizmo: '调试图元', gizmos: '调试图元', source: '源', sources: '源', caches: '缓存', cache: '缓存', batching: '批处理', batch: '批次', batches: '批次', indirect: '间接绘制', parameters: '参数', parameter: '参数', jobs: '任务', job: '任务', entities: '实体', entity: '实体', component: '组件', components: '组件', draw: '绘制', gpu: 'GPU', cpu: 'CPU', core: '核心', main: '主', early: '早期', late: '后期', pass: '通道', passes: '通道', opaque: '不透明', transparent: '透明', transmissive: '透射', transmission: '透射', prepass: '预通道', deferred: '延迟', fog: '雾', volumetric: '体积', atmosphere: '大气', environment: '环境', map: '映射', maps: '映射', probe: '探针', probes: '探针', cluster: '聚簇', clusters: '聚簇', clustering: '聚簇', count: '计数', frame: '帧', time: '时间', end: '结束', start: '起点', translation: '平移', channel: '声道', channels: '声道', audio: '音频', output: '输出', outputs: '输出', color: '颜色', colors: '颜色', image: '图像', images: '图像', font: '字体', fonts: '字体', focus: '焦点', hover: '悬停', hovered: '悬停', ray: '射线', rays: '射线', shape: '形状', hit: '命中', hits: '命中', range: '范围', ranges: '范围', contents: '内容', content: '内容', layout: '布局', stack: '堆叠', transparency: '透明度', and: '与', for: '用于', to: '到', from: '来源', with: '含', on: '针对', all: '全部', in: '于', if: '条件：', not: '非', needing: '需要', needs: '需要', as: '作为', their: '对应', has: '具有', the: '', system: '', systems: '' };

const specificPurposes = Object.fromEntries([
  'bevy_ecs::message::update::message_update_system','bevy_ecs::message::update::signal_message_update_system',
  'bevy_time::time_system','bevy_app::main_schedule::Main::run_main','bevy_app::main_schedule::FixedMain::run_fixed_main',
  'bevy_time::fixed::run_fixed_main_schedule','bevy_render::run_render_schedule','bevy_render::renderer::render_system',
  'bevy_extract::extract_resource::extract_resource','bevy_extract::extract_component::extract_components','bevy_extract::extract_instances::extract_all',
  'bevy_render::render_asset::prepare_assets','bevy_render::render_asset::extract_render_asset','bevy_render::init_gpu_resource',
  'bevy_asset::assets::Assets::asset_events','bevy_asset::assets::Assets::track_assets','bevy_enhanced_input::context::reset_action',
  'bevy_input_focus::dispatch_focused_input','bevy_enhanced_input::context::input_reader::update_pending','bevy_extract::extract_plugin::apply_extract_commands',
  'avian3d::diagnostics::reset',
].map(name=>[name,specialDescriptions[name.split('::').at(-1)]]));

function describeFunction(declaration, fullName, parameters, strict) {
  const reviewed=reviewedScheduleSystemPurpose(declaration.fullName);
  if (reviewed) return reviewed;
  if (specificPurposes[declaration.fullName]) return {description:specificPurposes[declaration.fullName],summary:specificPurposes[declaration.fullName]};
  if(strict)throw new Error('Schedule system purpose has not been reviewed: '+declaration.fullName);
  const words = declaration.symbol.split('_'), verb = Object.hasOwn(verbs,words[0])?verbs[words[0]]:null;
  const translated = words.slice(verb ? 1 : 0).map(word => Object.hasOwn(terms,word)?terms[word]:word).filter(Boolean).join(' ');
  const action = verb ? verb + translated : '执行 ' + translated;
  const facts=[],body=declaration.body||'';
  if (/\.create_bind_group\s*\(/.test(body)) facts.push('使用渲染设备建立绑定组，把本阶段所需的纹理、采样器或缓冲绑定到着色器接口');
  if (/\.specialize\s*\(/.test(body)) facts.push('按当前配置计算专用管线键，通过管线缓存复用或排队创建对应变体');
  if (/\.queue_(?:render|compute)_pipeline\s*\(/.test(body)) facts.push('把渲染或计算管线描述排入异步编译缓存，保存管线标识供后续阶段取用');
  if (/\.(?:write_buffer|write_buffer_with|write_texture)\s*\(/.test(body)) facts.push('将准备的数据写入 GPU 缓冲或纹理，供随后绘制或计算使用');
  if (/\.begin_(?:tracked_)?render_pass\s*\(/.test(body)) facts.push('创建当前视图的渲染通道，使用已准备的管线及资源记录绘制命令');
  if (/\.dispatch_workgroups(?:_indirect)?\s*\(/.test(body)) facts.push('在计算通道中调度 GPU 工作组，按本阶段任务执行计算着色器');
  if (/\bExtract\s*</.test(declaration.parameters)) facts.push('通过 Extract 参数读取主世界数据，在渲染世界维护本阶段的提取结果');
  if (/\bworld\.(?:init_resource|insert_resource)\s*(?:\(|::)/.test(body)) facts.push('通过 World 初始化或插入所需资源，使后续系统能够获取对应状态');
  if (/\bcommands\.(?:insert_resource|init_resource)\s*(?:\(|::)/.test(body)) facts.push('通过 Commands 排入资源初始化或替换，变化在延迟命令应用时生效');
  if (/\.(?:try_run_schedule|run_schedule)\s*\(/.test(body)) facts.push('调用原生 Schedule 入口推进对应子调度，执行顺序由其调度配置负责');
  const resources=parameters.accesses.filter(access=>access.kind==='Resource'&&access.operation!=='reference'),components=parameters.accesses.filter(access=>access.kind==='Component'&&access.operation!=='filter');
  const names=items=>unique(items.map(access=>access.type)).slice(0,4).join('、');
  if(resources.length)facts.push('资源参数包含 '+names(resources)+'，只读与可变声明分别在 Read／Write 中列出');
  else if(components.length)facts.push('查询涉及 '+names(components)+'，通过声明的查询条件限制实体范围');
  else if(parameters.accesses.some(access=>access.kind==='Local'))facts.push('使用 Local 保留本系统实例自己的跨帧状态，不把该状态当作共享世界资源');
  return {description:action+'。'+facts.slice(0,3).join('；')+(facts.length?'。':''),summary:action+'。',sourceGap:'系统用途尚未审阅；函数名和参数事实仅供合成源码测试定位，不可用于正式产物。'};
}

export function scanScheduleRustFile(text, { filename, crate, dependency } = {}) {
  const code = maskRustSource(text), file = { text, code, path: filename, crate, dependency }, modules = [], impls = [];
  for (const match of code.matchAll(/\bmod\s+([A-Za-z_]\w*)\s*\{/g)) {
    const open = code.indexOf('{', match.index); modules.push({ name: match[1], start: open, end: endOf(code, open) });
  }
  for (const match of code.matchAll(/\bimpl\b[^;{}]*\{/g)) {
    const open = code.indexOf('{', match.index), header = code.slice(match.index + 4, open).trim();
    let body = header;
    if (body.startsWith('<')) body = body.slice(endOf(body, 0, '<', '>') + 1).trim();
    const target = body.split(/\s+where\s/)[0].split(/\s+for\s/).at(-1).trim();
    const type = stripRustGenerics(target).split('::').at(-1);
    if (/^[A-Za-z_]\w*$/.test(type)) impls.push({ name: type, header, start: open, end: endOf(code, open) });
  }
  const prefix = offset => [crate, ...moduleFor(filename), ...modules.filter(module => module.start < offset && module.end > offset).map(module => module.name)];
  const declarations = [];
  for (const match of code.matchAll(/\b(fn|struct|enum|trait|type)\s+([A-Za-z_]\w*)/g)) {
    const enclosing = impls.filter(impl => impl.start < match.index && impl.end > match.index).at(-1);
    const fullName = [...prefix(match.index), ...(['fn','type'].includes(match[1]) && enclosing ? [enclosing.name] : []), match[2]].join('::');
    const entry = { file, kind: match[1], symbol: match[2], fullName, offset: match.index, impl: enclosing };
    const boundary=Math.max(code.lastIndexOf('}',match.index-1),code.lastIndexOf(';',match.index-1));
    entry.attributes=text.slice(boundary+1,match.index);
    entry.isSystemSet=/#\[\s*derive\s*\([^\]]*\bSystemSet\b/.test(code.slice(boundary+1,match.index));
    entry.isSystemParam=/#\[\s*derive\s*\([^\]]*\b(?:SystemParam|QueryData)\b/.test(code.slice(boundary+1,match.index));
    if(match[1]==='enum'||match[1]==='struct'||match[1]==='trait') {
      const open=code.indexOf('{',match.index+match[0].length),semicolon=code.indexOf(';',match.index+match[0].length);
      if(open>=0&&(semicolon<0||open<semicolon)){entry.bodyStart=open;entry.end=endOf(code,open);entry.body=code.slice(open+1,entry.end);}
      const cursor=match.index+match[0].length;
      const rest=code.slice(cursor).trimStart();
      if(rest.startsWith('<'))entry.generic=rest.slice(1,endOf(rest,0,'<','>'));
    }
    if (match[1] === 'fn') {
      let cursor = match.index + match[0].length;
      while (/\s/.test(code[cursor] || '')) cursor++;
      let generic = '';
      if (code[cursor] === '<') { const end = endOf(code, cursor, '<', '>'); generic = code.slice(cursor + 1, end); cursor = end + 1; }
      while (/\s/.test(code[cursor] || '')) cursor++;
      if (code[cursor] !== '(') continue;
      const parameterEnd = endOf(code, cursor, '(', ')');
      const open = code.indexOf('{', parameterEnd), semicolon = code.indexOf(';', parameterEnd);
      if (open < 0 || semicolon >= 0 && semicolon < open) continue;
      entry.signature = text.slice(cursor, parameterEnd + 1);
      entry.parameters = code.slice(cursor + 1, parameterEnd);
      entry.generic = generic; entry.bodyStart = open; entry.end = endOf(code, open);
      entry.body = code.slice(open + 1, entry.end);
      entry.complete = text.slice(match.index, open).trim();
    }
    const before = text.slice(0, match.index).split('\n');
    const docs = [];
    for (let index = before.length - 2; index >= 0; index--) {
      if (/^\s*\/\/\//.test(before[index])) docs.unshift(before[index].replace(/^\s*\/\/\/\s?/, ''));
      else if (!before[index].trim() || /^\s*#\[/.test(before[index])) continue;
      else break;
    }
    entry.docs = docs.join('\n');
    declarations.push(entry);
  }
  file.modules=modules;
  file.functions=declarations.filter(item=>item.kind==='fn');
  Object.defineProperty(declarations,'file',{value:file});
  return declarations;
}

export function createScheduleSourceCatalog({ repository, metadata, resolver, strictPurposes = true, localPurposes, bodyOperations, bodyGaps } = {}) {
  const packages = new Map(), all = new Map(), failures = new Map();
  const typePurposes = createScheduleTypePurposeResolver({ strict: strictPurposes, localPurposes });
  const bodyCatalog = createScheduleBodyOperationCatalog({ repository, metadata, sourceAt,
    resolveDeclaration: name => choose(declarationsFor(name), stripRustGenerics(name)),
    resolveType: resolveBodyOperationType,
    ...(bodyOperations ? {operations:bodyOperations} : {}), ...(bodyGaps ? {gaps:bodyGaps} : {}),
  });
  let setsLoaded=false;
  function load(crate) {
    if (packages.has(crate)) return packages.get(crate);
    const candidates = metadata.packages.filter(pkg => pkg.name.replaceAll('-', '_') === crate);
    if (candidates.length !== 1) throw new Error('Schedule source package is ambiguous: ' + crate);
    const pkg = candidates[0], root = path.dirname(pkg.manifest_path);
    const dependency = pkg.source?.startsWith('registry+') ? { name: pkg.name, version: pkg.version, root: root.replaceAll('\\', '/') } : null;
    const declarations = [];
    const walk = (directory, relative = 'src') => {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filename = relative + '/' + entry.name, absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(absolute, filename);
        else if (entry.isFile() && entry.name.endsWith('.rs')) {const scanned=scanScheduleRustFile(fs.readFileSync(absolute, 'utf8'), { filename, crate, dependency });declarations.push(...scanned);}
      }
    };
    walk(path.join(root, 'src'));
    packages.set(crate, declarations);
    for (const declaration of declarations) {
      if (!all.has(declaration.fullName)) all.set(declaration.fullName, []);
      all.get(declaration.fullName).push(declaration);
    }
    return declarations;
  }
  function declarationsFor(fullName) {
    let stripped = stripRustGenerics(fullName);
    if (fullName.startsWith('<')) {
      const end = endOf(fullName, 0, '<', '>'), head = fullName.slice(1, end).split(' as '), method = fullName.slice(end + 3);
      const trait = stripRustGenerics(head.at(-1)), type = stripRustGenerics(head[0]);
      const crate = trait.split('::')[0]; load(crate);
      const target = trait.split('::').at(-1), functionName = stripRustGenerics(method).split('::').filter(Boolean).at(-1);
      const candidates = [...all.values()].flat().filter(item => item.symbol === functionName && item.kind === 'fn' && (item.impl?.header.includes(target) || item.fullName === trait + '::' + functionName || item.fullName.startsWith(trait.split('::').slice(0,-1).join('::')+'::') && item.file.code.slice(0,item.offset).includes('trait '+target)));
      if (candidates.length) return candidates;
      load(type.split('::')[0]);
      return [...all.values()].flat().filter(item => item.kind === 'fn' && item.symbol === functionName && item.impl?.name === type.split('::').at(-1));
    }
    load(stripped.split('::')[0]);
    return all.get(stripped) || [];
  }
  function choose(declarations, identity) {
    const active=declarations.filter(declaration=>{
      const pkg=metadata.packages.find(pkg=>pkg.name.replaceAll('-','_')===declaration.file.crate),features=new Set(metadata.resolve?.nodes?.find(node=>node.id===pkg?.id)?.features||[]);
      const cfg=value=>{
        const call=/^(all|any|not)\s*\(([\s\S]*)\)$/.exec(value.trim());
        if(call){const children=splitRustArguments(call[2]).map(cfg);return call[1]==='not'?(children[0]===null?null:!children[0]):call[1]==='all'?(children.includes(false)?false:children.includes(null)?null:true):(children.includes(true)?true:children.includes(null)?null:false);}
        const feature=/^feature\s*=\s*"([^"]+)"$/.exec(value.trim());if(feature)return features.has(feature[1]);
        if(value.trim()==='test')return false;
        return null;
      };
      return [...(declaration.attributes||'').matchAll(/#\[\s*cfg\s*\(([\s\S]*?)\)\s*\]/g)].every(match=>cfg(match[1])!==false);
    });
    declarations=active;
    if (declarations.length === 1) return declarations[0];
    // Avian 同文件保留二维与三维定义；这里的锁定包明确为 avian3d。
    if (identity === 'avian3d::physics_transform::position_to_transform') return declarations.find(item => item.file.text.slice(Math.max(0,item.offset-100), item.offset).includes('feature = "3d"'));
    return null;
  }
  function reexportedType(fullName) {
    const symbol=fullName.split('::').at(-1),crate=fullName.split('::')[0], known=REVIEWED_PRELUDE_PACKAGES[symbol];
    if(metadata.packages.some(pkg=>pkg.name.replaceAll('-','_')===crate)){
      load(crate);
      const owner=fullName.split('::').slice(0,-1).join('::');
      // 已知类型后的名称是关联项；derive 未展开的关联类型不能借用同包另一类型的同名声明。
      if((all.get(owner)||[]).some(item=>['struct','enum','trait','type'].includes(item.kind)))return[];
      const claimed=choose(load(crate).filter(item=>item.kind!=='fn'&&item.symbol===symbol&&!/::tests?::/.test(item.fullName)),fullName);
      if(claimed)return[claimed.fullName];
    }
    if(!known)return[];
    const declarations=load(known).filter(item=>item.kind!=='fn'&&item.symbol===symbol&&!/::tests?::/.test(item.fullName));
    const declaration=choose(declarations,fullName);
    return declaration?[declaration.fullName]:[];
  }
  const imports = new WeakMap();
  const inheritedImports=new Map();
  function moduleImports(crate,module,seen=new Set()){
    const key=crate+'::'+module.join('::');if(inheritedImports.has(key))return inheritedImports.get(key);
    if(seen.has(key))return{names:new Map(),wildcards:[]};seen.add(key);
    const files=unique(load(crate).map(d=>d.file)).filter(file=>moduleFor(file.path).join('::')===module.join('::'));
    if(files.length!==1)return{names:new Map(),wildcards:[]};
    const file=files[0],current=importedPaths(file.text,offset=>!(file.functions||[]).some(fn=>fn.bodyStart<offset&&fn.end>offset)&&!(file.modules||[]).some(m=>m.start<offset&&m.end>offset));
    const supers=current.wildcards.filter(w=>/^(?:super::)*super$/.test(w));
    for(const wildcard of supers){const count=wildcard.split('::').length,parent=moduleImports(crate,module.slice(0,-count),new Set(seen));for(const[name,value]of parent.names)if(!current.names.has(name))current.names.set(name,value);current.wildcards.push(...parent.wildcards);}
    inheritedImports.set(key,current);return current;
  }
  function importFor(declaration) {
    const file=declaration.file;
    if(!imports.has(declaration)) {
      const scope=(file.modules||[]).filter(module=>module.start<declaration.offset&&module.end>declaration.offset);
      const visible=offset=>{
        const modules=(file.modules||[]).filter(module=>module.start<offset&&module.end>offset);
        return modules.every((module,index)=>scope[index]===module)&&!(file.functions||[]).some(fn=>fn.bodyStart<offset&&fn.end>offset&&!(fn.bodyStart<declaration.offset&&fn.end>declaration.offset));
      };
      const current=importedPaths(file.text,visible),module=declaration.fullName.split('::').slice(1,declaration.impl?-2:-1);
      for(const wildcard of current.wildcards.filter(w=>/^(?:super::)*super$/.test(w))){const parent=moduleImports(file.crate,module.slice(0,-wildcard.split('::').length));for(const[name,value]of parent.names)if(!current.names.has(name))current.names.set(name,value);current.wildcards.push(...parent.wildcards);}
      imports.set(declaration,current);
    }
    return imports.get(declaration);
  }
  function qualify(raw, declaration, substitution = {}, visited = new Set()) {
    let value = raw.trim().replace(/^&\s*(?:'\w+\s*)?(?:mut\s+)?/, '').replace(/^mut\s+/, '').trim();
    if(value.startsWith('(')&&value.endsWith(')'))return '('+splitRustArguments(value.slice(1,-1)).map(part=>qualify(part,declaration,substitution,new Set(visited))||part).join(', ')+')';
    if(value.startsWith('<')){
      const end=endOf(value,0,'<','>'),body=value.slice(1,end);let depth=0,as=-1;
      for(let index=0;index<body.length;index++){if(body[index]==='<')depth++;else if(body[index]==='>')depth--;else if(!depth&&body.startsWith(' as ',index)){as=index;break}}
      if(end<0)return null;
      if(as>=0){const owner=qualify(body.slice(0,as),declaration,substitution,new Set(visited)),trait=qualify(body.slice(as+4),declaration,substitution,new Set(visited));return owner&&trait?'<'+owner+' as '+trait+'>'+value.slice(end+1):null;}
      const owner=qualify(body,declaration,substitution,new Set(visited));return owner?owner+value.slice(end+1):null;
    }
    if (substitution[value]) return substitution[value];
    const head = /^([A-Za-z_]\w*(?:::\w+)*)/.exec(value)?.[1];
    if (!head) return null;
    const tail = value.slice(head.length), generic = tail.trim().startsWith('<') ? splitRustArguments(tail.trim().slice(1,-1)).filter(item=>!/^'/.test(item)) : [];
    const qualifiedArgs = generic.map(arg => qualify(arg, declaration, substitution, new Set(visited)) || substitution[arg] || arg);
    let canonical = head;
    if (substitution[head]) canonical = substitution[head];
    else if(substitution[head.split('::')[0]])canonical=substitution[head.split('::')[0]]+head.slice(head.split('::')[0].length);
    else if (head === 'Self') canonical = declaration.impl ? declaration.fullName.split('::').slice(0,-1).join('::') : head;
    else if (head.startsWith('crate::')) canonical = declaration.file.crate + head.slice(5);
    else if (head.startsWith('self::')) canonical = declaration.fullName.split('::').slice(0,-1).join('::') + head.slice(4);
    else if (head.startsWith('super::')) canonical = declaration.fullName.split('::').slice(0,-2).join('::') + head.slice(5);
    else if (!head.includes('::') || !metadata.packages.some(pkg=>pkg.name.replaceAll('-','_') === head.split('::')[0])) {
      const imp = importFor(declaration).names.get(head.split('::')[0]);
      if (imp && !visited.has(imp)) {
        visited.add(imp);
        const candidate = qualify(imp + head.slice(head.split('::')[0].length), declaration, substitution, visited);
        if (candidate) canonical = candidate;
      } else {
        const module = declaration.fullName.split('::').slice(0,declaration.impl?-2:-1).join('::');
        const local = all.get(module + '::' + head);
        if (local?.some(item=>item.kind!=='fn')) canonical = module + '::' + head;
        else {
          const own = load(declaration.file.crate).filter(item=>item.kind!=='fn'&&item.symbol===head);
          if (own.length===1) canonical=own[0].fullName;
          else {
            const candidates=[];
            for (const wildcard of importFor(declaration).wildcards) {
              const root = wildcard.startsWith('crate::') ? declaration.file.crate : wildcard.split('::')[0];
              if (!metadata.packages.some(pkg=>pkg.name.replaceAll('-','_')===root)) continue;
              const source=wildcard.startsWith('crate::')?declaration.file.crate+wildcard.slice(5):wildcard;
              const exported=reexportedType(source+'::'+head);
              if(exported.length===1)candidates.push(...(all.get(exported[0])||[]).filter(item=>item.kind!=='fn'));
            }
            const full=unique(candidates.map(item=>item.fullName));
            if(full.length===1)canonical=full[0];
          }
        }
      }
    }
    // 再导出路径仅在声明包中存在唯一类型时归一化，不跨全部依赖按短名搜索。
    if(canonical.includes('::')) {
      const crate=canonical.split('::')[0];
      if(metadata.packages.some(pkg=>pkg.name.replaceAll('-','_')===crate)) {
        const decls=load(crate);
        if(!all.has(canonical)) {
          const exported=reexportedType(canonical);
          if(exported.length===1)canonical=exported[0];
        }
      }
    }
    const standard={bool:'core::primitive::bool',f32:'core::primitive::f32',f64:'core::primitive::f64',u8:'core::primitive::u8',u16:'core::primitive::u16',u32:'core::primitive::u32',u64:'core::primitive::u64',usize:'core::primitive::usize',i32:'core::primitive::i32',i64:'core::primitive::i64',Vec:'alloc::vec::Vec',Option:'core::option::Option',String:'alloc::string::String'};
    canonical=standard[canonical]||canonical;
    return canonical+(qualifiedArgs.length?'<'+qualifiedArgs.join(', ')+'>':'');
  }
  function substitutionFor(declaration, fullName) {
    const generics = splitRustArguments(declaration.generic||'').filter(value=>!value.startsWith("'")).map(value=>/^(?:const\s+)?(\w+)/.exec(value)?.[1]);
    const suffix = fullName.slice(fullName.lastIndexOf('::'+declaration.symbol)+2+declaration.symbol.length);
    const actual = suffix.startsWith('<')?splitRustArguments(suffix.slice(1,endOf(suffix,0,'<','>'))):[];
    const result=Object.fromEntries(generics.map((key,index)=>[key,actual[index]]).filter(([,value])=>value));
    if(fullName.startsWith('<'))result.Self=fullName.slice(1,endOf(fullName,0,'<','>')).split(' as ')[0];
    else if(declaration.impl) {
      const receiver=fullName.slice(0,fullName.lastIndexOf('::'+declaration.symbol));
      result.Self=receiver;
      const implHeader=declaration.impl.header.trim();
      if(implHeader.startsWith('<')) {
        const implGenerics=splitRustArguments(implHeader.slice(1,endOf(implHeader,0,'<','>'))).filter(value=>!value.startsWith("'")).map(value=>/^(?:const\s+)?(\w+)/.exec(value)?.[1]);
        const open=receiver.indexOf('<'),implActual=open>=0?splitRustArguments(receiver.slice(open+1,endOf(receiver,open,'<','>'))):[];
        implGenerics.forEach((key,index)=>{if(implActual[index])result[key]=implActual[index]});
      }
    }
    return result;
  }
  function typeSource(type) {
    const base=stripRustGenerics(type),crate=base.split('::')[0];
    if(!metadata.packages.some(pkg=>pkg.name.replaceAll('-','_')===crate))return null;
    load(crate);
    const found=choose((all.get(base)||[]).filter(item=>item.kind!=='fn'),base);
    return found?{entry:sourceAt(found.file,found.offset,'definition','类型定义：'+type),declaration:found}:null;
  }
  function resolveBodyOperationType(raw, fullName, {declaration, kind, scope='current',depth=0,operationProofEntries=[]}={}) {
    if(!raw)return{sourceGaps:['函数体操作关联输出表达式尚未解析：'+fullName]};
    declaration ||= choose(declarationsFor(fullName), stripRustGenerics(fullName));
    const sourceGaps=[],substitution=substitutionFor(declaration,fullName);
    const unbound=unique([declaration.generic||'',declaration.impl?.header.startsWith('<')?declaration.impl.header.slice(1,endOf(declaration.impl.header,0,'<','>')):''].flatMap(value=>splitRustArguments(value).filter(item=>!item.startsWith("'")).map(item=>/^(?:const\s+)?(\w+)/.exec(item)?.[1])).filter(key=>key&&!substitution[key]));
    let type=qualify(raw,declaration,substitution);
    if(kind==='Messages<T>'&&stripRustGenerics(type||'')!=='bevy_ecs::message::messages::Messages')type=qualify('bevy_ecs::message::messages::Messages<'+raw+'>',declaration,substitution);
    if(!type||!stripRustGenerics(type).includes('::')||unbound.some(key=>new RegExp('(?<![A-Za-z0-9_:])'+key+'(?![A-Za-z0-9_])').test(type)))return{sourceGaps:['函数体操作类型尚未唯一实例化：'+raw+'；声明：'+fullName]};
    if(kind==='Resource'&&stripRustGenerics(type)==='bevy_ecs::message::messages::Messages')kind='Messages<T>';
    if(depth>5)return{sourceGaps:['函数体操作关联类型递归尚未展开：'+type]};
    if(type.startsWith('(')&&type.endsWith(')')){
      const children=splitRustArguments(type.slice(1,-1)).map(part=>resolveBodyOperationType(part,fullName,{declaration,kind,scope,depth:depth+1,operationProofEntries}));
      return {types:children.flatMap(child=>child.types||(child.fullName?[child]:[])),sourceGaps:unique(children.flatMap(child=>child.sourceGaps||[]))};
    }
    let definition=typeSource(type);
    if(/::(?:Out|Target)$/.test(type)){
      const owner=type.replace(/::(?:Out|Target)$/,''),associated=type.split('::').at(-1),ownerSource=typeSource(owner);
      if(!definition){
        for(const crate of ['bevy_render','bevy_core_pipeline','bevy_pbr','bevy_post_process','bevy_anti_alias'])if(metadata.packages.some(p=>p.name.replaceAll('-','_')===crate))load(crate);
        const candidates=[...all.values()].flat().filter(d=>d.kind==='type'&&d.symbol===associated&&d.impl&&new RegExp('\\b'+(associated==='Out'?'ExtractComponent':'SyncComponent')+'(?:\\s*<|\\s+for\\b)').test(d.impl.header)).filter(d=>{
          const target=d.impl.header.split(/\s+for\s+/).at(-1).split(/\s+where\s+/)[0];return qualify(target,d)===owner;
        }),selected=choose(candidates,type);
        if(selected)definition={entry:sourceAt(selected.file,selected.offset,'definition','关联类型声明：'+type),declaration:selected};
      }
      if(definition?.declaration.kind==='type'){
        const alias=definition.declaration,end=alias.file.text.indexOf(';',alias.offset),match=/=([\s\S]+);$/.exec(alias.file.text.slice(alias.offset,end+1));
        if(match){const actual=qualify(match[1],alias,{Self:owner}),proof={...definition.entry,role:'operation',label:'函数体输出关联类型展开：'+type};return resolveBodyOperationType(actual,fullName,{declaration,kind,scope,depth:depth+1,operationProofEntries:[...operationProofEntries,proof]});}
      }
      if(ownerSource&&/\bderive\s*\([^)]*\bExtractComponent\b/.test(ownerSource.declaration.attributes)){
        const macro=load('bevy_extract_macros').find(d=>d.fullName==='bevy_extract_macros::extract_component::derive_extract_component');
        if(!macro||!macro.body.includes('type Out = Self')||!macro.body.includes('type Target = #sync_target'))throw new Error('ExtractComponent derive output evidence changed');
        const attributes=ownerSource.declaration.attributes,attr=/extract_component_sync_target\s*\(/.exec(attributes),open=attr?attributes.indexOf('(',attr.index):-1,target=attr?attributes.slice(open+1,endOf(attributes,open,'(',')')):null,actual=associated==='Out'||!attr?owner:qualify(target,ownerSource.declaration,{Self:owner});
        const proof=sourceAt(macro.file,macro.bodyStart+1+macro.body.indexOf('type '+associated+' ='),'operation','ExtractComponent 派生关联类型：'+associated);
        return resolveBodyOperationType(actual,fullName,{declaration,kind,scope,depth:depth+1,operationProofEntries:[...operationProofEntries,{...ownerSource.entry,role:'operation',label:'ExtractComponent 派生声明及同步目标：'+owner},proof]});
      }
      return {sourceGaps:['函数体操作关联类型尚未核实实际输出，未把关联声明当作组件：'+type+'；声明：'+fullName]};
    }
    if(!definition)return{sourceGaps:['函数体操作类型声明尚未唯一定位：'+type+'；声明：'+fullName]};
    if(kind==='EntityEvent'&&!/\bderive\s*\([^)]*\bEntityEvent\b/.test(definition.declaration.attributes))return{sourceGaps:['触发类型未核实 EntityEvent 声明：'+type]};
    const sourceEntries=[definition.entry];
    if(kind==='Messages<T>'){
      const open=type.indexOf('<'),payload=open>=0?splitRustArguments(type.slice(open+1,endOf(type,open,'<','>')))[0]:null,payloadSource=payload&&typeSource(payload);
      if(payloadSource)sourceEntries.push({...payloadSource.entry,role:'message_definition',label:'消息类型定义：'+payload});
      else sourceGaps.push('消息类型声明尚未唯一定位：'+(payload||type));
    }
    const access={type:raw,fullName:type,kind,scope,sourceEntries};
    const purpose=typePurposes.describe(access,{declaration:definition.declaration,parameterDeclaration:declaration,systemDeclaration:declaration,systemFullName:fullName});
    return {...access,...purpose,operationProofEntries,sourceGaps:unique([...sourceGaps,...purpose.sourceGaps])};
  }
  function accessesFor(declaration, fullName, options={}) {
    const substitution=options.substitution||substitutionFor(declaration,fullName), accesses=[],gaps=[],filter=[];
    const unbound=unique([declaration.generic||'',declaration.impl?.header.startsWith('<')?declaration.impl.header.slice(1,endOf(declaration.impl.header,0,'<','>')):''].flatMap(value=>splitRustArguments(value).filter(item=>!item.startsWith("'")).map(item=>/^(?:const\s+)?(\w+)/.exec(item)?.[1])).filter(key=>key&&!substitution[key]));
    const origin=sourceAt(declaration.file,declaration.offset,'parameter','系统参数：'+fullName);
    const add=(raw,kind,operation,scope='current',parameterKey)=>{
      const type=qualify(raw,declaration,substitution);
      if(type&&unbound.some(key=>new RegExp('(?<![A-Za-z0-9_:])'+key+'(?![A-Za-z0-9_])').test(type))){gaps.push('参数保留未绑定泛型，未建立具体类型访问：'+type);return;}
      if(!type || !stripRustGenerics(type).includes('::')) {gaps.push('参数类型尚未唯一定位：'+raw);return;}
      if(kind==='Resource'&&stripRustGenerics(type)==='bevy_ecs::message::messages::Messages')kind='Messages<T>';
      const definition=typeSource(type);
      if(!definition && ['Component','Resource','NonSend','Messages<T>'].includes(kind)) {gaps.push('参数类型声明尚未唯一定位：'+type);return;}
      const sourceEntries=[...(definition?[definition.entry]:[]),origin];
      if(kind==='Messages<T>'){
        const open=type.indexOf('<'),payload=open>=0?splitRustArguments(type.slice(open+1,endOf(type,open,'<','>')))[0]:null,payloadSource=payload&&typeSource(payload);
        if(payloadSource)sourceEntries.push({...payloadSource.entry,role:'message_definition',label:'消息类型定义：'+payload});
        else gaps.push('消息类型声明尚未唯一定位：'+(payload||type));
      }
      const access={type:raw,fullName:type,kind,operation,scope,...(kind==='Local'?{parameterKey}:{}),sourceEntries};
      Object.assign(access,typePurposes.describe(access,{declaration:definition?.declaration,parameterDeclaration:declaration,declarationParameterKey:parameterKey?.slice((options.parameterPrefix||'').length),systemDeclaration:options.systemDeclaration||declaration,systemFullName:options.systemFullName||fullName}));
      accesses.push(access);
    };
    const parse=(raw,mode='parameter',scope='current',parameterKey='parameter')=>{
      let value=parameterType(raw.replace(/#\s*\[[\s\S]*?\]\s*/g,'').trim()).replace(/\s+/g,' ').trim();
      if(!value||/^'(?:\w+|_)$/.test(value))return;
      if(value.startsWith('(')&&value.endsWith(')')){splitRustArguments(value.slice(1,-1)).forEach((part,index)=>parse(part,mode,scope,parameterKey+'.'+index));return;}
      const ref=/^&\s*(?:'\w+\s*)?(mut\s+)?([\s\S]+)$/.exec(value);
      if(ref){
        const type=qualify(ref[2],declaration,substitution);
        if(type&&stripRustGenerics(type)==='bevy_ecs::system::function_system::SystemState'){
          add(ref[2],'SystemParam','reference',scope);
          const open=ref[2].indexOf('<'),args=open>=0?splitRustArguments(ref[2].slice(open+1,endOf(ref[2],open,'<','>'))).filter(arg=>!arg.startsWith("'")):[];
          if(args[0])parse(args[0],'parameter',scope,parameterKey+'.system_state');
          return;
        }
        add(ref[2],mode==='parameter'&&/\bWorld$/.test(ref[2])?'SystemParam':'Component',ref[1]?'write':'read',scope);return;
      }
      const outer=/^([A-Za-z_]\w*(?:::\w+)*)\s*</.exec(value);
      const family=outer?.[1].split('::').at(-1),open=outer?value.indexOf('<'):-1,end=open>=0?endOf(value,open,'<','>'):-1;
      const args=end>=0?splitRustArguments(value.slice(open+1,end)).filter(item=>!/^'/.test(item)):[];
      if(['Option','Result','Or','AnyOf','ParamSet','Single','Populated','ViewQuery'].includes(family)){args.forEach((part,index)=>parse(part,family==='ViewQuery'?'query':mode,scope,parameterKey+'.'+index));return;}
      if(family==='Extract'){args.forEach((part,index)=>parse(part,mode,'main',parameterKey+'.extract'+index));return;}
      if(family==='Query'){if(args[0])parse(args[0],'query',scope,parameterKey+'.data');if(args[1]){filter.push(args[1]);parse(args[1],'filter',scope,parameterKey+'.filter')}return;}
      if(['With','Without','Added','Changed','Spawned','Has'].includes(family)){args.forEach(part=>add(part,'Component','filter',scope));return;}
      if(['Ref','Mut'].includes(family)){if(args[0])add(args[0],'Component',family==='Mut'?'write':'read',scope);return;}
      if(['Res','ResMut','NonSend','NonSendMut','Local'].includes(family)){if(args[0])add(args[0],family==='Local'?'Local':family.startsWith('NonSend')?'NonSend':'Resource',/Mut$/.test(family)||family==='Local'?'write':'read',scope,parameterKey);return;}
      if(['MessageReader','MessageWriter','EventReader','EventWriter','MessageMutator'].includes(family)){if(args[0])add('bevy_ecs::message::messages::Messages<'+args[0]+'>','Resource',family.endsWith('Reader')?'read':'write',scope);return;}
      if(family==='In')return;
      if(mode==='filter')return;
      if(mode==='query'&&/^(?:Entity|EntityRef|FilteredEntityRef|EntityMut|FilteredEntityMut)\b/.test(value)){if(value!=='Entity')add(value,'SystemParam',/Mut/.test(value)?'write':'read',scope);return;}
      if(mode==='query'){
        add(value,'QueryData','reference',scope);
        expand(value,scope,parameterKey);
        return;
      }
      if(/^(?:&?mut )?World$/.test(value)){add('bevy_ecs::world::World','SystemParam','write',scope);return;}
      // 自定义参数先保留类型引用，仅派生参数的真实字段继续展开访问。
      add(value,'SystemParam','reference',scope);
      expand(value,scope,parameterKey);
    };
    const expand=(value,scope,parameterKey)=>{
      if(/\b(?:Commands|RemovedComponents|RenderContext|SystemChangeTick|PhantomData|DeferredWorld)\b/.test(value))return;
      const type=qualify(value,declaration,substitution),found=type&&typeSource(type)?.declaration;
      if(!found?.isSystemParam||!found.body){gaps.push('未展开自定义参数的数据访问，仅保留参数类型引用：'+(type||value));return;}
      if((options.depth||0)>=6){gaps.push('递归参数访问保留为类型引用：'+type);return;}
      const open=type.indexOf('<'),actual=open>=0?splitRustArguments(type.slice(open+1,endOf(type,open,'<','>'))):[];
      const names=splitRustArguments(found.generic||'').filter(item=>!item.startsWith("'")).map(item=>/^(?:const\s+)?(\w+)/.exec(item)?.[1]);
      const mapping=Object.fromEntries(names.map((name,index)=>[name,actual[index]]).filter(([,value])=>value));
      const child=accessesFor({...found,parameters:found.body},type,{substitution:mapping,depth:(options.depth||0)+1,scope,parameterPrefix:parameterKey+'.',systemDeclaration:options.systemDeclaration||declaration,systemFullName:options.systemFullName||fullName});
      accesses.push(...child.accesses);gaps.push(...child.sourceGaps);filter.push(...child.filters);
    };
    splitRustArguments(declaration.parameters).forEach((parameter,index)=>parse(parameter,'parameter',options.scope||'current',(options.parameterPrefix||'')+(/^(?:mut\s+)?(\w+)\s*:(?!:)/.exec(parameter.trim())?.[1]||'arg'+index)));
    return {accesses:[...new Map(accesses.map(item=>[[item.fullName,item.kind,item.operation,item.scope,item.kind==='Local'?item.parameterKey:''].join('|'),item])).values()],sourceGaps:unique(gaps),filters:filter};
  }
  function registrationSources(declaration, fullName, context) {
    const candidates=[];
    for(const file of unique(load(declaration.file.crate).map(item=>item.file))) {
      if(!new RegExp('\\b'+declaration.symbol+'\\b').test(file.code))continue;
      for(const match of file.code.matchAll(/\.(?:add_systems|add_systems_to|configure_sets)\s*\(/g)) {
        const open=file.code.indexOf('(',match.index),end=endOf(file.code,open,'(',')');if(end<0)continue;
        const body=file.code.slice(open+1,end),parts=splitRustArguments(body),systems=withoutConfigurationTargets(parts.slice(1).join(','));
        if(!new RegExp('\\b'+declaration.symbol+'\\b').test(systems))continue;
        const scope=parts[0]||'';
        const schedule=context?.scheduleLabel||'';
        if(schedule&&/^[A-Za-z_]\w*$/.test(schedule)&&!new RegExp('\\b'+schedule+'\\b').test(scope)&&!['schedule','schedule_label','schedule_label.clone()'].includes(scope.trim()))continue;
        const sameFile=file.path===declaration.file.path;
        const uniqueSymbol=load(declaration.file.crate).filter(item=>item.kind==='fn'&&item.symbol===declaration.symbol).length===1;
        if(!sameFile&&!uniqueSymbol&&!body.includes(declaration.fullName.split('::').slice(-2).join('::')))continue;
        candidates.push(sourceAt(file,match.index,'registration','Schedule 注册：'+(context?.scheduleLabel||'泛型调度')));
      }
    }
    return [...new Map(candidates.map(source=>[source.path+':'+source.line,source])).values()];
  }
  function resolveSystem(fullName, context={}) {
    const result=resolveSystemDetails(fullName,context);
    for(const access of result.accesses||[])access.usageContexts=unique([...(access.usageContexts||[]),fullName+'：'+result.description+' 参数范围：'+(access.kind==='Local'?'本系统独立状态':access.scope==='main'?'主世界':context.application||'当前世界')+'；'+({read:'只读声明',write:'可变声明',filter:'存在或变化过滤',reference:'参数或查询接口引用'}[access.operation])+'。']);
    return result;
  }
  function resolveSystemDetails(fullName, context={}) {
    if(fullName==='bevy_ecs::apply_deferred'){
      load('bevy_ecs');const declaration=choose(all.get('bevy_ecs::schedule::executor::ApplyDeferred')||[],'ApplyDeferred');
      const definition=sourceAt(declaration.file,declaration.offset,'definition','同步类型：ApplyDeferred');
      return {name:'ApplyDeferred',kind:'Synchronization',description:specialDescriptions.apply_deferred,display_summary:specialDescriptions.apply_deferred,definition,sourceEntries:[definition],sourceGaps:[],filters:[],accesses:[]};
    }
    if(fullName.startsWith('Pipe(')){
      const stages=splitRustArguments(fullName.slice(5,-1)).map(name=>resolveSystem(name,context));
      return {name:fullName,kind:'System group',description:'组合系统先执行前一阶段，将其输出作为后一阶段输入；此实例连接 '+stages.map(stage=>stage.name).join(' → ')+'。',display_summary:'按管道顺序执行组合系统。',sourceEntries:stages.flatMap(stage=>stage.sourceEntries),sourceGaps:unique(stages.flatMap(stage=>stage.sourceGaps)),filters:stages.flatMap(stage=>stage.filters),accesses:stages.flatMap((stage,index)=>stage.accesses.map(access=>access.kind==='Local'?{...access,parameterKey:'stage'+index+':'+access.parameterKey}:access)),bodyOperations:stages.flatMap(stage=>stage.bodyOperations||[]),fields:stages.map(stage=>stage.description)};
    }
    if(fullName.startsWith('(')) {
      // 上游 SystemParamFunction 使用参数元组生成名称；完整名称指纹指向已审阅实现。
      const symbol=TUPLE_IMPLEMENTATIONS[createHash('sha256').update(fullName).digest('hex')];
      if(!symbol)throw new Error('Unnamed system parameter tuple has not been reviewed: '+fullName);
      load('bevy_enhanced_input');
      let declaration=choose(all.get('bevy_enhanced_input::context::'+symbol)||[],symbol);
      if(!declaration&&symbol==='trigger')declaration=load('bevy_enhanced_input').find(item=>item.kind==='fn'&&item.symbol==='trigger'&&item.file.path==='src/context.rs');
      if(!declaration)throw new Error('Unnamed input system implementation is missing: '+symbol);
      const actual=fullName.match(/ContextInstances<([^>]+)>/)?.[1],effective={...declaration,generic:'S',parameters:fullName.slice(1,-1)};
      const parameters=context.skipParameterAccess?{accesses:[],sourceGaps:[],filters:[]}:accessesFor(effective,'bevy_enhanced_input::context::'+symbol+'<'+actual+'>');
      const description={update:'按上下文优先级评估输入绑定、修饰器和条件，计算动作值及触发状态；此卡片的名称由系统参数元组生成。',apply:'把类型擦除的动作值应用到各动作的强类型组件，保持动作实例与所属上下文一致；此卡片的名称由系统参数元组生成。',trigger:'依据动作事件标记向对应动作实体排入带类型的触发事件，并清理失效实例；此卡片的名称由系统参数元组生成。'}[symbol];
      const definition=sourceAt(declaration.file,declaration.offset,'definition','参数元组系统实现：'+symbol);
      const body=bodyCatalog.resolve(effective,'bevy_enhanced_input::context::'+symbol+'<'+actual+'>',context);
      return{name:'Enhanced Input '+symbol,kind:'System',description,display_summary:description,definition,sourceEntries:[definition,...registrationSources(declaration,fullName,context)],sourceGaps:[...parameters.sourceGaps,...body.sourceGaps],accesses:parameters.accesses,bodyOperations:body.bodyOperations,filters:[declaration.complete],fields:declaration.docs?['源码文档：'+declaration.docs]:[]};
    }
    if(fullName.includes('::{{closure}}')) {
      load('bevy_state');
      const declaration=load('bevy_state').find(item=>item.symbol==='register_sub_state_systems_in_schedule'&&item.impl?.name==='S');
      if(!declaration)throw new Error('StateSet sub-state transition implementation is missing');
      const parent=fullName.match(/^<(.+?) as /)?.[1],child=fullName.match(/register_sub_state_systems_in_schedule<(.+?)>::/)?.[1];
      const text=declaration.file.text.slice(declaration.bodyStart,declaration.end),closure=/let\s+apply_state_transition\s*=\s*(?:move\s*)?\|([\s\S]*?)\|/.exec(text),signature=closure?.[1];
      const source=sourceAt(declaration.file,declaration.bodyStart+closure.index,'definition','StateSet 子状态转换闭包定义');
      const register=/\.add_systems\s*\(apply_state_transition\b/.exec(text);
      if(!register)throw new Error('StateSet closure registration is missing');
      const effective={...declaration,parameters:signature||'',generic:'S,T'};
      const parameters=context.skipParameterAccess?{accesses:[],sourceGaps:[],filters:[]}:accessesFor(effective,fullName,{substitution:{S:parent,T:child,'S::RawState':parent}});
      const description='监听父状态变化与待处理的子状态切换，计算 '+child+' 是否仍应存在，应用转换并写入状态转换消息；闭包由 '+parent+' 的 StateSet 实现注册。';
      return{name:'子状态转换闭包',kind:'System',description,display_summary:description,definition:source,sourceEntries:[source,sourceAt(declaration.file,declaration.bodyStart+register.index,'registration','StateSet 注册子状态转换系统')],sourceGaps:parameters.sourceGaps,accesses:parameters.accesses,filters:[signature||declaration.complete]};
    }
    const declaration=choose(declarationsFor(fullName),stripRustGenerics(fullName));
    if(!declaration)throw new Error('Schedule system definition is missing or ambiguous: '+fullName);
    const definition=sourceAt(declaration.file,declaration.offset,'definition','系统定义：'+fullName), registration=registrationSources(declaration,fullName,context),parameters=context.skipParameterAccess?{accesses:[],sourceGaps:[],filters:[]}:accessesFor(declaration,fullName);
    const purpose=describeFunction(declaration,fullName,parameters,strictPurposes),description=purpose.description,name=fullName.slice(fullName.lastIndexOf('::'+declaration.symbol)+2),body=bodyCatalog.resolve(declaration,fullName,context);
    return {name,kind:'System',description,display_summary:purpose.summary,definition,sourceEntries:[definition,...registration],sourceGaps:[...parameters.sourceGaps,...body.sourceGaps,...(purpose.sourceGap?[purpose.sourceGap]:[]),...(registration.length?[]:['该实例的具体 Schedule 注册配置尚未唯一定位；注册存在由原始调度快照确认。'])],filters:[declaration.complete,...parameters.filters],accesses:parameters.accesses,bodyOperations:body.bodyOperations,fields:declaration.docs?['源码文档：'+declaration.docs]:[]};
  }
  function resolveSet(label, context={}, members=[]) {
    // 集合定位不依赖此前先解析了哪些系统。
    if(!setsLoaded){setsLoaded=true;for(const pkg of metadata.packages)if(/^(?:bevy(?:_|$)|avian3d$|demo$)/.test(pkg.name))load(pkg.name.replaceAll('-','_'));}
    const memberDeclarations=members.flatMap(member=>{
      if(member.startsWith('Pipe('))return splitRustArguments(member.slice(5,-1)).flatMap(name=>declarationsFor(name));
      if(member.startsWith('(')){load('bevy_enhanced_input');return[];}
      if(member.includes('closure')){load('bevy_state');return[];}
      if(member==='bevy_ecs::apply_deferred'){load('bevy_ecs');return[];}
      return declarationsFor(member);
    });
    load('bevy_ecs');load('bevy_app');
    if(label.startsWith('AnonymousSet(')) {
      const declaration=choose(all.get('bevy_ecs::schedule::set::AnonymousSet')||[],label);
      const definition=sourceAt(declaration.file,declaration.offset,'definition','原生匿名集合：AnonymousSet');
      const sourceEntries=[definition],gaps=[];
      for(const file of unique(memberDeclarations.map(item=>item.file))) for(const match of file.code.matchAll(/\.run_if\s*\(/g)) {
        const from=Math.max(0,file.code.lastIndexOf('.add_systems',match.index));
        const text=file.code.slice(from,match.index);
        if(memberDeclarations.some(item=>new RegExp('\\b'+item.symbol+'\\b').test(text)))sourceEntries.push(sourceAt(file,match.index,'configure','集合运行条件配置'));
      }
      const excerpt=members.slice(0,5).map(member=>stripRustGenerics(member).split('::').at(-1)).join('、');
      return{name:label,fullName:'bevy_ecs::schedule::set::'+label,kind:'SystemSet',definition,description:'为同一批系统保存共同运行条件的原生匿名集合。本调度中关联 '+members.length+' 个系统'+(excerpt?'，包括 '+excerpt:'')+'；集合成员身份来自原始成员关系，不表示额外执行系统。',display_summary:'保存本组系统共同的运行条件。',sourceEntries,sourceGaps:sourceEntries.length>1?gaps:['匿名集合对应的具体 collective run_if 配置尚未唯一定位。']};
    }
    const reviewed=REVIEWED_SCHEDULE_SETS.find(item=>item.application===context.application&&item.scheduleLabel===context.scheduleLabel&&item.graphName===context.graphName);
    if(reviewed){if(reviewed.dotSha256!==context.dotSha256||reviewed.label!==label)throw new Error('Reviewed Schedule set snapshot is stale: '+context.graphName);load(reviewed.fullName.split('::')[0]);}
    const head=label.split(/[({]/)[0].trim(),candidates=[];
    const crates=unique(memberDeclarations.map(item=>item.file.crate));
    for(const declaration of [...all.values()].flat()) {
      if(!declaration.isSystemSet||!['enum','struct'].includes(declaration.kind)||/::tests?::/.test(declaration.fullName))continue;
      if(declaration.symbol===head)candidates.push({declaration,fullName:declaration.fullName,offset:declaration.offset,name:head});
      if(declaration.kind==='enum'&&declaration.body)for(const match of declaration.body.matchAll(new RegExp('^[ \\t]*('+head.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')[ \\t]*(?:,|\\(|\\{|=)','gm')))candidates.push({declaration,fullName:declaration.fullName+'::'+head,offset:declaration.bodyStart+1+match.index+match[0].indexOf(head),name:declaration.symbol+'::'+head});
    }
    for(const candidate of candidates) {
      candidate.score=memberDeclarations.filter(member=>member.file.crate===candidate.declaration.file.crate).length*2;
      if(candidate.declaration.file.crate==='demo'&&memberDeclarations.some(member=>member.file.crate==='demo'))candidate.score+=2;
      const pattern=new RegExp('\\b'+candidate.name.replaceAll('::','\\s*::\\s*')+'\\b');
      candidate.configurations=[];
      const files=unique([...memberDeclarations.map(member=>member.file),...load(candidate.declaration.file.crate).map(item=>item.file)]);
      for(const file of files)for(const match of file.code.matchAll(/\.(?:add_systems|configure_sets)\s*\(/g)) {
        const open=file.code.indexOf('(',match.index),end=endOf(file.code,open,'(',')');if(end<0)continue;
        const body=file.code.slice(open+1,end);if(!pattern.test(body))continue;
        const symbols=unique(memberDeclarations.filter(member=>new RegExp('\\b'+member.symbol+'\\b').test(body)).map(member=>member.fullName));
        if(symbols.length)candidate.score+=symbols.length*10;
        candidate.configurations.push(sourceAt(file,match.index,'configure','集合配置：'+candidate.name));
      }
    }
    candidates.sort((a,b)=>b.score-a.score||a.fullName.localeCompare(b.fullName));
    const selected=reviewed?candidates.find(candidate=>candidate.fullName===reviewed.fullName):candidates[0]&&(!candidates[1]||candidates[0].score>candidates[1].score)?candidates[0]:null;
    if(!selected)throw new Error('Schedule set declaration is missing or ambiguous: '+context.application+'/'+context.scheduleLabel+'/'+label+' candidates='+candidates.map(candidate=>candidate.fullName+':'+candidate.score).join(','));
    const definition=sourceAt(selected.declaration.file,selected.offset,'definition','集合定义：'+selected.name);
    const sourceEntries=[definition,...new Map(selected.configurations.map(source=>[source.path+':'+source.line,source])).values()];
    const purpose=reviewedScheduleSetPurpose(selected.fullName,{strict:strictPurposes});
    return{name:selected.name+(label.includes('PhantomData')?' · '+label.slice(head.length):''),fullName:selected.fullName,kind:'SystemSet',definition,description:purpose.description,display_summary:purpose.summary,sourceEntries,sourceGaps:[...(purpose.sourceGap?[purpose.sourceGap]:[]),...(selected.configurations.length?[]:['集合的具体调度配置尚未唯一定位。'])],fields:selected.declaration.docs?['集合类型源码文档：'+selected.declaration.docs]:[]};
  }
  return { load, declarationsFor, resolveSystem, resolveSet, failures, sourceAt, typePurposes, systemPurposes:REVIEWED_SCHEDULE_SYSTEM_PURPOSES, bodyCatalog, resolveBodyOperationType, get declarations() { return [...all.values()].flat(); } };
}
