//! 原型玩法：玩家与角色分离，固定步模拟移动、跳跃和木箱交互。

use bevy::{ecs::relationship::RelationshipTarget, prelude::*};

/// 独立于运行时实体标识的玩家身份，便于后续多人输入路由。
#[derive(Component, Reflect, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[reflect(Component)]
pub struct PlayerId(pub u64);

/// 控制者当前操作的角色；输入设备和角色状态分别存储。
#[derive(Component, Reflect)]
#[reflect(Component)]
pub struct ControlsCharacter(#[entities] pub Entity);

/// 具有移动和跳跃能力的角色。
#[derive(Component, Reflect)]
#[reflect(Component)]
pub struct Character;

/// 来自控制者的玩法意图；输入状态跨帧保留，供固定步模拟读取。
///
/// PreUpdate 与 FixedUpdate 不一一对应：移动轴持续有效，跳跃和交互请求只消费一次。
/// 输入 Observer 仅更新意图，不按输入事件次数积分位置，避免运动速度依赖渲染帧率。
#[derive(Component, Reflect, Default)]
#[reflect(Component)]
pub struct CharacterIntent {
    /// 角色局部水平输入轴：x 表示左右横移，y 表示前后移动。
    pub movement: Vec2,
    pub jump_pending: bool,
    pub interact_pending: bool,
}

/// 角色的实际运动状态，位置与朝向由 Transform 保存。
#[derive(Component, Reflect, Default)]
#[reflect(Component)]
pub struct CharacterMotion {
    pub horizontal_velocity: Vec3,
    pub vertical_velocity: f32,
    pub grounded: bool,
}

/// 快递身份，当前使用木箱作为占位模型。
#[derive(Component, Reflect)]
#[reflect(Component)]
pub struct Parcel;

/// 允许被拾取的能力标签。
#[derive(Component, Reflect)]
#[reflect(Component)]
pub struct Pickable;

/// 物体的持有者；只由交互系统插入或移除。
#[derive(Component)]
#[relationship(relationship_target = HoldingItems)]
pub struct HeldBy(Entity);

/// Bevy 根据 HeldBy 自动维护的反向索引，业务代码只读取。
#[derive(Component)]
#[relationship_target(relationship = HeldBy)]
pub struct HoldingItems(Vec<Entity>);

/// 原型的运动、平地和持箱参数。
#[derive(Resource, Reflect, Clone, Debug)]
#[reflect(Resource)]
pub struct PrototypeConfig {
    pub move_speed: f32,
    pub jump_speed: f32,
    pub gravity: f32,
    pub pickup_radius: f32,
    pub hold_offset: Vec3,
    pub ground_y: f32,
    pub parcel_half_height: f32,
}

impl Default for PrototypeConfig {
    fn default() -> Self {
        Self {
            move_speed: 4.5,
            jump_speed: 6.0,
            gravity: 18.0,
            pickup_radius: 1.8,
            hold_offset: Vec3::new(0.0, 1.0, -0.9),
            ground_y: 0.0,
            parcel_half_height: 0.3,
        }
    }
}

/// 注册原型的固定步模拟；不依赖窗口或渲染插件。
pub struct GameplayPlugin;

/// 固定步玩法的调度阶段，外部系统可在模拟前同步角色朝向。
#[derive(SystemSet, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum GameplaySystems {
    /// 移动、跳跃、交互和持有物同步共享同一固定步。
    Simulate,
}

impl Plugin for GameplayPlugin {
    fn build(&self, app: &mut App) {
        // 反射元数据让检查器能够读取玩法组件与资源；持有关系仍由 Bevy 关系钩子维护。
        app.register_type::<PlayerId>()
            .register_type::<ControlsCharacter>()
            .register_type::<Character>()
            .register_type::<CharacterIntent>()
            .register_type::<CharacterMotion>()
            .register_type::<Parcel>()
            .register_type::<Pickable>()
            .register_type::<PrototypeConfig>()
            .init_resource::<PrototypeConfig>()
            .add_systems(Startup, log_configuration)
            .add_systems(
                FixedUpdate,
                (
                    move_characters,
                    update_jump_and_gravity,
                    handle_interaction,
                    sync_held_objects,
                )
                    // 拾取命令在跟随系统之前应用，使新关系在同一固定步可见。
                    .chain()
                    .in_set(GameplaySystems::Simulate),
            );
    }
}

fn log_configuration(config: Res<PrototypeConfig>) {
    info!(?config, "Prototype gameplay initialized");
}

/// 将角色局部移动轴转换为世界速度，斜向移动保持与单轴相同的最高速度。
fn move_characters(
    time: Res<Time<Fixed>>,
    config: Res<PrototypeConfig>,
    mut next_velocity_log_time: Local<f64>,
    mut characters: Query<
        (
            Entity,
            &CharacterIntent,
            &mut CharacterMotion,
            &mut Transform,
        ),
        With<Character>,
    >,
) {
    let elapsed = time.elapsed_secs_f64();
    for (entity, intent, mut motion, mut transform) in &mut characters {
        let axes = intent.movement.clamp_length_max(1.0);
        // 朝向在此系统之前由视角系统同步；横移和后退只改变速度，不改变角色朝向。
        let velocity = transform.rotation * Vec3::new(axes.x, 0.0, -axes.y) * config.move_speed;
        if velocity != motion.horizontal_velocity {
            // 连续转向会逐固定步改变速度，调试日志每 0.5 模拟秒最多采样一次；离散输入由输入模块记录。
            if elapsed >= *next_velocity_log_time {
                debug!(
                    ?entity,
                    before = ?motion.horizontal_velocity,
                    after = ?velocity,
                    reason = "movement_or_facing_changed",
                    "Character horizontal velocity changed"
                );
                *next_velocity_log_time = elapsed + 0.5;
            }
            motion.horizontal_velocity = velocity;
        }
        transform.translation += velocity * time.delta_secs();
    }
}

/// 一次性消费跳跃请求，使用固定时间步计算重力并在平地着陆。
fn update_jump_and_gravity(
    time: Res<Time<Fixed>>,
    config: Res<PrototypeConfig>,
    mut characters: Query<
        (
            Entity,
            &mut CharacterIntent,
            &mut CharacterMotion,
            &mut Transform,
        ),
        With<Character>,
    >,
) {
    for (entity, mut intent, mut motion, mut transform) in &mut characters {
        if std::mem::take(&mut intent.jump_pending) {
            if motion.grounded {
                motion.grounded = false;
                motion.vertical_velocity = config.jump_speed;
                info!(
                    ?entity,
                    before = "grounded",
                    after = "airborne",
                    jump_speed = config.jump_speed,
                    reason = "jump_action",
                    "Character jumped"
                );
            } else {
                info!(?entity, reason = "already_airborne", "Jump request ignored");
            }
        }
        if !motion.grounded {
            motion.vertical_velocity -= config.gravity * time.delta_secs();
            transform.translation.y += motion.vertical_velocity * time.delta_secs();
            if transform.translation.y <= config.ground_y {
                let landing_velocity = motion.vertical_velocity;
                transform.translation.y = config.ground_y;
                motion.vertical_velocity = 0.0;
                motion.grounded = true;
                info!(
                    ?entity,
                    before = "airborne",
                    after = "grounded",
                    landing_velocity,
                    reason = "ground_contact",
                    "Character landed"
                );
            }
        }
    }
}

/// 按 E 拿起最近的可拾取物体，已有持有物时将其放在面前的地面上。
fn handle_interaction(
    mut commands: Commands,
    config: Res<PrototypeConfig>,
    mut characters: Query<
        (
            Entity,
            &Transform,
            &mut CharacterIntent,
            Option<&HoldingItems>,
        ),
        (With<Character>, Without<Pickable>),
    >,
    pickables: Query<(Entity, &Transform), (With<Pickable>, Without<HeldBy>, Without<Character>)>,
    mut held_items: Query<&mut Transform, (With<Pickable>, With<HeldBy>, Without<Character>)>,
) {
    for (character, transform, mut intent, holding) in &mut characters {
        if !std::mem::take(&mut intent.interact_pending) {
            continue;
        }
        if let Some(item) = holding.and_then(|items| items.iter().next()) {
            if let Ok(mut item_transform) = held_items.get_mut(item) {
                let before = item_transform.translation;
                let mut drop_position =
                    transform.translation + transform.rotation * Vec3::new(0.0, 0.0, -1.2);
                drop_position.y = config.ground_y + config.parcel_half_height;
                item_transform.translation = drop_position;
                commands.entity(item).remove::<HeldBy>();
                info!(
                    ?character,
                    ?item,
                    before = ?before,
                    after = ?drop_position,
                    holding_before = "held",
                    holding_after = "free",
                    reason = "interact_action_drop",
                    "Wooden crate dropped"
                );
            }
            continue;
        }

        let nearest = pickables
            .iter()
            .map(|(entity, item_transform)| {
                (
                    entity,
                    transform
                        .translation
                        .distance_squared(item_transform.translation),
                )
            })
            .filter(|(_, distance)| *distance <= config.pickup_radius.powi(2))
            .min_by(|(_, a), (_, b)| a.total_cmp(b));

        if let Some((item, distance_squared)) = nearest {
            commands.entity(item).insert(HeldBy(character));
            info!(
                ?character,
                ?item,
                before = "free",
                after = "held",
                distance = distance_squared.sqrt(),
                reason = "interact_action_pickup",
                "Wooden crate picked up"
            );
        } else {
            info!(
                ?character,
                reason = "no_pickable_in_range",
                "No pickable item in range"
            );
        }
    }
}

/// 持箱使用世界空间位置，自定义关系不改变箱子的 Transform 父子层级。
/// 固定步在交互命令应用后同步；相机插件也在逐帧转向后注册此系统，补齐无固定步的帧。
pub(crate) fn sync_held_objects(
    config: Res<PrototypeConfig>,
    characters: Query<&Transform, (With<Character>, Without<Pickable>)>,
    mut items: Query<(&HeldBy, &mut Transform), (With<Pickable>, Without<Character>)>,
) {
    for (held_by, mut transform) in &mut items {
        if let Ok(character) = characters.get(held_by.0) {
            transform.translation = character.translation + character.rotation * config.hold_offset;
            transform.rotation = character.rotation;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn test_app() -> App {
        let mut app = App::new();
        app.insert_resource(Time::<Fixed>::from_hz(60.0))
            .add_plugins(GameplayPlugin);
        app
    }

    fn step(app: &mut App) {
        app.world_mut()
            .resource_mut::<Time<Fixed>>()
            .advance_by(Duration::from_secs_f64(1.0 / 60.0));
        app.world_mut().run_schedule(FixedUpdate);
    }

    fn spawn_character(app: &mut App, position: Vec3, intent: CharacterIntent) -> Entity {
        app.world_mut()
            .spawn((
                Character,
                intent,
                CharacterMotion {
                    grounded: true,
                    ..default()
                },
                Transform::from_translation(position),
            ))
            .id()
    }

    fn interact(app: &mut App, character: Entity) {
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .interact_pending = true;
        step(app);
    }

    #[test]
    fn diagonal_movement_has_same_speed_and_characters_move_independently() {
        let mut app = test_app();
        let straight = spawn_character(
            &mut app,
            Vec3::ZERO,
            CharacterIntent {
                movement: Vec2::Y,
                ..default()
            },
        );
        let diagonal = spawn_character(
            &mut app,
            Vec3::ZERO,
            CharacterIntent {
                movement: Vec2::ONE,
                ..default()
            },
        );
        step(&mut app);
        let straight_position = app.world().get::<Transform>(straight).unwrap().translation;
        let diagonal_position = app.world().get::<Transform>(diagonal).unwrap().translation;
        assert!((straight_position.length() - diagonal_position.length()).abs() < 0.0001);
        assert!(straight_position.z < 0.0);
        assert_eq!(straight_position.x, 0.0);
        assert!(diagonal_position.x > 0.0);
    }

    #[test]
    fn held_forward_input_follows_character_yaw_across_fixed_steps() {
        let mut app = test_app();
        let character = spawn_character(
            &mut app,
            Vec3::ZERO,
            CharacterIntent {
                movement: Vec2::Y,
                ..default()
            },
        );
        step(&mut app);
        let first_position = app.world().get::<Transform>(character).unwrap().translation;
        let rotation = Quat::from_rotation_y(std::f32::consts::FRAC_PI_2);
        app.world_mut()
            .get_mut::<Transform>(character)
            .unwrap()
            .rotation = rotation;

        // 固定步可多次读取同一移动意图，转动视角后无需新的按键事件即可改变世界方向。
        step(&mut app);
        let transform = app.world().get::<Transform>(character).unwrap();
        let displacement = transform.translation - first_position;
        let distance = app.world().resource::<PrototypeConfig>().move_speed / 60.0;
        assert!(displacement.abs_diff_eq(-Vec3::X * distance, 0.0001));
        assert_eq!(transform.rotation, rotation);
        assert_eq!(
            app.world()
                .get::<CharacterIntent>(character)
                .unwrap()
                .movement,
            Vec2::Y
        );
        assert!(
            app.world()
                .get::<CharacterMotion>(character)
                .unwrap()
                .horizontal_velocity
                .abs_diff_eq(
                    -Vec3::X * app.world().resource::<PrototypeConfig>().move_speed,
                    0.0001,
                )
        );
    }

    #[test]
    fn strafing_and_backing_up_use_local_axes_without_changing_facing() {
        let mut app = test_app();
        let rotation = Quat::from_rotation_y(std::f32::consts::FRAC_PI_2);
        let distance = app.world().resource::<PrototypeConfig>().move_speed / 60.0;
        for (axes, direction) in [
            (Vec2::X, -Vec3::Z),
            (-Vec2::X, Vec3::Z),
            (-Vec2::Y, Vec3::X),
        ] {
            let character = spawn_character(
                &mut app,
                Vec3::ZERO,
                CharacterIntent {
                    movement: axes,
                    ..default()
                },
            );
            app.world_mut()
                .get_mut::<Transform>(character)
                .unwrap()
                .rotation = rotation;
            step(&mut app);
            let transform = app.world().get::<Transform>(character).unwrap();
            assert!(
                transform
                    .translation
                    .abs_diff_eq(direction * distance, 0.0001)
            );
            assert_eq!(transform.rotation, rotation);
        }
    }

    #[test]
    fn jump_is_consumed_once_and_airborne_request_does_not_rejump_on_landing() {
        let mut app = test_app();
        let character = spawn_character(
            &mut app,
            Vec3::ZERO,
            CharacterIntent {
                jump_pending: true,
                ..default()
            },
        );
        step(&mut app);
        assert!(
            app.world()
                .get::<Transform>(character)
                .unwrap()
                .translation
                .y
                > 0.0
        );
        assert!(
            !app.world()
                .get::<CharacterIntent>(character)
                .unwrap()
                .jump_pending
        );
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .jump_pending = true;
        for _ in 0..90 {
            step(&mut app);
        }
        let motion = app.world().get::<CharacterMotion>(character).unwrap();
        assert!(motion.grounded);
        assert_eq!(motion.vertical_velocity, 0.0);
        assert_eq!(
            app.world()
                .get::<Transform>(character)
                .unwrap()
                .translation
                .y,
            0.0
        );
    }

    #[test]
    fn pickup_filters_capability_and_updates_relationship_before_following() {
        let mut app = test_app();
        let character = spawn_character(&mut app, Vec3::ZERO, default());
        let not_pickable = app
            .world_mut()
            .spawn((Parcel, Transform::from_xyz(0.0, 0.3, -0.5)))
            .id();
        interact(&mut app, character);
        assert!(app.world().get::<HeldBy>(not_pickable).is_none());

        let item = app
            .world_mut()
            .spawn((Parcel, Pickable, Transform::from_xyz(0.0, 0.3, -1.3)))
            .id();
        interact(&mut app, character);
        assert_eq!(app.world().get::<HeldBy>(item).unwrap().0, character);
        assert_eq!(
            app.world()
                .get::<HoldingItems>(character)
                .unwrap()
                .iter()
                .collect::<Vec<_>>(),
            vec![item]
        );
        let hold_offset = app.world().resource::<PrototypeConfig>().hold_offset;
        assert_eq!(
            app.world().get::<Transform>(item).unwrap().translation,
            hold_offset
        );
        assert!(app.world().get::<HeldBy>(not_pickable).is_none());

        interact(&mut app, character);
        assert!(app.world().get::<HeldBy>(item).is_none());
        assert!(
            app.world()
                .get::<HoldingItems>(character)
                .is_none_or(|items| items.is_empty())
        );
        assert_eq!(
            app.world().get::<Transform>(item).unwrap().translation,
            Vec3::new(0.0, 0.3, -1.2)
        );
    }

    #[test]
    fn separate_characters_can_hold_their_own_boxes() {
        let mut app = test_app();
        let first = spawn_character(
            &mut app,
            Vec3::ZERO,
            CharacterIntent {
                interact_pending: true,
                ..default()
            },
        );
        let second = spawn_character(
            &mut app,
            Vec3::X * 6.0,
            CharacterIntent {
                interact_pending: true,
                ..default()
            },
        );
        let first_box = app
            .world_mut()
            .spawn((Pickable, Transform::from_xyz(0.0, 0.3, -1.3)))
            .id();
        let second_box = app
            .world_mut()
            .spawn((Pickable, Transform::from_xyz(6.0, 0.3, -1.3)))
            .id();
        step(&mut app);
        assert_eq!(app.world().get::<HeldBy>(first_box).unwrap().0, first);
        assert_eq!(app.world().get::<HeldBy>(second_box).unwrap().0, second);
    }
}
