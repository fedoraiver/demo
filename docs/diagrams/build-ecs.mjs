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
  // 静态 SVG 渲染器不一定支持 textLength；显式字号也保护离线预览的边界。
  // 对字体回退与粗体保留少量宽度余量，完整函数名和访问声明仍放在交互详情。
  const estimate = [...String(value)].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? size * 1.05 : size * .66), 0);
  const fittedSize = estimate > width ? size * width / estimate : size;
  return text(x, y, value, cls).replace('<text ', `<text style="font-size:${fittedSize.toFixed(2)}px" `);
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
 facing_fixed:'按相机 yaw 同步人物朝向',movement:'输入 / 实际速度 → 有上限的控制力',gravity:'消费跳跃请求 → 一次向上冲量',interaction:'射线 / 范围 → 拾取或保留动量释放',held_apply:'应用持握关系、目标与碰撞层',held_fixed:'角色呈现姿态 → HeldTarget',facing_update:'保留插值位置，同步本帧 yaw',held_update:'更新呈现目标，不搬箱或施力',camera_follow:'插值位置 + 观察状态 → 固定镜头',camera_occlusion:'外壳扫掠 / 重叠 → 建筑需求并集',building_fade:'建筑需求 → 实例材质 alpha / 句柄',fade_cleanup:'Last：失效关联恢复 / 材质副本清理',visibility_update:'视角模式 → 人物模型可见性',perspective_apply:'消费请求，切换第一 / 第三人称',
 gravity_sync:'配置变化 → Gravity',grounded_fixed:'脚底 shape cast → 接地状态',grounded_after:'物理回写后重新探测接地',orphan_cleanup:'失效持有者 / 关系 → 自由碰撞',orphan_apply:'应用失效清理命令',grip_forces:'真实 Position / 速度 → 弹簧与反作用力',velocity_log:'解算后实际速度 → 采样日志',collision_log:'CollisionStart / End → 文件日志',physics_prepare:'准备物理位姿、质量与碰撞数据',physics_step:'积分 / 接触 / 子步求解 → 真实运动',physics_writeback:'Position / Rotation → Transform',easing_reset:'FixedFirst：重置并记录插值起点',easing_end:'FixedLast：记录物理步插值终点',easing_apply:'固定循环后按 overstep 插值',easing_tick:'显示同步后记录变化 tick',
 transform_propagate:'根 Transform → 子 GlobalTransform',render:'提取 ECS 数据，准备并绘制画面',observe_move:'路由到角色，更新持续移动轴',observe_complete:'移动完成，将轴归零',observe_cancel:'移动取消，将轴归零',observe_jump:'路由到角色，设置跳跃请求',observe_interact:'路由到角色，设置交互请求',observe_look:'有效捕获时更新当前模式角度',observe_perspective:'记录请求来源，稍后统一切换',audio_preload:'清单契约 → 短音加载与映射',audio_load_failures:'资产加载失败 → 会话日志',audio_play:'请求 / 加载 / 冷却 / 并发 → 播放队列',audio_stop:'AppExit → UI / SFX 通道停止',audio_strain:'持续持握误差 → 一次警告',audio_land:'真实支撑冲量 → 一次落地反馈'
};
const displayNames = { animation_grounding:'鞋底穿透补偿',observe_courier_ready:'菜单快递员 · 标记待绑定',courier_ready_observer:'主角 · 标记待绑定动画',time_update:'TimeSystems',input_update:'InputSystems',enhanced_prepare:'Enhanced Input · Prepare',enhanced_evaluate:'Enhanced Input · Update',input_apply:'Enhanced Input · Apply',held_apply:'ApplyDeferred · 持有关系',capture_apply:'ApplyDeferred · 上下文',inspector_pass:'World Inspector · UI Pass',transform_propagate:'Transform · Propagate',render:'RenderApp · 渲染概览' };
Object.assign(brief, {
  startup_pose: '记录固定模拟与插值后显示顺序',
  observe_menu_previous: '循环向上选择；焦点改变才反馈',
  observe_menu_next: '循环向下选择；焦点改变才反馈',
  observe_menu_back: 'Back → 暂停、恢复或返回',
  observe_menu_scroll: '设置视口：滚轮 → 夹取偏移',
  observe_courier_ready: '菜单模板就绪 → 动画 pending',
  observe_scrollbar_scroll: '滚轮 → 目标视口偏移',
  flow_enter_menu: 'MainMenu：展示主菜单并恢复展示动画时间',
  flow_pause: 'Paused：保存返回来源，展示暂停菜单',
  flow_suspend: '停物理，暂停另停虚拟时间；清意图并释放光标',
  flow_resume: 'Running：恢复时间，重新捕获并跳过鼠标位移',
  menu_spawn_controller: '创建菜单输入控制者及 Enhanced Input 绑定',
  menu_sync_context: '窗口焦点 → MenuContext；Hidden 仍保留 Esc',
  menu_handle_requests: '消费菜单消息 → 页面 / 设置 / NextState',
  menu_rebuild: '结构 key 变化 → BSN 重建；草稿不重建',
  menu_settings_text: '草稿 / 提示变化 → 原位更新 Text',
  menu_bind_scrollbars: 'Build 后 → 绑定真实 sibling target',
  menu_sync_scrollbars: '本帧布局 → 显隐 / 拾取 / 夹取 / 高亮',
  window_log: '记录平台、16:9 与最小尺寸策略',
  window_install: '窗口线程：安装 / 刷新 / 清理原生守卫',
  menu_pointer: '真实鼠标移动切输入来源；进入 / 离开同步悬停',
  menu_style: 'Interaction / 导航焦点 → 按钮纸色或黄色',
  menu_description: '当前设置焦点 → 右侧解释文字',
  menu_volume_pointer: '局部指针捕获 → SetVolume / 释放请求',
  menu_volume_visuals: '音量草稿 → 已有百分比 / 轨道填充',
  audio_mix: '草稿预览 / 已应用配置 → AudioMix',
  audio_voice_volumes: '有效混音 × 素材基准 → 实例分贝',
  audio_voice_volumes_post: 'Queued 就绪后补同步最新实例分贝',
  menu_scroll_focus: '键盘 / 手柄焦点 → 可见滚动范围',
  menu_asset_failures: '资产加载失败 → 英文会话日志',
  menu_backdrop_spawn: '真实 GLB 展台 / 独立菜单相机；无地图碰撞',
  menu_animation_play: 'pending / 命名 Carry_Idle → 循环播放',
  animation_initialize: '16 命名片段 / 鞋底节点 → 绑定',
  animation_sync: '局部速度 / 持箱 / 跳跃 → 权重与相位',
  animation_grounding: '本帧鞋底姿态 → 视觉高度补偿',
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
b += `<g class="node entity" ${register('app-main',registry['app-main'])}>${frame(30, 102, 1500, 224, '«App» main：装配应用与共享 World', 'Plugin 负责注册；下方位置不代表插件内部系统的执行先后。')}</g>`;
const mainLines = fs.readFileSync(path.join(dir, '../../src/main.rs'), 'utf8').split('\n');
const pluginDescriptions = {
  DefaultPlugins:'引擎输入、窗口、时间、资产、动画、变换、渲染、原生 ScrollbarPlugin 与统一日志。', WindowPolicyPlugin:'窗口线程安装、刷新与清理原生 16:9 策略。', EguiPlugin:'准备 Egui 上下文与界面绘制。', WorldInspectorPlugin:'通过反射检查 ECS；仅 Running 显示。', AppFlowPlugin:'主菜单/游戏/暂停生命周期与时间门控。', GameUiPlugin:'BSN 页面、菜单输入、草稿与展示舞台。', GameAudioPlugin:'Kira 预加载、策略、UI/SFX 输出与退出停止。', SettingsPlugin:'设置资源与限帧。', GameplayPlugin:'玩法资源、反射类型和固定模拟链。', PlayerInputPlugin:'输入上下文、动作与角色意图 Observer。', CameraControlPlugin:'相机 Observer、捕获、视角与姿态同步。', ArtAssetsPlugin:'五份运行 GLB 强句柄、加载状态与失败报告。', CharacterAnimationPlugin:'主角命名动作绑定与实际速度/持物切换。', IslandRecoveryPlugin:'固定步落水恢复与临时插值暂停生命周期。', PrototypeScenePlugin:'BSN 海岛准备、静态碰撞与动态业务装配。', StartupLogPlugin:'集中注册四项只读启动日志。'
};
// 候选索引可能只包含部分功能；插件只从该版本 main 的实际装配位置读取。
const plugins = Object.keys(pluginDescriptions).map(name => ({name, line:mainLines.findIndex(l => l.trim() === name || l.trim().startsWith(name + ',') || l.trim().startsWith(name + '::')) + 1})).filter(plugin => plugin.line > 0);
registry['app-main'].source.line = mainLines.findIndex(l=>l.startsWith('fn main('))+1;
plugins.forEach(({name,line}, i) => { const id = `plugin-${name}`; registry[id] = { id, name, kind:'Plugin', description:pluginDescriptions[name], notes:['注册顺序不等于系统执行顺序。', ...(name.includes('Egui') || name.includes('Inspector') ? ['EguiPlugin 必须先于 WorldInspectorPlugin 构建。'] : [])], source:{path:'src/main.rs',line} }; b += compact(44 + (i % 6) * 246, 165 + Math.floor(i / 6) * 52, 234, 42, id, name, 'plugin'); });
b += '<g transform="translate(0 104)">';
b += frame(30, 240, 1500, 108, '«Schedule» Startup · 启动一次', '菜单控制者、短音、美术请求与四项日志无彼此顺序；进入 InGame 才生成加载视图。');
const startupIds = ['menu_spawn_controller','audio_preload','startup_assets','startup_config','startup_timestep','startup_inspector'].filter(id => systems[id]);
startupIds.forEach((id, i) => { registry[id] = systems[id]; b += compact(48 + i * 246, 303, 232, 32, id, systems[id].name, 'system'); });
const phases = [
  { x: 30, w: 330, name: 'First', note: '每个渲染帧', rows: ['限帧 → 时间更新', '默认上限 60 FPS；最低 60', 'Local：帧间计时'] },
  { x: 395, w: 330, name: 'PreUpdate', note: '输入与界面准备', rows: ['捕获 / 上下文 → 动作评估', '事件 → 意图 / 观察角度', '本帧消费视角切换请求'] },
  { x: 760, w: 330, name: 'FixedUpdate', note: 'FixedFirst 先记录插值起点', rows: ['恢复 → 朝向；重力独立同步', '跳跃冲量 → 交互 / 清理', '持握目标 → 弹簧 / 反作用力'] },
  { x: 1125, w: 330, name: 'FixedPostUpdate', note: 'Avian 默认物理阶段', rows: ['Prepare → StepSimulation', '→ Writeback → 接地 / 速度日志', '真实位置 / 速度 / 碰撞'] },
  { x: 1490, w: 330, name: 'FixedLast', note: '固定步末尾', rows: ['记录本步插值终点', '角色：平移插值', '箱体：完整 Transform 插值'] },
  { x: 1855, w: 330, name: '固定循环之后', note: 'RunFixedMainLoop · 每帧', rows: ['Ease → 朝向 → HeldTarget → 镜头', '→ 建筑遮挡 → 淡化 → 可见性', '→ UpdateEasingTick'] },
  { x: 2220, w: 330, name: 'Update / SpawnScene', note: '资源与实例的异步准备', rows: ['海岛装配；主角 16 动作混合', '菜单 pending → 命名绑定', 'SpawnScene 实例化 / 就绪事件'] },
  { x: 2585, w: 330, name: 'PostUpdate', note: '骨骼动画与最终变换', rows: ['Animation → 鞋底补偿 → 传播', '检查器 UI 为独立分支', '→ 渲染子应用'] },
];
phases.forEach((p, phaseIndex) => { b += frame(p.x, 382, p.w, 180, p.name, `«Schedule» · ${p.note}`, '#526477', `phase-${phaseIndex}`); b += p.rows.map((r, i) => fitted(p.x + 17, 469 + i * 31, r, p.w - 34)).join(''); });
phases.slice(0, -1).forEach((p, i) => b += edge([[p.x + p.w, 420], [phases[i + 1].x, 420]]));
// 固定循环说明放在阶段卡片上方，避开下方的数据读写连线。
b += text(36, 371, 'FixedFirst → FixedUpdate → FixedPostUpdate → FixedLast 每帧 0～N 次；零固定步帧仍完成插值后显示链。', 'note');
const data = [
  { id: 'character.CharacterIntent', x: 395, w: 330, name: 'CharacterIntent', rows: ['movement：持续输入', 'jump_pending / interact_pending', '固定步消费后清除请求'] },
  { id: 'character.Position', x: 760, w: 330, name: '真实物理状态', rows: ['Position / Rotation / Velocity', 'CharacterMotion：仅 grounded', 'Transform：插值呈现位置'] },
  { id: 'parcel.HeldTarget', x: 1125, w: 330, name: 'HeldTarget / 物理持握', rows: ['目标仅供呈现检查', '施力另读真实 Position', '实际箱体可滞后 / 受碰撞阻挡'] },
  { id: 'world.Collider', x: 1490, w: 330, name: '静态世界碰撞', rows: ['三角网格 + 入口坡道', 'World / Character / Parcel', '持握箱忽略 Character 层'] },
  { id: 'camera.OrbitCamera', x: 1855, w: 330, name: 'OrbitCamera', rows: ['目标 / 模式 / yaw / 两组 pitch', '镜头读本帧插值后角色位置', '相机 Transform：固定环绕姿态'] },
  { id: 'visual.GlobalTransform', x: 2585, w: 330, name: '视觉子实体', rows: ['GLB 网格/骨骼子树无刚体', '主角视觉根只补偿鞋底高度', '骨骼 / GlobalTransform → 渲染'] },
];
data.forEach(d => { registry[d.id] = { id: d.id, name: d.name, kind: 'Component', description: d.rows.join('；') }; b += card(d.x, 697, d.w, 151, d.id, d.name, d.rows, 'component', 'small'); });
registry['resource.GameSettings'] = model.resources.find(r => r.id === 'resource.GameSettings');
b += card(30, 697, 330, 151, 'resource.GameSettings', '共享 Resource', ['GameSettings：帧率 / 相机 / 音量', 'PrototypeConfig / Gravity：物理', 'max_fps ≥ 60；默认 60'], 'resource', 'small');
b += edge([[195, 697], [195, 562]], 'R 设置', 'read', [195, 630], ['resource.GameSettings', 'frame_limit']);
b += edge([[560, 562], [560, 697]], 'W 意图', 'write', [560, 630], ['observe_move', 'character.CharacterIntent']);
b += edge([[650,562],[650,675],[1950,675],[1950,697]], 'W 角度 / 模式', 'write', [1670,675], ['observe_look','perspective_apply','camera.OrbitCamera']);
b += edge([[725, 754], [745, 754], [745, 582], [790, 582], [790, 562]], 'R 意图', 'read', [745, 649], ['character.CharacterIntent', 'movement']);
b += edge([[1290, 562], [1290, 648], [925,648], [925,697]], 'W 物理状态', 'write', [1120,648], ['physics_step', 'character.Position']);
b += edge([[2020, 697], [2020, 562]], 'R 角度', 'read', [2020, 640], ['camera.OrbitCamera', 'facing_update']);
b += edge([[2750, 562], [2750, 697]], 'W 世界变换', 'write', [2750, 641], ['transform_propagate', 'visual.GlobalTransform']);
b += text(36, 900, '图例：粗箭头＝执行顺序　R 蓝虚线＝读取　W 绿实线＝写入　Event 橙虚线＝触发　紫线＝引用 / 关系', 'note');
b += '</g>';
// GameplayPlugin 内部安装物理插件，不把内部注册伪装成 main 的额外插件。
const nestedPlugins = [['DemoPhysicsPlugin','src/gameplay.rs','add_plugins((DemoPhysicsPlugin, SoundEventsPlugin))'],['PhysicsPlugins::default()','src/physics.rs','add_plugins(PhysicsPlugins::default())']];
nestedPlugins.forEach(([name,file,needle],i)=>{const id=`plugin-physics-${i}`;registry[id]={name,kind:'Plugin',description:i?'Avian 默认 FixedPostUpdate 求解及物理插值插件。':'GameplayPlugin 内部安装，注册重力同步和碰撞日志。',notes:['内部插件注册关系；不表示系统执行顺序。'],source:{path:file,line:fs.readFileSync(path.join(dir,'../..',file),'utf8').split('\n').findIndex(line=>line.includes(needle))+1}};b+=card(1575+i*505,112,475,135,id,name,['GameplayPlugin → DemoPhysicsPlugin → Avian'],'engine','small');});
// 状态门控单独成区，避免将暂停误画成销毁并重建玩法场景。
b += frame(30, 1060, 2520, 410, 'AppFlow · 状态、场景与输入门控', 'AppState 控制场景生命周期；PlayState 是 InGame 内的子状态；MenuState 保存页面与返回来源。');
b += card(55, 1145, 700, 160, 'resource.AppState', 'MainMenu', ['OnEnter：show_main_menu → suspend_input', '生成菜单 GLB 展台；玩法输入 / 物理停用', 'Start Game → InGame，加载海岛，再等待碰撞就绪生成角色'], 'resource', 'small');
b += card(935, 1145, 700, 160, 'resource.PlayState', 'InGame / Running', ['OnEnter(InGame)：spawn_lighting，建立加载视图', 'OnEnter(Running)：恢复时间与光标捕获', 'GameplayContext、固定玩法、Inspector 有效'], 'resource', 'small');
b += card(1815, 1145, 700, 160, 'state-paused', 'InGame / Paused', ['OnEnter：show_pause_menu → suspend_input', 'Time<Virtual> / Time<Physics> 暂停并清本帧 delta', '保留业务实体；释放光标，隐藏 Inspector'], 'engine', 'small');
b += edge([[755,1225],[935,1225]], 'Start Game', 'order', [845,1225], ['resource.AppState','resource.PlayState','startup_spawn']);
b += edge([[1635,1225],[1815,1225]], 'Esc', 'trigger', [1725,1225], ['resource.PlayState','state-paused','flow_pause']);
b += edge([[2040,1305],[2040,1345],[1285,1345],[1285,1305]], 'Resume：保留原场景', 'order', [1620,1345], ['state-paused','flow_resume','resource.PlayState']);
b += edge([[2320,1305],[2320,1415],[405,1415],[405,1305]], 'Return to Main Menu：退出 InGame 时清理业务根', 'order', [1285,1415], ['state-paused','resource.AppState']);
b += frame(30, 1510, 2520, 310, 'Update · BSN 页面与鼠标 / 导航状态', 'UI 实体树更新后才处理指针，再更新显示；Style 组内系统不虚构串行顺序。');
b += system(55, 1595, 700, 'menu_rebuild', ['页面 / 分类 / 返回来源 / 视口 → 结构 key', '草稿和 status 由 Style 原位更新 Text'], 130);
b += system(935, 1595, 700, 'menu_pointer', ['真实鼠标移动（含空白）→ Pointer', '进入高亮、离开恢复；按钮点击排入消息'], 130);
b += system(1815, 1595, 700, 'menu_style', ['四个 Style 系统无彼此全序', '按钮高亮 / 值与提示 / 说明 / 焦点滚入'], 130);
b += edge([[755,1660],[935,1660]], 'Build →', 'order', [845,1660], ['menu_rebuild','menu_pointer']);
b += edge([[1635,1660],[1815,1660]], 'Pointer → Style', 'order', [1725,1660], ['menu_pointer','menu_style']);
b += text(55, 1770, 'Pointer / Navigation 区分焦点；音量草稿即时预览，Apply 成功后保存，Back 恢复最近应用值。音量与提示变化不重建页面。', 'note');
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
registry['audio-output']={name:'Update / Kira 播放输出',kind:'Engine',description:'UI Style 之后选有效混音并同步实例，再按加载/冷却/并发排队；PostUpdate 就绪后补同步实例，AppExit 时停止。',reads:['resource.AudioMix','resource.AudioInstances','resource.SoundBank','resource.SoundRequestMessages','resource.UiAudioChannel','resource.SfxAudioChannel'],source:systems.audio_play.source};
b+=card(2090,1885,825,155,'audio-output','UI Style → Update → Kira UI / SFX',['失败日志 → 混音 → 实例音量 → 播放 → 退出','0.25 × 总音量 × UI/SFX × 素材增益 → dB','PostUpdate：Queued 就绪后补同步实例'],'engine','small');
b+=edge([[680,1963],[800,1963]],'W','write',[740,1963],['audio-producers','resource.SoundRequestMessages']);
b+=edge([[1320,1962.5],[1380,1962.5],[1380,2075],[2502.5,2075],[2502.5,2040]],'R 请求','read',[1980,2075],['resource.SoundRequestMessages','audio-output']);
b+=edge([[1960,1963],[2090,1963]],'R','read',[2025,1963],['resource.SoundBank','audio-output']);
b+=edge([[2090,2007],[1960,2007]],'W','write',[2025,2007],['audio-output','resource.SoundBank']);
b+=edge([[1285,1725],[1285,1790],[1060,1790],[1060,1885]],'W MenuHover','write',[1060,1790],['menu_pointer','resource.SoundRequestMessages']);
b+=edge([[2515,1660],[2890,1660],[2890,1835],[2710,1835],[2710,1885]],'after(Style)','order',[2810,1835],['menu_style','audio-output']);
b+=card(30,2130,1290,130,'resource.AudioMix','AudioMix · 临时预览与保存分开',['Settings 页面：读取 SettingsDraft.audio，分类切换仍预览','离开设置：读取最近成功应用的 GameSettings.audio','默认 100%；静音丢弃新请求，不占冷却 / 并发'],'resource','small');
b+=edge([[1320,2195],[1360,2195],[2502.5,2195],[2502.5,2040]],'R 有效音量','read',[1900,2195],['resource.AudioMix','audio-output']);

// 建筑外壳透明只读固定镜头姿态；单列实例数据流，保留原有玩法 / 音频区域。
b += frame(30,2310,2885,350,'第三人称 · 固定镜头与建筑外壳半透明','插值后的目标与实际持物 → CameraQuery；检测只写透明需求，镜头距离 / 方向保持跟随计算。');
b += card(50,2395,590,150,'camera_shell.CameraShell','CameraShell · 独立外壳查询',['每栋最多 1 份合并几何','CameraQuery；接触掩码 NONE','完整 World 碰撞继续保留'],'component','small');
b += card(790,2395,590,150,'resource.OccludedBuildings','OccludedBuildings',['有效 TP 相机的建筑需求并集','0.12 m 扫掠 + 0.25 m 镜头重叠','FP / 目标失效清除对应需求'],'resource','small');
b += card(1530,2395,590,150,'building.BuildingFadeState','BuildingFadeState',['0.15 s → 原 alpha × 20%','无遮挡 0.25 s 后，用 0.35 s 恢复','不修改碰撞 / 拾取 / 镜头姿态'],'component','small');
b += card(2270,2395,625,150,'resource.ShellMaterialCache','实例材质副本与绑定',['缓存键：building + 原 material','ShellMaterialBinding 保留原句柄','Last 清失效；暂停不推进渐变'],'resource','small');
b += edge([[640,2470],[790,2470]],'查询','read',[715,2470],['camera_shell.CameraShell','camera_occlusion','resource.OccludedBuildings']);
b += edge([[1380,2470],[1530,2470]],'需求','read',[1455,2470],['resource.OccludedBuildings','building_fade','building.BuildingFadeState']);
b += edge([[2120,2470],[2270,2470]],'实例因子','write',[2195,2470],['building_fade','building.BuildingFadeState','resource.ShellMaterialCache']);
b += text(55,2618,'仅识别的建筑外壳淡化；家具、地板、NPC、包裹、未知部件与非建筑保持正常外观。第三人称人物始终遵循模式可见性。','note');

// 窗口策略作为独立平台桥接展示，不把原生回调画成菜单输入。
b += frame(30,2740,2885,270,'WindowPolicyPlugin · 原生 16:9 窗口','Windows/macOS：初始隐藏 → 窗口线程安装 → 显示；无窗口后端不调用原生 API。');
b += system(55,2825,700,'window_install',['PreUpdate · NonSendMarker / NonSendMut','WINIT_WINDOWS 只短借用取得存活 Entity'],130);
b += card(935,2825,700,130,'non_send.NativePolicies','NativePolicies · NonSend',['active：Entity → 原生守卫；failed：Entity 集合','实体 / 后端退出 → Drop 卸载或恢复属性'],'resource','small');
registry['window-native-policy']={name:'原生窗口约束',kind:'Native platform bridge',description:'Windows subclass 在尺寸应用前约束；macOS contentAspectRatio、工作区 min/max 及 Zoom 校准。纯几何与平台守卫不是 ECS 组件。',source:{path:'src/window_policy/macos.rs',line:22},platform_sources:[{source:{path:'src/window_policy/windows.rs',line:175}},{source:{path:'src/window_policy/geometry.rs',line:69}}]};
b += card(1815,2825,1075,130,'window-native-policy','Windows / macOS 原生窗口约束',['内容 16:9；拖边 / 工作区 / DPI / 最大化','主线程原生 API 在后端借用结束后调用'],'engine','small');
b += edge([[755,2890],[935,2890]],'R / W 守卫','write',[845,2890],['window_install','non_send.NativePolicies']);
b += edge([[1635,2890],[1815,2890]],'安装 / 刷新 / Drop','reference',[1725,2890],['non_send.NativePolicies','window-native-policy']);
b += text(55,2985,'只支持范围内保证 UI：逻辑最小 960×540；工作区不足时优先保持比例和可用范围，日志记录 small_work_area。','small');

save('overview', '当前 App · ECS 总览', 2955, 3100, b, '输入 → 固定控制力 → Avian 求解 → 插值 → 固定镜头 / 建筑外壳淡化 → 世界变换与渲染。');

// 时序视图：每个注册实例单独呈现，R/W 在卡片内列摘要，点击显示完整读写项。
b = text(36, 80, '系统卡片中的 R / W 是访问摘要；同一函数在不同 Schedule 中有两个注册实例。', 'note');
const columns = [
  { x: 30, w: 300, phase: 'First', note: '每帧一次', ids: ['frame_limit', 'time_update'] },
  { x: 375, w: 420, phase: 'PreUpdate', note: '每帧一次；响应输入', ids: [] },
  { x: 840, w: 420, phase: 'FixedFirst / FixedUpdate', note: '60 Hz · 每帧 0～N 次', ids: [] },
  // 保持卡片宽度，给独立碰撞日志支线预留右侧走线槽。
  { x: 1305, w: 430, nodeWidth: 380, phase: 'FixedPostUpdate', note: 'Avian 默认物理解算', ids: ['physics_prepare','physics_step','physics_writeback','grounded_after','velocity_log'] },
  { x: 1760, w: 330, phase: 'FixedLast', note: '每个固定步末尾', ids: ['easing_end'] },
  { x: 2135, w: 380, phase: '固定循环之后', note: 'RunFixedMainLoop · AfterFixedMainLoop', ids: ['easing_apply','facing_update','held_update','camera_follow','camera_occlusion','building_fade','visibility_update','easing_tick'] },
  { x: 2560, w: 470, phase: 'Update / SpawnScene', note: '资源 / 海岛 / 主角 / 菜单不设全序', ids: [] },
  { x: 3075, w: 400, phase: 'PostUpdate / 渲染', note: '动画 → 鞋底补偿 → 传播；UI 独立', ids: [] },
];
const accessName = value => value.split('.').pop().replace(/\s*\(.*/, '');
function accessRows(id) { const s = systems[id]; const summarize = values => { const rank = v => v.startsWith('resource.') ? 1 : v.startsWith('local.') ? 2 : 0; const sorted = [...values].sort((a,b)=>rank(a)-rank(b)); return sorted.map(accessName).slice(0,2).join(' / ') + (values.length>2?' …':''); }; return [brief[id] || s.description, ...(s.reads.length ? [`R ${summarize(s.reads)}`] : []), ...(s.writes.length ? [`W ${summarize(s.writes)}`] : [])].slice(0, 3); }
columns.forEach(col => { const nodeWidth = col.nodeWidth ?? col.w - 30, centerX = col.x + 15 + nodeWidth / 2; b += frame(col.x, 112, col.w, 2520, col.phase, `«Schedule» · ${col.note}`, '#526477', `schedule-${col.phase}`); col.ids.forEach((id, i) => {
  b += system(col.x + 15, 193 + i * 160, nodeWidth, id, accessRows(id), 130);
  if (i) b += edge([[centerX, 163 + i * 160], [centerX, 193 + i * 160]]);
 }); });
// 这里只展开和捕获逻辑有关的输入集合；主 UI 的多轮执行另列于 PostUpdate。
[['input_update','InputSystems'],['egui_input','Egui · ProcessInput'],['filter_egui_input','filter_captured_egui_input'],['egui_begin','Egui · BeginPass（集合边界）']].forEach(([id,label],i)=>{registry[id]=systems[id];b+=compact(390,193+i*50,390,28,id,label,systems[id].kind);b+=edge([[585,221+i*50],[585,i===3?400:243+i*50]],'','order',null,[id,i===3?'mouse_capture':['egui_input','filter_egui_input','egui_begin'][i]]);});
const preNodes = [ ['mouse_capture', 400, 130], ['capture_apply', 555, 96], ['enhanced_prepare', 676, 96], ['enhanced_evaluate', 797, 96], ['input_apply', 918, 106], ['event_apply', 1049, 106], ['perspective_apply', 1180, 130] ];
systems.event_apply = { id:'event_apply', name:'ApplyDeferred · 动作事件', kind:'sync', phase:'PreUpdate', description:'应用 Enhanced Input 排入的 trigger 命令，此时触发匹配 Observer。', reads:[], writes:['character.CharacterIntent','camera.OrbitCamera'], filters:[], events:model.observers.filter(o=>o.system.startsWith('observe_')).map(o=>o.event), notes:['这是命令同步点，不是 EnhancedInputSystems::Apply。','apply_perspective_toggle.after(EnhancedInputSystems::Apply) 建立依赖；常规调度在需要时自动应用延迟命令。','Observer 之间没有注册顺序所保证的串行依赖。'], source:systems.perspective_apply.source };
brief.event_apply = '应用 trigger 命令 → 匹配动作 Observer';
brief.capture_apply = '应用 ContextActivity 替换';
preNodes.forEach(([id,y,h],i)=>{b += system(390,y,390,id,h===130?accessRows(id):[brief[id] || systems[id].description],h);if(i){const previous=preNodes[i-1];b+=edge([[585,previous[1]+previous[2]],[585,y]],'','order',null,[previous[0],id]);}});
b += text(399, 1339, 'UI 捕获停用 GameplayContext；', 'small');
b += text(399, 1365, '动作 Complete / Cancel 清除移动轴。', 'small');
if (systems.water_recover && systems.interpolation_resume && systems.easing_start) {
  b += system(855, 193, 390, 'easing_reset', ['重置旧插值状态'], 90);
  b += system(855, 307, 390, 'interpolation_resume', ['只撤销上次恢复添加的暂停标记'], 80);
  registry.resume_apply = {name:'ApplyDeferred · 恢复插值',kind:'sync',description:'应用暂停组件清理，再记录新固定步起点。',source:systems.interpolation_resume.source};
  b += card(855,425,390,52,'resume_apply','ApplyDeferred · 插值暂停清理',[],'sync');
  b += system(855,520,390,'easing_start',['记录本固定步插值起点'],90);
  b += edge([[1050,283],[1050,307]],'','order',null,['easing_reset','interpolation_resume']);
  b += edge([[1050,387],[1050,425]],'','order',null,['interpolation_resume','resume_apply']);
  b += edge([[1050,477],[1050,520]],'','order',null,['resume_apply','easing_start']);
  b += system(855,660,390,'water_recover',['y < -1.5 → 出生点 / 清速度','解除持握；持续移动轴保留'],110);
  b += edge([[1050,610],[1050,660]],'','order',null,['easing_start','water_recover']);
  b += system(855,825,187,'gravity_sync',['配置 → Gravity'],85);
  b += system(1058,825,187,'facing_fixed',['当前 yaw → 朝向'],85);
  // FixedFirst 后进入两个独立 FixedUpdate 分支；重力不假借恢复节点建立顺序。
  b += edge([[855,555],[815,555],[815,867],[855,867]],'','order',null,['easing_start','gravity_sync']);
  b += edge([[1151,770],[1151,825]],'恢复后按视角转向','order',[995,798],['water_recover','facing_fixed']);
  b += edge([[948,910],[948,940],[1050,940]],'','order',null,['gravity_sync','grounded_fixed'],false);
  b += edge([[1151,910],[1151,940],[1050,940]],'','order',null,['facing_fixed','grounded_fixed'],false);
  b += edge([[1050,940],[1050,975]],'','order',null,['gravity_sync','facing_fixed','grounded_fixed']);
  const fixedNodes = ['grounded_fixed','movement','gravity','interaction','held_apply','orphan_cleanup','orphan_apply','held_fixed','grip_forces','audio_strain'];
  fixedNodes.forEach((id,i)=>{const y=975+i*155;b+=system(855,y,390,id,accessRows(id),130);if(i)b+=edge([[1050,y-25],[1050,y]],'','order',null,[fixedNodes[i-1],id]);});
} else {
  b += system(855,193,390,'easing_reset',[brief.easing_reset],96);
  b += system(855,360,187,'gravity_sync',[brief.gravity_sync],96);
  b += system(1058,360,187,'facing_fixed',['水平 yaw → 朝向'],96);
  b += edge([[948,456],[948,480],[1050,480]],'','order',null,['gravity_sync','grounded_fixed'],false);
  b += edge([[1151,456],[1151,480],[1050,480]],'','order',null,['facing_fixed','grounded_fixed'],false);
  b += edge([[1050,480],[1050,510]],'','order',null,['gravity_sync','facing_fixed','grounded_fixed']);
  b += text(860,502,'二者无彼此顺序','small');
  b += text(1080,502,'下方为显式玩法链','small');
  const fixedNodes = ['grounded_fixed','movement','gravity','interaction','held_apply','orphan_cleanup','orphan_apply','held_fixed','grip_forces','audio_strain'];
  fixedNodes.forEach((id,i)=>{const y=510+i*160;b+=system(855,y,390,id,accessRows(id),130);if(i)b+=edge([[1050,y-30],[1050,y]],'','order',null,[fixedNodes[i-1],id]);});
  b += edge([[1050,289],[1050,314],[948,314],[948,360]],'','order',null,['easing_reset','gravity_sync']);
  b += edge([[1050,314],[1151,314],[1151,360]],'','order',null,['easing_reset','facing_fixed']);
}
b += system(1320, 1170, 380, 'collision_log', accessRows('collision_log'), 130);
// 支线从卡片边缘出发，绕过中间节点；标签放在线外，保留转折及箭头的连续走线。
b += edge([[1700,415],[1723,415],[1723,1415]],'','order',null,['physics_step','collision_log','audio_land'],false);
b += edge([[1723,1135],[1510,1135],[1510,1170]],'after(StepSimulation)','order',[1510,1100],['physics_step','collision_log']);
b += text(1324, 1350, '碰撞日志与 Writeback 后观察无全序', 'small');
// 新增行为只绘制候选模型中实际存在的 ID，分步提交不会提前展示后续系统。
if (systems.asset_poll) b += system(2575,193,440,'asset_poll',['Loading → Ready / Failed','递归依赖就绪；状态变化才记录'],118);
const islandIds = ['island_begin','island_prepare','actors_spawn'].filter(id => systems[id]);
islandIds.forEach((id,i) => { const y=420+i*160; b+=system(2575,y,440,id,accessRows(id),130); if(i)b+=edge([[2795,y-30],[2795,y]],'chain / Commands','order',[2648,y-16],[islandIds[i-1],id]); });
b += text(2584,350,'资源轮询与海岛链无显式先后','small');
const animationIds = ['animation_initialize','animation_sync'].filter(id=>systems[id]);
animationIds.forEach((id,i)=>{const y=1020+i*160;b+=system(2575,y,440,id,accessRows(id),130);if(i)b+=edge([[2795,y-30],[2795,y]],'chain / Commands','order',[2648,y-16],[animationIds[i-1],id]);});
if(animationIds.length)b+=text(2584,963,'主角动画链与海岛链无显式全序','small');
if(systems.world_spawn){b+=system(2575,1450,440,'world_spawn',['SpawnScene：模板实例化','WorldInstanceReady → 对应 Observer'],130);b+=text(2584,1640,'就绪标记由后续 Update 消费','small');}
if(systems.menu_animation_play){b+=system(2575,1780,440,'menu_animation_play',accessRows('menu_animation_play'),130);b+=text(2584,1950,'菜单 GLTF / clip 未入库保留 pending；','small');b+=text(2584,1978,'按 Carry_Idle 名称绑定，不依赖排列。','small');}
const postX=3090;
if(systems.animation_engine){b+=system(postX,193,320,'animation_engine',['采样图 → 本帧骨骼 Transform'],118);b+=edge([[3250,311],[3250,370]],'after(AnimationSystems)','order',[3250,342],['animation_engine','animation_grounding']);}
b += system(postX,370,320,'animation_grounding',['Running：本帧鞋底 → 视觉高度','TransformHelper 读骨链；不写物理'],118);
b += edge([[3250,488],[3250,585]],'before(Propagate)','order',[3250,536],['animation_grounding','transform_propagate']);
b += system(postX,585,320,'transform_propagate',['R 根 Transform / ChildOf','W GlobalTransform / 可见性'],118);
b += system(postX,800,320,'inspector_pass',['反射读取 / 编辑实体、资源与资产','multipass：每帧可多轮处理'],118);
b += text(3099,761,'Running 显示检查器；无分支全序','small');
b += edge([[3410,644],[3450,644],[3450,995],[3330,995],[3330,1040]],'','order',null,['transform_propagate','render']);
b += edge([[3250,918],[3250,1040]],'','order',null,['inspector_pass','render']);
b += system(postX,1040,320,'render',['Extract → Prepare → Render','RenderApp 是相关子应用概览'],118);
columns.slice(0, -1).forEach((col, i) => b += edge([[col.x + col.w, 144], [columns[i + 1].x, 144]]));
b += text(43, 2590, 'OnEnter(InGame) 只准备日光/加载相机；Running 的 Update 资源和静态碰撞就绪后生成动态根。', 'note');
b += text(43, 2624, 'Commands 同步点用琥珀色框；碰撞日志与回写后接地/采样只有各自明确的依赖。', 'note');
b += text(43, 2658, '固定循环每帧 0～N 次；AfterFixedMainLoop 的 Ease → 显示链 → UpdateEasingTick 每帧执行。', 'note');
b += text(43, 2692, 'HeldTarget 仅呈现检查；物理施力直接读 Position，不读取插值目标，不把箱体直接搬到手前。', 'note');
// 原物理解算支线保持独立；落地音效只依赖实际 StepSimulation。
b += system(1320, 1460, 380, 'audio_land', accessRows('audio_land'), 130);
b += edge([[1723,1415],[1510,1415],[1510,1460]],'after(StepSimulation)','order',[1510,1385],['physics_step','audio_land']);
b += text(1324, 1635, '落地 / 日志 / Writeback 无额外全序', 'small');
// 生命周期、菜单与播放独立展开，避免改变海岛准备或动画链的读法。
b += frame(30, 2740, 680, 535, 'Startup · 持久输入与预加载', '系统彼此无串行约束；实际玩法场景不在 Startup。');
['menu_spawn_controller','startup_assets','startup_pose','startup_timestep','startup_inspector','audio_preload'].forEach((id,i)=>{
  b += system(50+i%2*330,2825+Math.floor(i/2)*150,310,id,[brief[id]||systems[id].description],110);
});
b += frame(750,2740,680,535,'PreUpdate · 菜单上下文与消息','上下文在 Prepare 前；请求消费在动作 Apply 后。');
b += system(770,2825,640,'menu_sync_context',accessRows('menu_sync_context'),130);
b += system(770,3015,640,'menu_handle_requests',accessRows('menu_handle_requests'),130);
b += text(777,3230,'UiRequest → 页面 / 草稿 / NextState / 退出。','small');
b += frame(1470,2740,1480,535,'StateTransition · 生命周期','MainMenu / Paused 的页面系统在 suspend_input 前；不同状态入口无串行链。');
['flow_enter_menu','flow_pause','flow_suspend','flow_resume','startup_spawn','menu_backdrop_spawn'].forEach((id,i)=>{
  b += system(1490+i%3*485,2825+Math.floor(i/3)*200,455,id,[brief[id]||systems[id].description,systems[id].phase],130);
});
b += text(1495,3200,'InGame 退出清理业务根和海岛；MainMenu 退出清理展台。Paused 保留原会话。','small');
b += frame(30,3310,2920,1120,'Update · Build → Pointer / Bind → 音量处理 → Style','结构命令先应用；音量元组与 Style 各组内无虚构串行链。');
b += system(55,3395,740,'menu_rebuild',accessRows('menu_rebuild'),130);
b += system(935,3395,740,'menu_pointer',accessRows('menu_pointer'),130);
b += card(1855,3395,1040,130,'ui-volume-set','音量元组 · after(Build / Pointer)',['两个系统都在 Style 之前，彼此没有显式先后','滑条输入只发消息；显示读取 PreUpdate 已更新的草稿'],'engine','small');
b += edge([[795,3460],[935,3460]],'应用 UI 命令','order',[865,3460],['menu_rebuild','menu_pointer']);
b += edge([[1675,3460],[1855,3460]],'after(Pointer)','order',[1765,3460],['menu_pointer','ui-volume-set']);
b += system(1875,3570,490,'menu_volume_pointer',[brief.menu_volume_pointer,'R 光标 / 左键 / Interaction；W 请求 / Local'],110);
b += system(2405,3570,490,'menu_volume_visuals',[brief.menu_volume_visuals,'R 草稿；W 既有 Text / Node'],110);
b += edge([[2201.7,3525],[2201.7,3548],[2120,3548],[2120,3570]],'','registration',null,['ui-volume-set','menu_volume_pointer']);
b += edge([[2548.3,3525],[2548.3,3548],[2650,3548],[2650,3570]],'','registration',null,['ui-volume-set','menu_volume_visuals']);
b += card(55,3750,2840,130,'ui-style-set','UiSystems::Style',['四个显示系统在音量处理之后；组内没有显式全序','输入来源区分 Pointer / Navigation，音量 / 提示不销毁既有实体'],'engine','small');
b += edge([[2120,3680],[2120,3715]],'','order',null,['menu_volume_pointer','ui-style-set'],false);
b += edge([[2650,3680],[2650,3715]],'','order',null,['menu_volume_visuals','ui-style-set'],false);
b += edge([[2650,3715],[1475,3715],[1475,3750]],'before(Style)','order',[1750,3715],['menu_volume_pointer','menu_volume_visuals','ui-style-set']);
// 滚动条绑定与指针同在 Build 后执行，不增加彼此的全序。
b += system(55,3570,740,'menu_bind_scrollbars',accessRows('menu_bind_scrollbars'),130);
b += edge([[425,3525],[425,3570]],'Build → Bind','order',[500,3550],['menu_rebuild','menu_bind_scrollbars']);
b += edge([[425,3700],[425,3715],[1475,3715]],'before(Style)','order',[845,3715],['menu_bind_scrollbars','ui-style-set'],false);
['menu_style','menu_description','menu_settings_text','menu_scroll_focus'].forEach((id,i)=>{
  const x=55+i*740;
  b += system(x,3970,620,id,[brief[id]],115);
  b += edge([[55+2840*(i+1)/5,3880],[55+2840*(i+1)/5,3925],[x+310,3925],[x+310,3970]],'','registration',null,['ui-style-set',id]);
});
b += system(55,4210,790,'menu_asset_failures',accessRows('menu_asset_failures'),130);
b += card(1045,4210,790,130,'resource.MenuInputSource','菜单输入来源',['Navigation：实际导航显示焦点','Pointer：真实移动、点击或离开窗口接管','文字保留自然测量；Apply / Tab 不常驻黄'],'resource','small');
b += frame(3010,2740,465,1690,'Update / PostUpdate · Kira 输出','Update 在 Style 后；PostUpdate 仅依赖 TypedChannels。');
const audioChain=['audio_load_failures','audio_mix','audio_voice_volumes','audio_play','audio_stop'];
audioChain.forEach((id,i)=>{
  const y=2825+i*215;
  b += system(3025,y,435,id,accessRows(id),150);
  if(i)b += edge([[3242.5,y-65],[3242.5,y]],'chain','order',[3310,y-32],[audioChain[i-1],id]);
});
b += card(3025,3900,435,120,'kira-play-typed','PostUpdate · PlayTypedChannels',['Kira 将 Queued 句柄写入 Assets','不与其它 PostUpdate 分支建立全序'],'engine','small');
b += system(3025,4130,435,'audio_voice_volumes_post',[brief.audio_voice_volumes_post,'R AudioMix；W SoundBank / 实例'],150);
b += edge([[3242.5,4020],[3242.5,4130]],'after','order',[3320,4075],['kira-play-typed','audio_voice_volumes_post']);
b += text(3025,4320,'Time<Real>；UI ≤ 4 / SFX ≤ 3；静音丢弃','small');
b += text(55,4470,'Running 门控海岛准备、主角动画、落水恢复、固定玩法与显示链；菜单和音频继续逐帧处理。','note');

// 原生滚动条几何属于 Layout；显隐在布局后、可见性传播前同步。
b += frame(30,4840,3445,300,'PostUpdate · 设置滚动条布局与显隐','固定 gutter；Main/Pause/Help 无视口；只有 Settings 右侧纸色面板内容滚动。');
registry['native-ui-layout']={name:'UiSystems::Layout',kind:'Engine SystemSet',description:'计算本帧 UI 内容与视口；原生 thumb 系统在 ui_layout_system 之后且仍属于 Layout。',source:{path:'src/ui/widgets.rs',line:63}};
registry['native-scrollbar-layout']={name:'ScrollbarPlugin · thumb geometry',kind:'Engine system',description:'DefaultPlugins 的原生 ScrollbarPlugin 按 target 的内容/视口比例计算滑块几何；滑块不带 Node。',source:{path:'src/ui/widgets.rs',line:115}};
registry['native-visibility']={name:'VisibilityPropagate',kind:'Engine system set',description:'在项目显隐同步后传播可见性。',source:{path:'src/ui/widgets.rs',line:64}};
b += card(55,4925,650,130,'native-ui-layout','UiSystems::Layout',['ui_layout_system：真实 ComputedNode','原生 thumb 几何在同一 Layout 集合内'],'engine','small');
b += card(870,4925,650,130,'native-scrollbar-layout','ScrollbarPlugin · thumb geometry',['target → 比例 / track / thumb 几何','属于 Layout，after(ui_layout_system)'],'engine','small');
b += system(1685,4925,790,'menu_sync_scrollbars',['实际溢出 → Hidden / Inherited + Pickable','fit / 离页取消拖拽；内容缩短夹取范围','W ScrollPosition / 高亮 / dragging'],130);
b += card(2640,4925,810,130,'native-visibility','VisibilityPropagate',['传播项目同步后的 Hidden / Inherited','拾取、拖拽与范围夹取由前一项目系统负责'],'engine','small');
b += edge([[705,4990],[870,4990]],'Layout 内','order',[788,4990],['native-ui-layout','native-scrollbar-layout']);
b += edge([[1520,4990],[1685,4990]],'after(Layout)','order',[1602,4990],['native-scrollbar-layout','menu_sync_scrollbars']);
b += edge([[2475,4990],[2640,4990]],'before','order',[2557,4990],['menu_sync_scrollbars','native-visibility']);
b += frame(30,5190,3445,275,'Startup / PreUpdate · 原生窗口策略','两种 Schedule 独立注册；原生 resize 回调不属于 ECS 调度或增强输入动作。');
b += system(55,5275,700,'window_log',accessRows('window_log'),130);
b += system(935,5275,1075,'window_install',accessRows('window_install'),130);
b += card(2190,5275,1260,130,'non_send.NativePolicies','NativePolicies · NonSend',['NonSendMarker 固定在窗口线程；守卫归 active 所有','短借用后端 map → 原生安装 / macOS 刷新 / 退出 Drop'],'resource','small');
b += edge([[2010,5340],[2190,5340]],'R / W','write',[2100,5340],['window_install','non_send.NativePolicies']);

// Last 是独立主阶段，避免将暂停时仍执行的生命周期清理画进 Running 显示链。
b += frame(30,5510,3445,270,'Last · 建筑外壳生命周期清理','不受 gameplay_running 条件限制；不读取时间，不推进正常渐变；场景销毁和暂停仍执行。');
b += system(55,5600,920,'fade_cleanup',accessRows('fade_cleanup'),130);
b += card(1135,5600,960,130,'building_visual.ShellMaterialBinding','恢复本系统拥有的材质绑定',['相机 / 目标失效 → 立即恢复原句柄','外部替换句柄 → 清绑定，保留外部新句柄','失效建筑 / 外壳 / 原资产 → 释放缓存副本'],'component','small');
b += card(2255,5600,1195,130,'resource.ShellMaterialCache','ShellMaterialCache / Assets<StandardMaterial>',['正常恢复保留可复用副本；仅失效关联删除副本资产','Commands 清除无外壳的 BuildingFadeState 与失效 Binding','与前面的正常计时渐变职责分开'],'resource','small');
b += edge([[975,5665],[1135,5665]],'W 绑定','write',[1055,5665],['fade_cleanup','building_visual.ShellMaterialBinding']);
b += edge([[515,5730],[515,5760],[2852.5,5760],[2852.5,5730]],'W 缓存 / 副本资产','write',[1610,5760],['fade_cleanup','resource.ShellMaterialCache']);

save('schedules', '调度泳道 · 系统与数据访问', 3515, 5820, b, '固定控制 → 物理解算 → 插值后显示；Last 独立清理外壳；点击查看完整访问。');

// 关系视图：矩形容器表达实体，内嵌组件；普通 Entity 引用与 Bevy 关系单独标注。
b = text(36, 80, '按实体角色汇总关键组件，可选组件并非始终存在；虚线＝普通引用，紫实线＝Bevy 关系。', 'note');
const entityBoxes = [
  {id:'controller',x:30,y:112,w:360,h:350},{id:'action',x:540,y:112,w:360,h:315},{id:'binding',x:1050,y:112,w:360,h:230},
  {id:'character',x:30,y:650,w:360,h:660},{id:'parcel',x:540,y:650,w:360,h:700},{id:'camera',x:1050,y:650,w:360,h:400},
  {id:'world',x:1050,y:1130,w:360,h:430},{id:'visual',x:30,y:1750,w:360,h:460},{id:'window',x:1050,y:1660,w:360,h:300},
  {id:'island',x:1510,y:112,w:440,h:350},{id:'npc',x:1510,y:550,w:440,h:260},{id:'animation_player',x:1510,y:930,w:440,h:360},{id:'model_node',x:1510,y:1450,w:440,h:480},
].filter(box=>entities[box.id]);
const primaryComponents = {
  controller:['PlayerId','GameplayContext','ContextActivity','ControlsCharacter','ControlsCamera','Actions','GamepadDevice'], action:['Action','ActionSettings','ActionOf','Bindings','Press'], binding:['Binding','BindingOf'],
  character:['Character','CharacterIntent','CharacterMotion','SpawnPoint','RigidBody','Collider','Position','LinearVelocity','Transform','CollisionLayers','SweptCcd','LockedAxes','TranslationInterpolation','HoldingItems','Children'],
  parcel:['Parcel','Pickable','ItemModel','CarryGrip','SpawnPoint','RigidBody','Collider','Position','LinearVelocity','AngularVelocity','Transform','CollisionLayers','HeldBy','HeldTarget','TransformInterpolation','Children'],
  camera:['LoadingCamera','OrbitCamera','CameraOcclusion','MouseLookState','Camera3d','Transform'],world:['IslandCollider','RigidBody','Collider','CollisionLayers','Transform','ChildOf'],
  visual:['CharacterVisual','CourierVisual','CourierAnimationPending','CourierFootGrounding','WorldAssetRoot','Transform','GlobalTransform','ChildOf','Children','Visibility'],window:['PrimaryWindow','Window','CursorOptions','RawHandleWrapper'],
  island:['IslandMap','IslandPending','IslandReady','ActorsSpawned','WorldAssetRoot','Children'],npc:['DisplayNpc','ChildOf'],animation_player:['AnimationPlayer','AnimationGraphHandle','CourierAnimation','ChildOf'],model_node:['Name','Transform','GlobalTransform','ChildOf','Mesh3d','MeshMaterial3d','Visibility','SkinnedMesh','AnimationTargetId','AnimatedBy']
};
entityBoxes.forEach(box=>{const e=entities[box.id];registry[`entity-${e.id}`]={...e,name:e.name,kind:'Entity'};
  const shortName={visual:'直属 GLB 视觉根',action:'动作',binding:'输入绑定',controller:'控制者',character:'角色',parcel:'五件可搬物',camera:'同一相机',world:'海岛静态碰撞',window:'主窗口',island:'海岛实例根',npc:'地图展示 NPC',animation_player:'主角播放器节点',model_node:'GLB 网格/骨骼节点'}[e.id];
  b+=`<g class="node entity" ${register(`entity-${e.id}`,registry[`entity-${e.id}`])}>${frame(box.x,box.y,box.w,box.h,`«Entity» ${shortName}`,`数量：${e.count}`,colors.entity, `entity-${e.id}`)}</g>`;
  const key=c=>c.name.split('<')[0].split(' ')[0];
  const visible=e.components.filter(c=>primaryComponents[e.id].includes(key(c))).sort((a,b)=>primaryComponents[e.id].indexOf(key(a))-primaryComponents[e.id].indexOf(key(b)));
  e.components.forEach(c=>registry[c.id]={...c,kind:'Component',owner:e.name});
  visible.forEach((c,i)=>b+=compact(box.x+15,box.y+71+i*34,box.w-30,30,c.id,c.name==='CharacterVisual'?'CharacterVisual（仅人物）':c.name));
  b+=text(box.x+16,box.y+box.h-12,`完整清单：${e.components.length} 项 · 可选组件并非始终存在`,'small');
});
b += edge([[540, 214], [390, 214]], 'ActionOf', 'relationship', [465, 212], ['entity-action', 'entity-controller']);
b += text(408, 247, '← Actions', 'small');
b += text(408, 272, '反向索引', 'small');
b += edge([[1050, 214], [900, 214]], 'BindingOf', 'relationship', [975, 212], ['entity-binding', 'entity-action']);
b += text(921, 247, '← Bindings', 'small');
b += text(921, 272, '反向索引', 'small');
b += edge([[152, 462], [152, 650]], 'ControlsCharacter', 'reference', [152, 566], ['entity-controller', 'entity-character']);
b += edge([[326, 462], [326, 493], [1230, 493], [1230, 650]], 'ControlsCamera', 'reference', [778, 493], ['entity-controller', 'entity-camera']);
b += edge([[1350, 650], [1350, 546], [370, 546], [370, 462]], 'toggle_requested_by（临时）', 'reference', [875, 546], ['entity-camera', 'entity-controller']);
b += edge([[1143, 650], [1143, 600], [273, 600], [273, 650]], 'OrbitCamera.target', 'reference', [735, 600], ['entity-camera', 'entity-character']);
b += edge([[540, 810], [390, 810]], 'HeldBy', 'relationship', [465, 808], ['entity-parcel', 'entity-character']);
b += text(399, 848, '← HoldingItems', 'small');
b += text(407, 873, '无 linked_spawn', 'small');
b += edge([[157, 1750], [157, 1310]], 'ChildOf：人物模型', 'relationship', [157, 1500], ['entity-visual', 'entity-character']);
// 标签靠近下方横线，避开 Resource 框的边界与竖向走线。
b += edge([[390, 1927], [965, 1927], [965, 1300], [900,1300]], 'ChildOf：箱子模型', 'relationship', [690, 1900], ['entity-visual', 'entity-parcel']);
b += frame(540, 2290, 1410, 228, '关系的基数与生命周期', '这里只描述当前源码声明的行为。');
b += lines(561, 2374, ['HeldBy：每箱 0..1 位持有者；HoldingItems 容器允许 0..N，当前业务一次持一件。', 'ActionOf / BindingOf / ChildOf 声明 linked_spawn；HeldBy 不连带销毁箱体。', '失效持有者 / 异常解除：移除 HeldTarget、恢复自由碰撞，动态箱体自然下落。', 'Position / Velocity 为物理状态，Transform 为插值呈现；视觉子实体无刚体。', '持握使用反作用力，仍参与世界碰撞；持握箱当前忽略全部 Character 层。'], 'small', 27);
b += frame(540, 1430, 360, 393, '«Resource / Local» 数据范围', 'Resource 共享；Local 属于某个系统。');
model.resources.forEach(r => registry[r.id] = r);
['resource.GameSettings','resource.PrototypeConfig','resource.TimeFixed','resource.Gravity','resource.ColliderTrees','resource.ArtAssets','resource.ArtLoadState'].filter(id=>registry[id]).forEach((id,i)=>{const r=registry[id];b+=compact(554,1500+i*33,332,28,id,r.name,'resource');});
b += text(557, 1760, '预留集合 / 采样计时：Local', 'small');
b += text(557, 1788, 'LastEasingTick：插值共享 Resource', 'small');
if(entities.island && entities.npc){b+=edge([[1730,550],[1730,462]],'原地图子树','relationship',[1730,502],['entity-npc','entity-island']);}
if(entities.model_node){
  b+=edge([[1950,1670],[2070,1670],[2070,320],[1950,320]],'地图导入子树','relationship',[2070,860],['entity-model_node','entity-island']);
  b+=edge([[1410,1360],[1460,1360],[1460,1580],[1510,1580]],'ChildOf：原地图实例','relationship',[1460,1403],['entity-world','entity-model_node']);
  b+=edge([[1510,1850],[1484,1850],[1484,2175],[390,2175]],'GLB 节点 ChildOf 子树','relationship',[1010,2175],['entity-model_node','entity-visual']);
}
if(entities.animation_player){
  b+=edge([[1510,1210],[1448,1210],[1448,2242],[332,2242],[332,2210]],'CourierVisual 内的播放器子树','relationship',[1080,2242],['entity-animation_player','entity-visual']);
  b+=edge([[1510,995],[1432,995],[1432,621],[355,621],[355,650]],'CourierAnimation.character','reference',[920,621],['entity-animation_player','entity-character']);
}
// 高度补偿缓存的是普通引用；GLB ChildOf 生命周期与数据读取关系分别表达。
b+=edge([[220,1750],[220,1660],[480,1660],[480,1210],[390,1210]],'补偿 → 角色','reference',[480,1510],['entity-visual','entity-character','visual.CourierFootGrounding']);
b+=edge([[390,2050],[1418,2050],[1418,1880],[1510,1880]],'缓存八个鞋底节点','reference',[960,2050],['entity-visual','entity-model_node','visual.CourierFootGrounding']);
b+=edge([[390,1990],[950,1990],[1000,1990],[1470,1990],[1470,1332],[1730,1332],[1730,1290]],'首个播放器 / 接地状态','reference',[1150,1990],['entity-visual','entity-animation_player','visual.CourierFootGrounding']);
b+=edge([[1900,1450],[1900,1290]],'AnimatedBy','reference',[1900,1380],['entity-model_node','entity-animation_player','model_node.AnimatedBy']);
// 菜单实体在海岛和骨骼层级右侧独立展开，省略中间 BSN 布局容器。
const menuEntityBoxes=[
 {id:'menu_controller',x:2250,y:112,w:430,h:350},{id:'menu_root',x:2780,y:112,w:430,h:350},
 {id:'menu_scroll',x:2250,y:560,w:430,h:430},{id:'menu_button',x:2780,y:560,w:430,h:430},
 {id:'menu_backdrop',x:2250,y:1100,w:430,h:380},{id:'menu_camera',x:2780,y:1100,w:430,h:380},
 {id:'menu_model',x:2250,y:1630,w:430,h:430},{id:'menu_text',x:2780,y:1630,w:430,h:430},
 {id:'menu_volume',x:2780,y:2140,w:430,h:330},
 {id:'settings_panel',x:3330,y:112,w:530,h:350},{id:'settings_scrollbar',x:3330,y:560,w:530,h:430},
 {id:'settings_scrollbar_thumb',x:3940,y:560,w:530,h:430},
];
menuEntityBoxes.forEach(box=>{
 const e=entities[box.id],id=`entity-${e.id}`;registry[id]={...e,kind:'Entity'};
 b += `<g class="node entity" ${register(id,registry[id])}>${frame(box.x,box.y,box.w,box.h,`«Entity» ${e.name}`,`数量：${e.count}`,colors.entity,id)}</g>`;
 e.components.slice(0,Math.floor((box.h-110)/34)).forEach((c,i)=>b+=compact(box.x+15,box.y+71+i*34,box.w-30,30,c.id,c.name));
 b += text(box.x+16,box.y+box.h-12,`完整清单：${e.components.length} 项 · 点击查看`,'small');
});
b += edge([[2995,560],[2995,462]],'ChildOf 子树','relationship',[2900,490],['entity-menu_button','entity-menu_root']);
b += edge([[3330,287],[3210,287]],'ChildOf','relationship',[3270,235],['entity-settings_panel','entity-menu_root']);
b += edge([[2465,560],[2465,515],[3540,515],[3540,462]],'ChildOf 经 frame','relationship',[3150,515],['entity-menu_scroll','entity-settings_panel']);
b += edge([[3595,560],[3595,462]],'经 frame','relationship',[3595,512],['entity-settings_scrollbar','entity-settings_panel']);
b += edge([[3940,775],[3860,775]],'ChildOf','relationship',[3900,720],['entity-settings_scrollbar_thumb','entity-settings_scrollbar']);
b += edge([[3595,990],[3595,1060],[2465,1060],[2465,990]],'Scrollbar.target · Entity 引用','reference',[3100,1060],['entity-settings_scrollbar','entity-menu_scroll']);
b += text(2270,1030,'MenuContext 复用 ActionOf / BindingOf；Coming Soon 无 MenuButton。','small');
b += edge([[2780,1250],[2680,1250]],'ChildOf','relationship',[2730,1250],['entity-menu_camera','entity-menu_backdrop']);
b += edge([[2465,1630],[2465,1480]],'ChildOf 子树','relationship',[2465,1555],['entity-menu_model','entity-menu_backdrop']);
b += text(2800,1530,'MainMenu 退出清理展台；','small');
b += text(2800,1557,'页面重建仅清 MenuRoot 子树。','small');
b += edge([[2995,2140],[2995,2095],[3250,2095],[3250,775],[3210,775]],'ChildOf 子树','relationship',[3135,2095],['entity-menu_volume','entity-menu_button']);
b += frame(2250,2580,960,545,'«Resource / Message» 菜单、生命周期与音频','音量草稿即时预览；持久配置只在 Apply 保存成功后替换。');
const menuResourceIds=['resource.AppState','resource.PlayState','resource.MenuState','resource.MenuFocus','resource.MenuInputSource','resource.SettingsDraft','resource.SettingsFile','resource.UiTheme','resource.UiRequestMessages','resource.TimePhysics','resource.SoundBank','resource.UiAudioChannel','resource.SfxAudioChannel','resource.AudioMix','resource.AudioInstances','local.VolumeDrag','local.VolumeEdit','local.MenuLayout'];
menuResourceIds.forEach((id,i)=>b+=compact(2270+i%2*465,2665+Math.floor(i/2)*40,440,32,id,registry[id].name,id.startsWith('local.')?'local':'resource'));
b += text(2270,3095,'Paused 保留会话；页面重建清 MenuRoot 子树，音量变化保留滑条。','small');

// 新角色放在原图空白底部；保留地图 / 骨骼 / 菜单布局和原有连线。
b += frame(30,2580,2110,765,'建筑实例 · 查询外壳 · 视觉材质','建筑是原 GLB 实例；CameraShell 单独查询，BuildingShellVisual 保留原网格层级。');
const shellEntityBoxes=[
 {id:'building',x:50,y:2715,w:450,h:330},
 {id:'camera_shell',x:650,y:2715,w:450,h:330},
 {id:'building_visual',x:1250,y:2715,w:610,h:330},
];
const shellPrimary={building:['Transform','Children','ChildOf','BuildingFadeState'],camera_shell:['CameraShell','RigidBody','Collider','CollisionLayers','Transform','ChildOf'],building_visual:['BuildingShellVisual','MeshMaterial3d','ShellMaterialBinding','ChildOf']};
shellEntityBoxes.forEach(box=>{
 const e=entities[box.id],id=`entity-${e.id}`;registry[id]={...e,kind:'Entity'};
 b+=`<g class="node entity" ${register(id,registry[id])}>${frame(box.x,box.y,box.w,box.h,`«Entity» ${e.name}`,`数量：${e.count}`,colors.entity,id)}</g>`;
 e.components.filter(c=>shellPrimary[e.id].includes(c.name.split('<')[0])).forEach((c,i)=>b+=compact(box.x+15,box.y+71+i*34,box.w-30,30,c.id,c.name));
 b+=text(box.x+16,box.y+box.h-12,`完整清单：${e.components.length} 项 · 可选状态 / 绑定`,'small');
});
b += edge([[650,2825],[500,2825]],'CameraShell.0','reference',[575,2825],['entity-camera_shell','entity-building']);
b += edge([[650,2935],[500,2935]],'ChildOf','relationship',[575,2935],['entity-camera_shell','entity-building']);
b += edge([[1555,2715],[1555,2675],[275,2675],[275,2715]],'BuildingShellVisual.0','reference',[915,2675],['entity-building_visual','entity-building']);
b += edge([[1555,3045],[1555,3110],[275,3110],[275,3045]],'ChildOf · 原 GLB 子树（含间接层级）','relationship',[915,3110],['entity-building_visual','entity-building']);
b += card(50,3170,530,130,'resource.OccludedBuildings','OccludedBuildings',['所有有效 TP 相机的建筑需求并集','与 CameraOcclusion 的历史集合分开'],'resource','small');
b += card(670,3170,780,130,'resource.ShellMaterialCache','ShellMaterialCache',['key：building Entity + 原材质 AssetId','value：原句柄 / 副本强句柄；实例之间隔离'],'resource','small');
b += card(1540,3170,575,130,'local.OcclusionDetected','Local · detected',['每台相机临时需求缓冲','clear / swap 复用容量'],'local','small');

b += frame(3330,1100,1140,380,'设置滚动范围与控件生命周期','面板内部滚动，固定区域和普通 Entity 引用分别建模。');
registry['settings-fixed-regions']={name:'设置固定区域',kind:'BSN layout',description:'左侧分类、右列底部 Restore Defaults / Apply / Back、页脚固定；纸色面板内标题/字段/说明/保存提示滚动。',source:{path:'src/ui/screens.rs',line:397}};
b += card(3350,1185,1100,180,'settings-fixed-regions','分类 / 底部操作 / 页脚固定',['SettingsPanel → frame → MenuScroll + track（兄弟）','track → thumb（直接 ChildOf）；track.target → MenuScroll（普通引用）','值和提示原位更新；结构 key 变化才销毁旧树重建'],'engine','small');
b += text(3350,1430,'原生 DragEnd / Cancel 清理；fit 或离页同步取消 dragging，重建的新 thumb 默认未拖拽。','small');
b += card(3330,1630,1140,230,'non_send.NativePolicies','NativePolicies · NonSend（窗口线程）',['不是普通 Send Resource；平台守卫不是 ECS 组件','active 持有原生窗口守卫；failed 记录安装失败实体','退出实体 / 后端 → Drop 卸载 Windows subclass 或恢复 macOS 属性'],'resource','small');

save('relationships', '实体 · 组件归属与关系', 4500, 3390, b, '真实物理状态、插值呈现、建筑查询、实例材质与设置滚动分别归属；点击组件查看字段及源码入口。');

// 通信视图：输入动作事件、全局 Observer 与窗口缓冲消息保持不同路线。
b = text(36, 80, `${model.observers.length} 个 Observer（玩法／菜单动作、滚轮与实例就绪）由匹配事件触发；它们不是按 add_observer 的注册顺序组成流水线。`, 'note');
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
registry['window-messages'] = { name: 'WindowFocused / MouseButtonInput', kind: 'Message', description: 'Bevy 的窗口消息缓冲，由 sync_mouse_capture 的 MessageReader 读取。', notes:['缓冲不是永久业务队列。','Esc 使用菜单 BackAction；F3 使用 GameplayContext 的 ReleasePointerAction，Window 光标与 Egui 状态仅用于捕获。'], source:systems.mouse_capture.source };
b += card(50, 1410, 374, 130, 'window-messages', '窗口消息缓冲', ['WindowFocused / MouseButtonInput', 'MessageReader 读取', 'Window / Egui 状态另由参数访问'], 'message', 'small');
b += system(512, 1410, 356, 'mouse_capture', ['R 消息 / Window / Egui / AppState', 'W MouseLookState / CursorOptions', 'Commands：ContextActivity 开 / 关'], 130);
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
if(systems.island_ready_observer || systems.courier_ready_observer){
  b+=frame(30,1880,1460,430,'模板实例化 · WorldInstanceReady','SpawnScene 的就绪事件只标记对应根；随后 Update 分别准备地图或绑定主角动画。');
  if(systems.world_spawn)b+=system(50,2010,374,'world_spawn',['WorldAssetRoot → GLB 实例层级'],130);
  registry['world-ready-event']={name:'WorldInstanceReady',kind:'EntityEvent',description:'实例化完成后在对应 WorldAssetRoot 实体上触发，不是资源轮询的 Message。',source:(systems.island_ready_observer||systems.courier_ready_observer).source};
  b+=card(512,2030,356,100,'world-ready-event','WorldInstanceReady',['target：对应的模板根实体'],'event','small');
  if(systems.world_spawn)b+=edge([[424,2080],[512,2080]],'触发','trigger',[468,2080],['world_spawn','world-ready-event']);
  ['island_ready_observer','courier_ready_observer'].filter(id=>systems[id]).forEach((id,i)=>{const y=1970+i*170;b+=system(971,y,486,id,[id==='island_ready_observer'?'IslandMap → IslandPending':'CourierVisual → CourierAnimationPending'],100);b+=edge([[868,2080],[920,2080],[920,y+50],[971,y+50]],'匹配目标','trigger',[920,y+21],['world-ready-event',id]);});
  b+=text(52,2270,'两个 Observer 按标记筛选；无注册顺序链。地图/NPC 和主角动画保持各自生命周期。','small');
}
const sessionPath=path.join(dir,'../../src/session_log.rs');
const sessionLines=fs.existsSync(sessionPath)?fs.readFileSync(sessionPath,'utf8').split('\n'):[];
const queuedLogging=sessionLines.some(line=>line.includes('struct QueuedWriter'));
if(queuedLogging){
  const logSource=name=>({path:'src/session_log.rs',line:sessionLines.findIndex(line=>new RegExp('\\bfn\\s+'+name+'\\b').test(line))+1});
  b+=frame(30,2350,1460,485,'统一 tracing 输出 · 文件与控制台后台线程','两路无界队列是外部 I/O，不是 ECS Component / Resource / Event / Message。');
  registry['log-producer']={name:'tracing producer',kind:'External I/O',description:'事件在调用线程格式化并入队；两路格式层 log_internal_errors(false)，不在失败时同步回退 stderr。',source:logSource('file_layer')};
  registry['log-file-worker']={name:'File worker',kind:'External I/O',description:'独立线程 write_all + flush；首个错误保留，在后续写入/Flush/Shutdown 反馈。',source:logSource('spawn')};
  registry['log-console-worker']={name:'Console worker',kind:'External I/O',description:'独立 stderr 线程；慢或故障控制台不拖住文件与普通日志生产线程。',source:logSource('console_layer')};
  b+=card(50,2480,374,140,'log-producer','玩法 / 引擎 tracing',['时间 / level / target / 字段','统一 EnvFilter；不丢弃队列记录','普通调用不等待设备 I/O'],'external','small');
  b+=card(600,2420,857,130,'log-file-worker','文件队列 → File worker',['独立会话文件 logs/unix-<时间戳>_<UUID>.log','write_all + flush；panic 文件 Sync barrier → sync_data'],'external','small');
  b+=card(600,2600,857,130,'log-console-worker','控制台队列 → Stderr worker',['与文件队列隔离；同一过滤规则','record_exit：文件 Flush → 控制台 Flush'],'external','small');
  b+=edge([[424,2550],[475,2550],[475,2485],[600,2485]],'入队','write',[535,2485],['log-producer','log-file-worker']);
  b+=edge([[475,2550],[475,2665],[600,2665]],'入队','write',[535,2665],['log-producer','log-console-worker']);
  b+=text(52,2775,'Drop：Shutdown 后拒绝新记录，排空已接受记录并 join；失败仍反馈，worker panic 避免等待自身。','small');
  b+=text(52,2808,'相机建筑需求 / 淡化只记录离散变化；日志与存档分别管理，不表示透明叠层或实机 FPS 已验收。','small');
}
// 调试释放由独立玩法动作响应，Esc 走菜单动作。
b += frame(30,2890,1460,230,'调试释放光标 · GameplayContext','F3 保持 Running，释放检查器光标；Esc 属于菜单 BackAction。');
const releasePointer=model.observers.find(o=>o.system==='observe_release_pointer');
registry['event-observe_release_pointer']={name:releasePointer.event,kind:'EntityEvent',description:releasePointer.description};
b += card(50,2975,374,110,'event-observe_release_pointer',releasePointer.event,['F3 → context 控制者'],'event','small');
b += system(512,2975,356,'observe_release_pointer',[brief.observe_release_pointer],110);
registry['result-observe_release_pointer']={...systems.observe_release_pointer,name:'调试释放捕获',kind:'Component write'};
b += card(971,2975,486,110,'result-observe_release_pointer','相机 / 窗口捕获状态',['active = false；skip_motion = true','visible = true；grab_mode = None'],'component','small');
b += edge([[424,3030],[512,3030]],'触发','trigger',[468,3030],['event-observe_release_pointer','observe_release_pointer']);
b += edge([[868,3030],[971,3030]],'W','write',[919,3030],['observe_release_pointer','result-observe_release_pointer']);
// 菜单动作、指针滚轮与菜单模型就绪事件单独列出。
const existingEvents=new Set([...eventRows.map(([id])=>id),'observe_release_pointer','island_ready_observer','courier_ready_observer']);
const menuEvents=model.observers.filter(o=>!existingEvents.has(o.system));
const menuEventStep=148,menuEventBottom=306+menuEvents.length*menuEventStep;
b += frame(1540,112,1470,menuEventBottom-112,'菜单动作 / UI 滚动 / GLB 就绪','六个菜单动作来自 Enhanced Input；滚轮来自原生 UI，模型就绪来自 WorldAssetRoot。');
b += lines(1560,200,['MenuContext 优先级 10；consume_input 避免同键被两种上下文重复消费。','Hidden 仍保留 Back（Esc）暂停；方向和确认在隐藏页面返回。'],'body',32);
menuEvents.forEach((o,i)=>{
 const id=o.system,y=306+i*menuEventStep,s=systems[id],action=o.event.startsWith('Fire<');
 registry[`event-${id}`]={name:o.event,kind:'EntityEvent',description:o.description,notes:[o.target],source:s.source};
 b += card(1552,y,312,118,`event-${id}`,o.event,[action?'target：MenuContext 控制者':o.event.startsWith('Pointer')?(id==='observe_menu_scroll'?'target：MenuScroll 视口':'target：轨道 / 滑块'):'target：菜单快递员 GLB 根'],'event','small');
 b += system(1944,y,335,id,[brief[id] || s.description],118);
 const resultId=`result-${id}`;registry[resultId]={name:`${s.name} 输出`,kind:'Data write',description:s.description,reads:s.reads,writes:s.writes,notes:s.notes,source:s.source};
 b += card(2366,y,345,118,resultId,action?'菜单共享数据':o.event.startsWith('Pointer')?(id==='observe_scrollbar_press'?'MenuInputSource':'ScrollPosition'):'菜单 pending 标记',s.writes.slice(0,2).map(v=>`W ${accessName(v)}`),action?'resource':'component','small');
 b += edge([[1864,y+59],[1944,y+59]],'触发','trigger',[1904,y+59],[`event-${id}`,id]);
 b += edge([[2279,y+59],[2366,y+59]],'W','write',[2322,y+59],[id,resultId,...s.writes]);
});
b += frame(2750,306,250,menuEventBottom-346,'路由与消费','事件分别匹配真实目标。');
b += ['Previous / Next','↓ MenuFocus','＋ Navigation 来源','','Left / Right / Confirm','Back（含 Esc）','↓ UiRequest Message','↓ PreUpdate 统一消费','','指针点击写同一队列','滚轮只改视口位置','','WorldInstanceReady','↓ 仅标记菜单 pending','↓ Update 等待命名 clip','绑定 Carry_Idle 循环播放'].map((v,i)=>fitted(2767,392+i*38,v,216,'small')).join('');
const requestY=menuEventBottom+45;
b += frame(1540,requestY,1470,750,'UiRequest · 页面、设置与状态','消息消费集中于 PreUpdate；滑条数值与释放归并，返回优先于旧采样。');
b += card(1560,requestY+85,360,130,'resource.UiRequestMessages','UiRequest 消息缓冲',['Confirm / Adjust / Back / SetVolume','释放：FinishVolumeEdit'],'message','small');
b += system(2040,requestY+85,430,'menu_handle_requests',['消费请求 → 页面 / 草稿 / NextState','接受的操作 → MenuConfirm / Cancel'],130);
b += card(2600,requestY+85,385,130,'resource.SettingsDraft','设置草稿',['音量即时预览；Apply 成功才保存','Back 回滚；失败保留草稿与预览'],'resource','small');
b += edge([[1920,requestY+150],[2040,requestY+150]],'读取','read',[1980,requestY+150],['resource.UiRequestMessages','menu_handle_requests']);
b += edge([[2470,requestY+150],[2600,requestY+150]],'W 草稿','write',[2535,requestY+150],['menu_handle_requests','resource.SettingsDraft']);
b += card(1560,requestY+320,660,130,'resource.MenuState','页面与返回来源',['Main / Hidden / Pause / Settings / Help','设置和帮助保留 return_page'],'resource','small');
b += card(2335,requestY+320,650,130,'ui-next-state','NextState → StateTransition',['Start Game / ReturnToMenu：AppState','Pause / Resume：PlayState'],'engine','small');
b += edge([[2145,requestY+215],[2145,requestY+265],[1890,requestY+265],[1890,requestY+320]],'W 页面','write',[1890,requestY+265],['menu_handle_requests','resource.MenuState']);
b += edge([[2370,requestY+215],[2370,requestY+265],[2660,requestY+265],[2660,requestY+320]],'状态请求','write',[2660,requestY+265],['menu_handle_requests','ui-next-state']);
b += card(1560,requestY+550,660,130,'volume-request-source','Audio 页 · 滑条局部捕获',['Interaction 命中；只在真实左键按下后捕获','SetVolume 只改草稿，结束且最终值改变才确认','失焦 / 离开窗口 / 页面销毁时清理手势'],'engine','small');
b += card(2335,requestY+550,650,130,'resource.AudioMix','有效音量与试听',['Settings 读草稿；切换分类仍预览','Back 离开后回到最近成功应用值','TestSfx → ParcelPickup；只发声音请求'],'resource','small');
const scrollbarEventY = requestY + 800;
const soundEventY = Math.max(3150, scrollbarEventY + 380);
const nativeWindowEventY = soundEventY + 610;
// 声音缓冲在真实语义/物理结果之后产生；不通过声音驱动物理。
b += frame(30,soundEventY,2980,550,'SoundRequest · 真实结果到 Kira 输出','菜单焦点/接受的操作、拿放、持续持握偏差与真实支撑触地；预留映射不会自动产生声音。');
b += system(50,soundEventY+85,374,'audio_strain',['真实 Position / CarryGrip → 持握偏差','Local 宽限 / 持续计时 / 滞回锁存'],130);
b += system(50,soundEventY+270,374,'audio_land',['ContactGraph：支撑法线与冲量','Running 中收集；离开支撑才解锁'],130);
b += card(512,soundEventY+85,356,130,'resource.SoundRequestMessages','SoundRequest 缓冲',['cue：稳定事件名','source：只记录 Entity'],'message','small');
b += system(971,soundEventY+85,486,'audio_play',['R 请求 / AudioMix / 策略 / Time<Real>','静音丢弃；W SoundBank / UI / SFX 命令'],130);
b += card(1600,soundEventY+85,550,130,'resource.SoundBank','SoundBank',['预加载句柄、冷却与声音实例','总并发 4；SFX 最多 3'],'resource','small');
registry['kira-output']={name:'Kira UI / SFX 通道',kind:'Engine',description:'类型 AudioChannel 消费排队命令，AppExit 停止；环境底声仅供试听。',source:systems.audio_play.source};
b += card(2290,soundEventY+85,690,130,'kira-output','Kira UI / SFX 通道',['设备输出；退出统一停止','ambience 不自动播放'],'engine','small');
b += edge([[424,soundEventY+150],[468,soundEventY+150]],'','write',null,['audio_strain','resource.SoundRequestMessages'],false);
b += edge([[424,soundEventY+335],[468,soundEventY+335],[468,soundEventY+150]],'','write',null,['audio_land','resource.SoundRequestMessages'],false);
// 汇合末段较短，标签置于线条上方，避免白底遮住整段连线和目标箭头。
b += edge([[468,soundEventY+150],[512,soundEventY+150]],'W','write',[488,soundEventY+125],['audio_strain','audio_land','interaction','resource.SoundRequestMessages']);
b += edge([[868,soundEventY+150],[971,soundEventY+150]],'读取','read',[919,soundEventY+150],['resource.SoundRequestMessages','audio_play']);
b += edge([[1600,soundEventY+130],[1457,soundEventY+130]],'R 策略','read',[1530,soundEventY+130],['resource.SoundBank','audio_play']);
b += edge([[1457,soundEventY+170],[1600,soundEventY+170]],'W 实例','write',[1530,soundEventY+170],['audio_play','resource.SoundBank']);
b += edge([[1214,soundEventY+215],[1214,soundEventY+430],[2635,soundEventY+430],[2635,soundEventY+215]],'排队播放','write',[1960,soundEventY+430],['audio_play','kira-output']);
b += text(55,soundEventY+500,'拿放声音随关系命令生效；菜单发 Hover / Confirm / Cancel，拖动仅结束且最终值改变时确认；TestSfx 发 ParcelPickup。','note');

// 控件原生事件是引擎能力概览；项目 Observer 不重复实现拖拽生命周期。
b += frame(1540,scrollbarEventY,1470,330,'DefaultPlugins · 原生 ScrollbarPlugin','菜单语义使用 Enhanced Input；滚动条的坐标、轨道分页和拖拽复用原生 UI 指针事件。');
registry['native-scrollbar-events']={name:'ScrollbarPlugin · pointer observers',kind:'Engine observers',description:'Scrollbar / ScrollbarThumb 原生控件处理 track Press 分页、DragStart/Drag/DragEnd/Cancel；几何在 Layout 内更新。项目只绑定 target 和同步显隐/来源。',source:{path:'src/ui/widgets.rs',line:115}};
b += card(1560,scrollbarEventY+85,650,160,'native-scrollbar-events','Press / DragStart / Drag / End / Cancel',['原生 track 分页和 thumb 拖拽更新 target','DragEnd / Cancel 清理原生 dragging','项目 Press Observer 只接管输入来源'],'engine','small');
b += card(2320,scrollbarEventY+85,665,160,'menu_sync_scrollbars','项目布局后同步',['fit / 离页：offset 清零、禁拾取、取消拖拽','仍 overflow 的 resize：原生按当前几何计算','重建销毁旧 thumb，新实体默认未拖拽'],'system','small');
b += edge([[2210,scrollbarEventY+165],[2320,scrollbarEventY+165]],'控件数据','reference',[2265,scrollbarEventY+135],['native-scrollbar-events','menu_sync_scrollbars']);
b += frame(30,nativeWindowEventY,2980,290,'原生窗口桥接 · OS 消息与回调','窗口 resize 是原生平台约束；不通过 Enhanced Input，也不是 Bevy EntityEvent 或 MessageReader 消息。');
registry['native-window-events']={name:'OS 窗口事件 / API',kind:'Native platform event',description:'Windows WM_SIZING / WM_WINDOWPOSCHANGING / WM_DPICHANGED / WM_SYSCOMMAND；macOS contentAspectRatio、屏幕工作区和 Zoom 几何校准。',source:{path:'src/window_policy/windows.rs',line:175}};
b += card(55,nativeWindowEventY+85,850,130,'native-window-events','Windows resize / DPI / maximize · macOS Zoom',['在原生尺寸应用前约束内容比例和工作区','macOS PreUpdate 刷新边界并校准旁路几何'],'engine','small');
b += card(1080,nativeWindowEventY+85,850,130,'window-native-policy','原生守卫 / 平台纯几何',['守卫由 NativePolicies.active 所有','非 ECS 组件；不建立额外实体或 State'],'engine','small');
b += card(2105,nativeWindowEventY+85,850,130,'window.Window','主窗口 Window',['逻辑内容 16:9；初始化安装后显示','退出 / 后端消失：清理守卫'],'component','small');
b += edge([[905,nativeWindowEventY+150],[1080,nativeWindowEventY+150]],'原生约束','reference',[992,nativeWindowEventY+150],['native-window-events','window-native-policy']);
b += edge([[1930,nativeWindowEventY+150],[2105,nativeWindowEventY+150]],'应用尺寸','write',[2017,nativeWindowEventY+150],['window-native-policy','window.Window']);

save('events','事件 · Observer · Message',3040,nativeWindowEventY+340,b,'输入 EntityEvent、实例就绪、窗口/碰撞 Message 与外部后台日志分别建模。');

// 源码与图同时生成快照，让网页和离线文件都能打开完整源码并定位行号。
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
