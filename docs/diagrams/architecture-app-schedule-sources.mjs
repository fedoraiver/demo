// 阶段是调度结构，源码指向配置与实际驱动，不伪造成注册表中的业务节点。
const main = { package: 'bevy_app', path: 'src/main_schedule.rs' };
const state = { package: 'bevy_state', path: 'src/app.rs' };
const egui = { package: 'bevy_egui', path: 'src/lib.rs' };
const sources = {
  startup: { ...main, role: 'configure', label: 'MainScheduleOrder::default：启动阶段配置', pattern: '^[ \\t]*startup_labels: vec!\\[PreStartup\\.intern\\(\\), Startup\\.intern\\(\\), PostStartup\\.intern\\(\\)\\],' },
  frame: { ...main, role: 'configure', label: 'MainScheduleOrder::default：每帧阶段配置', pattern: '^[ \\t]*labels: vec!\\[(?=\\s*First\\.intern\\(\\),)' },
  main: { ...main, role: 'implementation', label: 'Main::run_main：首次启动及每帧 Schedule 驱动', kind: 'fn', symbol: 'run_main' },
  stateStartup: { ...state, role: 'configure', label: 'StatesPlugin::build：初始 StateTransition 插入 PreStartup 之前', pattern: '^[ \\t]*schedule\\.insert_startup_before\\(PreStartup, StateTransition\\);' },
  stateFrame: { ...state, role: 'configure', label: 'StatesPlugin::build：每帧 StateTransition 插入 PreUpdate 之后', pattern: '^[ \\t]*schedule\\.insert_after\\(PreUpdate, StateTransition\\);' },
  fixed: { ...main, role: 'configure', label: 'FixedMainScheduleOrder::default：固定步阶段配置', pattern: '^[ \\t]*labels: vec!\\[(?=\\s*FixedFirst\\.intern\\(\\),)' },
  fixedMain: { ...main, role: 'implementation', label: 'FixedMain::run_fixed_main：按固定步列表执行 Schedule', kind: 'fn', symbol: 'run_fixed_main' },
  loopChain: { ...main, role: 'configure', label: 'MainSchedulePlugin::build：固定循环前、循环体、循环后集合链', pattern: '^[ \\t]*RunFixedMainLoop,(?=\\s*\\(\\s*RunFixedMainLoopSystems::BeforeFixedMainLoop)' },
  loopInstall: { package: 'bevy_time', path: 'src/lib.rs', role: 'configure', label: 'TimePlugin::build：固定循环驱动注册到 FixedMainLoop 集合', pattern: '^[ \\t]*run_fixed_main_schedule\\.in_set\\(RunFixedMainLoopSystems::FixedMainLoop\\),' },
  loop: { package: 'bevy_time', path: 'src/fixed.rs', role: 'implementation', label: 'run_fixed_main_schedule：按累计时间执行零至多个完整固定步', kind: 'fn', symbol: 'run_fixed_main_schedule' },
  eguiInstall: { ...egui, role: 'configure', label: 'EguiPlugin::build：PostUpdate 内注册上下文 pass 驱动', pattern: '^[ \\t]*app\\.add_systems\\(\\s*PostUpdate,\\s*\\(run_egui_context_pass_loop_system, end_pass_system\\)' },
  egui: { ...egui, role: 'implementation', label: 'run_egui_context_pass_loop_system：在 Egui pass 中运行上下文 Schedule', kind: 'fn', symbol: 'run_egui_context_pass_loop_system' },
};

const groupSources = {
  'Startup.StateTransition': ['stateStartup', 'main'],
  PreStartup: ['startup', 'main'], Startup: ['startup', 'main'], PostStartup: ['startup', 'main'],
  First: ['frame', 'main'], PreUpdate: ['frame', 'main'], StateTransition: ['stateFrame', 'main'],
  'RunFixedMainLoop.BeforeFixedMainLoop': ['loopChain', 'loopInstall', 'loop'],
  FixedFirst: ['fixed', 'fixedMain', 'loop'], FixedPreUpdate: ['fixed', 'fixedMain', 'loop'],
  FixedUpdate: ['fixed', 'fixedMain', 'loop'], FixedPostUpdate: ['fixed', 'fixedMain', 'loop'], FixedLast: ['fixed', 'fixedMain', 'loop'],
  'RunFixedMainLoop.AfterFixedMainLoop': ['loopChain', 'loopInstall', 'loop'],
  Update: ['frame', 'main'], SpawnScene: ['frame', 'main'], PostUpdate: ['frame', 'main'], Last: ['frame', 'main'],
  EguiPrimaryContextPass: ['eguiInstall', 'egui'],
};
const linkSources = {
  'app-startup-state-pre': ['stateStartup', 'main'],
  'app-startup-pre-startup': ['startup', 'main'], 'app-startup-post': ['startup', 'main'], 'app-startup-first-frame': ['startup', 'frame', 'main'],
  'app-frame-first-pre': ['frame', 'main'], 'app-frame-state': ['stateFrame', 'main'],
  'app-frame-before-fixed': ['frame', 'stateFrame', 'loopChain', 'main'],
  'app-fixed-empty-path': ['loopChain', 'loopInstall', 'loop'], 'app-fixed-enter': ['loopChain', 'loopInstall', 'loop', 'fixedMain'],
  'app-fixed-first-pre': ['fixed', 'fixedMain'], 'app-fixed-pre-update': ['fixed', 'fixedMain'],
  'app-fixed-update-post': ['fixed', 'fixedMain'], 'app-fixed-post-last': ['fixed', 'fixedMain'],
  'app-fixed-return': ['loopChain', 'loop'], 'app-frame-update': ['frame', 'loopChain', 'main'],
  'app-frame-spawn': ['frame', 'main'], 'app-frame-post': ['frame', 'main'], 'app-frame-last': ['frame', 'main'],
  'app-egui-pass': ['eguiInstall', 'egui'],
};

export function attachAppScheduleSources(view, dependencyResolver) {
  if (view.layout !== 'app-schedule') return view;
  const resolved = new Map();
  function attach(record, keys) {
    record.sourceEntries = [];
    record.sourceGaps = [];
    if (!keys) {
      if (['external', 'explanatory'].includes(record.track)) return;
      record.sourceGaps.push(`待核实：${record.label || record.id} 的区域级流程入口尚未纳入阶段源码清单；区域内节点的源码入口分别保留。`);
      return;
    }
    for (const key of keys) {
      const { role, label, ...definition } = sources[key];
      if (!resolved.has(key)) {
        try { resolved.set(key, { entry: { ...dependencyResolver.resolve(definition), column: 1, role, label } }); }
        catch (error) { resolved.set(key, { gap: `待核实：${label}（${error.message}）` }); }
      }
      const result = resolved.get(key);
      if (result.entry) record.sourceEntries.push({ ...result.entry });
      else record.sourceGaps.push(result.gap);
    }
  }
  for (const group of view.scheduleGroups || []) attach(group, groupSources[group.id]);
  for (const link of [...(view.phaseLinks || []), ...(view.scheduleLinks || [])]) attach(link, linkSources[link.id]);
  return view;
}
