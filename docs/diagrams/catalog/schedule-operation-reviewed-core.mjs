// 按完整声明核实函数体的直接 ECS 操作；与参数声明关系分开。
export const CORE_SCHEDULE_BODY_OPERATIONS = {
  "bevy_app::propagate::propagate_inherited": [
    {
      "kind": "Component",
      "type": "Inherited<C>",
      "operation": "insert",
      "via": "commands",
      "method": "try_insert",
      "match": "commands.entity(entity).try_insert(inherited)",
      "evidenceMatch": "mut to_process: Local<Vec<(Entity, Option<Inherited<C>>)>>",
      "condition": "继承值变化且应向当前节点传播时。"
    },
    {
      "kind": "Component",
      "type": "Inherited<C>",
      "operation": "remove",
      "via": "commands",
      "method": "try_remove",
      "match": "commands.entity(entity).try_remove::<Inherited<C>>()",
      "condition": "上游继承值已移除时。"
    }
  ],
  "bevy_app::propagate::propagate_output": [
    {
      "kind": "Component",
      "type": "C",
      "operation": "insert",
      "via": "commands",
      "method": "try_insert",
      "match": "commands.entity(entity).try_insert(inherited.0.clone())",
      "evidenceMatch": "(Entity, &Inherited<C>, Option<&C>)",
      "condition": "继承值与当前输出组件不同。"
    },
    {
      "kind": "Component",
      "type": "C",
      "operation": "remove",
      "via": "commands",
      "method": "try_remove",
      "match": "commands.entity(inherited_removed).try_remove::<C>()",
      "condition": "Inherited 已移除且本帧未重新添加传播组件。"
    }
  ],
  "bevy_app::propagate::update_source": [
    {
      "kind": "Component",
      "type": "Inherited<C>",
      "operation": "insert",
      "via": "commands",
      "method": "try_insert",
      "match": ".try_insert(Inherited(source.0.clone()))",
      "condition": "传播源 Propagate<C> 变化或缺少继承值。"
    },
    {
      "kind": "Component",
      "type": "Inherited<C>",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.insert(inherited.clone())",
      "evidenceMatch": "relations: Query<&Inherited<C>, Without<PropagateStop<C>>>",
      "condition": "传播源移除后能从关系祖先重新取得继承值。"
    },
    {
      "kind": "Component",
      "type": "Inherited<C>",
      "operation": "remove",
      "via": "commands",
      "method": "try_remove",
      "match": "commands.try_remove::<Inherited<C>>()",
      "condition": "传播源移除后无法从祖先取得继承值。"
    }
  ],
  "bevy_enhanced_input::context::trigger": [
    {
      "kind": "Component",
      "type": "ActionFns",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "action.get::<ActionFns>()"
    },
    {
      "kind": "Component",
      "type": "ActionValue",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "action.get::<ActionValue>()"
    },
    {
      "kind": "Component",
      "type": "TriggerState",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "action.get::<TriggerState>()"
    },
    {
      "kind": "Component",
      "type": "ActionEvents",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "action.get::<ActionEvents>()"
    },
    {
      "kind": "Component",
      "type": "ActionTime",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "action.get::<ActionTime>()"
    }
  ],
  "bevy_input_focus::dispatch_focused_input": [
    {
      "kind": "EntityEvent",
      "type": "FocusedInput<M>",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(FocusedInput {",
      "allMatches": true,
      "condition": "把读到的输入转给仍存活的焦点实体，否则转给主窗口。"
    }
  ],
  "bevy_input_focus::gained_and_lost::process_recorded_focus_changes": [
    {
      "kind": "EntityEvent",
      "type": "FocusLost",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(FocusLost { entity: old_focus })",
      "allMatches": true,
      "condition": "记录的焦点目标发生变化且原目标存在。"
    },
    {
      "kind": "EntityEvent",
      "type": "FocusGained",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(FocusGained {",
      "condition": "记录的焦点切换到新目标。"
    }
  ],
  "bevy_input::gamepad::gamepad_connection_system": [
    {
      "kind": "Component",
      "type": "Name",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "gamepad.insert((",
      "condition": "收到手柄连接事件。"
    },
    {
      "kind": "Component",
      "type": "Gamepad",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "gamepad.insert((",
      "condition": "收到手柄连接事件。"
    },
    {
      "kind": "Component",
      "type": "Gamepad",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "gamepad.remove::<Gamepad>()",
      "condition": "收到手柄断开事件，保留实体及持久设置。"
    }
  ],
  "bevy_picking::hover::update_interactions": [
    {
      "kind": "Component",
      "type": "PickingInteraction",
      "operation": "insert",
      "via": "commands",
      "method": "try_insert",
      "match": "entity_commands.try_insert(new_interaction)",
      "evidenceMatch": "let mut new_interaction_state = EntityHashMap::<PickingInteraction>::default()",
      "condition": "当前被拾取实体尚无 PickingInteraction 时，插入多指针聚合后的状态。"
    }
  ],
  "bevy_picking::hover::update_is_directly_hovered": [
    {
      "kind": "Component",
      "type": "DirectlyHovered",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(entity).insert(DirectlyHovered(is_hovering))",
      "condition": "鼠标直接悬停状态改变。"
    },
    {
      "kind": "Component",
      "type": "DirectlyHovered",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(entity).insert(DirectlyHovered(false))",
      "condition": "没有鼠标悬停命中时清除原悬停状态。"
    }
  ],
  "bevy_picking::hover::update_is_hovered": [
    {
      "kind": "Component",
      "type": "Hovered",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(entity).insert(Hovered(is_hovering))",
      "condition": "鼠标命中实体及其祖先集合对应的悬停状态改变。"
    }
  ],
  "bevy_picking::input::spawn_mouse_pointer": [
    {
      "kind": "Component",
      "type": "PointerId",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": "commands.spawn(PointerId::Mouse)"
    }
  ],
  "bevy_picking::input::touch_pick_events": [
    {
      "kind": "Component",
      "type": "PointerId",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": "commands.spawn((pointer, PointerLocation::new(location.clone())))",
      "evidenceMatch": "let pointer = PointerId::Touch(touch.id)",
      "condition": "触摸开始时创建指针实体。"
    },
    {
      "kind": "Component",
      "type": "PointerLocation",
      "operation": "insert",
      "via": "commands",
      "method": "spawn",
      "match": "commands.spawn((pointer, PointerLocation::new(location.clone())))",
      "condition": "触摸开始时创建指针实体。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerInput>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "pointer_inputs.write(PointerInput::new(",
      "allMatches": true
    }
  ],
  "bevy_text::editing::apply_text_edits": [
    {
      "kind": "EntityEvent",
      "type": "TextEditChange",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(TextEditChange { entity })",
      "condition": "编辑器 generation 与已记录的 EditableTextGeneration 不同。"
    }
  ],
  "bevy_time::fixed::run_fixed_main_schedule": [
    {
      "kind": "Resource",
      "type": "Time<Virtual>",
      "operation": "read",
      "via": "world",
      "method": "resource",
      "match": "world.resource::<Time<Virtual>>()",
      "allMatches": true
    },
    {
      "kind": "Resource",
      "type": "Time<Fixed>",
      "operation": "read",
      "via": "world",
      "method": "resource",
      "match": "world.resource::<Time<Fixed>>()"
    },
    {
      "kind": "Resource",
      "type": "Time<Fixed>",
      "operation": "mutable_access",
      "via": "world",
      "method": "resource_mut",
      "match": ".resource_mut::<Time<Fixed>>()",
      "allMatches": true
    },
    {
      "kind": "Resource",
      "type": "Time",
      "operation": "mutable_access",
      "via": "world",
      "method": "resource_mut",
      "match": "world.resource_mut::<Time>()",
      "allMatches": true,
      "condition": "每次固定步换入 Fixed 时钟，循环结束后恢复 Virtual 时钟。"
    }
  ],
  "bevy_ui_widgets::dialog::sync_dialog_z": [
    {
      "kind": "Component",
      "type": "GlobalZIndex",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(entity).insert(GlobalZIndex(z))",
      "condition": "按对话框堆栈顺序更新全局绘制层级。"
    }
  ],
  "bevy_ui_widgets::menu::menu_on_lose_focus": [
    {
      "kind": "EntityEvent",
      "type": "MenuEvent",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(MenuEvent {",
      "condition": "已打开或正在打开的菜单不再包含焦点目标时发出 CloseAll。"
    }
  ],
  "bevy_ui_widgets::tabs::update_tablist_derived_state": [
    {
      "kind": "Component",
      "type": "Selected",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(*child).insert(Selected)",
      "condition": "子标签应被选中且还没有 Selected。"
    },
    {
      "kind": "Component",
      "type": "Selected",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "commands.entity(*child).remove::<Selected>()",
      "condition": "子标签不应被选中但仍有 Selected。"
    },
    {
      "kind": "Component",
      "type": "TabIndex",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(*child).insert(TabIndex(desired_index))",
      "condition": "游走焦点计算出的 TabIndex 与当前值不同。"
    }
  ],
  "bevy_window::system::close_when_requested": [
    {
      "kind": "Component",
      "type": "ClosingWindow",
      "operation": "insert",
      "via": "commands",
      "method": "try_insert",
      "match": "commands.entity(event.window).try_insert(ClosingWindow)",
      "condition": "收到关闭请求，先标记，在后续帧销毁窗口实体。"
    }
  ],
  "bevy_winit::cursor::update_cursors": [
    {
      "kind": "Component",
      "type": "PendingCursor",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(PendingCursor(Some(cursor_source)))",
      "condition": "游标变化且系统或自定义游标已成功解析，排队交给窗口线程应用。"
    }
  ],
  "bevy_winit::system::changed_windows": [
    {
      "kind": "Component",
      "type": "OnMonitor",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(entity).insert(OnMonitor(winit_monitor_entity.to_owned()))",
      "allMatches": true,
      "condition": "窗口当前显示器与关系不一致，或尚无显示器关系但能找到对应显示器实体。"
    },
    {
      "kind": "Component",
      "type": "OnMonitor",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "commands.entity(entity).remove::<OnMonitor>()",
      "condition": "原有 OnMonitor 关系存在但窗口已无法取得当前显示器。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<WindowResized>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "window_resized.write(event.clone())"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<WindowScaleFactorChanged>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "window_rescaled.write(event.clone())"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<WindowEvent>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "window_event.write(event.into())",
      "allMatches": true
    }
  ],
  "bevy_app::main_schedule::FixedMain::run_fixed_main": [
    {
      "kind": "Resource",
      "type": "FixedMainScheduleOrder",
      "operation": "mutable_access",
      "via": "world",
      "method": "resource_scope",
      "match": "world.resource_scope(|world, order: Mut<FixedMainScheduleOrder>|"
    }
  ],
  "bevy_app::main_schedule::Main::run_main": [
    {
      "kind": "Resource",
      "type": "MainScheduleOrder",
      "operation": "mutable_access",
      "via": "world",
      "method": "resource_scope",
      "match": "world.resource_scope(|world, order: Mut<MainScheduleOrder>|",
      "allMatches": true
    }
  ],
  "bevy_inspector_egui::quick::world_inspector_ui": [
    {
      "kind": "Component",
      "type": "EguiContext",
      "operation": "mutable_access",
      "via": "world",
      "method": "query_filtered",
      "match": ".query_filtered::<&mut EguiContext, With<PrimaryEguiContext>>()"
    }
  ],
  "bevy_scene::spawn::spawn_queued": [
    {
      "kind": "Resource",
      "type": "Assets<SceneListPatch>",
      "operation": "mutable_access",
      "via": "world",
      "method": "resource_scope",
      "match": "world.resource_scope(|world, mut list_patches: Mut<Assets<SceneListPatch>>|"
    },
    {
      "kind": "Resource",
      "type": "WaitingScenes",
      "operation": "mutable_access",
      "via": "world",
      "method": "resource_scope",
      "match": "world.resource_scope(|world, mut waiting: Mut<WaitingScenes>|"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<AssetEvent<ScenePatch>>",
      "operation": "mutable_access",
      "via": "world",
      "method": "resource_scope",
      "match": "world.resource_scope(|world, events: Mut<Messages<AssetEvent<ScenePatch>>>|"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<AssetEvent<SceneListPatch>>",
      "operation": "mutable_access",
      "via": "world",
      "method": "resource_scope",
      "match": "world.resource_scope(\n                |world, list_events: Mut<Messages<AssetEvent<SceneListPatch>>>|"
    },
    {
      "kind": "Resource",
      "type": "Assets<ScenePatch>",
      "operation": "read",
      "via": "world",
      "method": "resource",
      "match": "world.resource::<Assets<ScenePatch>>()"
    },
    {
      "kind": "Resource",
      "type": "QueuedScenes",
      "operation": "mutable_access",
      "via": "world",
      "method": "resource_mut",
      "match": "world.resource_mut::<QueuedScenes>()"
    }
  ],
  "bevy_world_serialization::world_asset_spawner::world_instance_spawner": [
    {
      "kind": "Component",
      "type": "WorldInstance",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(entity).insert(WorldInstance(new_instance))",
      "allMatches": true,
      "condition": "根实体尚无 WorldInstance 时插入新生成的实例身份。"
    }
  ],
  "bevy_world_serialization::world_asset_spawner::world_instance_spawner_system": [
    {
      "kind": "Resource",
      "type": "WorldInstanceSpawner",
      "operation": "mutable_access",
      "via": "world",
      "method": "resource_scope",
      "match": "world.resource_scope(|world, mut instance_spawner: Mut<WorldInstanceSpawner>|"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<AssetEvent<WorldAsset>>",
      "operation": "read",
      "via": "world",
      "method": "resource",
      "match": "world.resource::<Messages<AssetEvent<WorldAsset>>>()"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<AssetEvent<DynamicWorld>>",
      "operation": "read",
      "via": "world",
      "method": "resource",
      "match": "world.resource::<Messages<AssetEvent<DynamicWorld>>>()"
    }
  ],
  "demo::bounds_recovery::recovery::recover_from_water": [
    {
      "kind": "Component",
      "type": "HeldBy",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget)>()"
    },
    {
      "kind": "Component",
      "type": "HeldTarget",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget)>()"
    },
    {
      "kind": "Component",
      "type": "avian3d::collision::collider::layers::CollisionLayers",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(parcel_collision_layers())"
    },
    {
      "kind": "Component",
      "type": "Sleeping",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "recovered.remove::<Sleeping>()"
    },
    {
      "kind": "Component",
      "type": "ResumeInterpolation",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ResumeInterpolation {"
    },
    {
      "kind": "Component",
      "type": "bevy_transform_interpolation::NoTranslationEasing",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "recovered.insert(NoTranslationEasing)",
      "condition": "恢复前未暂停平移插值。"
    },
    {
      "kind": "Component",
      "type": "bevy_transform_interpolation::NoRotationEasing",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "recovered.insert(NoRotationEasing)",
      "condition": "恢复前未暂停旋转插值。"
    },
    {
      "kind": "Component",
      "type": "HeldAttachment",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "item_ref.get::<HeldAttachment>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldBy",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "item_ref.get::<HeldBy>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldTarget",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "item_ref.get::<HeldTarget>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderOf",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": ".get::<ColliderOf>(attachment.collider)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "CarryBaseMass",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "world.get::<CarryBaseMass>(holder)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderDisabled",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": "proxy.insert(ColliderDisabled)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderOf",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": "proxy.insert(ColliderDisabled).remove::<ColliderOf>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderDisabled",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": "item_entity.insert(ColliderDisabled)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldBy",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldTarget",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldAttachment",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderOf",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Sleeping",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<Sleeping>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "RigidBody",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Position",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Rotation",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Transform",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "LinearVelocity",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "AngularVelocity",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "avian3d::collision::collider::layers::CollisionLayers",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ResumeCarryEasing",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": "item_entity.insert(ResumeCarryEasing {",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderDisabled",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": "item_entity.remove::<ColliderDisabled>()",
      "allMatches": true,
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::rigid_body::mass_properties::components::Mass",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert(Mass(base))",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "CarryBaseMass",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<CarryBaseMass>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    }
  ],
  "demo::bounds_recovery::recovery::resume_interpolation": [
    {
      "kind": "Component",
      "type": "bevy_transform_interpolation::NoTranslationEasing",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "entity.remove::<NoTranslationEasing>()",
      "condition": "ResumeInterpolation.translation 为真。"
    },
    {
      "kind": "Component",
      "type": "bevy_transform_interpolation::NoRotationEasing",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "entity.remove::<NoRotationEasing>()",
      "condition": "ResumeInterpolation.rotation 为真。"
    },
    {
      "kind": "Component",
      "type": "ResumeInterpolation",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "entity.remove::<ResumeInterpolation>()"
    }
  ],
  "demo::character_animation::binding::initialize_ready_couriers": [
    {
      "kind": "Component",
      "type": "CourierAnimationPending",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<CourierAnimationPending>()",
      "allMatches": true,
      "condition": "绑定成功，或已确定父角色/动画片段/片段时长不符合契约。"
    },
    {
      "kind": "Component",
      "type": "bevy_animation::transition::AnimationTransitions",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "commands.entity(descendant).remove::<AnimationTransitions>()"
    },
    {
      "kind": "Component",
      "type": "bevy_animation::graph::AnimationGraphHandle",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(descendant).insert((",
      "condition": "所有命名片段及持续时间已就绪，并找到 AnimationPlayer。"
    },
    {
      "kind": "Component",
      "type": "demo::character_animation::state::CourierAnimation",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(descendant).insert((",
      "condition": "所有命名片段及持续时间已就绪，并找到 AnimationPlayer。"
    },
    {
      "kind": "Component",
      "type": "CourierFootGrounding",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(visual_root).insert(CourierFootGrounding {",
      "condition": "至少绑定一个动画播放器，且所有鞋底标记均能解析。"
    }
  ],
  "demo::character_animation::grounding::compensate_courier_sole_penetration": [
    {
      "kind": "Component",
      "type": "CourierFootGrounding",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<CourierFootGrounding>()",
      "condition": "动画播放器、角色或鞋底层级已无法提供有效接地信息。"
    }
  ],
  "demo::character_animation::state::sync_courier_animation": [
    {
      "kind": "Component",
      "type": "demo::character_animation::state::CourierAnimation",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(CourierAnimation, AnimationGraphHandle)>()",
      "condition": "动画播放器所绑定的角色已不存在。"
    },
    {
      "kind": "Component",
      "type": "bevy_animation::graph::AnimationGraphHandle",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<(CourierAnimation, AnimationGraphHandle)>()",
      "condition": "动画播放器所绑定的角色已不存在。"
    }
  ],
  "demo::first_person::capture::sync_mouse_capture": [
    {
      "kind": "Component",
      "type": "ContextActivity<GameplayContext>",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ContextActivity::<GameplayContext>::INACTIVE)",
      "condition": "主窗口不可用时停用原本活动的控制上下文。"
    },
    {
      "kind": "Component",
      "type": "ContextActivity<GameplayContext>",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ContextActivity::<GameplayContext>::new(after))",
      "condition": "相机捕获、角色绑定、游戏状态或窗口焦点导致上下文活动状态变化。"
    }
  ],
  "demo::first_person::facing::sync_character_facing": [
    {
      "kind": "Component",
      "type": "Rotation",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(Rotation(rotation))",
      "condition": "输入转向或当前安全朝向需要更新。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<SoundRequest>",
      "operation": "publish",
      "via": "commands",
      "method": "write_message",
      "match": "commands.write_message(SoundRequest::new(SoundCue::ParcelRelease, item))",
      "condition": "持箱旋转路径受阻，接受自动卸载结果后。"
    },
    {
      "kind": "Component",
      "type": "HeldAttachment",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "item_ref.get::<HeldAttachment>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldBy",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "item_ref.get::<HeldBy>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldTarget",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "item_ref.get::<HeldTarget>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderOf",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": ".get::<ColliderOf>(attachment.collider)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "CarryBaseMass",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "world.get::<CarryBaseMass>(holder)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderDisabled",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": "proxy.insert(ColliderDisabled)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderOf",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": "proxy.insert(ColliderDisabled).remove::<ColliderOf>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderDisabled",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": "item_entity.insert(ColliderDisabled)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldBy",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldTarget",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldAttachment",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderOf",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Sleeping",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<Sleeping>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "RigidBody",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Position",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Rotation",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Transform",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "LinearVelocity",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "AngularVelocity",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "avian3d::collision::collider::layers::CollisionLayers",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ResumeCarryEasing",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": "item_entity.insert(ResumeCarryEasing {",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderDisabled",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": "item_entity.remove::<ColliderDisabled>()",
      "allMatches": true,
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::rigid_body::mass_properties::components::Mass",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert(Mass(base))",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "CarryBaseMass",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<CarryBaseMass>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    }
  ],
  "demo::first_person::suspend_controls": [
    {
      "kind": "Component",
      "type": "ContextActivity<GameplayContext>",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ContextActivity::<GameplayContext>::INACTIVE)"
    }
  ],
  "demo::item_interaction::attachment::finish_attachments": [
    {
      "kind": "Component",
      "type": "CarryBaseMass",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(holder).insert(CarryBaseMass(holder_mass.0))",
      "condition": "挂接尚未记录持有者原始质量。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::rigid_body::mass_properties::components::Mass",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(holder).insert(Mass(holder_mass.0 + mass.0))"
    },
    {
      "kind": "Component",
      "type": "Name",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((\n                Name::new(\"Held parcel collision proxy\"),",
      "condition": "挂接处于 pending，刚体已移除且持有者可用时配置碰撞代理。"
    },
    {
      "kind": "Component",
      "type": "HeldCollider",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((\n                Name::new(\"Held parcel collision proxy\"),",
      "condition": "挂接处于 pending，刚体已移除且持有者可用时配置碰撞代理。"
    },
    {
      "kind": "Component",
      "type": "Collider",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((\n                Name::new(\"Held parcel collision proxy\"),",
      "condition": "挂接处于 pending，刚体已移除且持有者可用时配置碰撞代理。"
    },
    {
      "kind": "Component",
      "type": "avian3d::collision::collider::layers::CollisionLayers",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((\n                Name::new(\"Held parcel collision proxy\"),",
      "condition": "挂接处于 pending，刚体已移除且持有者可用时配置碰撞代理。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::rigid_body::physics_material::Friction",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((\n                Name::new(\"Held parcel collision proxy\"),",
      "condition": "挂接处于 pending，刚体已移除且持有者可用时配置碰撞代理。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::rigid_body::physics_material::Restitution",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((\n                Name::new(\"Held parcel collision proxy\"),",
      "condition": "挂接处于 pending，刚体已移除且持有者可用时配置碰撞代理。"
    },
    {
      "kind": "Component",
      "type": "avian3d::collision::collision_events::CollisionEventsEnabled",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((\n                Name::new(\"Held parcel collision proxy\"),",
      "condition": "挂接处于 pending，刚体已移除且持有者可用时配置碰撞代理。"
    },
    {
      "kind": "Component",
      "type": "Transform",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((\n                Name::new(\"Held parcel collision proxy\"),",
      "condition": "挂接处于 pending，刚体已移除且持有者可用时配置碰撞代理。"
    },
    {
      "kind": "Component",
      "type": "ColliderOf",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ColliderOf { body: holder })"
    },
    {
      "kind": "Component",
      "type": "ColliderTransform",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ColliderTransform::from(attachment.local_pose))"
    },
    {
      "kind": "Component",
      "type": "ColliderDisabled",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ColliderDisabled)",
      "condition": "业务物品在拾取前的碰撞体本就停用。"
    }
  ],
  "demo::item_interaction::interaction::handle_interaction": [
    {
      "kind": "Component",
      "type": "HeldBy",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(item).insert((",
      "condition": "交互动作命中可见范围内且未被同批其他角色预留的可拾取物。"
    },
    {
      "kind": "Component",
      "type": "HeldTarget",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(item).insert((",
      "condition": "交互动作命中可见范围内且未被同批其他角色预留的可拾取物。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<SoundRequest>",
      "operation": "publish",
      "via": "commands",
      "method": "write_message",
      "match": "commands.write_message(SoundRequest::new(SoundCue::ParcelRelease, item))",
      "condition": "交互动作释放当前持握物。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<SoundRequest>",
      "operation": "publish",
      "via": "commands",
      "method": "write_message",
      "match": "commands.write_message(SoundRequest::new(SoundCue::ParcelPickup, item))",
      "condition": "交互动作成功预留并挂接可拾取物。"
    },
    {
      "kind": "Component",
      "type": "HeldAttachment",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "item_ref.get::<HeldAttachment>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldBy",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "item_ref.get::<HeldBy>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldTarget",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "item_ref.get::<HeldTarget>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderOf",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": ".get::<ColliderOf>(attachment.collider)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "CarryBaseMass",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "world.get::<CarryBaseMass>(holder)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderDisabled",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": "proxy.insert(ColliderDisabled)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderOf",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": "proxy.insert(ColliderDisabled).remove::<ColliderOf>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderDisabled",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": "item_entity.insert(ColliderDisabled)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldBy",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldTarget",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldAttachment",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderOf",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Sleeping",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<Sleeping>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "RigidBody",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Position",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Rotation",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Transform",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "LinearVelocity",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "AngularVelocity",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "avian3d::collision::collider::layers::CollisionLayers",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ResumeCarryEasing",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": "item_entity.insert(ResumeCarryEasing {",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderDisabled",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": "item_entity.remove::<ColliderDisabled>()",
      "allMatches": true,
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::rigid_body::mass_properties::components::Mass",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert(Mass(base))",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "CarryBaseMass",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<CarryBaseMass>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderDisabled",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(item).insert(ColliderDisabled)",
      "helper": "demo::item_interaction::attachment::begin_attachment",
      "callMatch": "begin_attachment(",
      "condition": "已选中可拾取物，先保存拾取瞬间姿态并暂停插值，等待刚体卸载和代理挂接。"
    },
    {
      "kind": "Component",
      "type": "RigidBody",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "commands.entity(item).remove::<RigidBody>()",
      "helper": "demo::item_interaction::attachment::begin_attachment",
      "callMatch": "begin_attachment(",
      "condition": "已选中可拾取物，先保存拾取瞬间姿态并暂停插值，等待刚体卸载和代理挂接。"
    },
    {
      "kind": "Component",
      "type": "HeldAttachment",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((\n        HeldAttachment {",
      "helper": "demo::item_interaction::attachment::begin_attachment",
      "callMatch": "begin_attachment(",
      "condition": "已选中可拾取物，先保存拾取瞬间姿态并暂停插值，等待刚体卸载和代理挂接。"
    },
    {
      "kind": "Component",
      "type": "bevy_transform_interpolation::NoTranslationEasing",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((\n        HeldAttachment {",
      "helper": "demo::item_interaction::attachment::begin_attachment",
      "callMatch": "begin_attachment(",
      "condition": "已选中可拾取物，先保存拾取瞬间姿态并暂停插值，等待刚体卸载和代理挂接。"
    },
    {
      "kind": "Component",
      "type": "bevy_transform_interpolation::NoRotationEasing",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((\n        HeldAttachment {",
      "helper": "demo::item_interaction::attachment::begin_attachment",
      "callMatch": "begin_attachment(",
      "condition": "已选中可拾取物，先保存拾取瞬间姿态并暂停插值，等待刚体卸载和代理挂接。"
    }
  ],
  "demo::item_interaction::lifecycle::cleanup_orphaned_colliders": [
    {
      "kind": "Component",
      "type": "ColliderDisabled",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ColliderDisabled)",
      "condition": "代理所关联的业务物品已不存在，随后卸载并销毁代理。"
    },
    {
      "kind": "Component",
      "type": "ColliderOf",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<ColliderOf>()",
      "condition": "代理所关联的业务物品已不存在。"
    }
  ],
  "demo::item_interaction::lifecycle::restore_empty_holder_mass": [
    {
      "kind": "Component",
      "type": "CarryBaseMass",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "commands.entity(holder).remove::<CarryBaseMass>()",
      "condition": "持有者已经没有实际持握物，恢复基础质量后移除备份。"
    }
  ],
  "demo::item_interaction::lifecycle::resume_carry_easing": [
    {
      "kind": "Component",
      "type": "bevy_transform_interpolation::NoTranslationEasing",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "item.remove::<NoTranslationEasing>()",
      "condition": "ResumeCarryEasing.translation 为真。"
    },
    {
      "kind": "Component",
      "type": "bevy_transform_interpolation::NoRotationEasing",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "item.remove::<NoRotationEasing>()",
      "condition": "ResumeCarryEasing.rotation 为真。"
    },
    {
      "kind": "Component",
      "type": "ResumeCarryEasing",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "item.remove::<ResumeCarryEasing>()"
    }
  ],
  "demo::ui::backdrop::play_courier_animation": [
    {
      "kind": "Component",
      "type": "CourierAnimationPending",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "commands.entity(entity).remove::<CourierAnimationPending>()",
      "allMatches": true,
      "condition": "命名动画片段缺失或已完成绑定尝试。"
    },
    {
      "kind": "Component",
      "type": "bevy_animation::graph::AnimationGraphHandle",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(AnimationGraphHandle(graph.clone()))",
      "condition": "命名动画片段已入库且后代实体有 AnimationPlayer。"
    }
  ],
  "demo::ui::navigation::sync_context": [
    {
      "kind": "Component",
      "type": "ContextActivity<MenuContext>",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(ContextActivity::<MenuContext>::new(focused))",
      "condition": "主窗口焦点与菜单上下文活动状态不同。"
    }
  ],
  "demo::ui::pointer::clear_cancelled_primary_presses": [
    {
      "kind": "Component",
      "type": "PrimaryPress",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "commands.entity(entity).remove::<(PrimaryPress, Pressed)>()",
      "allMatches": true,
      "condition": "收到对应指针 Cancel，或鼠标指针因失焦/离窗而失效。"
    },
    {
      "kind": "Component",
      "type": "Pressed",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "commands.entity(entity).remove::<(PrimaryPress, Pressed)>()",
      "allMatches": true,
      "condition": "收到对应指针 Cancel，或鼠标指针因失焦/离窗而失效。"
    }
  ],
  "demo::ui::scroll::bind_settings_scrollbars": [
    {
      "kind": "Component",
      "type": "Scrollbar",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(entity).insert(Scrollbar::new(",
      "condition": "滚动条轨道尚未绑定，且同父级下已找到 MenuScroll 区域。"
    }
  ],
  "bevy_picking::events::pointer_events": [
    {
      "kind": "EntityEvent",
      "type": "PointerOut",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(out_event.clone())",
      "allMatches": true,
      "evidenceMatch": "let out_event = PointerOut {",
      "condition": "按指针悬停变化、按键、移动、滚动、取消或拖动状态进入对应事件分支。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerOut>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "message_writers.out_events.write(out_event)",
      "allMatches": true
    },
    {
      "kind": "EntityEvent",
      "type": "PointerLeave",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(leave_event.clone())",
      "allMatches": true,
      "evidenceMatch": "for leave_event in entities_to_send_leave.iter().map(|entity| PointerLeave {",
      "condition": "按指针悬停变化、按键、移动、滚动、取消或拖动状态进入对应事件分支。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerLeave>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "message_writers.leave_events.write(leave_event)",
      "allMatches": true
    },
    {
      "kind": "EntityEvent",
      "type": "PointerDragLeave",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(drag_leave_event.clone())",
      "allMatches": true,
      "evidenceMatch": "let drag_leave_event = PointerDragLeave { pointer: pointer.clone(), entity: hovered_entity, button, dragged: *drag_target,",
      "condition": "按指针悬停变化、按键、移动、滚动、取消或拖动状态进入对应事件分支。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerDragLeave>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "message_writers.drag_leave_events.write(drag_leave_event)",
      "allMatches": true
    },
    {
      "kind": "EntityEvent",
      "type": "PointerDragEnter",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(drag_enter_event.clone())",
      "allMatches": true,
      "evidenceMatch": "let drag_enter_event = PointerDragEnter { pointer: pointer.clone(), entity: hovered_entity, button, dragged: *drag_target,",
      "condition": "按指针悬停变化、按键、移动、滚动、取消或拖动状态进入对应事件分支。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerDragEnter>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "message_writers.drag_enter_events.write(drag_enter_event)",
      "allMatches": true
    },
    {
      "kind": "EntityEvent",
      "type": "PointerEnter",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(enter_event.clone())",
      "allMatches": true,
      "evidenceMatch": "for enter_event in entities_to_send_enter.iter().map(|entity| PointerEnter {",
      "condition": "按指针悬停变化、按键、移动、滚动、取消或拖动状态进入对应事件分支。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerEnter>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "message_writers.enter_events.write(enter_event)",
      "allMatches": true
    },
    {
      "kind": "EntityEvent",
      "type": "PointerOver",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(over_event.clone())",
      "allMatches": true,
      "evidenceMatch": "let over_event = PointerOver {",
      "condition": "按指针悬停变化、按键、移动、滚动、取消或拖动状态进入对应事件分支。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerOver>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "message_writers.over_events.write(over_event)",
      "allMatches": true
    },
    {
      "kind": "EntityEvent",
      "type": "PointerPress",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(pressed_event.clone())",
      "allMatches": true,
      "evidenceMatch": "let pressed_event = PointerPress {",
      "condition": "按指针悬停变化、按键、移动、滚动、取消或拖动状态进入对应事件分支。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerPress>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "message_writers.pressed_events.write(pressed_event)",
      "allMatches": true
    },
    {
      "kind": "EntityEvent",
      "type": "PointerClick",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(click_event.clone())",
      "allMatches": true,
      "evidenceMatch": "let click_event = PointerClick {",
      "condition": "按指针悬停变化、按键、移动、滚动、取消或拖动状态进入对应事件分支。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerClick>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "message_writers.click_events.write(click_event)",
      "allMatches": true
    },
    {
      "kind": "EntityEvent",
      "type": "PointerRelease",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(released_event.clone())",
      "allMatches": true,
      "evidenceMatch": "let released_event = PointerRelease {",
      "condition": "按指针悬停变化、按键、移动、滚动、取消或拖动状态进入对应事件分支。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerRelease>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "message_writers.released_events.write(released_event)",
      "allMatches": true
    },
    {
      "kind": "EntityEvent",
      "type": "PointerDragDrop",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(drag_drop_event.clone())",
      "allMatches": true,
      "evidenceMatch": "let drag_drop_event = PointerDragDrop {",
      "condition": "按指针悬停变化、按键、移动、滚动、取消或拖动状态进入对应事件分支。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerDragDrop>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "message_writers.drag_drop_events.write(drag_drop_event)",
      "allMatches": true
    },
    {
      "kind": "EntityEvent",
      "type": "PointerDragEnd",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(drag_end_event.clone())",
      "allMatches": true,
      "evidenceMatch": "let drag_end_event = PointerDragEnd {",
      "condition": "按指针悬停变化、按键、移动、滚动、取消或拖动状态进入对应事件分支。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerDragEnd>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "message_writers.drag_end_events.write(drag_end_event)",
      "allMatches": true
    },
    {
      "kind": "EntityEvent",
      "type": "PointerDragStart",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(drag_start_event.clone())",
      "allMatches": true,
      "evidenceMatch": "let drag_start_event = PointerDragStart {",
      "condition": "按指针悬停变化、按键、移动、滚动、取消或拖动状态进入对应事件分支。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerDragStart>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "message_writers.drag_start_events.write(drag_start_event)",
      "allMatches": true
    },
    {
      "kind": "EntityEvent",
      "type": "PointerDrag",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(drag_event.clone())",
      "allMatches": true,
      "evidenceMatch": "let drag_event = PointerDrag {",
      "condition": "按指针悬停变化、按键、移动、滚动、取消或拖动状态进入对应事件分支。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerDrag>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "message_writers.drag_events.write(drag_event)",
      "allMatches": true
    },
    {
      "kind": "EntityEvent",
      "type": "PointerDragOver",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(drag_over_event.clone())",
      "allMatches": true,
      "evidenceMatch": "let drag_over_event = PointerDragOver {",
      "condition": "按指针悬停变化、按键、移动、滚动、取消或拖动状态进入对应事件分支。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerDragOver>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "message_writers.drag_over_events.write(drag_over_event)",
      "allMatches": true
    },
    {
      "kind": "EntityEvent",
      "type": "PointerMove",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(move_event.clone())",
      "allMatches": true,
      "evidenceMatch": "let move_event = PointerMove {",
      "condition": "按指针悬停变化、按键、移动、滚动、取消或拖动状态进入对应事件分支。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerMove>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "message_writers.move_events.write(move_event)",
      "allMatches": true
    },
    {
      "kind": "EntityEvent",
      "type": "PointerScroll",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(scroll_event.clone())",
      "allMatches": true,
      "evidenceMatch": "let scroll_event = PointerScroll {",
      "condition": "按指针悬停变化、按键、移动、滚动、取消或拖动状态进入对应事件分支。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerScroll>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "message_writers.scroll_events.write(scroll_event)",
      "allMatches": true
    },
    {
      "kind": "EntityEvent",
      "type": "PointerCancel",
      "operation": "trigger",
      "via": "commands",
      "method": "trigger",
      "match": "commands.trigger(cancel_event.clone())",
      "allMatches": true,
      "evidenceMatch": "let cancel_event = PointerCancel {",
      "condition": "按指针悬停变化、按键、移动、滚动、取消或拖动状态进入对应事件分支。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerCancel>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "message_writers.cancel_events.write(cancel_event)",
      "allMatches": true
    }
  ],
  "bevy_gilrs::gilrs_system::gilrs_event_startup_system": [
    {
      "kind": "Messages<T>",
      "type": "Messages<GamepadConnectionEvent>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "events.write(GamepadConnectionEvent {",
      "condition": "枚举启动时已连接设备。"
    }
  ],
  "bevy_gilrs::gilrs_system::gilrs_event_system": [
    {
      "kind": "Messages<T>",
      "type": "Messages<RawGamepadEvent>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "events.write(event.clone().into())",
      "allMatches": true
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<RawGamepadEvent>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "events.write(\n                        RawGamepadButtonChangedEvent::new(gamepad, button, raw_value).into(),"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<RawGamepadEvent>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "events.write(RawGamepadAxisChangedEvent::new(gamepad, axis, raw_value).into())"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<GamepadConnectionEvent>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "connection_events.write(event)",
      "allMatches": true
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<RawGamepadButtonChangedEvent>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "button_events.write(RawGamepadButtonChangedEvent::new("
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<RawGamepadAxisChangedEvent>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "axis_event.write(RawGamepadAxisChangedEvent::new("
    }
  ],
  "demo::item_interaction::audio_events::emit_parcel_land": [
    {
      "kind": "Messages<T>",
      "type": "Messages<SoundRequest>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "sounds.write(SoundRequest::new(SoundCue::ParcelLand, parcel))",
      "condition": "非持握包裹出现足够向上支撑冲量，且本次落地尚未报告。"
    }
  ],
  "demo::item_interaction::audio_events::warn_hold_strain": [
    {
      "kind": "Messages<T>",
      "type": "Messages<SoundRequest>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "sounds.write(SoundRequest::new(SoundCue::InstabilityWarning, parcel))",
      "condition": "持握偏差越过距离与持续时间门槛，宽限结束且尚未告警。"
    }
  ],
  "demo::item_interaction::attachment::align_attachments": [
    {
      "kind": "Component",
      "type": "HeldAttachment",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "item_ref.get::<HeldAttachment>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldBy",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "item_ref.get::<HeldBy>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldTarget",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "item_ref.get::<HeldTarget>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderOf",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": ".get::<ColliderOf>(attachment.collider)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "CarryBaseMass",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "world.get::<CarryBaseMass>(holder)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderDisabled",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": "proxy.insert(ColliderDisabled)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderOf",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": "proxy.insert(ColliderDisabled).remove::<ColliderOf>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderDisabled",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": "item_entity.insert(ColliderDisabled)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldBy",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldTarget",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldAttachment",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderOf",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Sleeping",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<Sleeping>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "RigidBody",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Position",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Rotation",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Transform",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "LinearVelocity",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "AngularVelocity",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "avian3d::collision::collider::layers::CollisionLayers",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ResumeCarryEasing",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": "item_entity.insert(ResumeCarryEasing {",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderDisabled",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": "item_entity.remove::<ColliderDisabled>()",
      "allMatches": true,
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::rigid_body::mass_properties::components::Mass",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert(Mass(base))",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "CarryBaseMass",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<CarryBaseMass>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    }
  ],
  "demo::item_interaction::lifecycle::release_orphaned_items": [
    {
      "kind": "Component",
      "type": "HeldAttachment",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "item_ref.get::<HeldAttachment>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldBy",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "item_ref.get::<HeldBy>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldTarget",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "item_ref.get::<HeldTarget>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderOf",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": ".get::<ColliderOf>(attachment.collider)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "CarryBaseMass",
      "operation": "read",
      "via": "world",
      "method": "get",
      "match": "world.get::<CarryBaseMass>(holder)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderDisabled",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": "proxy.insert(ColliderDisabled)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderOf",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": "proxy.insert(ColliderDisabled).remove::<ColliderOf>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderDisabled",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": "item_entity.insert(ColliderDisabled)",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldBy",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldTarget",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "HeldAttachment",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderOf",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<(HeldBy, HeldTarget, HeldAttachment, ColliderOf)>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Sleeping",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<Sleeping>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "RigidBody",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Position",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Rotation",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "Transform",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "LinearVelocity",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "AngularVelocity",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "avian3d::collision::collider::layers::CollisionLayers",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert((\n                attachment.map_or(RigidBody::Dynamic, |attachment| attachment.free_body),",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ResumeCarryEasing",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": "item_entity.insert(ResumeCarryEasing {",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "ColliderDisabled",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": "item_entity.remove::<ColliderDisabled>()",
      "allMatches": true,
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::rigid_body::mass_properties::components::Mass",
      "operation": "insert",
      "via": "world",
      "method": "insert",
      "match": ".insert(Mass(base))",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    },
    {
      "kind": "Component",
      "type": "CarryBaseMass",
      "operation": "remove",
      "via": "world",
      "method": "remove",
      "match": ".remove::<CarryBaseMass>()",
      "helper": "demo::item_interaction::lifecycle::release_item",
      "callMatch": "release_item(",
      "allMatches": true,
      "queueMatch": "commands.queue(move |world: &mut World| {",
      "condition": "调用共享卸载入口，待队列提交时确认物品和持握关系仍有效，再恢复独立刚体、原插值和碰撞状态；代理及持有者质量仅在对应对象仍存在时处理。"
    }
  ],
  "demo::scene_assembly::actors::spawn_actors": [
    {
      "kind": "Component",
      "type": "bevy_state::state_scoped::DespawnOnExit<demo::game_flow::AppState>",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((character_body(&config), DespawnOnExit(AppState::InGame)))"
    },
    {
      "kind": "Component",
      "type": "bevy_state::state_scoped::DespawnOnExit<demo::game_flow::AppState>",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(DespawnOnExit(AppState::InGame))"
    },
    {
      "kind": "Component",
      "type": "bevy_state::state_scoped::DespawnOnExit<demo::game_flow::AppState>",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "entity.insert((parcel_body(&config), DespawnOnExit(AppState::InGame)))"
    },
    {
      "kind": "Component",
      "type": "Collider",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "entity.insert(Collider::compound(vec![(",
      "condition": "物品模型为 WoodenCrate，覆盖为与导出几何一致的复合形状。"
    },
    {
      "kind": "Component",
      "type": "LoadingCamera",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": "commands.entity(camera).remove::<LoadingCamera>()"
    },
    {
      "kind": "Component",
      "type": "Name",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((\n            Name::new(\"Courier first-person camera\"),",
      "condition": "岛屿已就绪，把加载相机改为角色第一人称相机。"
    },
    {
      "kind": "Component",
      "type": "FirstPersonCamera",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((\n            Name::new(\"Courier first-person camera\"),",
      "condition": "岛屿已就绪，把加载相机改为角色第一人称相机。"
    },
    {
      "kind": "Component",
      "type": "MouseLookState",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((\n            Name::new(\"Courier first-person camera\"),",
      "condition": "岛屿已就绪，把加载相机改为角色第一人称相机。"
    },
    {
      "kind": "Component",
      "type": "Transform",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((\n            Name::new(\"Courier first-person camera\"),",
      "condition": "岛屿已就绪，把加载相机改为角色第一人称相机。"
    },
    {
      "kind": "Component",
      "type": "ControlsCamera",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(controller).insert(ControlsCamera(camera))"
    },
    {
      "kind": "Component",
      "type": "ActorsSpawned",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(map).insert(ActorsSpawned)"
    },
    {
      "kind": "Component",
      "type": "RigidBody",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((character_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/character/body.rs",
          "line": 20,
          "match": "pub(crate) fn character_body(config: &PrototypeConfig) -> impl Bundle {\r\n    (\r\n        RigidBody::Dynamic,\r\n        character_collider(config),\r\n        Mass(config.character_mass),\r\n        LockedAxes::ROTATION_LOCKED,\r\n        // 人物的刹车由运动控制力表达，低摩擦避免贴墙时被摩擦卡住。\r\n        Friction::new(0.0).with_combine_rule(CoefficientCombine::Min),\r\n        Restitution::new(0.0),\r\n        CollisionLayers::new(GamePhysicsLayer::Character, LayerMask::ALL),\r\n        CollisionEventsEnabled,\r\n        // Avian 按每步位移与身体最薄尺寸的比例自动启用非线性扫掠。\r\n        // 半厚度门槛避免普通步行逐帧扫掠建筑网格；保留对动态箱体的高速碰撞保护。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        SpeculativeCcd::default(),\r\n        TranslationInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 character_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "Collider",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((character_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/character/body.rs",
          "line": 20,
          "match": "pub(crate) fn character_body(config: &PrototypeConfig) -> impl Bundle {\r\n    (\r\n        RigidBody::Dynamic,\r\n        character_collider(config),\r\n        Mass(config.character_mass),\r\n        LockedAxes::ROTATION_LOCKED,\r\n        // 人物的刹车由运动控制力表达，低摩擦避免贴墙时被摩擦卡住。\r\n        Friction::new(0.0).with_combine_rule(CoefficientCombine::Min),\r\n        Restitution::new(0.0),\r\n        CollisionLayers::new(GamePhysicsLayer::Character, LayerMask::ALL),\r\n        CollisionEventsEnabled,\r\n        // Avian 按每步位移与身体最薄尺寸的比例自动启用非线性扫掠。\r\n        // 半厚度门槛避免普通步行逐帧扫掠建筑网格；保留对动态箱体的高速碰撞保护。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        SpeculativeCcd::default(),\r\n        TranslationInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 character_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::rigid_body::mass_properties::components::Mass",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((character_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/character/body.rs",
          "line": 20,
          "match": "pub(crate) fn character_body(config: &PrototypeConfig) -> impl Bundle {\r\n    (\r\n        RigidBody::Dynamic,\r\n        character_collider(config),\r\n        Mass(config.character_mass),\r\n        LockedAxes::ROTATION_LOCKED,\r\n        // 人物的刹车由运动控制力表达，低摩擦避免贴墙时被摩擦卡住。\r\n        Friction::new(0.0).with_combine_rule(CoefficientCombine::Min),\r\n        Restitution::new(0.0),\r\n        CollisionLayers::new(GamePhysicsLayer::Character, LayerMask::ALL),\r\n        CollisionEventsEnabled,\r\n        // Avian 按每步位移与身体最薄尺寸的比例自动启用非线性扫掠。\r\n        // 半厚度门槛避免普通步行逐帧扫掠建筑网格；保留对动态箱体的高速碰撞保护。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        SpeculativeCcd::default(),\r\n        TranslationInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 character_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::rigid_body::locked_axes::LockedAxes",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((character_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/character/body.rs",
          "line": 20,
          "match": "pub(crate) fn character_body(config: &PrototypeConfig) -> impl Bundle {\r\n    (\r\n        RigidBody::Dynamic,\r\n        character_collider(config),\r\n        Mass(config.character_mass),\r\n        LockedAxes::ROTATION_LOCKED,\r\n        // 人物的刹车由运动控制力表达，低摩擦避免贴墙时被摩擦卡住。\r\n        Friction::new(0.0).with_combine_rule(CoefficientCombine::Min),\r\n        Restitution::new(0.0),\r\n        CollisionLayers::new(GamePhysicsLayer::Character, LayerMask::ALL),\r\n        CollisionEventsEnabled,\r\n        // Avian 按每步位移与身体最薄尺寸的比例自动启用非线性扫掠。\r\n        // 半厚度门槛避免普通步行逐帧扫掠建筑网格；保留对动态箱体的高速碰撞保护。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        SpeculativeCcd::default(),\r\n        TranslationInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 character_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::rigid_body::physics_material::Friction",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((character_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/character/body.rs",
          "line": 20,
          "match": "pub(crate) fn character_body(config: &PrototypeConfig) -> impl Bundle {\r\n    (\r\n        RigidBody::Dynamic,\r\n        character_collider(config),\r\n        Mass(config.character_mass),\r\n        LockedAxes::ROTATION_LOCKED,\r\n        // 人物的刹车由运动控制力表达，低摩擦避免贴墙时被摩擦卡住。\r\n        Friction::new(0.0).with_combine_rule(CoefficientCombine::Min),\r\n        Restitution::new(0.0),\r\n        CollisionLayers::new(GamePhysicsLayer::Character, LayerMask::ALL),\r\n        CollisionEventsEnabled,\r\n        // Avian 按每步位移与身体最薄尺寸的比例自动启用非线性扫掠。\r\n        // 半厚度门槛避免普通步行逐帧扫掠建筑网格；保留对动态箱体的高速碰撞保护。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        SpeculativeCcd::default(),\r\n        TranslationInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 character_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::rigid_body::physics_material::Restitution",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((character_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/character/body.rs",
          "line": 20,
          "match": "pub(crate) fn character_body(config: &PrototypeConfig) -> impl Bundle {\r\n    (\r\n        RigidBody::Dynamic,\r\n        character_collider(config),\r\n        Mass(config.character_mass),\r\n        LockedAxes::ROTATION_LOCKED,\r\n        // 人物的刹车由运动控制力表达，低摩擦避免贴墙时被摩擦卡住。\r\n        Friction::new(0.0).with_combine_rule(CoefficientCombine::Min),\r\n        Restitution::new(0.0),\r\n        CollisionLayers::new(GamePhysicsLayer::Character, LayerMask::ALL),\r\n        CollisionEventsEnabled,\r\n        // Avian 按每步位移与身体最薄尺寸的比例自动启用非线性扫掠。\r\n        // 半厚度门槛避免普通步行逐帧扫掠建筑网格；保留对动态箱体的高速碰撞保护。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        SpeculativeCcd::default(),\r\n        TranslationInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 character_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "avian3d::collision::collider::layers::CollisionLayers",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((character_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/character/body.rs",
          "line": 20,
          "match": "pub(crate) fn character_body(config: &PrototypeConfig) -> impl Bundle {\r\n    (\r\n        RigidBody::Dynamic,\r\n        character_collider(config),\r\n        Mass(config.character_mass),\r\n        LockedAxes::ROTATION_LOCKED,\r\n        // 人物的刹车由运动控制力表达，低摩擦避免贴墙时被摩擦卡住。\r\n        Friction::new(0.0).with_combine_rule(CoefficientCombine::Min),\r\n        Restitution::new(0.0),\r\n        CollisionLayers::new(GamePhysicsLayer::Character, LayerMask::ALL),\r\n        CollisionEventsEnabled,\r\n        // Avian 按每步位移与身体最薄尺寸的比例自动启用非线性扫掠。\r\n        // 半厚度门槛避免普通步行逐帧扫掠建筑网格；保留对动态箱体的高速碰撞保护。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        SpeculativeCcd::default(),\r\n        TranslationInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 character_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "avian3d::collision::collision_events::CollisionEventsEnabled",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((character_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/character/body.rs",
          "line": 20,
          "match": "pub(crate) fn character_body(config: &PrototypeConfig) -> impl Bundle {\r\n    (\r\n        RigidBody::Dynamic,\r\n        character_collider(config),\r\n        Mass(config.character_mass),\r\n        LockedAxes::ROTATION_LOCKED,\r\n        // 人物的刹车由运动控制力表达，低摩擦避免贴墙时被摩擦卡住。\r\n        Friction::new(0.0).with_combine_rule(CoefficientCombine::Min),\r\n        Restitution::new(0.0),\r\n        CollisionLayers::new(GamePhysicsLayer::Character, LayerMask::ALL),\r\n        CollisionEventsEnabled,\r\n        // Avian 按每步位移与身体最薄尺寸的比例自动启用非线性扫掠。\r\n        // 半厚度门槛避免普通步行逐帧扫掠建筑网格；保留对动态箱体的高速碰撞保护。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        SpeculativeCcd::default(),\r\n        TranslationInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 character_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::ccd::SweptCcd",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((character_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/character/body.rs",
          "line": 20,
          "match": "pub(crate) fn character_body(config: &PrototypeConfig) -> impl Bundle {\r\n    (\r\n        RigidBody::Dynamic,\r\n        character_collider(config),\r\n        Mass(config.character_mass),\r\n        LockedAxes::ROTATION_LOCKED,\r\n        // 人物的刹车由运动控制力表达，低摩擦避免贴墙时被摩擦卡住。\r\n        Friction::new(0.0).with_combine_rule(CoefficientCombine::Min),\r\n        Restitution::new(0.0),\r\n        CollisionLayers::new(GamePhysicsLayer::Character, LayerMask::ALL),\r\n        CollisionEventsEnabled,\r\n        // Avian 按每步位移与身体最薄尺寸的比例自动启用非线性扫掠。\r\n        // 半厚度门槛避免普通步行逐帧扫掠建筑网格；保留对动态箱体的高速碰撞保护。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        SpeculativeCcd::default(),\r\n        TranslationInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 character_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::ccd::SpeculativeCcd",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((character_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/character/body.rs",
          "line": 20,
          "match": "pub(crate) fn character_body(config: &PrototypeConfig) -> impl Bundle {\r\n    (\r\n        RigidBody::Dynamic,\r\n        character_collider(config),\r\n        Mass(config.character_mass),\r\n        LockedAxes::ROTATION_LOCKED,\r\n        // 人物的刹车由运动控制力表达，低摩擦避免贴墙时被摩擦卡住。\r\n        Friction::new(0.0).with_combine_rule(CoefficientCombine::Min),\r\n        Restitution::new(0.0),\r\n        CollisionLayers::new(GamePhysicsLayer::Character, LayerMask::ALL),\r\n        CollisionEventsEnabled,\r\n        // Avian 按每步位移与身体最薄尺寸的比例自动启用非线性扫掠。\r\n        // 半厚度门槛避免普通步行逐帧扫掠建筑网格；保留对动态箱体的高速碰撞保护。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        SpeculativeCcd::default(),\r\n        TranslationInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 character_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "bevy_transform_interpolation::interpolation::TranslationInterpolation",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert((character_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/character/body.rs",
          "line": 20,
          "match": "pub(crate) fn character_body(config: &PrototypeConfig) -> impl Bundle {\r\n    (\r\n        RigidBody::Dynamic,\r\n        character_collider(config),\r\n        Mass(config.character_mass),\r\n        LockedAxes::ROTATION_LOCKED,\r\n        // 人物的刹车由运动控制力表达，低摩擦避免贴墙时被摩擦卡住。\r\n        Friction::new(0.0).with_combine_rule(CoefficientCombine::Min),\r\n        Restitution::new(0.0),\r\n        CollisionLayers::new(GamePhysicsLayer::Character, LayerMask::ALL),\r\n        CollisionEventsEnabled,\r\n        // Avian 按每步位移与身体最薄尺寸的比例自动启用非线性扫掠。\r\n        // 半厚度门槛避免普通步行逐帧扫掠建筑网格；保留对动态箱体的高速碰撞保护。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        SpeculativeCcd::default(),\r\n        TranslationInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 character_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "RigidBody",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "entity.insert((parcel_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/item_interaction/body.rs",
          "line": 8,
          "match": "pub(crate) fn parcel_body(config: &PrototypeConfig) -> impl Bundle {\r\n    let size = 2.0 * config.parcel_half_height;\r\n    (\r\n        RigidBody::Dynamic,\r\n        Collider::cuboid(size, size, size),\r\n        Mass(config.parcel_mass),\r\n        Friction::new(0.65),\r\n        Restitution::new(0.08),\r\n        AngularDamping(0.15),\r\n        parcel_collision_layers(),\r\n        CollisionEventsEnabled,\r\n        // 默认只扫静态与运动学刚体，箱体仍需防止高速穿过人物或其他动态箱体。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        // 相向高速物体的路径可能只在中途交会，预测邻域必须覆盖双方的单步位移。\r\n        SpeculativeCcd::default(),\r\n        TransformInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 parcel_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "Collider",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "entity.insert((parcel_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/item_interaction/body.rs",
          "line": 8,
          "match": "pub(crate) fn parcel_body(config: &PrototypeConfig) -> impl Bundle {\r\n    let size = 2.0 * config.parcel_half_height;\r\n    (\r\n        RigidBody::Dynamic,\r\n        Collider::cuboid(size, size, size),\r\n        Mass(config.parcel_mass),\r\n        Friction::new(0.65),\r\n        Restitution::new(0.08),\r\n        AngularDamping(0.15),\r\n        parcel_collision_layers(),\r\n        CollisionEventsEnabled,\r\n        // 默认只扫静态与运动学刚体，箱体仍需防止高速穿过人物或其他动态箱体。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        // 相向高速物体的路径可能只在中途交会，预测邻域必须覆盖双方的单步位移。\r\n        SpeculativeCcd::default(),\r\n        TransformInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 parcel_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::rigid_body::mass_properties::components::Mass",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "entity.insert((parcel_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/item_interaction/body.rs",
          "line": 8,
          "match": "pub(crate) fn parcel_body(config: &PrototypeConfig) -> impl Bundle {\r\n    let size = 2.0 * config.parcel_half_height;\r\n    (\r\n        RigidBody::Dynamic,\r\n        Collider::cuboid(size, size, size),\r\n        Mass(config.parcel_mass),\r\n        Friction::new(0.65),\r\n        Restitution::new(0.08),\r\n        AngularDamping(0.15),\r\n        parcel_collision_layers(),\r\n        CollisionEventsEnabled,\r\n        // 默认只扫静态与运动学刚体，箱体仍需防止高速穿过人物或其他动态箱体。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        // 相向高速物体的路径可能只在中途交会，预测邻域必须覆盖双方的单步位移。\r\n        SpeculativeCcd::default(),\r\n        TransformInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 parcel_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::rigid_body::physics_material::Friction",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "entity.insert((parcel_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/item_interaction/body.rs",
          "line": 8,
          "match": "pub(crate) fn parcel_body(config: &PrototypeConfig) -> impl Bundle {\r\n    let size = 2.0 * config.parcel_half_height;\r\n    (\r\n        RigidBody::Dynamic,\r\n        Collider::cuboid(size, size, size),\r\n        Mass(config.parcel_mass),\r\n        Friction::new(0.65),\r\n        Restitution::new(0.08),\r\n        AngularDamping(0.15),\r\n        parcel_collision_layers(),\r\n        CollisionEventsEnabled,\r\n        // 默认只扫静态与运动学刚体，箱体仍需防止高速穿过人物或其他动态箱体。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        // 相向高速物体的路径可能只在中途交会，预测邻域必须覆盖双方的单步位移。\r\n        SpeculativeCcd::default(),\r\n        TransformInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 parcel_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::rigid_body::physics_material::Restitution",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "entity.insert((parcel_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/item_interaction/body.rs",
          "line": 8,
          "match": "pub(crate) fn parcel_body(config: &PrototypeConfig) -> impl Bundle {\r\n    let size = 2.0 * config.parcel_half_height;\r\n    (\r\n        RigidBody::Dynamic,\r\n        Collider::cuboid(size, size, size),\r\n        Mass(config.parcel_mass),\r\n        Friction::new(0.65),\r\n        Restitution::new(0.08),\r\n        AngularDamping(0.15),\r\n        parcel_collision_layers(),\r\n        CollisionEventsEnabled,\r\n        // 默认只扫静态与运动学刚体，箱体仍需防止高速穿过人物或其他动态箱体。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        // 相向高速物体的路径可能只在中途交会，预测邻域必须覆盖双方的单步位移。\r\n        SpeculativeCcd::default(),\r\n        TransformInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 parcel_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::rigid_body::AngularDamping",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "entity.insert((parcel_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/item_interaction/body.rs",
          "line": 8,
          "match": "pub(crate) fn parcel_body(config: &PrototypeConfig) -> impl Bundle {\r\n    let size = 2.0 * config.parcel_half_height;\r\n    (\r\n        RigidBody::Dynamic,\r\n        Collider::cuboid(size, size, size),\r\n        Mass(config.parcel_mass),\r\n        Friction::new(0.65),\r\n        Restitution::new(0.08),\r\n        AngularDamping(0.15),\r\n        parcel_collision_layers(),\r\n        CollisionEventsEnabled,\r\n        // 默认只扫静态与运动学刚体，箱体仍需防止高速穿过人物或其他动态箱体。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        // 相向高速物体的路径可能只在中途交会，预测邻域必须覆盖双方的单步位移。\r\n        SpeculativeCcd::default(),\r\n        TransformInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 parcel_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "avian3d::collision::collider::layers::CollisionLayers",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "entity.insert((parcel_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/item_interaction/body.rs",
          "line": 8,
          "match": "pub(crate) fn parcel_body(config: &PrototypeConfig) -> impl Bundle {\r\n    let size = 2.0 * config.parcel_half_height;\r\n    (\r\n        RigidBody::Dynamic,\r\n        Collider::cuboid(size, size, size),\r\n        Mass(config.parcel_mass),\r\n        Friction::new(0.65),\r\n        Restitution::new(0.08),\r\n        AngularDamping(0.15),\r\n        parcel_collision_layers(),\r\n        CollisionEventsEnabled,\r\n        // 默认只扫静态与运动学刚体，箱体仍需防止高速穿过人物或其他动态箱体。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        // 相向高速物体的路径可能只在中途交会，预测邻域必须覆盖双方的单步位移。\r\n        SpeculativeCcd::default(),\r\n        TransformInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 parcel_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "avian3d::collision::collision_events::CollisionEventsEnabled",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "entity.insert((parcel_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/item_interaction/body.rs",
          "line": 8,
          "match": "pub(crate) fn parcel_body(config: &PrototypeConfig) -> impl Bundle {\r\n    let size = 2.0 * config.parcel_half_height;\r\n    (\r\n        RigidBody::Dynamic,\r\n        Collider::cuboid(size, size, size),\r\n        Mass(config.parcel_mass),\r\n        Friction::new(0.65),\r\n        Restitution::new(0.08),\r\n        AngularDamping(0.15),\r\n        parcel_collision_layers(),\r\n        CollisionEventsEnabled,\r\n        // 默认只扫静态与运动学刚体，箱体仍需防止高速穿过人物或其他动态箱体。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        // 相向高速物体的路径可能只在中途交会，预测邻域必须覆盖双方的单步位移。\r\n        SpeculativeCcd::default(),\r\n        TransformInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 parcel_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::ccd::SweptCcd",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "entity.insert((parcel_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/item_interaction/body.rs",
          "line": 8,
          "match": "pub(crate) fn parcel_body(config: &PrototypeConfig) -> impl Bundle {\r\n    let size = 2.0 * config.parcel_half_height;\r\n    (\r\n        RigidBody::Dynamic,\r\n        Collider::cuboid(size, size, size),\r\n        Mass(config.parcel_mass),\r\n        Friction::new(0.65),\r\n        Restitution::new(0.08),\r\n        AngularDamping(0.15),\r\n        parcel_collision_layers(),\r\n        CollisionEventsEnabled,\r\n        // 默认只扫静态与运动学刚体，箱体仍需防止高速穿过人物或其他动态箱体。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        // 相向高速物体的路径可能只在中途交会，预测邻域必须覆盖双方的单步位移。\r\n        SpeculativeCcd::default(),\r\n        TransformInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 parcel_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "avian3d::dynamics::ccd::SpeculativeCcd",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "entity.insert((parcel_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/item_interaction/body.rs",
          "line": 8,
          "match": "pub(crate) fn parcel_body(config: &PrototypeConfig) -> impl Bundle {\r\n    let size = 2.0 * config.parcel_half_height;\r\n    (\r\n        RigidBody::Dynamic,\r\n        Collider::cuboid(size, size, size),\r\n        Mass(config.parcel_mass),\r\n        Friction::new(0.65),\r\n        Restitution::new(0.08),\r\n        AngularDamping(0.15),\r\n        parcel_collision_layers(),\r\n        CollisionEventsEnabled,\r\n        // 默认只扫静态与运动学刚体，箱体仍需防止高速穿过人物或其他动态箱体。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        // 相向高速物体的路径可能只在中途交会，预测邻域必须覆盖双方的单步位移。\r\n        SpeculativeCcd::default(),\r\n        TransformInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 parcel_body 返回元组统一装配身体物理组件。"
    },
    {
      "kind": "Component",
      "type": "bevy_transform_interpolation::interpolation::TransformInterpolation",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "entity.insert((parcel_body(&config), DespawnOnExit(AppState::InGame)))",
      "proofs": [
        {
          "path": "src/item_interaction/body.rs",
          "line": 8,
          "match": "pub(crate) fn parcel_body(config: &PrototypeConfig) -> impl Bundle {\r\n    let size = 2.0 * config.parcel_half_height;\r\n    (\r\n        RigidBody::Dynamic,\r\n        Collider::cuboid(size, size, size),\r\n        Mass(config.parcel_mass),\r\n        Friction::new(0.65),\r\n        Restitution::new(0.08),\r\n        AngularDamping(0.15),\r\n        parcel_collision_layers(),\r\n        CollisionEventsEnabled,\r\n        // 默认只扫静态与运动学刚体，箱体仍需防止高速穿过人物或其他动态箱体。\r\n        SweptCcd::default().with_filter(CcdFilter::ALL),\r\n        // 相向高速物体的路径可能只在中途交会，预测邻域必须覆盖双方的单步位移。\r\n        SpeculativeCcd::default(),\r\n        TransformInterpolation,\r\n    )\r\n}\r\n"
        }
      ],
      "condition": "岛屿就绪后使用已核实的 parcel_body 返回元组统一装配身体物理组件。"
    }
  ],
  "demo::scene_assembly::loading::prepare_island": [
    {
      "kind": "Component",
      "type": "DisplayNpc",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": "commands.entity(entity).insert(DisplayNpc)"
    },
    {
      "kind": "Component",
      "type": "IslandPending",
      "operation": "remove",
      "via": "commands",
      "method": "remove",
      "match": ".remove::<IslandPending>()"
    },
    {
      "kind": "Component",
      "type": "IslandReady",
      "operation": "insert",
      "via": "commands",
      "method": "insert",
      "match": ".insert(IslandReady { player, items })"
    },
    {
      "kind": "Component",
      "type": "Name",
      "operation": "insert",
      "via": "commands",
      "method": "spawn_scene",
      "match": "commands.spawn_scene(bsn! {\n                name\n                IslandCollider",
      "condition": "已从地图元数据与实际网格成功构造静态碰撞体，按父实体附加碰撞子实体。"
    },
    {
      "kind": "Component",
      "type": "IslandCollider",
      "operation": "insert",
      "via": "commands",
      "method": "spawn_scene",
      "match": "commands.spawn_scene(bsn! {\n                name\n                IslandCollider",
      "condition": "已从地图元数据与实际网格成功构造静态碰撞体，按父实体附加碰撞子实体。"
    },
    {
      "kind": "Component",
      "type": "RigidBody",
      "operation": "insert",
      "via": "commands",
      "method": "spawn_scene",
      "match": "commands.spawn_scene(bsn! {\n                name\n                IslandCollider",
      "condition": "已从地图元数据与实际网格成功构造静态碰撞体，按父实体附加碰撞子实体。"
    },
    {
      "kind": "Component",
      "type": "Collider",
      "operation": "insert",
      "via": "commands",
      "method": "spawn_scene",
      "match": "commands.spawn_scene(bsn! {\n                name\n                IslandCollider",
      "condition": "已从地图元数据与实际网格成功构造静态碰撞体，按父实体附加碰撞子实体。"
    },
    {
      "kind": "Component",
      "type": "avian3d::collision::collider::layers::CollisionLayers",
      "operation": "insert",
      "via": "commands",
      "method": "spawn_scene",
      "match": "commands.spawn_scene(bsn! {\n                name\n                IslandCollider",
      "condition": "已从地图元数据与实际网格成功构造静态碰撞体，按父实体附加碰撞子实体。"
    },
    {
      "kind": "Component",
      "type": "ChildOf",
      "operation": "insert",
      "via": "commands",
      "method": "spawn_scene",
      "match": "commands.spawn_scene(bsn! {\n                name\n                IslandCollider",
      "condition": "已从地图元数据与实际网格成功构造静态碰撞体，按父实体附加碰撞子实体。"
    },
    {
      "kind": "Component",
      "type": "Name",
      "operation": "insert",
      "via": "commands",
      "method": "spawn_scene",
      "match": ".spawn_scene(bsn! {\n                    Name(\"Display NPC collider\")",
      "condition": "地图展示 NPC 使用胶囊碰撞子实体，保持模型原点及层级清理。"
    },
    {
      "kind": "Component",
      "type": "IslandCollider",
      "operation": "insert",
      "via": "commands",
      "method": "spawn_scene",
      "match": ".spawn_scene(bsn! {\n                    Name(\"Display NPC collider\")",
      "condition": "地图展示 NPC 使用胶囊碰撞子实体，保持模型原点及层级清理。"
    },
    {
      "kind": "Component",
      "type": "Transform",
      "operation": "insert",
      "via": "commands",
      "method": "spawn_scene",
      "match": ".spawn_scene(bsn! {\n                    Name(\"Display NPC collider\")",
      "condition": "地图展示 NPC 使用胶囊碰撞子实体，保持模型原点及层级清理。"
    },
    {
      "kind": "Component",
      "type": "RigidBody",
      "operation": "insert",
      "via": "commands",
      "method": "spawn_scene",
      "match": ".spawn_scene(bsn! {\n                    Name(\"Display NPC collider\")",
      "condition": "地图展示 NPC 使用胶囊碰撞子实体，保持模型原点及层级清理。"
    },
    {
      "kind": "Component",
      "type": "Collider",
      "operation": "insert",
      "via": "commands",
      "method": "spawn_scene",
      "match": ".spawn_scene(bsn! {\n                    Name(\"Display NPC collider\")",
      "condition": "地图展示 NPC 使用胶囊碰撞子实体，保持模型原点及层级清理。"
    },
    {
      "kind": "Component",
      "type": "avian3d::collision::collider::layers::CollisionLayers",
      "operation": "insert",
      "via": "commands",
      "method": "spawn_scene",
      "match": ".spawn_scene(bsn! {\n                    Name(\"Display NPC collider\")",
      "condition": "地图展示 NPC 使用胶囊碰撞子实体，保持模型原点及层级清理。"
    },
    {
      "kind": "Component",
      "type": "ChildOf",
      "operation": "insert",
      "via": "commands",
      "method": "spawn_scene",
      "match": ".spawn_scene(bsn! {\n                    Name(\"Display NPC collider\")",
      "condition": "地图展示 NPC 使用胶囊碰撞子实体，保持模型原点及层级清理。"
    }
  ],
  "bevy_app::terminal_ctrl_c_handler::TerminalCtrlCHandlerPlugin::exit_on_flag": [
    {
      "kind": "Messages<T>",
      "type": "Messages<AppExit>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "app_exit_writer.write(AppExit::from_code(Self::EXIT_CODE))",
      "condition": "终端信号标志要求退出时。"
    }
  ],
  "bevy_input::gamepad::gamepad_event_processing_system": [
    {
      "kind": "Messages<T>",
      "type": "Messages<GamepadEvent>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "processed_events.write(GamepadEvent::from(send_event.clone()))"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<GamepadEvent>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "processed_events.write(GamepadEvent::from(send_event))",
      "allMatches": true
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<GamepadAxisChangedEvent>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "processed_axis_events.write(send_event)"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<GamepadButtonStateChangedEvent>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "processed_digital_events.write(GamepadButtonStateChangedEvent::new(",
      "allMatches": true
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<GamepadButtonChangedEvent>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "processed_analog_events.write(send_event)"
    }
  ],
  "bevy_picking::input::mouse_pick_events": [
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerInput>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "pointer_inputs.write(PointerInput::new(",
      "allMatches": true
    }
  ],
  "bevy_picking::window::update_window_hits": [
    {
      "kind": "Messages<T>",
      "type": "Messages<PointerHits>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "pointer_hits_writer.write(PointerHits::new(",
      "condition": "指针可解析到窗口目标时以最低优先级报告窗口命中。"
    }
  ],
  "bevy_window::system::exit_on_all_closed": [
    {
      "kind": "Messages<T>",
      "type": "Messages<AppExit>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "app_exit_writer.write(AppExit::Success)",
      "condition": "查询中已经没有 Window 组件。"
    }
  ],
  "bevy_winit::accessibility::poll_receivers": [
    {
      "kind": "Messages<T>",
      "type": "Messages<ActionRequestWrapper>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "actions.write(ActionRequestWrapper(event))",
      "condition": "窗口无障碍请求队列有待处理操作。"
    }
  ],
  "bevy_winit::system::check_keyboard_focus_lost": [
    {
      "kind": "Messages<T>",
      "type": "Messages<KeyboardFocusLost>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "keyboard_focus_lost_writer.write(KeyboardFocusLost)",
      "condition": "本帧存在窗口失焦且没有窗口获得焦点。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<KeyboardInput>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "keyboard_input_writer.write(event)",
      "condition": "本帧失焦且没有新焦点，为该窗口记录的按键生成释放。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<WindowEvent>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "window_event_writer.write(WindowEvent::KeyboardFocusLost(KeyboardFocusLost))"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<WindowEvent>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "window_event_writer.write(WindowEvent::KeyboardInput(event.clone()))"
    }
  ],
  "bevy_winit::system::despawn_windows": [
    {
      "kind": "Messages<T>",
      "type": "Messages<WindowClosing>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "closing_event_writer.write(WindowClosing { window })",
      "allMatches": true,
      "condition": "窗口已标记关闭，或应用准备退出时通知渲染端。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<WindowClosed>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "closed_event_writer.write(WindowClosed { window })",
      "condition": "移除事件对应的实体确实已不含 Window，清理窗口后端后发送。"
    }
  ],
  "demo::ui::pointer::pointer_interaction": [
    {
      "kind": "Messages<T>",
      "type": "Messages<UiRequest>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "requests.write(UiRequest(button.action))",
      "condition": "主键点击命中当前页面按钮且动作不是无效 Adjust。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<SoundRequest>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "sounds.write(SoundRequest::new(SoundCue::MenuHover, entity))",
      "condition": "真实指针移动进入新的已存在按钮，排除点击和初次构建导致的伪悬停。"
    }
  ],
  "demo::ui::requests::handle_requests": [
    {
      "kind": "Messages<T>",
      "type": "Messages<AppExit>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "exits.write(AppExit::Success)",
      "condition": "主菜单接受 Quit 请求。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<SoundRequest>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "sounds.write(SoundRequest::new(SoundCue::ParcelPickup, source))",
      "condition": "音频设置页接受 TestSfx 且能解析菜单控制者。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<SoundRequest>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "sounds.write(SoundRequest::new(cue, source))",
      "condition": "菜单语义请求真正被接受后反馈一次提示音。"
    }
  ],
  "demo::ui::volume::sample_slider_pointer": [
    {
      "kind": "Messages<T>",
      "type": "Messages<UiRequest>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "requests.write(UiRequest(UiAction::FinishVolumeEdit))",
      "allMatches": true,
      "condition": "滑条捕获因窗口失效、实体重建、释放、离窗或失焦而结束。"
    },
    {
      "kind": "Messages<T>",
      "type": "Messages<UiRequest>",
      "operation": "publish",
      "via": "message_writer",
      "method": "write",
      "match": "requests.write(UiRequest(UiAction::SetVolume(slider.key, value)))",
      "condition": "音频设置页有效捕获中的滑条坐标换算出不同音量值。"
    }
  ]
};
export const CORE_SCHEDULE_BODY_GAPS = {
  "bevy_animation::animate_targets": [
    "函数体通过 TimedAnimationEvent 中的动态 event.trigger 回调触发事件，具体事件类型由动画资产决定；不能静态展开为某个固定 EntityEvent。AnimationEvaluationState.commit_all 写入的属性类型由动态曲线决定。"
  ],
  "bevy_animation::trigger_untargeted_animation_events": [
    "函数体调用动画资产中的动态 event.trigger 回调，具体事件类型由 TimedAnimationEvent 决定，未补造固定事件类型或 Observer 关系。"
  ],
  "bevy_enhanced_input::context::trigger": [
    "ActionFns.trigger 回调按动作实体的运行时类型触发事件；本目录不把动态动作事件推断为固定类型。"
  ],
  "bevy_gilrs::gilrs_system::gilrs_event_startup_system": [
    "commands.spawn_empty() 为设备分配空实体，未由此调用插入具名组件；Gamepad 组件由后续连接消息系统装配。"
  ],
  "bevy_gilrs::gilrs_system::gilrs_event_system": [
    "设备连接分支调用 commands.spawn_empty() 分配空实体，未由该调用插入具名组件；连接消息的 Gamepad 装配在后续系统中。"
  ],
  "bevy_picking::input::deactivate_touch_pointers": [
    "触摸结束或取消后按 PointerId 查到实体并调用 despawn；销毁会移除实体上的动态组件集合，不能伪装为固定组件的显式 remove。"
  ],
  "bevy_window::system::close_when_requested": [
    "上一帧带 ClosingWindow 的窗口实体由 commands.entity(window).despawn() 销毁；此操作不能精确展开为窗口实体动态组件的固定 remove 边。"
  ],
  "bevy_inspector_egui::quick::world_inspector_ui": [
    "bevy_inspector::ui_for_world(world, ui) 通过反射检查运行时实体、资源和资产；开放编辑的数据类型由当前 World 决定，未补造固定类型的实际修改边。"
  ],
  "bevy_scene::spawn::spawn_queued": [
    "resolved.apply、list_patch.spawn_with/spawn 及 queued.spawn_queued 依据已解析场景资产的动态 Bundle 装配实体；函数体不包含这些组件的固定声明清单，未按资产内容猜测类型。"
  ],
  "bevy_world_serialization::world_asset_spawner::world_instance_spawner_system": [
    "WorldInstanceSpawner 的 spawn/update/despawn helper 根据 WorldAsset 或 DynamicWorld 中的动态反射类型清单装配和更新实体，未将未知资产内容展开为固定组件操作；trigger_instance_ready_events 的内部事件触发尚未展开。"
  ],
  "demo::scene_assembly::actors::spawn_actors": [
    "courier_scene/carryable_scene 与 spawn_keyboard_controller 返回的 BSN/控制器结构由各自 helper 装配；此目录已核实角色/物品物理 Bundle 及本体显式插入，尚未把这些嵌套场景和控制器 helper 的所有子实体组件展开为直接操作。"
  ],
  "demo::scene_assembly::loading::prepare_island": [
    "替换导入占位角色和物品时调用 commands.entity(entity).despawn()；其原始 GLB 实例含动态组件集合，未把销毁伪装为固定组件移除。"
  ]
};
