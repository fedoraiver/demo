// 仅收录已核对的显式 ECS 操作；借用与插入、移除分别记录。
export const PHYSICS_SCHEDULE_BODY_OPERATIONS = {
  'avian3d::collision::collider::backend::init_collider_constructor_hierarchies': [
    { kind: 'Component', type: 'Collider', operation: 'insert', via: 'commands', method: 'insert', match: 'commands.entity(child_entity).insert((', evidenceMatch: 'Collider::try_from_constructor(constructor.clone(), None)', condition: '子实体构造器成功生成碰撞体时，与配置碰撞层、密度一同插入。' },
    { kind: 'Component', type: 'CollisionLayers', operation: 'insert', via: 'commands', method: 'insert', match: 'commands.entity(child_entity).insert((', evidenceMatch: 'collider_constructor_hierarchy.default_layers', condition: '成功构造碰撞体时，使用子项覆盖值或层级默认碰撞层。' },
    { kind: 'Component', type: 'ColliderDensity', operation: 'insert', via: 'commands', method: 'insert', match: 'commands.entity(child_entity).insert((', evidenceMatch: 'collider_constructor_hierarchy.default_density', condition: '成功构造碰撞体时，使用子项覆盖值或层级默认密度。' },
    { kind: 'Component', type: 'ColliderConstructorHierarchy', operation: 'remove', via: 'commands', method: 'remove', match: '.remove::<ColliderConstructorHierarchy>()', condition: '完成根实体的所有子项尝试后移除一次性层级构造器。' },
    { kind: 'EntityEvent', type: 'ColliderConstructorHierarchyReady', operation: 'trigger', via: 'commands', method: 'trigger', match: 'commands.trigger(ColliderConstructorHierarchyReady {', condition: '完成根实体的层级构造尝试后触发就绪事件。' },
  ],
  'avian3d::collision::collider::backend::init_collider_constructors': [
    { kind: 'Component', type: 'Collider', operation: 'insert', via: 'commands', method: 'insert', match: 'commands.entity(entity).insert(collider)', evidenceMatch: 'Collider::try_from_constructor(constructor.clone(), None)', condition: '实体原本没有碰撞体且构造成功。' },
    { kind: 'Component', type: 'ColliderConstructor', operation: 'remove', via: 'commands', method: 'remove', match: 'commands.entity(entity).remove::<ColliderConstructor>()', allMatches: true, condition: '已存在碰撞体而跳过，或本次构造尝试完成后移除一次性构造器。' },
    { kind: 'EntityEvent', type: 'ColliderConstructorReady', operation: 'trigger', via: 'commands', method: 'trigger', match: 'commands.trigger(ColliderConstructorReady { entity })', condition: '新碰撞体构造成功。' },
  ],
  'avian3d::collision::narrow_phase::trigger_collision_events': [
    { kind: 'EntityEvent', type: 'CollisionStart', operation: 'trigger', via: 'world', method: 'trigger', match: 'started.drain(..).for_each(|event| {\n        world.trigger(event);', evidenceMatch: 'mut started: Local<Vec<CollisionStart>>', condition: '碰撞开始消息中启用了事件的碰撞体一侧，排空开始事件缓冲并直接触发。' },
    { kind: 'EntityEvent', type: 'CollisionEnd', operation: 'trigger', via: 'world', method: 'trigger', match: 'ended.drain(..).for_each(|event| {\n        world.trigger(event);', evidenceMatch: 'mut ended: Local<Vec<CollisionEnd>>', condition: '碰撞结束消息中启用了事件的碰撞体一侧，排空结束事件缓冲并直接触发。' },
  ],
  'avian3d::dynamics::joints::joint_graph::plugin::on_change_joint_entities': [
    { kind: 'Messages<T>', type: 'Messages<JointGraphChange>', operation: 'publish', via: 'message_writer', method: 'write', match: 'joint_graph_changes.write(JointGraphChange::Removed(old_id))', condition: '已登记关节的关联刚体发生变化，旧边已从关节图移除。' },
    { kind: 'Messages<T>', type: 'Messages<JointGraphChange>', operation: 'publish', via: 'message_writer', method: 'write', match: 'joint_graph_changes.write(JointGraphChange::Added(joint_id))', condition: '已把修改后的关节边重新加入关节图。' },
    { kind: 'Component', type: 'XpbdVelocityProjection', operation: 'insert', via: 'commands', method: 'try_insert', match: 'commands.entity(body).try_insert(XpbdVelocityProjection)', condition: '启用 xpbd_joints，关节两端实体发生变化后为新刚体添加速度投影标记。' },
    { kind: 'Component', type: 'XpbdVelocityProjection', operation: 'remove', via: 'commands', method: 'try_remove', match: 'commands.entity(body).try_remove::<XpbdVelocityProjection>()', condition: '启用 xpbd_joints，旧刚体已没有其他关节。' },
  ],
  'avian3d::dynamics::rigid_body::mass_properties::queue_mass_recomputation_on_collider_mass_change': [
    { kind: 'Component', type: 'RecomputeMassProperties', operation: 'insert', via: 'commands', method: 'insert', match: 'entity_commands.insert(RecomputeMassProperties)', condition: '碰撞体质量、局部变换或质量属性变化且所属刚体仍存在。' },
  ],
  'avian3d::dynamics::rigid_body::mass_properties::queue_mass_recomputation_on_mass_change': [
    { kind: 'Component', type: 'RecomputeMassProperties', operation: 'insert', via: 'commands', method: 'insert', match: 'commands.entity(entity).insert(RecomputeMassProperties)', condition: '独立刚体的质量属性发生变化。' },
  ],
  'avian3d::dynamics::rigid_body::mass_properties::update_mass_properties': [
    { kind: 'Component', type: 'RecomputeMassProperties', operation: 'remove', via: 'commands', method: 'remove', match: 'commands.entity(entity).remove::<RecomputeMassProperties>()', condition: '对标记实体调用质量属性重算后移除待重算标记。' },
  ],
  'avian3d::dynamics::solver::schedule::run_substep_schedule': [
    { kind: 'Resource', type: 'Time<Physics>', operation: 'read', via: 'world', method: 'resource', match: 'world.resource::<Time<Physics>>()', allMatches: true },
    { kind: 'Resource', type: 'SubstepCount', operation: 'read', via: 'world', method: 'resource', match: 'world.resource::<SubstepCount>()' },
    { kind: 'Resource', type: 'Time<Substeps>', operation: 'read', via: 'world', method: 'resource', match: 'world.resource::<Time<Substeps>>()' },
    { kind: 'Resource', type: 'Time<Substeps>', operation: 'mutable_access', via: 'world', method: 'resource_mut', match: 'world.resource_mut::<Time<Substeps>>()' },
    { kind: 'Resource', type: 'Time', operation: 'mutable_access', via: 'world', method: 'resource_mut', match: 'world.resource_mut::<Time>()', allMatches: true, condition: '每次子步前切换通用时钟，所有子步完成后恢复物理时钟。' },
  ],
  'avian3d::schedule::run_physics_schedule': [
    { kind: 'Resource', type: 'Time<Physics>', operation: 'read', via: 'world', method: 'resource', match: 'world.resource::<Time<Physics>>()', allMatches: true },
    { kind: 'Resource', type: 'Time', operation: 'read', via: 'world', method: 'resource', match: 'world.resource::<Time>()', allMatches: true },
    { kind: 'Resource', type: 'Time<Physics>', operation: 'mutable_access', via: 'world', method: 'resource_mut', match: '.resource_mut::<Time<Physics>>()', allMatches: true },
    { kind: 'Resource', type: 'Time<Substeps>', operation: 'mutable_access', via: 'world', method: 'resource_mut', match: 'world.resource_mut::<Time<Substeps>>()', condition: '物理未暂停时预推进子步时钟。' },
    { kind: 'Resource', type: 'SubstepCount', operation: 'read', via: 'world', method: 'resource', match: 'world.resource::<SubstepCount>()', condition: '物理未暂停时计算子步步长。' },
    { kind: 'Resource', type: 'Time', operation: 'mutable_access', via: 'world', method: 'resource_mut', match: 'world.resource_mut::<Time>()', allMatches: true, condition: '运行物理调度前换入物理时钟，完成后恢复原通用时钟。' },
  ],
  'bevy_ui::accessibility::button_changed': [
    { kind: 'Component', type: 'AccessibilityNode', operation: 'insert', via: 'commands', method: 'try_insert', match: '.try_insert(AccessibilityNode::from(node))', condition: 'Button 变化且实体尚无无障碍节点。' },
  ],
  'bevy_ui::accessibility::image_changed': [
    { kind: 'Component', type: 'AccessibilityNode', operation: 'insert', via: 'commands', method: 'try_insert', match: '.try_insert(AccessibilityNode::from(node))', condition: '非按钮 ImageNode 变化且实体尚无无障碍节点。' },
  ],
  'bevy_ui::accessibility::label_changed': [
    { kind: 'Component', type: 'AccessibilityNode', operation: 'insert', via: 'commands', method: 'try_insert', match: '.try_insert(AccessibilityNode::from(node))', condition: 'Label 变化且实体尚无无障碍节点。' },
  ],
  'bevy_ui::update::propagate_ui_target_cameras': [
    { kind: 'Component', type: 'Propagate<ComputedUiTargetCamera>', operation: 'remove', via: 'commands', method: 'remove', match: '.remove::<(\n                Propagate<ComputedUiTargetCamera>,', condition: '实体已有 UI 父节点，不应继续作为相机传播根。' },
    { kind: 'Component', type: 'Propagate<ComputedUiRenderTargetInfo>', operation: 'remove', via: 'commands', method: 'remove', match: '.remove::<(\n                Propagate<ComputedUiTargetCamera>,', condition: '实体已有 UI 父节点，不应继续作为目标尺寸传播根。' },
    { kind: 'Component', type: 'Propagate<ComputedUiTargetCamera>', operation: 'insert', via: 'commands', method: 'try_insert', match: '.try_insert(Propagate(ComputedUiTargetCamera { camera }))', condition: 'UI 根节点使用显式或默认相机。' },
    { kind: 'Component', type: 'Propagate<ComputedUiRenderTargetInfo>', operation: 'insert', via: 'commands', method: 'try_insert', match: '.try_insert(Propagate(ComputedUiRenderTargetInfo {', condition: 'UI 根节点使用已解析相机的缩放和物理尺寸，无相机时写默认目标信息。' },
  ],
  'bevy_ui::widget::viewport::viewport_picking': [
    { kind: 'Messages<T>', type: 'bevy_ecs::message::Messages<PointerInput>', operation: 'publish', via: 'commands', method: 'write_message', match: 'commands.write_message(PointerInput {', condition: '视口正在悬停或拖动，并能解析相机和图像目标时转发指针消息。' },
  ],
  'bevy_ui::picking_backend::ui_picking': [
    { kind: 'Messages<T>', type: 'Messages<PointerHits>', operation: 'publish', via: 'message_writer', method: 'write', match: 'output.write(PointerHits::new(*pointer, picks, order))', condition: '按相机与指针汇总经过裁剪、透明性和遮挡规则筛选的 UI 命中。' },
  ],
};
export const PHYSICS_SCHEDULE_BODY_GAPS = {
  'avian3d::dynamics::rigid_body::mass_properties::update_mass_properties': [
    '函数体调用 mass_helper.update_mass_properties(entity)，质量属性更新由 MassPropertyHelper 方法执行；此目录未将其内部条件写入、插入或删除展开为直接操作边，参数声明关系仍保留。',
  ],
};
