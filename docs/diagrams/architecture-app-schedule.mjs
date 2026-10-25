import { buildArchitectureModel } from './architecture-model.mjs';
import { INFRASTRUCTURE_FEATURES } from './architecture-infrastructure.mjs';

const catalog = records => Object.freeze(records.map(record => Object.freeze({ ...record, notes: Object.freeze(record.notes || []) })));

// 启动与逐帧入口共用真实 Schedule，但初始化状态转换不是每帧链的前置系统。
export const APP_SCHEDULE_GROUPS = catalog([
  { id: 'ApplicationLifecycle', label: 'App 构建与退出', order: -50, track: 'explanatory', notes: ['main 创建、装配并运行 App；run 返回后刷新会话日志。插件构建和退出清理不是逐帧 Schedule。'] },
  { id: 'Startup.StateTransition', label: 'StateTransition · 首次初始化', schedule: 'StateTransition', order: -40, track: 'startup', notes: ['StatesPlugin 在首次 PreStartup 之前处理初始状态；仅执行符合当前状态的入口。', 'OnEnter 系统统一列在逐帧 StateTransition 区域，完整注册保留在系统详情，不复制系统卡片。'] },
  { id: 'PreStartup', label: 'PreStartup', order: -30, track: 'startup', notes: ['首次 Main 运行时执行一次，位于初始 StateTransition 之后、Startup 之前；当前清单没有单列此阶段的系统。'] },
  { id: 'Startup', label: 'Startup', order: -20, track: 'startup', notes: ['首次 Main 运行时执行一次；项目启动日志、菜单控制者和音频预加载之间没有额外全序。'] },
  { id: 'PostStartup', label: 'PostStartup', order: -10, track: 'startup', notes: ['首次 Main 运行时执行一次；TransformSystems::Propagate 的初始化注册保留在其 PostUpdate 卡片详情，不复制集合卡片。', '当前清单没有单列其他初始化系统。'] },
  { id: 'First', label: 'First', order: 10, track: 'frame', notes: ['每帧一次；限帧在 TimeSystems 之前，随后输入与状态处理使用本帧时间。'] },
  { id: 'PreUpdate', label: 'PreUpdate', order: 20, track: 'frame', notes: ['输入、拾取、Egui 输入处理及菜单请求服从各自的真实集合依赖；无依赖的分支没有额外先后。'] },
  { id: 'StateTransition', label: 'StateTransition', order: 30, track: 'conditional', notes: ['每帧位于 PreUpdate 之后、RunFixedMainLoop 之前；状态改变时驱动对应的退出、转换和进入 Schedule。', '这里展示 OnEnter 注册系统，完整 AppState／PlayState 参数在各系统详情；不同状态入口不构成系统全序。', '首次状态初始化另在 PreStartup 之前执行。'] },
  { id: 'RunFixedMainLoop.BeforeFixedMainLoop', label: 'RunFixedMainLoop · BeforeFixedMainLoop', schedule: 'RunFixedMainLoop', order: 40, track: 'nested', parent: 'RunFixedMainLoop', notes: ['这是 RunFixedMainLoop 内的具名 SystemSet，不是独立 Schedule；每帧固定循环前执行。', '当前清单没有单列此集合的系统。'] },
  { id: 'FixedFirst', label: 'FixedFirst', order: 50, track: 'fixed', parent: 'RunFixedMainLoop', notes: ['每个固定步先恢复插值状态并保存本步起点；整个 FixedMain 根据累计固定时间运行零次或多次。'] },
  { id: 'FixedPreUpdate', label: 'FixedPreUpdate', order: 60, track: 'fixed', parent: 'RunFixedMainLoop', notes: ['FixedMain 中位于 FixedFirst 与 FixedUpdate 之间的真实 Schedule；当前清单没有单列此阶段的系统。'] },
  { id: 'FixedUpdate', label: 'FixedUpdate', order: 70, track: 'fixed', parent: 'RunFixedMainLoop', notes: ['按恢复、朝向、运动、交互、目标和挂接的公开集合推进玩法。', '仅显式依赖表达执行顺序；列内纵向摆放不建立全序，玩法系统保留 gameplay_running 条件。'] },
  { id: 'FixedPostUpdate', label: 'FixedPostUpdate', order: 80, track: 'fixed', parent: 'RunFixedMainLoop', notes: ['Avian Prepare → StepSimulation → Writeback；StepSimulation 内驱动物理 Schedule，内部步骤由已核实集合概括。', '项目接地、碰撞、音效和持物系统分别依赖实际物理集合，不互相补造先后。'] },
  { id: 'FixedLast', label: 'FixedLast', order: 90, track: 'fixed', parent: 'RunFixedMainLoop', notes: ['每个固定步末尾记录插值终点；若还有累计固定时间则继续下一个完整 FixedMain，没有固定步的帧不进入本循环体。'] },
  { id: 'RunFixedMainLoop.AfterFixedMainLoop', label: 'RunFixedMainLoop · AfterFixedMainLoop', schedule: 'RunFixedMainLoop', order: 100, track: 'nested', parent: 'RunFixedMainLoop', notes: ['这是 RunFixedMainLoop 内的具名 SystemSet，不是独立 Schedule；每帧固定循环后执行，零固定步也执行。', 'Ease → Facing → HeldPhysics → HeldPresentation → Camera → Visibility → UpdateEasingTick，完整条件与注册在详情保留。'] },
  { id: 'Update', label: 'Update', order: 110, track: 'frame', notes: ['海岛、动画、菜单和音频有独立分支；仅连接源码声明的局部顺序与集合成员。', 'UI Style → Audio Mix → Playback 是跨功能依赖；两个音量系统之间及 Style 内部没有额外全序。'] },
  { id: 'SpawnScene', label: 'SpawnScene', order: 120, track: 'frame', notes: ['Update 之后、PostUpdate 之前实例化场景；WorldInstanceReady 触发 Observer，不意味着相关 Update 系统在此串行执行。'] },
  { id: 'PostUpdate', label: 'PostUpdate', order: 130, track: 'frame', notes: ['动画、变换传播、UI 布局、音频和 Egui 驱动分别遵循已声明的依赖；不是额外一条全序系统链。', 'EguiPrimaryContextPass 由本阶段内部驱动，不在整个 PostUpdate 结束后追加。'] },
  { id: 'EguiPrimaryContextPass', label: 'EguiPrimaryContextPass', order: 131, track: 'nested', parent: 'PostUpdate', notes: ['EguiPostUpdateSet::EndPass 在 PostUpdate 内驱动多轮 pass，检查器仅在 gameplay_running 时显示。'] },
  { id: 'Last', label: 'Last', order: 140, track: 'frame', notes: ['主应用每帧调度的最后一个 Schedule；当前清单没有单列此阶段的系统。'] },
  { id: 'RenderApp', label: 'RenderApp · 独立渲染子应用', order: 150, track: 'external', notes: ['渲染子应用的 ExtractSchedule 与 Render 由渲染流程概括；不作为 Last 后的普通主应用 Schedule 串联。'] },
  { id: 'NativePlatformEvents', label: '原生平台回调 · 调度外', order: 160, track: 'external', notes: ['窗口系统消息与原生 API 回调位于 ECS Schedule 之外；安装系统仍按真实 PreUpdate 注册显示。'] },
  { id: 'EventTriggered', label: 'Observer · 匹配事件触发', order: 170, track: 'external', notes: ['Observer 按匹配事件触发，没有固定 Schedule；按功能并列展示不代表按此顺序执行。', '动作、场景就绪、指针及生命周期事件分别由真实来源触发；普通辅助函数不作为 Observer。'] },
  { id: 'Explanatory', label: '约束与说明 · 非调度', order: 180, track: 'explanatory', notes: ['数据、状态和机制说明不属于调度系统；位置只服务阅读。'] },
]);

export const APP_SCHEDULE_LINKS = catalog([
  { id: 'app-startup-state-pre', from: 'Startup.StateTransition', to: 'PreStartup', edgeSemantic: 'schedule', displayLabel: '', notes: ['StatesPlugin::build 将 StateTransition 插入启动列表的 PreStartup 之前。'] },
  { id: 'app-startup-pre-startup', from: 'PreStartup', to: 'Startup', edgeSemantic: 'schedule', displayLabel: '', notes: ['MainScheduleOrder::startup_labels 中的真实相邻阶段。'] },
  { id: 'app-startup-post', from: 'Startup', to: 'PostStartup', edgeSemantic: 'schedule', displayLabel: '', notes: ['MainScheduleOrder::startup_labels 中的真实相邻阶段。'] },
  { id: 'app-startup-first-frame', from: 'PostStartup', to: 'First', edgeSemantic: 'schedule', displayLabel: '首次帧', notes: ['Main::run_main 首次完成 startup_labels 后开始逐帧 labels；后续帧不再执行启动列表。'] },
  { id: 'app-frame-first-pre', from: 'First', to: 'PreUpdate', edgeSemantic: 'schedule', displayLabel: '', notes: ['MainScheduleOrder::labels 中的真实相邻阶段。'] },
  { id: 'app-frame-state', from: 'PreUpdate', to: 'StateTransition', edgeSemantic: 'schedule', displayLabel: '', notes: ['StatesPlugin::build 将 StateTransition 插入每帧列表的 PreUpdate 之后。'] },
  { id: 'app-frame-before-fixed', from: 'StateTransition', to: 'RunFixedMainLoop.BeforeFixedMainLoop', edgeSemantic: 'schedule', displayLabel: '', notes: ['Main 在 StateTransition 后运行 RunFixedMainLoop；其 BeforeFixedMainLoop 集合位于固定循环前。'] },
  { id: 'app-fixed-empty-path', from: 'RunFixedMainLoop.BeforeFixedMainLoop', to: 'RunFixedMainLoop.AfterFixedMainLoop', edgeSemantic: 'schedule', displayLabel: '固定循环可为零步', notes: ['BeforeFixedMainLoop → FixedMainLoop → AfterFixedMainLoop 为真实集合链；FixedMainLoop 根据累计固定时间执行零次或多次完整 FixedMain。', '这条连线概括驱动集合链，不把固定阶段标为每帧必经。'] },
  { id: 'app-fixed-enter', from: 'RunFixedMainLoop.BeforeFixedMainLoop', to: 'FixedFirst', edgeSemantic: 'nested', displayLabel: '有固定步时 · 1..N 次', notes: ['run_fixed_main_schedule 在累计固定时间足够时运行整个 FixedMain；默认项目固定时钟为 60 Hz。'] },
  { id: 'app-fixed-first-pre', from: 'FixedFirst', to: 'FixedPreUpdate', edgeSemantic: 'schedule', displayLabel: '', notes: ['FixedMainScheduleOrder::labels 中的真实相邻阶段。'] },
  { id: 'app-fixed-pre-update', from: 'FixedPreUpdate', to: 'FixedUpdate', edgeSemantic: 'schedule', displayLabel: '', notes: ['FixedMainScheduleOrder::labels 中的真实相邻阶段。'] },
  { id: 'app-fixed-update-post', from: 'FixedUpdate', to: 'FixedPostUpdate', edgeSemantic: 'schedule', displayLabel: '', notes: ['FixedMainScheduleOrder::labels 中的真实相邻阶段。'] },
  { id: 'app-fixed-post-last', from: 'FixedPostUpdate', to: 'FixedLast', edgeSemantic: 'schedule', displayLabel: '', notes: ['FixedMainScheduleOrder::labels 中的真实相邻阶段。'] },
  { id: 'app-fixed-return', from: 'FixedLast', to: 'RunFixedMainLoop.AfterFixedMainLoop', edgeSemantic: 'nested', displayLabel: '全部固定步结束', notes: ['累计固定时间仍足够时继续执行完整 FixedMain；全部固定步结束后才进入 AfterFixedMainLoop。', '循环次数在驱动与阶段说明中表达，不增加固定系统间不存在的执行依赖。'] },
  { id: 'app-frame-update', from: 'RunFixedMainLoop.AfterFixedMainLoop', to: 'Update', edgeSemantic: 'schedule', displayLabel: '', notes: ['RunFixedMainLoop 完成后，Main 进入 Update；零固定步帧也经过 AfterFixedMainLoop。'] },
  { id: 'app-frame-spawn', from: 'Update', to: 'SpawnScene', edgeSemantic: 'schedule', displayLabel: '', notes: ['MainScheduleOrder::labels 中的真实相邻阶段。'] },
  { id: 'app-frame-post', from: 'SpawnScene', to: 'PostUpdate', edgeSemantic: 'schedule', displayLabel: '', notes: ['MainScheduleOrder::labels 中的真实相邻阶段。'] },
  { id: 'app-frame-last', from: 'PostUpdate', to: 'Last', edgeSemantic: 'schedule', displayLabel: '', notes: ['MainScheduleOrder::labels 中的真实相邻阶段。'] },
  { id: 'app-egui-pass', from: 'PostUpdate', to: 'EguiPrimaryContextPass', edgeSemantic: 'nested', displayLabel: '内部多轮 pass', notes: ['EguiPostUpdateSet::EndPass 中的 run_egui_context_pass_loop_system 驱动上下文 Schedule，不构成 PostUpdate 后的独立主阶段。'] },
]);

function orderNodes(group, links) {
  const pending = new Map(group.nodes.map(node => [node.id, 0]));
  const successors = new Map(group.nodes.map(node => [node.id, new Set()]));
  for (const link of links) {
    if (link.kind !== 'order' || !pending.has(link.from) || !pending.has(link.to) || successors.get(link.from).has(link.to)) continue;
    successors.get(link.from).add(link.to);
    pending.set(link.to, pending.get(link.to) + 1);
  }
  const ordered = [];
  while (pending.size) {
    const next = group.nodes.find(node => pending.get(node.id) === 0);
    if (!next) throw new Error(`App 调度分组存在循环执行依赖：${group.id}`);
    ordered.push(next); pending.delete(next.id);
    for (const successor of successors.get(next.id)) pending.set(successor, pending.get(successor) - 1);
  }
  return ordered;
}

export function buildAppSchedule(model, registry) {
  const architecture = buildArchitectureModel(model);
  const nodes = new Map(), links = new Map();
  for (const feature of [...architecture.features, ...INFRASTRUCTURE_FEATURES]) {
    const graph = architecture.graphFor(feature.id, 'systems');
    for (const node of graph.nodes) if (!nodes.has(node.id)) nodes.set(node.id, { ...node, role: 'internal' });
    for (const link of graph.links) {
      if (!['order', 'registration'].includes(link.kind)) throw new Error(`App 调度图包含非调度关系：${link.id}`);
      if (!links.has(link.id)) links.set(link.id, { ...link });
    }
  }
  for (const system of model.systems || []) if (registry[system.id]?.kind === 'Observer' && !nodes.has(system.id)) {
    nodes.set(system.id, { id: system.id, role: 'internal', group: 'Observer' });
  }
  const groups = APP_SCHEDULE_GROUPS.map(group => ({ ...group, notes: [...group.notes], nodes: [] }));
  const byId = new Map(groups.map(group => [group.id, group]));
  for (const node of nodes.values()) {
    const record = registry[node.id];
    if (!record) throw new Error(`App 调度图缺少节点声明：${node.id}`);
    const groupId = record.kind === 'Observer' ? 'EventTriggered' : record.schedule_group || 'Explanatory';
    const group = byId.get(groupId);
    if (!group) throw new Error(`App 调度图缺少阶段：${groupId}（${node.id}）`);
    group.nodes.push(node);
  }
  const graph = { nodes: [...nodes.values()], links: [...links.values()] };
  for (const group of groups) {
    const original = model.schedule_groups?.find(candidate => candidate.id === group.id);
    group.notes = [...new Set([...group.notes, ...(original?.notes || [])])];
    group.nodes = orderNodes(group, graph.links);
  }
  return { graph, groups, phaseLinks: APP_SCHEDULE_LINKS.map(link => ({ ...link, notes: [...link.notes] })) };
}
