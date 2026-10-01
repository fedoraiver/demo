// 将已核对的 ECS 清单生成独立 SVG 与离线 HTML；不加载或执行游戏。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSourceViewer } from './source-viewer.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const model = JSON.parse(fs.readFileSync(path.join(dir, 'ecs-data.json'), 'utf8'));
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const colors = { system: '#234f80', observer: '#7851a9', engine: '#667085', sync: '#a56615', entity: '#25674e', component: '#2a7156', resource: '#8b6130', event: '#bd601f', message: '#367b96', local: '#81754c' };
const systems = Object.fromEntries(model.systems.map(s => [s.id, s]));
const entities = Object.fromEntries(model.entities.map(e => [e.id, e]));
const registry = {};
const views = [];
// 共享资源提前进入注册表，便于不同视图复用同一份点击详情。
model.resources.forEach(resource => registry[resource.id] = resource);
Object.assign(registry, systems);
model.entities.forEach(entity=>{
  registry[`entity-${entity.id}`]={...entity,kind:'Entity'};
  entity.components.forEach(component=>registry[component.id]={...component,kind:'Component',owner:entity.name});
});
let nodeBoxes = new Map();
let edgeSpecs = [];
// 连线延迟到整个视图收集完成后定位：同侧出线和入线共同分配 n+1 等分槽位。
function boxAttributes(id, x, y, width, height, container = false) {
  if (nodeBoxes.has(id)) throw new Error('Duplicate geometry box: ' + id);
  nodeBoxes.set(id, { id, x, y, width, height, container });
  return 'data-box-id="' + esc(id) + '"' + (container ? ' data-box-container="true"' : '');
}
const normal = side => ({ left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] }[side]);
function port(anchor) {
  const box = nodeBoxes.get(anchor.box), f = anchor.slot / (anchor.count + 1);
  return { left: [box.x, box.y + box.height * f], right: [box.x + box.width, box.y + box.height * f], top: [box.x + box.width * f, box.y], bottom: [box.x + box.width * f, box.y + box.height] }[anchor.side];
}
function endpoint(point, next) {
  // 实际矩形边界决定所属节点；语义 data-connect 中的其它引用不能冒充几何端点。
  const candidates = [];
  for (const box of nodeBoxes.values()) for (const side of ['left', 'right', 'top', 'bottom']) {
    const onSide = side === 'left' || side === 'right'
      ? Math.abs(point[0] - (box.x + (side === 'right' ? box.width : 0))) < .01 && point[1] >= box.y && point[1] <= box.y + box.height
      : Math.abs(point[1] - (box.y + (side === 'bottom' ? box.height : 0))) < .01 && point[0] >= box.x && point[0] <= box.x + box.width;
    if (onSide) { const n = normal(side), outward = (next[0] - point[0]) * n[0] + (next[1] - point[1]) * n[1]; candidates.push({ box: box.id, side, score: (box.container ? 0 : 10) + (outward > 0 ? 1 : 0) }); }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.length ? { box: candidates[0].box, side: candidates[0].side } : null;
}
function orthogonalRoute(spec) {
  const old = spec.points, start = spec.source ? port(spec.source) : old[0], end = spec.target ? port(spec.target) : old.at(-1);
  let points;
  if (old.length <= 3) {
    // 一条直线的两端槽位可能不再对齐；保留法向出口，用走线中点接上两端。
    if (spec.source && spec.target && normal(spec.source.side)[0] && normal(spec.target.side)[0]) {
      const mid = old.length === 3 ? old[1][0] : (start[0] + end[0]) / 2;
      points = [start, [mid, start[1]], [mid, end[1]], end];
    } else if (spec.source && spec.target && normal(spec.source.side)[1] && normal(spec.target.side)[1]) {
      const mid = old.length === 3 ? old[1][1] : (start[1] + end[1]) / 2;
      points = [start, [start[0], mid], [end[0], mid], end];
    } else if (spec.source && !spec.target) {
      const n = normal(spec.source.side), projection = (old[1][0] - old[0][0]) * n[0] + (old[1][1] - old[0][1]) * n[1];
      const distance = projection > 0 ? projection : 32;
      points = [start, [start[0] + n[0] * distance, start[1] + n[1] * distance], ...old.slice(2, -1), end];
    } else if (!spec.source && spec.target) {
      const n = normal(spec.target.side), projection = (old.at(-2)[0] - old.at(-1)[0]) * n[0] + (old.at(-2)[1] - old.at(-1)[1]) * n[1];
      const distance = projection > 0 ? projection : 32;
      points = [start, ...old.slice(1, -2), [end[0] + n[0] * distance, end[1] + n[1] * distance], end];
    } else points = old.map(p => [...p]);
  } else points = old.map(p => [...p]);
  points[0] = start; points[points.length - 1] = end;
  if (spec.source && old.length > 3) {
    const n = normal(spec.source.side), projection = (old[1][0] - old[0][0]) * n[0] + (old[1][1] - old[0][1]) * n[1];
    const distance = projection > 0 ? projection : 32;
    points[1] = [start[0] + n[0] * distance, start[1] + n[1] * distance];
  }
  if (spec.target && old.length > 3) {
    const n = normal(spec.target.side), distance = Math.max(32, (old.at(-2)[0] - old.at(-1)[0]) * n[0] + (old.at(-2)[1] - old.at(-1)[1]) * n[1]);
    points[points.length - 2] = [end[0] + n[0] * distance, end[1] + n[1] * distance];
  }
  // 调整首末段后，只补正交拐点；框外分叉和汇合仍使用原来的真实连接坐标。
  const routed = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const previous = routed.at(-1), current = points[i];
    if (previous[0] !== current[0] && previous[1] !== current[1]) routed.push([previous[0], current[1]]);
    if (routed.at(-1)[0] !== current[0] || routed.at(-1)[1] !== current[1]) routed.push(current);
  }
  // 去掉同方向冗余点与回头段，避免等分调整留下不可辨认的短折线。
  const simplified = [];
  for (const point of routed) {
    while (simplified.length >= 2) {
      const a = simplified.at(-2), b = simplified.at(-1);
      if ((a[0] === b[0] && b[0] === point[0]) || (a[1] === b[1] && b[1] === point[1])) simplified.pop(); else break;
    }
    simplified.push(point);
  }
  return simplified;
}
function resolveEdges() {
  const sides = new Map();
  for (const spec of edgeSpecs) {
    spec.source = endpoint(spec.points[0], spec.points[1]);
    spec.target = endpoint(spec.points.at(-1), spec.points.at(-2));
    for (const [end, point] of [['source', spec.points[0]], ['target', spec.points.at(-1)]]) if (spec[end]) {
      const anchor = spec[end], key = anchor.box + ':' + anchor.side;
      if (!sides.has(key)) sides.set(key, []);
      sides.get(key).push({ anchor, coordinate: point[normal(anchor.side)[0] ? 1 : 0] });
    }
  }
  for (const group of sides.values()) {
    group.sort((a, b) => a.coordinate - b.coordinate);
    group.forEach((entry, i) => Object.assign(entry.anchor, { slot: i + 1, count: group.length }));
  }
  for (const spec of edgeSpecs) spec.points = orthogonalRoute(spec);
}
function text(x, y, value, cls = 'body', anchor = 'start') { return `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${esc(value)}</text>`; }
function lines(x, y, values, cls = 'body', step = 25) { return values.map((s, i) => text(x, y + i * step, s, cls)).join(''); }
function fitted(x, y, value, width, cls = 'body') {
  const size = { 'node-title': 19, 'group-title': 21, small: 15, body: 18 }[cls] || 18;
  const estimate = [...String(value)].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? size : size * .57), 0);
  return text(x, y, value, cls).replace('<text ', `<text ${estimate > width ? `textLength="${width}" lengthAdjust="spacingAndGlyphs" ` : ''}`);
}
function compact(x, y, w, h, id, name, kind = 'component') {
  return `<g class="node ${kind}" ${register(id, registry[id] || { name, kind })}><rect ${boxAttributes(id, x, y, w, h)} x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${kind === 'component' ? '#f2faf5' : '#fff'}" stroke="${colors[kind] || colors.system}"/>${fitted(x + 12, y + h / 2 + 6, name, w - 24, 'node-title')}</g>`;
}
function register(id, data) { registry[id] = data; return `data-id="${esc(id)}" tabindex="0" role="button" aria-label="${esc(data.name || data.title || id)}"`; }
function frame(x, y, w, h, label, subtitle = '', tone = '#526477', geometryId = null) {
  return `<g><rect ${geometryId ? boxAttributes(geometryId, x, y, w, h, true) : ''} x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="#fff" stroke="${tone}" stroke-width="1.5"/><path d="M${x},${y + 57}H${x + w}" stroke="#dae2e8"/>${fitted(x + 20, y + 30, label, w - 40, 'group-title')}${subtitle ? fitted(x + 20, y + 49, subtitle, w - 40, 'small') : ''}</g>`;
}
function card(x, y, w, h, id, title, rows = [], kind = 'system', extra = '') {
  const data = registry[id] || { id, name: title, kind, description: rows.join('；') };
  const color = colors[kind] || colors.system;
  const stereotype = { system: 'System', observer: 'Observer', engine: 'Engine', sync: 'Commands / Sync', resource: 'Resource', local: 'Local', external: 'External I/O', event: 'EntityEvent', message: 'Message', component: 'Component', entity: 'Entity' }[kind] || kind;
  // 类型由标签与颜色表达；矩形避免 EntityEvent 装饰尖角成为连线出口。
  const shape = `<rect ${boxAttributes(id, x, y, w, h)} x="${x}" y="${y}" width="${w}" height="${h}" rx="${kind === 'observer' ? 20 : kind === 'system' || kind === 'engine' ? 10 : 3}" fill="${kind === 'component' ? '#f2faf5' : kind === 'observer' ? '#f8f3fc' : kind === 'resource' ? '#fffaf0' : kind === 'event' ? '#fff8ed' : '#fff'}" stroke="${color}" stroke-width="1.7" ${kind === 'local' ? 'stroke-dasharray="5 4"' : ''}/>`;
  return `<g class="node ${kind}" ${register(id, data)}>${shape}${kind === 'observer' ? `<rect x="${x + 5}" y="${y + 5}" width="${w - 10}" height="${h - 10}" rx="16" fill="none" stroke="${color}" stroke-opacity=".28"/>` : ''}${text(x + 14, y + 21, `«${stereotype}»`, 'stereotype')}${fitted(x + 14, y + 48, title, w - 34, 'node-title')}${rows.map((r, i) => fitted(x + 14, y + 73 + i * 23, r, w - 34, extra || 'body')).join('')}</g>`;
}
const brief = {
 frame_limit:'按设置等待帧间剩余时间',time_update:'更新引擎时间与固定步累积',input_update:'更新键鼠状态与窗口输入消息',mouse_capture:'窗口 / Egui 命中 → 捕获与上下文',enhanced_prepare:'准备有效输入上下文和绑定',enhanced_evaluate:'评估绑定、条件和动作状态',input_apply:'写动作输出，排入 trigger 命令',
 facing_fixed:'按相机 yaw 同步人物朝向',movement:'输入 / 实际速度 → 有上限的控制力',gravity:'消费跳跃请求 → 一次向上冲量',interaction:'射线 / 范围 → 拾取或保留动量释放',held_apply:'应用持握关系、目标与碰撞层',held_fixed:'角色呈现姿态 → HeldTarget',facing_update:'保留插值位置，同步本帧 yaw',held_update:'更新呈现目标，不搬箱或施力',camera_follow:'插值位置 + 观察状态 → 镜头',visibility_update:'视角模式 → 人物模型可见性',perspective_apply:'消费请求，切换第一 / 第三人称',
 gravity_sync:'配置变化 → Gravity',grounded_fixed:'脚底 shape cast → 接地状态',grounded_after:'物理回写后重新探测接地',orphan_cleanup:'失效持有者 / 关系 → 自由碰撞',orphan_apply:'应用失效清理命令',grip_forces:'真实 Position / 速度 → 弹簧与反作用力',velocity_log:'解算后实际速度 → 采样日志',collision_log:'CollisionStart / End → 文件日志',physics_prepare:'准备物理位姿、质量与碰撞数据',physics_step:'积分 / 接触 / 子步求解 → 真实运动',physics_writeback:'Position / Rotation → Transform',easing_reset:'FixedFirst：重置并记录插值起点',easing_end:'FixedLast：记录物理步插值终点',easing_apply:'固定循环后按 overstep 插值',easing_tick:'显示同步后记录变化 tick',
 transform_propagate:'根 Transform → 子 GlobalTransform',render:'提取 ECS 数据，准备并绘制画面',observe_move:'路由到角色，更新持续移动轴',observe_complete:'移动完成，将轴归零',observe_cancel:'移动取消，将轴归零',observe_jump:'路由到角色，设置跳跃请求',observe_interact:'路由到角色，设置交互请求',observe_look:'有效捕获时更新当前模式角度',observe_perspective:'记录请求来源，稍后统一切换',audio_preload:'清单契约 → 短音加载与映射',audio_load_failures:'资产加载失败 → 会话日志',audio_play:'请求 / 加载 / 冷却 / 并发 → 播放队列',audio_stop:'AppExit → UI / SFX 通道停止',audio_strain:'持续持握误差 → 一次警告',audio_land:'真实支撑冲量 → 一次落地反馈'
};
const displayNames = { time_update:'TimeSystems',input_update:'InputSystems',enhanced_prepare:'Enhanced Input · Prepare',enhanced_evaluate:'Enhanced Input · Update',input_apply:'Enhanced Input · Apply',held_apply:'ApplyDeferred · 持有关系',capture_apply:'ApplyDeferred · 上下文',inspector_pass:'World Inspector · UI Pass',transform_propagate:'Transform · Propagate',render:'RenderApp · 渲染概览' };
Object.assign(brief, {
  flow_enter_menu: 'MainMenu：展示主菜单并恢复展示动画时间',
  flow_pause: 'Paused：保存返回来源，展示暂停菜单',
  flow_suspend: '停物理，暂停另停虚拟时间；清意图并释放光标',
  flow_resume: 'Running：恢复时间，重新捕获并跳过鼠标位移',
  menu_spawn_controller: '创建菜单输入控制者及 Enhanced Input 绑定',
  menu_sync_context: '窗口焦点 → MenuContext；Hidden 仍保留 Esc',
  menu_handle_requests: '消费菜单消息 → 页面 / 设置 / NextState',
  menu_rebuild: '页面变化 → BSN 重建 UI 实体树',
  menu_pointer: '真实鼠标移动切输入来源；进入 / 离开同步悬停',
  menu_style: 'Interaction / 导航焦点 → 按钮纸色或黄色',
  menu_description: '当前设置焦点 → 右侧解释文字',
  menu_scroll_focus: '键盘 / 手柄焦点 → 可见滚动范围',
  menu_asset_failures: '资产加载失败 → 英文会话日志',
  menu_backdrop_spawn: '真实 GLB 展台 / 独立菜单相机；无地图碰撞',
  observe_release_pointer: 'F3：释放光标，保持 Running 和检查器',
});
function system(x, y, w, id, extraRows = null, height = 112) {
  const s = systems[id]; if (!s) throw new Error(`Missing system ${id}`);
  registry[id] = s;
  return card(x, y, w, height, id, displayNames[id] || s.name, extraRows || [brief[id] || s.description], s.kind, 'small');
}
function edge(points, label = '', kind = 'order', labelPoint = null, ids = [], arrow = true) {
  const index = edgeSpecs.length;
  edgeSpecs.push({ points, label, kind, labelPoint, ids, arrow });
  return '<!--edge-' + index + '-->';
}
function renderEdge(spec) {
  const { points, label, kind, labelPoint, ids, arrow } = spec;
  const c = { order: '#324153', read: '#2d72ad', write: '#288554', trigger: '#bf651e', reference: '#7b65a6', relationship: '#7b65a6', registration: '#89939f' }[kind] || '#324153';
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');
  const dash = ['read', 'trigger', 'reference', 'registration'].includes(kind) ? 'stroke-dasharray="6 5"' : '';
  const midpoint = labelPoint || points[Math.floor(points.length / 2)];
  const width = Math.max(44, [...label].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 17 : 9), 0) + 16);
  // 汇合支线只表达连接；仅进入目标节点的末段带箭头，避免把汇合点误读为目标。
  return `<g class="edge ${kind}" data-connect="${esc(ids.join('|'))}" data-source-anchor="${esc(JSON.stringify(spec.source))}" data-target-anchor="${esc(JSON.stringify(spec.target))}"><path d="${d}" stroke="${c}" stroke-width="${kind === 'order' ? 2.7 : 2}" fill="none" ${dash} ${arrow ? `marker-end="url(#arrow-${kind})"` : ''}/>${label ? `<rect x="${midpoint[0] - width / 2}" y="${midpoint[1] - 13}" width="${width}" height="24" rx="4" fill="#fffdf9"/>${text(midpoint[0], midpoint[1] + 4, label, 'edge-label', 'middle')}` : ''}</g>`;
}
function svg(name, width, height, body) {
  const markers = ['order', 'read', 'write', 'trigger', 'reference', 'relationship', 'registration'].map(k => { const c = { order: '#324153', read: '#2d72ad', write: '#288554', trigger: '#bf651e', reference: '#7b65a6', relationship: '#7b65a6', registration: '#89939f' }[k]; return `<marker id="arrow-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10" fill="${c}"/></marker>`; }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title"><title id="title">${esc(name)}</title><defs>${markers}<style>text{font-family:'Segoe UI','Microsoft YaHei',sans-serif;fill:#263648}.body{font-size:18px}.small{font-size:15px;fill:#576779}.stereotype{font-size:13px;fill:#687886;letter-spacing:.6px}.node-title{font-size:19px;font-weight:600}.group-title{font-size:21px;font-weight:600}.edge-label{font-size:16px}.page-title{font-size:32px;font-weight:650}.section-title{font-size:24px;font-weight:650}.note{font-size:17px;fill:#526477}.node{cursor:pointer}.node:focus{outline:none}.node.selected>rect,.node.selected>path{stroke:#db7521;stroke-width:4}.node.dim{opacity:.20}.edge.dim{opacity:.13}.edge.focused>path{stroke-width:3.5}</style></defs><rect width="100%" height="100%" fill="#f7f8fa"/>${text(36, 48, name, 'page-title')}${body}</svg>`;
}
function save(id, label, width, height, body, summary) {
  resolveEdges();
  const rendered = body.replace(/<!--edge-(\d+)-->/g, (_, index) => renderEdge(edgeSpecs[Number(index)]));
  const content = svg(label, width, height, rendered);
  fs.writeFileSync(path.join(dir, `ecs-${id}.svg`), content);
  views.push({ id, label, width, height, svg: content, summary });
  nodeBoxes = new Map(); edgeSpecs = [];
}

// 总览：保留最重要的执行路径和数据路径，完整函数在细节视图展开。
let b = text(36, 78, '先沿粗箭头看执行顺序，再沿 R / W 看数据；点击卡片查看源码与完整访问声明。', 'note');
registry['app-main'] = { name:'main / App',kind:'App',description:'创建 App 与会话日志，配置默认插件，加载设置，装配功能插件后进入主循环。退出时记录结果并刷新日志。',notes:model.startup_notes,source:{path:'src/main.rs',line:17} };
b += `<g class="node entity" ${register('app-main',registry['app-main'])}>${frame(30, 102, 1500, 222, '«App» main：装配应用与共享 World', 'Plugin 负责注册；下方位置不代表插件内部系统的执行先后。')}</g>`;
const plugins = ['DefaultPlugins', 'EguiPlugin', 'WorldInspectorPlugin', 'SettingsPlugin', 'GameplayPlugin', 'GameAudioPlugin', 'PlayerInputPlugin', 'CameraControlPlugin', 'PrototypeScenePlugin', 'StartupLogPlugin', 'AppFlowPlugin', 'GameUiPlugin'];
const pluginNotes = ['引擎输入、窗口、时间、变换、渲染与日志。','准备 Egui 上下文与界面绘制。','通过反射检查 ECS；仅 Running 显示。','设置加载、草稿校验、保存与限帧。','玩法资源、反射类型和固定模拟链。','Kira 输出、预加载、短音限制与退出停止。','输入上下文、动作与角色意图 Observer。','相机 Observer、捕获、视角与姿态同步。','共享场景资源；OnEnter(InGame) 生成玩法。','集中注册四项只读启动日志，沿用现有日志 target。','主菜单 / 游戏 / 暂停生命周期与时间门控。','BSN 页面、菜单输入、设置草稿与展示资产。'];
const mainLines = fs.readFileSync(path.join(dir, '../../src/main.rs'), 'utf8').split('\n');
registry['app-main'].source.line = mainLines.findIndex(l=>l.startsWith('fn main('))+1;
// 插件分三行展示；原物理与相机内容整体下移，保留原有走线。
plugins.forEach((name, i) => { const id = `plugin-${name}`; const line = mainLines.findIndex(l => l.trim() === name || l.trim().startsWith(name + ',') || l.trim().startsWith(name + '::')) + 1; registry[id] = { id, name, kind: 'Plugin', description: pluginNotes[i], notes: ['注册顺序不等于系统执行顺序。', ...(name.includes('Egui') || name.includes('Inspector') ? ['EguiPlugin 必须先于 WorldInspectorPlugin 构建。'] : [])], source: { path: 'src/main.rs', line } }; b += compact(44 + (i % 5) * 296, 165 + Math.floor(i / 5) * 52, 284, 42, id, name, 'plugin'); });
b += '<g transform="translate(0 104)">';
b += frame(30, 240, 1500, 108, '«Schedule» Startup · 启动一次', '菜单控制者、音频预加载与四项启动日志无彼此顺序；玩法场景改由 OnEnter(InGame) 生成。');
['menu_spawn_controller', 'startup_config', 'startup_timestep', 'startup_pose', 'startup_inspector', 'audio_preload'].forEach((id, i) => { registry[id] = systems[id]; b += compact(48 + i * 246, 303, 228, 32, id, systems[id].name, 'system'); });
const phases = [
  { x: 30, w: 330, name: 'First', note: '每个渲染帧', rows: ['限帧 → 时间更新', '默认上限 60 FPS；最低 60', 'Local：帧间计时'] },
  { x: 395, w: 330, name: 'PreUpdate', note: '输入与界面准备', rows: ['捕获 / 上下文 → 动作评估', '事件 → 意图 / 观察角度', '本帧消费视角切换请求'] },
  { x: 760, w: 330, name: 'FixedUpdate', note: 'FixedFirst 先记录插值起点', rows: ['朝向 / 重力 → 接地 / 控制力', '跳跃冲量 → 交互 / 清理', '持握目标 → 弹簧 / 反作用力'] },
  { x: 1125, w: 330, name: 'FixedPostUpdate', note: 'Avian 默认物理阶段', rows: ['Prepare → StepSimulation', '→ Writeback → 接地 / 速度日志', '真实位置 / 速度 / 碰撞'] },
  { x: 1490, w: 330, name: 'FixedLast', note: '固定步末尾', rows: ['记录本步插值终点', '角色：平移插值', '箱体：完整 Transform 插值'] },
  { x: 1855, w: 330, name: '固定循环之后', note: 'RunFixedMainLoop · 每帧', rows: ['Ease → 朝向 → HeldTarget', '→ 镜头 → 可见性', '→ UpdateEasingTick'] },
  { x: 2220, w: 330, name: 'Update', note: '每个渲染帧的音频输出', rows: ['加载失败日志 → 播放请求', '→ AppExit 时停止 UI / SFX', 'Kira 排队不改变玩法状态'] },
  { x: 2585, w: 330, name: 'PostUpdate', note: '本帧变换 / UI 后处理', rows: ['Transform → GlobalTransform', '检查器 UI 为同阶段独立分支', '→ 渲染子应用'] },
];
phases.forEach((p, i) => { b += frame(p.x, 382, p.w, 180, p.name, `«Schedule» · ${p.note}`, '#526477', `phase-${i}`); b += p.rows.map((r, i) => fitted(p.x + 17, 469 + i * 31, r, p.w - 34)).join(''); });
phases.slice(0, -1).forEach((p, i) => b += edge([[p.x + p.w, 420], [phases[i + 1].x, 420]]));
// 固定循环说明放在阶段卡片上方，避开下方的数据读写连线。
b += text(36, 371, 'FixedFirst → FixedUpdate → FixedPostUpdate → FixedLast 每帧 0～N 次；零固定步帧仍完成插值后显示链。', 'note');
const data = [
  { id: 'character.CharacterIntent', x: 395, w: 330, name: 'CharacterIntent', rows: ['movement：持续输入', 'jump_pending / interact_pending', '固定步消费后清除请求'] },
  { id: 'character.Position', x: 760, w: 330, name: '真实物理状态', rows: ['Position / Rotation / Velocity', 'CharacterMotion：仅 grounded', 'Transform：插值呈现位置'] },
  { id: 'parcel.HeldTarget', x: 1125, w: 330, name: 'HeldTarget / 物理持握', rows: ['目标仅供呈现检查', '施力另读真实 Position', '实际箱体可滞后 / 受碰撞阻挡'] },
  { id: 'world.Collider', x: 1490, w: 330, name: '静态世界碰撞', rows: ['地面与墙体两个盒形刚体', 'World / Character / Parcel', '持握箱忽略 Character 层'] },
  { id: 'camera.OrbitCamera', x: 1855, w: 330, name: 'OrbitCamera', rows: ['目标 / 模式 / yaw / 两组 pitch', '镜头读本帧插值后角色位置', '相机 Transform：最终姿态'] },
  { id: 'visual.GlobalTransform', x: 2585, w: 330, name: '视觉子实体', rows: ['Mesh3d / 材质，无物理体', 'ChildOf → 业务根实体', 'GlobalTransform → 渲染'] },
];
data.forEach(d => { registry[d.id] = { id: d.id, name: d.name, kind: 'Component', description: d.rows.join('；') }; b += card(d.x, 697, d.w, 151, d.id, d.name, d.rows, 'component', 'small'); });
registry['resource.GameSettings'] = model.resources.find(r => r.id === 'resource.GameSettings');
b += card(30, 697, 330, 151, 'resource.GameSettings', '共享 Resource', ['GameSettings：帧率 / 相机', 'PrototypeConfig / Gravity：物理', 'max_fps ≥ 60；默认 60'], 'resource', 'small');
b += edge([[195, 697], [195, 562]], 'R 设置', 'read', [195, 630], ['resource.GameSettings', 'frame_limit']);
b += edge([[560, 562], [560, 600], [560, 697]], 'W 意图', 'write', [560, 645], ['observe_move', 'character.CharacterIntent']);
b += edge([[650,562],[650,675],[1950,675],[1950,697]], 'W 角度 / 模式', 'write', [1670,675], ['observe_look','perspective_apply','camera.OrbitCamera']);
b += edge([[725, 754], [745, 754], [745, 610], [790, 610], [790, 562]], 'R 意图', 'read', [745, 649], ['character.CharacterIntent', 'movement']);
b += edge([[1290, 562], [1290, 648], [925,648], [925,697]], 'W 物理状态', 'write', [1120,648], ['physics_step', 'character.Position']);
b += edge([[2020, 697], [2020, 562]], 'R 角度', 'read', [2075, 655], ['camera.OrbitCamera', 'facing_update']);
b += edge([[2750, 562], [2750, 697]], 'W 世界变换', 'write', [2750, 641], ['transform_propagate', 'visual.GlobalTransform']);
b += text(36, 900, '图例：粗箭头＝执行顺序　R 蓝虚线＝读取　W 绿实线＝写入　Event 橙虚线＝触发　紫线＝引用 / 关系', 'note');
b += '</g>';
// GameplayPlugin 内部安装物理插件，不把内部注册伪装成 main 的额外插件。
const nestedPlugins = [['DemoPhysicsPlugin','src/gameplay.rs','add_plugins((DemoPhysicsPlugin, SoundEventsPlugin))'],['PhysicsPlugins::default()','src/physics.rs','add_plugins(PhysicsPlugins::default())']];
nestedPlugins.forEach(([name,file,needle],i)=>{const id=`plugin-physics-${i}`;registry[id]={name,kind:'Plugin',description:i?'Avian 默认 FixedPostUpdate 求解及物理插值插件。':'GameplayPlugin 内部安装，注册重力同步和碰撞日志。',notes:['内部插件注册关系；不表示系统执行顺序。'],source:{path:file,line:fs.readFileSync(path.join(dir,'../..',file),'utf8').split('\n').findIndex(line=>line.includes(needle))+1}};b+=card(1575+i*505,112,475,135,id,name,['GameplayPlugin → DemoPhysicsPlugin → Avian'],'engine','small');});
// 状态门控单独成区，避免将暂停误画成销毁并重建玩法场景。
b += frame(30, 1060, 2520, 410, 'AppFlow · 状态、场景与输入门控', 'AppState 控制场景生命周期；PlayState 是 InGame 内的子状态；MenuState 保存页面与返回来源。');
b += card(55, 1145, 700, 160, 'resource.AppState', 'MainMenu', ['OnEnter：show_main_menu → suspend_input', '生成菜单 GLB 展台；玩法输入 / 物理停用', 'Start Game → InGame，才创建玩法场景'], 'resource', 'small');
b += card(935, 1145, 700, 160, 'resource.PlayState', 'InGame / Running', ['OnEnter(InGame)：spawn_scene，业务根标记生命周期', 'OnEnter(Running)：恢复时间与光标捕获', 'GameplayContext、固定玩法、Inspector 有效'], 'resource', 'small');
b += card(1815, 1145, 700, 160, 'state-paused', 'InGame / Paused', ['OnEnter：show_pause_menu → suspend_input', 'Time<Virtual> / Time<Physics> 暂停并清本帧 delta', '保留业务实体；释放光标，隐藏 Inspector'], 'engine', 'small');
b += edge([[755,1225],[935,1225]], 'Start Game', 'order', [845,1225], ['resource.AppState','resource.PlayState','startup_spawn']);
b += edge([[1635,1225],[1815,1225]], 'Esc', 'trigger', [1725,1225], ['resource.PlayState','state-paused','flow_pause']);
b += edge([[2040,1305],[2040,1345],[1285,1345],[1285,1305]], 'Resume：保留原场景', 'order', [1620,1345], ['state-paused','flow_resume','resource.PlayState']);
b += edge([[2320,1305],[2320,1415],[405,1415],[405,1305]], 'Return to Main Menu：退出 InGame 时清理业务根', 'order', [1285,1415], ['state-paused','resource.AppState']);
b += frame(30, 1510, 2520, 310, 'Update · BSN 页面与鼠标 / 导航状态', 'UI 实体树更新后才处理指针，再更新显示；Style 组内系统不虚构串行顺序。');
b += system(55, 1595, 700, 'menu_rebuild', ['MenuState / UiTheme → UI 实体树', '自动宽度 Text 保留自然测量'], 130);
b += system(935, 1595, 700, 'menu_pointer', ['真实鼠标移动（含空白）→ Pointer', '进入高亮、离开恢复；按钮点击排入消息'], 130);
b += system(1815, 1595, 700, 'menu_style', ['鼠标模式按 Interaction；导航模式按 MenuFocus', 'Apply / 当前 Tab 无常驻黄色'], 130);
b += edge([[755,1660],[935,1660]], 'Build →', 'order', [845,1660], ['menu_rebuild','menu_pointer']);
b += edge([[1635,1660],[1815,1660]], 'Pointer → Style', 'order', [1725,1660], ['menu_pointer','menu_style']);
b += text(55, 1770, 'MenuInputSource：Pointer / Navigation；键盘或手柄实际导航后显示焦点。设置只在 Apply 成功后热生效并保存，取消丢弃草稿。', 'note');
// 音频插件装配和反馈路径单独列出；它们不建立新的玩法实体。
registry['plugin-sound-events']={name:'SoundEventsPlugin',kind:'Plugin',description:'GameplayPlugin 内部注册声音消息和无设备的物理反馈观察。',source:{path:'src/gameplay.rs',line:fs.readFileSync(path.join(dir,'../../src/gameplay.rs'),'utf8').split('\n').findIndex(l=>l.includes('add_plugins((DemoPhysicsPlugin, SoundEventsPlugin))'))+1}};
registry['plugin-kira']={name:'KiraAudioPlugin',kind:'Plugin',description:'GameAudioPlugin 安装 Kira 0.26.0；DefaultPlugins 禁用 Bevy 默认 AudioPlugin。',source:{path:'src/audio.rs',line:fs.readFileSync(path.join(dir,'../../src/audio.rs'),'utf8').split('\n').findIndex(l=>l.includes('app.add_plugins(KiraAudioPlugin)'))+1}};
b+=card(1575,278,475,116,'plugin-sound-events','SoundEventsPlugin',['GameplayPlugin 内部：反馈收集'],'engine','small');
b+=card(2080,278,475,116,'plugin-kira','KiraAudioPlugin',['GameAudioPlugin 内部：设备输出'],'engine','small');
model.resources.forEach(r=>registry[r.id]=r);
b+=text(36,1845,'菜单确认实际焦点 / 接受的操作，玩法确认物理结果；缓冲 Message 交给 UI Style 之后的 Update 播放。','note');
registry['audio-producers']={name:'已接入的反馈生产者',kind:'System group',description:'菜单真实焦点与接受的语义操作、成功拿起/释放、真实落地和持续持握偏差。',notes:['菜单三种与玩法四种 cue 已产生；交接、推车、弹开与交付共五种映射预留。'],source:systems.interaction.source};
b+=card(30,1885,650,155,'audio-producers','菜单 / 玩法反馈生产者',['MenuHover / MenuConfirm / MenuCancel','拿起 / 释放 / 落地 / 持握失稳','反馈不改变物理规则'],'system','small');
b+=card(800,1885,520,155,'resource.SoundRequestMessages','SoundRequest 消息',['cue：稳定事件标识','source：仅记录 Entity','延迟拿放消息与关系一起生效'],'message','small');
b+=card(1440,1885,520,155,'resource.SoundBank','SoundBank',['预加载句柄与清单策略','Time<Real>：暂停时冷却仍前进','总并发 4；SFX 最多 3，菜单保留 1'],'resource','small');
registry['audio-output']={name:'Update / Kira 播放输出',kind:'Engine',description:'读取 SoundRequest，检查加载/冷却/并发后向类型通道排队；AppExit 时停止。',reads:['resource.SoundBank','resource.SoundRequestMessages','resource.UiAudioChannel','resource.SfxAudioChannel'],source:systems.audio_play.source};
b+=card(2090,1885,825,155,'audio-output','UI Style → Update → Kira UI / SFX',['失败日志 → 播放请求 → 退出停止','线性音量乘 0.25 后转为 dB','ambience 只供试听，不自动播放'],'engine','small');
b+=edge([[680,1963],[800,1963]],'W','write',[740,1963],['audio-producers','resource.SoundRequestMessages']);
b+=edge([[1320,1962.5],[1380,1962.5],[1380,2075],[2502.5,2075],[2502.5,2040]],'R 请求','read',[1980,2075],['resource.SoundRequestMessages','audio-output']);
b+=edge([[1960,1963],[2090,1963]],'R','read',[2025,1963],['resource.SoundBank','audio-output']);
b+=edge([[2090,2007],[1960,2007]],'W','write',[2025,2007],['audio-output','resource.SoundBank']);
b+=edge([[1285,1725],[1285,1790],[1060,1790],[1060,1885]],'W MenuHover','write',[1060,1790],['menu_pointer','resource.SoundRequestMessages']);
b+=edge([[2515,1660],[2890,1660],[2890,1835],[2710,1835],[2710,1885]],'after(Style)','order',[2810,1835],['menu_style','audio-output']);
save('overview', '当前 App · ECS 总览', 2955, 2130, b, '主菜单 → InGame / Running ↔ Paused；菜单与玩法反馈使用 SoundRequest 交给 Update / Kira。');

// 时序视图：每个注册实例单独呈现，R/W 在卡片内列摘要，点击显示完整读写项。
b = text(36, 80, '系统卡片中的 R / W 是访问摘要；同一函数在不同 Schedule 中有两个注册实例。', 'note');
const columns = [
  { x: 30, w: 300, phase: 'First', note: '每帧一次', ids: ['frame_limit', 'time_update'] },
  { x: 375, w: 420, phase: 'PreUpdate', note: '每帧一次；响应输入', ids: [] },
  { x: 840, w: 420, phase: 'FixedFirst / FixedUpdate', note: '60 Hz · 每帧 0～N 次', ids: [] },
  // 保持卡片宽度，给独立碰撞日志支线预留右侧走线槽。
  { x: 1305, w: 430, nodeWidth: 380, phase: 'FixedPostUpdate', note: 'Avian 默认物理解算', ids: ['physics_prepare','physics_step','physics_writeback','grounded_after','velocity_log'] },
  { x: 1760, w: 330, phase: 'FixedLast', note: '每个固定步末尾', ids: ['easing_end'] },
  { x: 2135, w: 380, phase: '固定循环之后', note: 'RunFixedMainLoop · AfterFixedMainLoop', ids: ['easing_apply','facing_update','held_update','camera_follow','visibility_update','easing_tick'] },
  { x: 2560, w: 390, phase: 'Update · 音频', note: 'after(UiSystems::Style)', ids: ['audio_load_failures','audio_play','audio_stop'] },
  { x: 3005, w: 390, phase: 'PostUpdate / 渲染', note: '本帧变换 / UI 后处理', ids: [] },
];
const accessName = value => value.split('.').pop().replace(/\s*\(.*/, '');
function accessRows(id) { const s = systems[id]; const summarize = values => { const rank = v => v.startsWith('resource.') ? 1 : v.startsWith('local.') ? 2 : 0; const sorted = [...values].sort((a,b)=>rank(a)-rank(b)); return sorted.map(accessName).slice(0,2).join(' / ') + (values.length>2?' …':''); }; return [brief[id] || s.description, ...(s.reads.length ? [`R ${summarize(s.reads)}`] : []), ...(s.writes.length ? [`W ${summarize(s.writes)}`] : [])].slice(0, 3); }
columns.forEach((col, index) => { const nodeWidth = col.nodeWidth ?? col.w - 30, centerX = col.x + 15 + nodeWidth / 2; b += frame(col.x, 112, col.w, 1980, col.phase, `«Schedule» · ${col.note}`, '#526477', `lane-${index}`); col.ids.forEach((id, i) => {
  b += system(col.x + 15, 193 + i * 160, nodeWidth, id, accessRows(id), 130);
  if (i) b += edge([[centerX, 163 + i * 160], [centerX, 193 + i * 160]]);
 }); });
// 这里只展开和捕获逻辑有关的输入集合；主 UI 的多轮执行另列于 PostUpdate。
[['input_update','InputSystems'],['egui_input','Egui · ProcessInput'],['filter_egui_input','filter_captured_egui_input'],['egui_begin','Egui · BeginPass（集合边界）']].forEach(([id,label],i)=>{registry[id]=systems[id];b+=compact(390,193+i*50,390,28,id,label,systems[id].kind);b+=edge([[585,221+i*50],[585,i===3?400:243+i*50]],'','order',null,[id,i===3?'mouse_capture':['egui_input','filter_egui_input','egui_begin'][i]]);});
const preNodes = [ ['mouse_capture', 400, 130], ['capture_apply', 555, 96], ['enhanced_prepare', 676, 96], ['enhanced_evaluate', 797, 96], ['input_apply', 918, 106], ['event_apply', 1049, 106], ['perspective_apply', 1180, 130] ];
systems.event_apply = { id:'event_apply', name:'ApplyDeferred · 动作事件', kind:'sync', phase:'PreUpdate', description:'应用 Enhanced Input 排入的 trigger 命令，此时触发匹配 Observer。', reads:[], writes:['character.CharacterIntent','camera.OrbitCamera'], filters:[], events:model.observers.map(o=>o.event), notes:['这是命令同步点，不是 EnhancedInputSystems::Apply。','apply_perspective_toggle.after(EnhancedInputSystems::Apply) 建立依赖；常规调度在需要时自动应用延迟命令。','Observer 之间没有注册顺序所保证的串行依赖。'], source:systems.perspective_apply.source };
brief.event_apply = '应用 trigger 命令 → 匹配动作 Observer';
brief.capture_apply = '应用 ContextActivity 替换';
brief.held_apply = '关系 / 碰撞层 / 已接受声音消息生效';
preNodes.forEach(([id,y,h],i)=>{b += system(390,y,390,id,h===130?accessRows(id):[brief[id] || systems[id].description],h);if(i){const previous=preNodes[i-1];b+=edge([[585,previous[1]+previous[2]],[585,y]],'','order',null,[previous[0],id]);}});
b += text(399, 1339, 'UI 捕获停用 GameplayContext；', 'small');
b += text(399, 1365, '动作 Complete / Cancel 清除移动轴。', 'small');
b += system(855, 193, 390, 'easing_reset', [brief.easing_reset], 96);
// 重力与朝向都在玩法链之前，但二者没有显式先后依赖。
// 两卡和下方玩法链整体下移，分叉末段留出 46px；约 19px 的箭头头部之外仍有可见竖线。
b += system(855, 360, 187, 'gravity_sync', [brief.gravity_sync], 96);
b += system(1058, 360, 187, 'facing_fixed', ['水平 yaw → 朝向'], 96);
b += edge([[948,456],[948,480],[1050,480]],'','order',null,['gravity_sync','grounded_fixed'],false);
b += edge([[1151,456],[1151,480],[1050,480]],'','order',null,['facing_fixed','grounded_fixed'],false);
b += edge([[1050,480],[1050,510]],'','order',null,['gravity_sync','facing_fixed','grounded_fixed']);
// 说明分居汇合点两侧，不遮挡指向玩法链的竖线与箭头。
b += text(860, 502, '二者无彼此顺序', 'small');
b += text(1080, 502, '下方为显式玩法链', 'small');
const fixedNodes = ['grounded_fixed','movement','gravity','interaction','held_apply','orphan_cleanup','orphan_apply','held_fixed','grip_forces','audio_strain'];
fixedNodes.forEach((id,i)=>{const y=510+i*160;b+=system(855,y,390,id,accessRows(id),130);if(i)b+=edge([[1050,y-30],[1050,y]],'','order',null,[fixedNodes[i-1],id]);});
b += edge([[1050,289],[1050,314],[948,314],[948,360]],'','order',null,['easing_reset','gravity_sync']);
b += edge([[1050,314],[1151,314],[1151,360]],'','order',null,['easing_reset','facing_fixed']);
b += system(1320, 1170, 380, 'collision_log', accessRows('collision_log'), 130);
// 支线从卡片边缘出发，绕过中间节点；标签放在线外，保留转折及箭头的连续走线。
b += edge([[1700,415],[1723,415],[1723,1415]],'','order',null,['physics_step','collision_log','audio_land'],false);
b += edge([[1723,1135],[1510,1135],[1510,1170]],'after(StepSimulation)','order',[1510,1100],['physics_step','collision_log']);
b += system(1320,1460,380,'audio_land',accessRows('audio_land'),130);
b += edge([[1723,1415],[1510,1415],[1510,1460]],'after(StepSimulation)','order',[1510,1388],['physics_step','audio_land']);
b += text(1324,1640,'落地 / 日志 / Writeback 观察无额外全序','small');
b += text(1324, 1350, '碰撞日志与 Writeback 后观察无全序', 'small');
b += system(3020, 193, 320, 'transform_propagate', ['R 根 Transform / ChildOf', 'W GlobalTransform（另有可见性传播）'], 118);
b += system(3020, 365, 320, 'inspector_pass', ['仅 InGame / Running：反射读取 / 编辑', 'multipass：界面可在此多轮处理'], 118);
b += text(3029, 340, '相关分支并列；彼此未指定全序', 'small');
// 两条渲染分支使用独立入口，右侧留出走线空间，避免沿卡片边框或合并箭头。
b += edge([[3340, 252], [3373, 252], [3373, 566], [3260, 566], [3260, 610]], '', 'order', null, ['transform_propagate','render']);
b += edge([[3180, 483], [3180, 610]], '', 'order', null, ['inspector_pass','render']);
b += system(3020, 610, 320, 'render', ['Extract → Prepare → Render', 'RenderApp 是子应用，不是单个系统'], 118);
columns.slice(0, -1).forEach((col, i) => b += edge([[col.x + col.w, 144], [columns[i + 1].x, 144]]));
b += text(43, 2140, 'Startup：菜单控制者、音频预加载与四项日志无彼此顺序；OnEnter(InGame) 才生成物理主体与碰撞体。', 'note');
b += text(43, 2174, 'Commands 同步点用琥珀色框；碰撞日志与回写后接地/采样只有各自明确的依赖。', 'note');
b += text(43, 2208, '固定循环每帧 0～N 次；AfterFixedMainLoop 的 Ease → 显示链 → UpdateEasingTick 每帧执行。', 'note');
b += text(43, 2242, 'HeldTarget 仅呈现检查；物理施力直接读 Position，不读取插值目标，不把箱体直接搬到手前。', 'note');
// 新增菜单泳道放在原图下方；不改变旧物理支线的空间与箭头。
b += frame(30, 2330, 680, 535, 'Startup · 一次注册', '以下系统彼此无串行约束；场景生成不在 Startup。');
['menu_spawn_controller','startup_config','startup_timestep','startup_pose','startup_inspector','audio_preload'].forEach((id,i)=>{
  b += system(50 + i % 2 * 330, 2415 + Math.floor(i / 2) * 150, 310, id, [brief[id] || systems[id].description], 110);
});
b += frame(750, 2330, 680, 535, 'PreUpdate · 菜单上下文与消息', 'MenuContext 按窗口焦点启用；Hidden 时保留 Back 动作处理暂停。');
b += system(770, 2415, 640, 'menu_sync_context', accessRows('menu_sync_context'), 130);
b += system(770, 2605, 640, 'menu_handle_requests', accessRows('menu_handle_requests'), 130);
b += text(777, 2580, '上下文同步在 Prepare 前；消息消费在动作 Apply 后。', 'small');
b += text(777, 2780, 'UiRequest → 页面 / 设置草稿 / NextState / 退出请求。', 'small');
b += frame(1470, 2330, 1480, 535, 'StateTransition · 生命周期', 'OnEnter(MainMenu / Paused) 的页面切换在 suspend_input 前；其余不同入口不组成串行链。');
['flow_enter_menu','flow_pause','flow_suspend','flow_resume','startup_spawn','menu_backdrop_spawn'].forEach((id,i)=>{
  b += system(1490 + i % 3 * 485, 2415 + Math.floor(i / 3) * 200, 455, id, [brief[id] || systems[id].description, systems[id].phase], 130);
});
b += text(1495, 2790, '退出 InGame：业务根与子实体清理；退出 MainMenu：菜单相机与展台清理。暂停不清理玩法实体。', 'small');
b += frame(30, 2910, 2920, 560, 'Update · Build → Pointer → Style', 'UiSystems 的显式阶段顺序；Style 内样式、说明与滚动独立运行，资产失败记录为独立分支。');
b += system(55, 2995, 790, 'menu_rebuild', accessRows('menu_rebuild'), 130);
b += system(1045, 2995, 790, 'menu_pointer', accessRows('menu_pointer'), 130);
b += card(2035, 2995, 890, 130, 'ui-style-set', 'UiSystems::Style', ['在 Pointer 之后执行三个显示系统', '组内没有彼此先后约束；样式不改变设置草稿'], 'engine', 'small');
b += edge([[845,3060],[1045,3060]], '应用 UI 命令', 'order', [945,3060], ['menu_rebuild','menu_pointer']);
b += edge([[1835,3060],[2035,3060]], 'Pointer → Style', 'order', [1935,3060], ['menu_pointer','ui-style-set']);
['menu_style','menu_description','menu_scroll_focus'].forEach((id,i)=>{
  b += system(2035 + i * 300, 3230, 290, id, [brief[id]], 115);
  const targetX = 2180 + i * 300;
  b += edge([[targetX,3125],[targetX,3230]], '', 'registration', null, ['ui-style-set',id]);
});
b += system(55, 3230, 790, 'menu_asset_failures', accessRows('menu_asset_failures'), 130);
b += card(1045, 3230, 790, 130, 'resource.MenuInputSource', '菜单输入来源', ['Navigation：实际键盘 / 手柄导航显示焦点', 'Pointer：真实鼠标移动（含空白）恢复悬停规则', '进入高亮 / 离开纸色；Apply / 当前 Tab 无常驻黄'], 'resource', 'small');
b += text(55, 3425, '门控：MainMenu / Paused 停用玩法上下文并冻结物理；Running 恢复输入，菜单与暂停隐藏 Inspector。F3 仅释放指针供检查器编辑。', 'note');
b += text(1045, 3390, 'Pointer 发 MenuHover；音频完整链在 Style 后消费。', 'small');
save('schedules', '调度泳道 · 系统与数据访问', 3435, 3505, b, '原固定模拟与相机链保留；下方展开菜单输入、状态入口、BSN 页面与样式顺序。');

// 关系视图：矩形容器表达实体，内嵌组件；普通 Entity 引用与 Bevy 关系单独标注。
b = text(36, 80, '按实体角色汇总关键组件，可选组件并非始终存在；虚线＝普通引用，紫实线＝Bevy 关系。', 'note');
const entityBoxes = [
  { id: 'controller', x: 30, y: 112, w: 360, h: 350 }, { id: 'action', x: 540, y: 112, w: 360, h: 315 }, { id: 'binding', x: 1050, y: 112, w: 360, h: 230 },
  { id: 'character', x: 30, y: 650, w: 360, h: 600 }, { id: 'parcel', x: 540, y: 650, w: 360, h: 615 }, { id: 'camera', x: 1050, y: 650, w: 360, h: 365 },
  { id: 'world', x: 1050, y: 1080, w: 360, h: 430 },
  { id: 'visual', x: 30, y: 1540, w: 360, h: 355 }, { id: 'window', x: 1050, y: 1580, w: 360, h: 270 },
];
const primaryComponents = { controller: ['PlayerId', 'GameplayContext', 'ContextActivity', 'ControlsCharacter', 'ControlsCamera', 'Actions', 'GamepadDevice'], action: ['Action', 'ActionSettings', 'ActionOf', 'Bindings', 'Press'], binding: ['Binding', 'BindingOf'], character: ['Character', 'CharacterIntent', 'CharacterMotion', 'RigidBody', 'Collider', 'Position', 'LinearVelocity', 'Transform', 'CollisionLayers', 'LockedAxes', 'TranslationInterpolation', 'HoldingItems', 'Children'], parcel: ['Parcel', 'Pickable', 'RigidBody', 'Collider', 'Position', 'LinearVelocity', 'AngularVelocity', 'Transform', 'CollisionLayers', 'HeldBy', 'HeldTarget', 'TransformInterpolation', 'Children'], camera: ['OrbitCamera', 'MouseLookState', 'Camera3d', 'Transform'], world: ['RigidBody','Collider','CollisionLayers','Transform','Mesh3d','MeshMaterial3d'], visual: ['CharacterVisual', 'Mesh3d', 'MeshMaterial3d', 'Transform', 'GlobalTransform', 'ChildOf'], window: ['PrimaryWindow', 'Window', 'CursorOptions'] };
entityBoxes.forEach(box => { const e = entities[box.id]; registry[`entity-${e.id}`] = { ...e, name: e.name, kind: 'Entity' };
  const shortName = {visual:'视觉子实体',action:'动作',binding:'输入绑定',controller:'控制者',character:'角色',parcel:'木箱快递',camera:'相机',world:'静态地面 / 墙体',window:'主窗口'}[e.id];
  b += `<g class="node entity" ${register(`entity-${e.id}`, registry[`entity-${e.id}`])}>${frame(box.x, box.y, box.w, box.h, `«Entity» ${shortName}`, e.id==='visual'?'6 个：人物 3、木箱 3':`当前数量：${e.count}`, colors.entity, `entity-${e.id}`)}</g>`;
  const key = c => c.name.split('<')[0].split(' ')[0];
  const visible = e.components.filter(c => primaryComponents[e.id].includes(key(c))).sort((a, b) => primaryComponents[e.id].indexOf(key(a)) - primaryComponents[e.id].indexOf(key(b)));
  e.components.forEach(c => registry[c.id] = { ...c, kind: 'Component', owner: e.name });
  visible.forEach((c, i) => {
    const label = c.name==='CharacterVisual'?'CharacterVisual（仅人物）':c.name;
    b += compact(box.x + 15, box.y + 71 + i * 34, box.w - 30, 30, c.id, label);
  });
  b += text(box.x + 16, box.y + box.h - 12, `完整清单：${e.components.length} 项组件 · 点击实体查看`, 'small');
});
b += edge([[540, 214], [390, 214]], 'ActionOf', 'relationship', [465, 315], ['entity-action', 'entity-controller']);
b += text(408, 344, '← Actions', 'small');
b += text(408, 369, '反向索引', 'small');
b += edge([[1050, 214], [900, 214]], 'BindingOf', 'relationship', [975, 299], ['entity-binding', 'entity-action']);
b += text(921, 327, '← Bindings', 'small');
b += text(921, 352, '反向索引', 'small');
b += edge([[152, 462], [152, 535], [152, 650]], 'ControlsCharacter', 'reference', [150, 610], ['entity-controller', 'entity-character']);
b += edge([[326, 462], [326, 493], [170, 493], [170, 570], [1230, 570], [1230, 650]], 'ControlsCamera', 'reference', [778, 570], ['entity-controller', 'entity-camera']);
b += edge([[1350, 650], [1350, 546], [370, 546], [370, 462]], 'toggle_requested_by（临时）', 'reference', [875, 546], ['entity-camera', 'entity-controller']);
b += edge([[1143, 650], [1143, 600], [273, 600], [273, 650]], 'OrbitCamera.target', 'reference', [735, 600], ['entity-camera', 'entity-character']);
b += edge([[540, 810], [390, 810]], 'HeldBy', 'relationship', [465, 925], ['entity-parcel', 'entity-character']);
b += text(399, 986, '← HoldingItems', 'small');
b += text(407, 1011, '无 linked_spawn', 'small');
b += edge([[157, 1540], [157, 1250]], 'ChildOf：人物模型', 'relationship', [210, 1400], ['entity-visual', 'entity-character']);
// 标签靠近下方横线，避开 Resource 框的边界与竖向走线。
b += edge([[390,1717.5],[430,1717.5],[430,1680],[965,1680],[965,957.5],[900,957.5]], 'ChildOf：箱子模型', 'relationship', [690, 1655], ['entity-visual', 'entity-parcel']);
b += frame(540, 1910, 870, 228, '关系的基数与生命周期', '这里只描述当前源码声明的行为。');
b += lines(561, 1994, ['HeldBy：每箱 0..1 位持有者；HoldingItems 容器允许 0..N，当前业务一次持一件。', 'ActionOf / BindingOf / ChildOf 声明 linked_spawn；HeldBy 不连带销毁箱体。', '失效持有者 / 异常解除：移除 HeldTarget、恢复自由碰撞，动态箱体自然下落。', 'Position / Velocity 为物理状态，Transform 为插值呈现；视觉子实体无刚体。', '持握使用反作用力，仍参与世界碰撞；持握箱当前忽略全部 Character 层。'], 'small', 27);
b += frame(540, 1300, 360, 338, '«Resource / Local» 数据范围', 'Resource 共享；Local 属于某个系统。');
model.resources.forEach(r => registry[r.id] = r);
['resource.GameSettings','resource.PrototypeConfig','resource.TimeFixed','resource.Gravity','resource.ColliderTrees','resource.ContactGraph'].forEach((id,i)=>{const r=registry[id];b+=compact(554,1370+i*33,332,28,id,r.name,'resource');});
b += text(557, 1593, '预留集合 / 采样计时：Local', 'small');
b += text(557, 1621, 'LastEasingTick：插值共享 Resource', 'small');
b += frame(540,1720,360,168,'«Resource» 音频数据','警告 / 落地锁存各属于系统 Local。');
['resource.SoundBank','resource.UiAudioChannel','resource.SfxAudioChannel'].forEach((id,i)=>{const r=registry[id];b+=compact(554,1791+i*33,332,28,id,r.name,'resource');});
// 菜单实体独立列在右侧，省略 BSN 中间布局容器但保留完整组件详情。
const menuEntityBoxes = [
  { id:'menu_controller', x:1500, y:112, w:430, h:350 }, { id:'menu_root', x:2030, y:112, w:430, h:350 },
  { id:'menu_scroll', x:1500, y:560, w:430, h:430 }, { id:'menu_button', x:2030, y:560, w:430, h:430 },
  { id:'menu_backdrop', x:1500, y:1100, w:430, h:380 }, { id:'menu_camera', x:2030, y:1100, w:430, h:380 },
  { id:'menu_model', x:1500, y:1630, w:430, h:430 }, { id:'menu_text', x:2030, y:1630, w:430, h:430 },
];
menuEntityBoxes.forEach(box=>{
  const entity = entities[box.id];
  if (!entity) throw new Error(`Missing menu entity ${box.id}`);
  const id = `entity-${entity.id}`;
  registry[id] = {...entity,kind:'Entity'};
  b += `<g class="node entity" ${register(id,registry[id])}>${frame(box.x,box.y,box.w,box.h,`«Entity» ${entity.name}`,`当前数量：${entity.count}`,colors.entity,id)}</g>`;
  entity.components.forEach(component=>registry[component.id]={...component,kind:'Component',owner:entity.name});
  const visible = entity.components.slice(0,Math.floor((box.h-110)/34));
  visible.forEach((component,i)=>b+=compact(box.x+15,box.y+71+i*34,box.w-30,30,component.id,component.name));
  b += text(box.x+16,box.y+box.h-12,`完整清单：${entity.components.length} 项组件 · 点击实体查看`,'small');
});
b += edge([[1715,560],[1715,515],[2245,515]], '', 'relationship', null, ['entity-menu_scroll','entity-menu_root'], false);
b += edge([[2245,560],[2245,515]], '', 'relationship', null, ['entity-menu_button','entity-menu_root'], false);
b += edge([[2245,515],[2245,462]], '', 'relationship', null, ['entity-menu_scroll','entity-menu_button','entity-menu_root']);
b += text(1735, 499, 'Children / ChildOf 子树（中间容器省略）', 'small');
b += text(1520, 1030, '菜单控制者复用 ActionOf / BindingOf 模式；Coming Soon 装饰不含 MenuButton。', 'small');
b += text(1520, 1060, '文字叶节点使用自然宽度；说明标题 / 正文由焦点系统更新。', 'small');
b += edge([[2030,1250],[1930,1250]], 'ChildOf', 'relationship', [1980,1250], ['entity-menu_camera','entity-menu_backdrop']);
b += edge([[1715,1630],[1715,1480]], 'ChildOf 子树', 'relationship', [1715,1555], ['entity-menu_model','entity-menu_backdrop']);
b += text(2050, 1530, 'MainMenu 退出清理舞台与相机；', 'small');
b += text(2050, 1557, '页面重建仅清 MenuRoot 的 UI 子树。', 'small');
b += frame(1500, 2160, 960, 405, '«Resource / Message» 菜单与生命周期共享数据', '草稿与已应用设置分开；NextState 决定后续状态入口；GLB 展示资产没有物理碰撞地图。');
const menuResourceIds = ['resource.AppState','resource.PlayState','resource.MenuState','resource.MenuFocus','resource.MenuInputSource','resource.SettingsDraft','resource.SettingsFile','resource.UiTheme','resource.UiRequestMessages','resource.TimePhysics','resource.AssetServer','resource.AssetsAnimationGraph','resource.AssetLoadFailedMessages'];
menuResourceIds.forEach((id,i)=>{
  const resource = registry[id];
  if (!resource) throw new Error(`Missing menu resource ${id}`);
  b += compact(1520+i%2*465,2245+Math.floor(i/2)*40,440,32,id,resource.name,'resource');
});
b += text(1520, 2540, 'Pause：保留 InGame 世界，冻结时间；Return to Main Menu：DespawnOnExit(InGame) 清理业务根。', 'small');
save('relationships', '实体 · 组件归属与关系', 2490, 2600, b, '左侧保留物理与持握关系；右侧展开菜单输入、BSN 子树、文字、展示舞台及共享资源。');

// 通信视图：输入动作事件、全局 Observer 与窗口缓冲消息保持不同路线。
b = text(36, 80, `${model.observers.length} 个 Observer 由匹配事件触发；它们不是按 add_observer 的注册顺序组成流水线。`, 'note');
b += frame(30, 112, 1460, 154, '输入动作 · PreUpdate 中由 Enhanced Input 评估', '事件携带 context（控制者实体）、action（动作实体）和 value（动作输出）。');
b += lines(50, 200, ['设备绑定 → Prepare → Update → Apply → Commands::trigger(EntityEvent) → 应用命令 → 匹配 Observer', 'Fire / Complete / Cancel 是触发式 EntityEvent；它们不经过 MessageReader 的消息缓冲。'], 'body', 32);
const eventRows = [
  ['observe_move', 'Fire<MoveAction>', 'movement ← value'], ['observe_complete', 'Complete<MoveAction>', 'movement ← ZERO'], ['observe_cancel', 'Cancel<MoveAction>', 'movement ← ZERO'],
  ['observe_jump', 'Fire<JumpAction>', 'jump_pending ← true'], ['observe_interact', 'Fire<InteractAction>', 'interact_pending ← true'], ['observe_look', 'Fire<LookAction>', 'yaw / 当前模式 pitch ← 鼠标位移'], ['observe_perspective','Fire<TogglePerspectiveAction>','toggle_requested_by ← context'],
];
eventRows.forEach(([id, name, result], i) => { const y = 306 + i * 136;
  registry[`event-${id}`] = { name, kind: 'EntityEvent', description: '由 Enhanced Input 动作评估触发，context 为目标控制者。', notes: ['Commands::trigger 在命令应用时运行 Observer。'] };
  b += card(42, y, 312, 94, `event-${id}`, name, ['target：context 控制者'], 'event', 'small');
  b += system(434, y, 335, id, [brief[id]], 94);
  const cameraEvent = ['observe_look','observe_perspective'].includes(id);
  const dataId = cameraEvent ? 'camera.OrbitCamera' : 'character.CharacterIntent';
  b += card(856, y, 345, 94, `result-${id}`, cameraEvent ? '相机 OrbitCamera' : '角色 CharacterIntent', [result], 'component', 'small');
  registry[`result-${id}`] = { name: result, kind: 'Component write', description: systems[id].description, reads: systems[id].reads, writes: systems[id].writes, notes: systems[id].notes, source: systems[id].source };
  b += edge([[354, y + 46], [434, y + 46]], '触发', 'trigger', [394, y + 46], [`event-${id}`, id]);
  b += edge([[769, y + 46], [856, y + 46]], 'W', 'write', [812, y + 46], [id, `result-${id}`, dataId]);
});
b += frame(1240, 306, 250, 910, '路由与状态消费', 'Observer 是全局注册的。');
const route = ['event.context → 控制者','ControlsCharacter → 角色','↓ CharacterIntent','','movement → 控制力','jump_pending → 跳跃冲量','interact_pending → 交互','布尔请求一次消费后清零','','观察 / 切换另走：','ControlsCamera → 相机','↓ OrbitCamera','','观察：直接更新角度','切换：先记请求来源','↓ apply_perspective_toggle','在事件命令应用后切换','','目标或组件缺失 → 返回','零固定步帧保留玩法请求'];
b += route.map((r,i)=>fitted(1257,392+i*38,r,216,'small')).join('');
b += text(45, 1273, '移动轴持续保留至 Complete / Cancel；跳跃与交互的同类未消费请求会合并为一次。', 'note');
b += frame(30, 1320, 1460, 280, '窗口通信 · 缓冲 Message、输入 Resource 与 Egui 上下文', '窗口消息有独立读取游标；UI 占用通过输入上下文停用，避免与玩法动作重复触发。');
registry['window-messages'] = { name: 'WindowFocused / MouseButtonInput', kind: 'Message', description: 'Bevy 的窗口消息缓冲，由 sync_mouse_capture 的 MessageReader 读取。', notes:['缓冲不是永久业务队列。','Esc 的底层读取仅处理光标生命周期；Window 光标与 Egui 已缓存 UI 状态参与点击归属判定。','暂停业务由 MenuContext 的 BackAction 处理；F3 经 GameplayContext 的 ReleasePointerAction 释放光标。'], source:systems.mouse_capture.source };
b += card(50, 1410, 374, 130, 'window-messages', '窗口消息缓冲', ['WindowFocused / MouseButtonInput', 'MessageReader 读取', 'Esc / Window / Egui 另由参数访问'], 'message', 'small');
b += system(512, 1410, 356, 'mouse_capture', ['R 消息 / Esc / Window / Egui / AppState', 'W MouseLookState / CursorOptions', 'Commands：ContextActivity 开 / 关'], 130);
registry['capture-state'] = { name:'捕获与输入上下文',kind:'Component',description:'捕获与焦点状态写入相机和窗口；UI 占用通过 Commands 改变控制者的 ContextActivity，命令在动作 Prepare 前应用。',writes:systems.mouse_capture.writes,notes:systems.mouse_capture.notes,source:systems.mouse_capture.source };
b += card(971, 1410, 486, 130, 'capture-state', '捕获与输入上下文', ['MouseLookState：active / skip_motion / focused', 'CursorOptions：visible / grab_mode', 'ContextActivity：ACTIVE / INACTIVE（延迟命令）'], 'component', 'small');
b += edge([[424, 1474], [512, 1474]], '读取', 'read', [468, 1474], ['window-messages', 'mouse_capture']);
b += edge([[868, 1474], [971, 1474]], 'W', 'write', [919, 1474], ['mouse_capture', 'capture-state']);
b += text(52, 1577, '恢复鼠标捕获当帧跳过位移；检查器编辑直接作用于 ECS 内存，界面绘制见调度视图。', 'small');
b += frame(30, 1640, 1460, 200, '物理碰撞 · 缓冲 Message', 'PhysicsSchedule 产生离散接触消息；项目不新增碰撞 Observer。');
registry['physics-messages']={name:'CollisionStart / CollisionEnd',kind:'Message',description:'Avian 缓冲碰撞开始/结束消息，携带 collider1 和 collider2；log_collisions 在物理步之后读取。',notes:systems.collision_log.notes,source:systems.collision_log.source};
b += card(50,1720,374,100,'physics-messages','CollisionStart / End',['collider1 / collider2：Entity'],'message','small');
b += system(512,1720,356,'collision_log',[brief.collision_log],100);
registry['physics-file-log']={name:'会话文件日志',kind:'External I/O',description:'离散碰撞记录复用集中 tracing 文件输出，与游戏存档分别管理。',source:systems.collision_log.source};
b += card(971,1720,486,100,'physics-file-log','统一会话日志',['碰撞双方、原因、时间与级别'],'external','small');
b += edge([[424,1770],[512,1770]],'读取','read',[468,1770],['physics-messages','collision_log']);
b += edge([[868,1770],[971,1770]],'日志','write',[919,1770],['collision_log','physics-file-log']);
b += frame(30, 1880, 1460, 230, '调试释放光标 · GameplayContext', 'F3 保持 Running，可编辑 Inspector；Esc 属于右侧菜单 BackAction，不直接轮询底层键盘。');
const releasePointer = model.observers.find(observer=>observer.system==='observe_release_pointer');
registry['event-observe_release_pointer']={name:releasePointer.event,kind:'EntityEvent',description:releasePointer.description};
b += card(50,1965,374,110,'event-observe_release_pointer',releasePointer.event,['F3 → context 控制者'],'event','small');
b += system(512,1965,356,'observe_release_pointer',[brief.observe_release_pointer],110);
b += card(971,1965,486,110,'result-observe_release_pointer','相机 / 窗口捕获状态',['MouseLookState.active = false；skip_motion = true','CursorOptions.visible = true；grab_mode = None'],'component','small');
registry['result-observe_release_pointer']={...systems.observe_release_pointer,name:'调试释放捕获',kind:'Component write'};
b += edge([[424,2020],[512,2020]],'触发','trigger',[468,2020],['event-observe_release_pointer','observe_release_pointer']);
b += edge([[868,2020],[971,2020]],'W','write',[919,2020],['observe_release_pointer','result-observe_release_pointer','camera.MouseLookState','window.CursorOptions']);

// 从清单动态展开菜单及资产 Observer，避免新增事件被旧七行输入表遗漏。
const existingEvents = new Set([...eventRows.map(([id])=>id),'observe_release_pointer']);
const menuEvents = model.observers.filter(observer=>!existingEvents.has(observer.system));
const menuEventStep = 148;
const menuEventBottom = 306 + menuEvents.length * menuEventStep;
b += frame(1540,112,1470,menuEventBottom-112,'菜单动作 / UI 滚动 / GLB 就绪','菜单六个动作来自 Enhanced Input；滚轮来自原生 UI，资产就绪来自 WorldAssetRoot。');
b += lines(1560,200,['MenuContext 按窗口焦点启用；优先级 10，高于玩法，consume_input 避免同键重复消费。','Hidden 保留 Back（Esc）暂停；方向与确认在页面隐藏时返回。'], 'body', 32);
menuEvents.forEach((observer,i)=>{
  const id=observer.system, y=306+i*menuEventStep, sourceSystem=systems[id];
  const action=observer.event.startsWith('Fire<');
  registry[`event-${id}`]={name:observer.event,kind:'EntityEvent',description:observer.description,notes:[observer.target]};
  b += card(1552,y,312,118,`event-${id}`,observer.event,[action?'target：MenuContext 控制者':observer.event.startsWith('Pointer')?'target：MenuScroll 视口':'target：快递员 GLB 根'],'event','small');
  b += system(1944,y,335,id,[sourceSystem.description],118);
  const resultId=`result-${id}`;
  registry[resultId]={name:`${sourceSystem.name} 输出`,kind:'Data write',description:sourceSystem.description,reads:sourceSystem.reads,writes:sourceSystem.writes,notes:sourceSystem.notes,source:sourceSystem.source};
  b += card(2366,y,345,118,resultId,action?'菜单共享数据':observer.event.startsWith('Pointer')?'ScrollPosition':'动画播放与图句柄',sourceSystem.writes.slice(0,2).map(value=>`W ${accessName(value)}`),action?'resource':'component','small');
  b += edge([[1864,y+59],[1944,y+59]],'触发','trigger',[1904,y+59],[`event-${id}`,id]);
  b += edge([[2279,y+59],[2366,y+59]],'W','write',[2322,y+59],[id,resultId,...sourceSystem.writes]);
});
b += frame(2750,306,250,menuEventBottom-346,'路由与消费','源事件保持各自目标。');
b += ['Previous / Next','↓ MenuFocus','＋ Navigation 来源','','Left / Right / Confirm','Back（含 Esc）','↓ UiRequest Message','↓ PreUpdate 统一消费','','指针点击也写同一队列','UI 滚轮只改视口位置','','WorldInstanceReady','↓ 遍历 GLB 骨架子树','AnimationPlayer 循环播放','Commands 插入图句柄'].map((value,i)=>fitted(2767,392+i*38,value,216,'small')).join('');
const requestY=menuEventBottom+45;
b += frame(1540,requestY,1470,525,'UiRequest · 从输入到页面、设置与状态','确认、调整、返回与指针点击产生消息；焦点、滚动与动画直接更新 ECS；未接通功能为禁用 Coming Soon。');
b += card(1560,requestY+85,360,130,'resource.UiRequestMessages','UiRequest 消息缓冲',['导航确认 / 调整 / Back','与 pointer_interactions 共用 UiAction'],'message','small');
b += system(2040,requestY+85,430,'menu_handle_requests',['MessageReader 统一消费请求','更新 MenuState / Draft / NextState'],130);
b += card(2600,requestY+85,385,130,'resource.SettingsDraft','设置草稿',['Apply：校验、保存成功才热生效','Back：丢弃；保存失败保留原文件'],'resource','small');
b += edge([[1920,requestY+150],[2040,requestY+150]],'读取','read',[1980,requestY+150],['resource.UiRequestMessages','menu_handle_requests']);
b += edge([[2470,requestY+150],[2600,requestY+150]],'W 草稿','write',[2535,requestY+150],['menu_handle_requests','resource.SettingsDraft']);
b += card(1560,requestY+320,660,130,'resource.MenuState','页面与返回来源',['Main / Hidden / Pause / Settings / Help','Settings / Help 返回来源保存在 return_page'],'resource','small');
b += card(2335,requestY+320,650,130,'ui-next-state','NextState → StateTransition',['Start Game / ReturnToMenu：AppState','Pause / Resume：InGame 内 PlayState'],'engine','small');
b += edge([[2145,requestY+215],[2145,requestY+265],[1890,requestY+265],[1890,requestY+320]],'W 页面','write',[1890,requestY+265],['menu_handle_requests','resource.MenuState']);
b += edge([[2370,requestY+215],[2370,requestY+265],[2660,requestY+265],[2660,requestY+320]],'状态请求','write',[2660,requestY+265],['menu_handle_requests','ui-next-state','resource.AppState','resource.PlayState']);
// 三个生产者汇入同一个缓冲消息；汇合支线不带箭头，不暗示生产者之间有顺序。
b+=frame(30,2130,1460,710,'音效反馈 · 缓冲 SoundRequest → Update / Kira','只发送已发生的业务结果；输入 Observer 不直接播放成功声音。');
b+=system(50,2230,374,'interaction',['Commands：成功拾取 / 释放','关系变更与 SoundRequest 同步提交'],130);
b+=system(50,2400,374,'audio_strain',['真实 Position / 朝向 → 持握偏差','Local 宽限 / 持续计时 / 滞回锁存'],130);
b+=system(50,2570,374,'audio_land',['ContactGraph：支撑法线与冲量','Local 锁存至完全离开支撑'],130);
b+=card(512,2400,356,130,'resource.SoundRequestMessages','SoundRequest',['cue：SoundCue（12 种映射）','source：Entity，仅用于日志','MessageReader；默认缓冲非永久队列'],'message','small');
b+=card(971,2230,486,100,'resource.SoundBank','SoundBank',['句柄 / 清单策略 / 实例与时间'],'resource','small');
b+=system(971,2400,486,'audio_play',['R 请求 / 资产 / 策略 / 时钟','W SoundBank；排队 UI / SFX 命令','冷却 / 并发 / 加载限制'],130);
registry['kira-output']={name:'Kira UI / SFX 通道',kind:'Engine',description:'类型化 AudioChannel 接收排队播放命令；声音实例与加载失败共用统一日志。',reads:['resource.UiAudioChannel','resource.SfxAudioChannel'],notes:['总并发 4；Queued 计入并发。','当前未自动播放 ambience。'],source:systems.audio_play.source};
b+=card(971,2590,486,130,'kira-output','Kira UI / SFX',['类型化通道消费排队播放命令','AppExit → 停止两个通道','声音初始化 / 跳过 / 失败写会话日志'],'engine','small');
b+=edge([[424,2055],[468,2055],[468,2465]],'','write',null,['interaction','resource.SoundRequestMessages'],false);
b+=edge([[424,2465],[468,2465]],'','write',null,['audio_strain','resource.SoundRequestMessages'],false);
b+=edge([[424,2635],[468,2635],[468,2465]],'','write',null,['audio_land','resource.SoundRequestMessages'],false);
b+=edge([[468,2465],[512,2465]],'','write',null,['interaction','audio_strain','audio_land','resource.SoundRequestMessages']);
b+=edge([[868,2465],[971,2465]],'读取','read',[919,2465],['resource.SoundRequestMessages','audio_play']);
b+=edge([[1214,2330],[1214,2400]],'R','read',[1133,2365],['resource.SoundBank','audio_play']);
b+=edge([[1315,2400],[1315,2330]],'W','write',[1295,2365],['audio_play','resource.SoundBank']);
b+=edge([[1214,2530],[1214,2590]],'排队','write',[1214,2560],['audio_play','kira-output']);
b+=text(52,2756,'玩法四种反馈仅 Running 收集；菜单三种已接入，交接 / 推车 / 弹开 / 交付共五种预留。','small');
b+=text(52,2791,'反馈测试只安装消息与最小物理 App；Kira 输出仅在用户启动游戏时安装。','small');
// 菜单声音另列真实生产入口；两条回路从空白下方接入共享消息，不穿越 Kira 卡片。
b+=frame(1540,2130,1470,475,'菜单声音 · 同一个 SoundRequest 缓冲','焦点反馈直接产生；确认 / 返回由统一 UiRequest 消费结果产生，页面重建不重复发声。');
registry['menu-hover-producers']={name:'previous / next / pointer_interaction',kind:'System / Observer group',description:'键盘 / 手柄实际改变目标按钮，或真实指针进入新按钮时发送 MenuHover。',writes:['resource.SoundRequestMessages'],notes:['单按钮页、占位控件、按钮内移动、点击释放和重建初始 Hovered 静音。'],source:systems.menu_pointer.source};
b+=card(1560,2230,660,130,'menu-hover-producers','MenuHover：previous / next / pointer_interaction',['实际焦点变化 → SoundRequest(MenuHover)','source：新焦点按钮 Entity'],'system','small');
registry['menu-request-feedback']={name:'handle_requests · 接受的操作反馈',kind:'System output',description:'每帧只反馈第一项真正接受的 UiRequest；确认有效操作，返回 / 恢复 / 保存失败用取消音。',writes:['resource.SoundRequestMessages'],notes:systems.menu_handle_requests.notes,source:systems.menu_handle_requests.source};
b+=card(2335,2230,650,130,'menu-request-feedback','MenuConfirm / MenuCancel：handle_requests',['接受的语义请求 → 一次确认 / 返回反馈','source：持久 MenuContext 控制者 Entity'],'system','small');
b+=text(1560,2440,'Update 的 log_load_failures → play_requests → stop_on_exit 整条链在 UiSystems::Style 之后执行。','small');
b+=text(1560,2475,'Time<Real> 保持暂停菜单节流可用；总并发 4，SFX 最多 3，菜单保留 1 个名额。','small');
b+=edge([[1890,2360],[1890,2392],[1515,2392],[1515,2880],[630,2880],[630,2530]],'W MenuHover','write',[1230,2880],['menu-hover-producers','observe_menu_previous','observe_menu_next','menu_pointer','resource.SoundRequestMessages']);
b+=edge([[2660,2360],[2660,2392],[3025,2392],[3025,2940],[750,2940],[750,2530]],'W MenuConfirm / MenuCancel','write',[1740,2940],['menu-request-feedback','menu_handle_requests','resource.SoundRequestMessages']);
save('events', '事件 · Observer · Message', 3040, Math.max(2980,requestY+565), b, '玩法与菜单动作使用 EntityEvent / Observer；UiRequest 和 SoundRequest 使用缓冲 Message，声音统一由 Kira 输出。');

// 源码与图同时生成快照，让网页和离线文件都能打开完整源码并定位行号。
// 清单中仅在详情出现的组件和资源也需要完整源码快照，不能只收集画布节点。
function sourceReferences(value, result = new Set()) {
  if (value && typeof value === 'object') {
    if (value.source?.path) result.add(value.source.path);
    Object.values(value).forEach(child=>sourceReferences(child,result));
  }
  return result;
}
const sourcePaths = [...sourceReferences({model,registry})].sort();
writeSourceViewer({ outputDirectory: dir, sources: sourcePaths.map(sourcePath => ({ path: sourcePath, text: fs.readFileSync(path.resolve(dir, '../..', sourcePath), 'utf8') })) });

// UI 使用内嵌数据和 SVG，离线打开不依赖网络、字体 CDN 或第三方脚本。
const state = JSON.stringify({ model, registry, views }).replace(/</g, '\\u003c');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Crect width='10' height='10' rx='2' fill='%23234f80'/%3E%3C/svg%3E"><title>demo · ECS 架构</title><style>
.node.entity.selected>g>rect{stroke:#db7521;stroke-width:4}.side .data-link{padding:2px 5px;max-width:100%;text-align:left;font:12px/1.55 Consolas,monospace;overflow-wrap:anywhere;border:0;background:#f0f3f7;color:#234f80}.side .data-link:hover{background:#dcebf9}.side details{margin-top:20px}.side summary{cursor:pointer;color:#5c7086}
.side a.source{display:block;color:#234f80;text-decoration:underline;text-underline-offset:3px}.side a.source:hover{background:#dcebf9}.side a.source:focus-visible{outline:3px solid #a8c8ee}
/* 画布用于平移和节点点击，禁选范围包含 SVG 文字；详情与源码仍可正常复制。 */
.canvas,.canvas *{-webkit-user-select:none;user-select:none}
*{box-sizing:border-box}body{margin:0;background:#f5f6f8;color:#263648;font:14px/1.6 'Segoe UI','Microsoft YaHei',sans-serif}button,input{font:inherit}button{cursor:pointer;border:1px solid #d8e0e7;border-radius:8px;background:white;color:inherit;padding:7px 13px}button:hover{background:#edf4fa}button:focus-visible,input:focus-visible{outline:3px solid #a8c8ee}header{padding:19px 26px 13px;border-bottom:1px solid #dfe5ec;background:white}header h1{font-size:25px;margin:0;letter-spacing:-.5px}.eyebrow{font-size:11px;color:#76859b;letter-spacing:2px}.sub{margin:4px 0 0;color:#67788b}.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:13px 22px;background:#fff}.tabs{display:flex;gap:6px;flex-wrap:wrap}.tabs button.active{background:#234f80;color:white;border-color:#234f80}.tools{display:flex;gap:6px;align-items:center;margin-left:auto}.tools input{width:205px;padding:8px 10px;border:1px solid #d8e0e7;border-radius:8px}.tools span{width:44px;text-align:center;color:#6c7b8d}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 312px;gap:14px;padding:0 20px 20px;height:calc(100vh - 170px);min-height:500px}.canvas-wrap{background:#f7f8fa;border:1px solid #d9e1e8;border-radius:14px;position:relative;overflow:hidden;display:flex;flex-direction:column}.caption{padding:11px 16px;background:#fff;border-bottom:1px solid #e1e6ec;color:#68798c;flex:0 0 auto}.canvas{position:relative;flex:1;overflow:hidden;touch-action:none;cursor:grab}.canvas.dragging{cursor:grabbing}.diagram{position:absolute;left:0;top:0;transform-origin:0 0}.diagram svg{display:block}.canvas-hint{position:absolute;bottom:9px;left:12px;pointer-events:none;background:#ffffffde;padding:3px 8px;border-radius:6px;color:#7a8796;font-size:12px}.side{overflow:auto;background:white;border:1px solid #d9e1e8;border-radius:14px;padding:20px}.side h2{font-size:18px;margin:0 0 12px}.side h3{font-size:13px;margin:20px 0 7px;color:#5c7086}.side p{margin:8px 0}.side code{font:12px/1.55 Consolas,monospace;overflow-wrap:anywhere;background:#f0f3f7;padding:2px 4px;border-radius:4px}.side ul{padding-left:18px;margin:6px 0}.side li{margin:4px 0;overflow-wrap:anywhere}.badge{display:inline-block;border:1px solid #dbe4eb;background:#f3f6fa;border-radius:20px;padding:2px 9px;font-size:11px;color:#617387;margin-bottom:8px}.legend{display:grid;gap:8px}.legend div{display:flex;gap:10px;align-items:center}.line{display:inline-block;width:33px;border-top:3px solid #324153}.line.read{border-color:#2d72ad;border-top-style:dashed}.line.write{border-color:#288554}.line.event{border-color:#bf651e;border-top-style:dashed}.line.ref{border-color:#7b65a6;border-top-style:dashed}.line.rel{border-color:#7b65a6}.footnote{font-size:12px;color:#718195}.reset{margin-top:15px;width:100%}.source{font-size:12px;color:#6c7e91;padding:8px;background:#f3f6f9;border-radius:7px;overflow-wrap:anywhere}.empty{color:#8390a0}.help{padding:8px 12px;background:#f9f6ee;border-left:3px solid #caa772;border-radius:4px;font-size:12px}footer{display:none}@media(max-width:1000px){.workspace{grid-template-columns:1fr;height:auto;min-height:0}.canvas-wrap{height:75vh;min-height:490px}.side{max-height:450px}.tools{margin-left:0}.toolbar{padding:10px 20px}.workspace{padding:0 12px 12px}header{padding:15px 20px}}
</style></head><body><header><div class="eyebrow">DEMO / ECS ARCHITECTURE · V1</div><h1>从输入到画面，当前 App 如何运作</h1><p class="sub">UML 风格的实体、组件、系统与关系 · 基于生成时的源码快照 · 不执行游戏</p></header><div class="toolbar"><nav class="tabs" aria-label="架构视图"><button data-view="overview" class="active">总览</button><button data-view="schedules">调度与读写</button><button data-view="relationships">实体关系</button><button data-view="events">事件与 Observer</button></nav><div class="tools"><input id="search" placeholder="搜索系统、组件或字段" aria-label="搜索架构节点"><button id="zoom-out" aria-label="缩小">−</button><span id="zoom-label">100%</span><button id="zoom-in" aria-label="放大">＋</button><button id="fit">适合窗口</button><button id="export">导出 SVG</button></div></div><main class="workspace"><section class="canvas-wrap"><div id="caption" class="caption"></div><div id="canvas" class="canvas"><div id="diagram" class="diagram"></div><div class="canvas-hint">滚轮缩放 · 拖动平移 · 点击卡片查看数据与源码</div></div></section><aside id="details" class="side" aria-live="polite"></aside></main><script id="architecture-data" type="application/json">${state}</script><script>
const DATA=JSON.parse(document.getElementById('architecture-data').textContent);const canvas=document.getElementById('canvas'),diagram=document.getElementById('diagram'),details=document.getElementById('details');let view=DATA.views[0],scale=1,panX=0,panY=0,selected=null,drag=null;
const safe=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function transform(){diagram.style.transform='translate('+panX+'px,'+panY+'px) scale('+scale+')';document.getElementById('zoom-label').textContent=Math.round(scale*100)+'%'}
function fit(){scale=Math.min((canvas.clientWidth-28)/view.width,(canvas.clientHeight-28)/view.height,1);panX=(canvas.clientWidth-view.width*scale)/2;panY=(canvas.clientHeight-view.height*scale)/2;transform()}
function list(title,items){return items&&items.length?'<h3>'+safe(title)+'</h3><ul>'+items.map(x=>{const key=DATA.registry[x]?x:String(x).split(' ')[0],d=DATA.registry[key];return '<li>'+(d?'<button class="data-link" data-open="'+safe(key)+'">'+safe(d.name)+' '+safe(String(x).slice(key.length))+'</button>':'<code>'+safe(x)+'</code>')+'</li>'}).join('')+'</ul>':''}
function guide(){details.innerHTML='<span class="badge">读图指南</span><h2>'+safe(view.label)+'</h2><p>'+safe(view.summary)+'</p><div class="legend"><div><i class="line"></i>调度先后与执行依赖</div><div><i class="line read"></i>R：数据 → 系统</div><div><i class="line write"></i>W：系统 → 数据</div><div><i class="line event"></i>事件触发 Observer</div><div><i class="line ref"></i>普通 Entity 引用</div><div><i class="line rel"></i>Bevy 关系及反向索引</div></div><h3>类型框</h3><p>«Entity» 包含组件框；«System» 是调度运行的函数；«Observer» 按事件响应；«Resource» 共享，«Local» 为系统私有。</p><div class="help">固定步每帧 0～N 次。角色朝向和持物同步在固定步与逐帧更新中复用；数据访问连线不代表执行顺序。</div><h3>范围与抽象</h3><p class="footnote">业务系统与组件来自当前源码；引擎输入、时钟、变换传播和渲染以必要概览节点表示。普通引用不自动成为 Bevy 关系。</p><button class="reset" id="clear-selection">清除选择</button>';document.getElementById('clear-selection').onclick=()=>select(null)}
function sourceLink(source){return '<h3>源码位置</h3><a class="source" href="ecs-source.html?file='+encodeURIComponent(source.path)+'#L'+encodeURIComponent(source.line)+'" target="_blank" rel="noopener noreferrer" title="在新标签页查看源码并定位此行">'+safe(source.path)+':'+safe(source.line)+'</a>'}
function showDetail(id){const d=DATA.registry[id];if(!d){guide();return}details.innerHTML='<span class="badge">'+safe(d.kind||'数据')+(d.phase?' · '+safe(d.phase):'')+'</span><h2>'+safe(d.name||id)+'</h2><p>'+safe(d.description||'')+'</p>'+(d.owner?'<p>所属实体：'+safe(d.owner)+'</p>':'')+list('R · 读取',d.reads)+list('W · 修改',d.writes)+list('Query · 过滤',d.filters)+list('事件 / 消息',d.events)+list('字段',d.fields)+list('约束与说明',d.notes)+(d.components?list('实体组件',d.components.map(c=>c.id)):'')+(d.source?sourceLink(d.source):'')+'<button class="reset" id="clear-selection">清除选择</button>';document.getElementById('clear-selection').onclick=()=>select(null);details.scrollTop=0}
details.addEventListener('click',e=>{const n=e.target.closest('[data-open]');if(n)select(n.dataset.open)});
function select(id){selected=id;const d=DATA.registry[id];const relevant=new Set([id,...(d?.reads||[]),...(d?.writes||[])]);diagram.querySelectorAll('[data-id]').forEach(n=>{n.classList.toggle('selected',n.dataset.id===id);n.classList.toggle('dim',!!id&&!relevant.has(n.dataset.id))});diagram.querySelectorAll('.edge').forEach(n=>{const active=n.dataset.connect.split('|').some(v=>relevant.has(v));n.classList.toggle('focused',!!id&&active);n.classList.toggle('dim',!!id&&!active)});id?showDetail(id):guide()}
function switchView(id){view=DATA.views.find(v=>v.id===id);if(!view)return;document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===id));diagram.innerHTML=view.svg;document.getElementById('caption').textContent=view.summary;document.getElementById('search').value='';selected=null;guide();requestAnimationFrame(fit)}
function zoom(factor,x=canvas.clientWidth/2,y=canvas.clientHeight/2){const old=scale;scale=Math.min(2.4,Math.max(.2,scale*factor));panX=x-(x-panX)*scale/old;panY=y-(y-panY)*scale/old;transform()}
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>switchView(b.dataset.view));document.getElementById('fit').onclick=fit;document.getElementById('zoom-in').onclick=()=>zoom(1.2);document.getElementById('zoom-out').onclick=()=>zoom(1/1.2);
canvas.addEventListener('wheel',e=>{e.preventDefault();const r=canvas.getBoundingClientRect();zoom(e.deltaY<0?1.12:1/1.12,e.clientX-r.left,e.clientY-r.top)},{passive:false});
canvas.addEventListener('pointerdown',e=>{
  if(e.button!==0)return;
  // 自定义平移接管左键手势，阻止浏览器同时开始文字选择或原生拖动。
  e.preventDefault();
  drag={x:e.clientX,y:e.clientY,px:panX,py:panY,moved:false};canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove',e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>4)drag.moved=true;if(drag.moved){panX=drag.px+dx;panY=drag.py+dy;canvas.classList.add('dragging');transform()}});
canvas.addEventListener('pointerup',e=>{
  if(drag&&!drag.moved){
    const n=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-id]');
    // pointerdown 取消了默认聚焦；点击节点时补回焦点，保留 Enter / 空格操作。
    n?.focus({preventScroll:true});select(n?n.dataset.id:null);
  }
  drag=null;canvas.classList.remove('dragging');
});
canvas.addEventListener('pointercancel',()=>{drag=null;canvas.classList.remove('dragging')});
diagram.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){const n=e.target.closest('[data-id]');if(n){e.preventDefault();select(n.dataset.id)}}});document.getElementById('search').addEventListener('input',e=>{const q=e.target.value.trim().toLowerCase();selected=null;const hits=[];diagram.querySelectorAll('[data-id]').forEach(n=>{const d=DATA.registry[n.dataset.id],hit=!q||JSON.stringify(d).toLowerCase().includes(q);n.classList.toggle('dim',!hit);n.classList.toggle('selected',!!q&&hit);if(hit)hits.push(n.dataset.id)});diagram.querySelectorAll('.edge').forEach(n=>n.classList.remove('dim','focused'));if(q){details.innerHTML='<span class="badge">搜索结果</span><h2>'+hits.length+' 个匹配节点</h2><p>当前视图中匹配的卡片已高亮。点击卡片查看详情。</p><p class="footnote">搜索仅覆盖当前视图；可切换其他视图继续查找。</p>'}else guide()});
document.getElementById('export').onclick=()=>{const blob=new Blob([view.svg],{type:'image/svg+xml;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='ecs-'+view.id+'.svg';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};window.addEventListener('resize',fit);switchView('overview');
</script></body></html>`;
fs.writeFileSync(path.join(dir, 'ecs-architecture.html'), html);
console.log(JSON.stringify({ html: path.join(dir, 'ecs-architecture.html'), source_viewer: path.join(dir, 'ecs-source.html'), svgs: views.map(v => `ecs-${v.id}.svg`), systems: model.systems.length, entities: model.entities.length, interactive_nodes: Object.keys(registry).length }, null, 2));
