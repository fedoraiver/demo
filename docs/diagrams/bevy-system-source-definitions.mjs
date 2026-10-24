// 系统集合定位真实标签或成员，聚合流程定位主类型或安装实现，不冒充单个系统函数。
const applyDeferred = { package: 'bevy_ecs', path: 'src/schedule/executor/mod.rs', symbol: 'ApplyDeferred', kind: 'struct' };
const picking = variant => ({ package: 'bevy_picking', path: 'src/lib.rs', pattern: `(?<=^pub enum PickingSystems \\{[^}]*\\n)^[ \\t]*${variant},` });
const button = symbol => ({ package: 'bevy_ui_widgets', path: 'src/button.rs', symbol, kind: 'fn' });

export const BEVY_SYSTEM_SOURCE_DEFINITIONS = {
  time_update: { package: 'bevy_time', path: 'src/lib.rs', symbol: 'TimeSystems', kind: 'struct' },
  input_update: { package: 'bevy_input', path: 'src/lib.rs', symbol: 'InputSystems', kind: 'struct' },
  held_apply: applyDeferred,
  transform_propagate: { package: 'bevy_transform', path: 'src/plugins.rs', pattern: '^[ \\t]*Propagate,[ \\t]*$' },
  render: { package: 'bevy_render', path: 'src/lib.rs', symbol: 'RenderApp', kind: 'struct' },
  capture_apply: applyDeferred,
  orphan_apply: applyDeferred,
  wake_apply: applyDeferred,
  event_apply: applyDeferred,
  world_spawn: { package: 'bevy_world_serialization', path: 'src/world_asset_spawner.rs', symbol: 'WorldInstanceSpawner', kind: 'struct' },
  animation_engine: { package: 'bevy_app', path: 'src/main_schedule.rs', symbol: 'AnimationSystems', kind: 'struct' },
  'native-ui-layout': { package: 'bevy_ui', path: 'src/lib.rs', pattern: '^[ \\t]*Layout,[ \\t]*$' },
  'native-scrollbar-layout': { package: 'bevy_ui_widgets', path: 'src/scrollbar.rs', symbol: 'update_scrollbar_thumb', kind: 'fn' },
  'native-visibility': { package: 'bevy_camera', path: 'src/visibility/mod.rs', pattern: '^[ \\t]*VisibilityPropagate,[ \\t]*$' },
  'native-scrollbar-events': { package: 'bevy_ui_widgets', path: 'src/scrollbar.rs', pattern: '^impl[ \\t]+Plugin[ \\t]+for[ \\t]+ScrollbarPlugin[ \\t]*\\{[ \\t]*$' },
  native_pointer_events: { package: 'bevy_picking', path: 'src/events.rs', symbol: 'pointer_events', kind: 'fn' },
  native_update_hovered: { package: 'bevy_picking', path: 'src/hover.rs', symbol: 'update_is_hovered', kind: 'fn' },
  native_button_down: button('button_on_pointer_down'),
  native_button_up: button('button_on_pointer_up'),
  native_button_click: button('button_on_pointer_click'),
  native_button_drag_end: button('button_on_pointer_drag_end'),
  native_button_cancel: button('button_on_pointer_cancel'),
  native_button_key: button('button_on_key_event'),
  picking_hover: picking('Hover'),
  picking_post_hover: picking('PostHover'),
  picking_last: picking('Last'),
};
