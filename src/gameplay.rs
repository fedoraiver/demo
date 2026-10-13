//! 固定步把角色意图转换为力与冲量，箱子持握时共享人物刚体，释放恢复独立运动。

use avian3d::prelude::*;
use bevy::{ecs::relationship::RelationshipTarget, prelude::*};
use std::collections::HashSet;

use crate::app_flow::gameplay_running;
use crate::audio_events::{SoundCue, SoundEventsPlugin, SoundRequest};
pub(crate) use crate::carry::sync_held_presentation as sync_held_objects;
use crate::carry::{CarryPlugin, begin_attachment, release_item};
use crate::physics::{DemoPhysicsPlugin, gameplay_query_layers};
#[cfg(test)]
use crate::physics::{held_collision_layers, parcel_collision_layers};

/// 独立于运行时实体标识的玩家身份，便于后续多人输入路由。
#[derive(Component, Reflect, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[reflect(Component)]
pub struct PlayerId(pub u64);

/// 控制者当前操作的角色；输入设备和角色状态分别存储。
#[derive(Component, Reflect)]
#[reflect(Component)]
pub struct ControlsCharacter(#[entities] pub Entity);

/// 具有移动和跳跃能力的角色。
#[derive(Component, Reflect, Default, Clone)]
#[reflect(Component)]
pub struct Character;

/// 来自控制者的玩法意图；输入状态跨帧保留，供固定步模拟读取。
///
/// PreUpdate 与 FixedUpdate 不一一对应：移动轴持续有效，跳跃和交互请求只消费一次。
/// 输入 Observer 仅更新意图，不按输入事件次数积分位置，避免运动速度依赖渲染帧率。
#[derive(Component, Reflect, Default, Clone)]
#[reflect(Component)]
pub struct CharacterIntent {
    /// 角色局部水平输入轴：x 表示左右横移，y 表示前后移动。
    pub movement: Vec2,
    pub jump_pending: bool,
    pub interact_pending: bool,
}

/// 接地状态由物理查询派生；实际速度直接读取 Avian 的 LinearVelocity。
#[derive(Component, Reflect, Default, Clone)]
#[reflect(Component)]
pub struct CharacterMotion {
    pub grounded: bool,
}

/// 可搬运快递身份；纸箱与木箱的美术种类由场景组件表达。
#[derive(Component, Reflect, Default, Clone)]
#[reflect(Component)]
pub struct Parcel;

/// 允许被拾取的能力标签。
#[derive(Component, Reflect, Default, Clone)]
#[reflect(Component)]
pub struct Pickable;

/// 模型对应的手前偏移；未指定时继续使用原型配置，纸箱对齐持箱动作的双手。
#[derive(Component, Reflect, Default, Clone, Copy)]
#[reflect(Component)]
pub(crate) struct CarryGrip(pub Vec3);

/// 物体的持有者；只由交互系统插入或移除。
#[derive(Component)]
#[relationship(relationship_target = HoldingItems)]
pub struct HeldBy(Entity);

/// Bevy 根据 HeldBy 自动维护的反向索引，业务代码只读取。
#[derive(Component)]
#[relationship_target(relationship = HeldBy)]
pub struct HoldingItems(Vec<Entity>);

/// 手前的目标姿态；对齐期间与真实局部挂接姿态分离，完成后由共享刚体保持相对位置。
#[derive(Component, Reflect)]
#[reflect(Component)]
pub(crate) struct HeldTarget {
    pub translation: Vec3,
    pub rotation: Quat,
}

/// 原型的运动、平地和持箱参数。
#[derive(Resource, Reflect, Clone, Debug)]
#[reflect(Resource)]
pub struct PrototypeConfig {
    pub move_speed: f32,
    pub acceleration: f32,
    pub braking_acceleration: f32,
    pub air_acceleration: f32,
    pub jump_speed: f32,
    pub gravity: f32,
    pub pickup_radius: f32,
    pub hold_offset: Vec3,
    pub ground_y: f32,
    pub parcel_half_height: f32,
    pub character_mass: f32,
    pub character_height: f32,
    pub character_radius: f32,
    pub parcel_mass: f32,
}

impl Default for PrototypeConfig {
    fn default() -> Self {
        Self {
            move_speed: 4.5,
            acceleration: 30.0,
            braking_acceleration: 45.0,
            air_acceleration: 6.0,
            jump_speed: 5.0,
            gravity: 9.81,
            pickup_radius: 1.8,
            hold_offset: Vec3::new(0.0, 1.0, -0.9),
            ground_y: 0.0,
            parcel_half_height: 0.3,
            character_mass: 75.0,
            character_height: 1.9,
            character_radius: 0.32,
            parcel_mass: 3.0,
        }
    }
}

/// 注册固定步控制、交互与物理解算后的状态观察；不加载游戏窗口。
pub struct GameplayPlugin;

/// 固定步先同步朝向，再准备力、冲量和持握目标，随后由 Avian 求解。
#[derive(SystemSet, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum GameplaySystems {
    Simulate,
}

impl Plugin for GameplayPlugin {
    fn build(&self, app: &mut App) {
        app.register_type::<PlayerId>()
            .register_type::<ControlsCharacter>()
            .register_type::<Character>()
            .register_type::<CharacterIntent>()
            .register_type::<CharacterMotion>()
            .register_type::<Parcel>()
            .register_type::<Pickable>()
            .register_type::<CarryGrip>()
            .register_type::<HeldTarget>()
            .register_type::<PrototypeConfig>()
            .init_resource::<PrototypeConfig>()
            .add_plugins((DemoPhysicsPlugin, SoundEventsPlugin, CarryPlugin))
            .add_systems(Startup, log_configuration)
            .add_systems(
                FixedUpdate,
                (
                    update_grounded,
                    move_characters,
                    jump_characters,
                    handle_interaction,
                    sync_held_objects,
                )
                    // 拿放关系先应用，再让共享刚体装卸读取；人物运动始终由同一固定步求解。
                    .chain()
                    .in_set(GameplaySystems::Simulate)
                    .run_if(gameplay_running),
            )
            .add_systems(
                FixedPostUpdate,
                (update_grounded, log_character_velocity)
                    .chain()
                    .after(PhysicsSystems::Writeback)
                    .run_if(gameplay_running),
            );
    }
}

/// 记录实际玩法配置；显式保留日志分类，兼容现有过滤设置。
fn log_configuration(config: Res<PrototypeConfig>) {
    // 刚体与持握方式属于玩法配置，合并到同一记录便于沿用日志筛选。
    info!(target: "demo::gameplay", ?config,
        physics_engine = "avian3d", physics_version = "0.7.0",
        character_body = "dynamic", parcel_body = "dynamic_free_shared_held",
        grip_mode = "shared_body", release_mode = "preserve_velocity",
        "Prototype gameplay initialized");
}

/// 脚底附近的小球向下探测支撑面；墙面法线和上升中的角色不能算接地。
fn update_grounded(
    config: Res<PrototypeConfig>,
    spatial_query: SpatialQuery,
    colliders: Query<(
        Option<&CollisionLayers>,
        Has<HeldBy>,
        Has<crate::carry::HeldCollider>,
        Has<Sensor>,
    )>,
    mut characters: Query<
        (
            Entity,
            &Position,
            &LinearVelocity,
            Option<&CollisionLayers>,
            &mut CharacterMotion,
        ),
        With<Character>,
    >,
) {
    let probe = Collider::sphere(config.character_radius * 0.8);
    for (entity, position, velocity, layers, mut motion) in &mut characters {
        // 相机查询网格不参与接地或拾取，即使其碰撞掩码为空也必须显式排除所属层。
        let filter =
            SpatialQueryFilter::from_excluded_entities([entity]).with_mask(gameplay_query_layers());
        let character_layers = layers.copied().unwrap_or_default();
        let mut grounded = false;
        if velocity.y <= 0.5 {
            // 空间查询只按目标所属层过滤；支撑还必须满足双方碰撞掩码并排除持握物和传感器。
            // 遍历所有命中，避免最近的侧墙挡住稍远的有效地面。
            spatial_query.shape_hits_callback(
                &probe,
                position.0 + Vec3::Y * config.character_radius,
                Quat::IDENTITY,
                Dir3::NEG_Y,
                &ShapeCastConfig::from_max_distance(0.12),
                &filter,
                |hit| {
                    if let Ok((layers, held, held_proxy, sensor)) = colliders.get(hit.entity) {
                        // 手持的实际碰撞代理没有 HeldBy，不能被脚底探测误判为外部支撑。
                        grounded |= !held
                            && !held_proxy
                            && !sensor
                            && character_layers.interacts_with(layers.copied().unwrap_or_default())
                            && hit.normal1.y >= 0.65;
                    }
                    !grounded
                },
            );
        }
        if grounded != motion.grounded {
            info!(
                ?entity,
                before = motion.grounded,
                after = grounded,
                vertical_velocity = velocity.y,
                reason = "support_probe",
                "Character grounded state changed"
            );
            if grounded {
                info!(
                    ?entity,
                    landing_velocity = velocity.y,
                    reason = "ground_contact",
                    "Character landed"
                );
            }
            motion.grounded = grounded;
        }
    }
}

/// 用有上限的加速度趋近目标水平速度，保留碰撞和外部冲量造成的实际运动。
fn move_characters(
    time: Res<Time<Fixed>>,
    config: Res<PrototypeConfig>,
    mut characters: Query<
        (Forces, &Transform, &CharacterIntent, &CharacterMotion),
        With<Character>,
    >,
) {
    for (mut forces, transform, intent, motion) in &mut characters {
        let axes = intent.movement.clamp_length_max(1.0);
        // 空中松键保留惯性，地面松键使用较快的主动刹车。
        if !motion.grounded && axes == Vec2::ZERO {
            continue;
        }
        let limit = if !motion.grounded {
            config.air_acceleration
        } else if axes == Vec2::ZERO {
            config.braking_acceleration
        } else {
            config.acceleration
        };
        let target = transform.rotation * Vec3::new(axes.x, 0.0, -axes.y) * config.move_speed;
        let velocity = forces.linear_velocity();
        let horizontal = Vec3::new(velocity.x, 0.0, velocity.z);
        let acceleration = ((target - horizontal) / time.delta_secs()).clamp_length_max(limit);
        forces.apply_linear_acceleration(acceleration);
    }
}

/// 跳跃只消费一次，通过冲量改变速度；重力和位置积分全部交给 Avian。
fn jump_characters(
    config: Res<PrototypeConfig>,
    mut characters: Query<
        (
            Entity,
            Forces,
            &ComputedMass,
            &mut CharacterIntent,
            &mut CharacterMotion,
        ),
        With<Character>,
    >,
) {
    for (entity, mut forces, mass, mut intent, mut motion) in &mut characters {
        if !std::mem::take(&mut intent.jump_pending) {
            continue;
        }
        if motion.grounded {
            let speed_before = forces.linear_velocity().y;
            forces
                .apply_linear_impulse(Vec3::Y * mass.value() * (config.jump_speed - speed_before));
            motion.grounded = false;
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
}

/// 拾取建立物理持握关系；释放只解除控制，保留刚体姿态、线速度和角速度。
fn handle_interaction(
    mut commands: Commands,
    config: Res<PrototypeConfig>,
    spatial_query: SpatialQuery,
    mut reserved: Local<HashSet<Entity>>,
    mut characters: Query<
        (
            Entity,
            &Position,
            &Rotation,
            &Transform,
            &mut CharacterIntent,
            Option<&HoldingItems>,
        ),
        (With<Character>, Without<Pickable>),
    >,
    pickables: Query<
        (
            Entity,
            &Position,
            &Rotation,
            &Transform,
            &RigidBody,
            Has<NoTranslationEasing>,
            Has<NoRotationEasing>,
            Has<ColliderDisabled>,
        ),
        (With<Pickable>, Without<HeldBy>, Without<Character>),
    >,
    held_items: Query<
        (
            &Position,
            &Rotation,
            &Transform,
            &LinearVelocity,
            &AngularVelocity,
        ),
        (With<Pickable>, With<HeldBy>, Without<Character>),
    >,
) {
    reserved.clear();
    for (character, position, rotation, transform, mut intent, holding) in &mut characters {
        if !std::mem::take(&mut intent.interact_pending) {
            continue;
        }
        if let Some(item) = holding.and_then(|items| items.iter().next()) {
            if let Ok((item_position, item_rotation, item_transform, velocity, angular_velocity)) =
                held_items.get(item)
            {
                release_item(
                    &mut commands,
                    item,
                    Transform {
                        translation: item_position.0,
                        rotation: item_rotation.0,
                        scale: item_transform.scale,
                    },
                    velocity.0,
                    angular_velocity.0,
                    "interact_action_release",
                );
                // 延迟消息与解除关系一起提交，播放者只能收到已接受的交互结果。
                commands.write_message(SoundRequest::new(SoundCue::ParcelRelease, item));
            }
            continue;
        }
        let origin = position.0 + Vec3::Y * config.hold_offset.y;
        let nearest = pickables
            .iter()
            .filter(|(item, ..)| !reserved.contains(item))
            .filter_map(|(item, item_position, ..)| {
                let distance = position.0.distance_squared(item_position.0);
                if distance > config.pickup_radius.powi(2) {
                    return None;
                }
                // 碰撞世界也约束拾取视线，不能隔着墙抓取箱子。
                let offset = item_position.0 - origin;
                if let Ok(direction) = Dir3::new(offset)
                    && let Some(hit) = spatial_query.cast_ray(
                        origin,
                        direction,
                        offset.length(),
                        true,
                        &SpatialQueryFilter::from_excluded_entities([character])
                            .with_mask(gameplay_query_layers()),
                    )
                    && hit.entity != item
                {
                    return None;
                }
                Some((item, distance))
            })
            .min_by(|(_, a), (_, b)| a.total_cmp(b));
        if let Some((item, distance_squared)) = nearest {
            // 同批次延迟命令尚未应用，预留集合防止两个角色同时占用一件物体。
            reserved.insert(item);
            commands.entity(item).insert((
                HeldBy(character),
                HeldTarget {
                    translation: position.0 + transform.rotation * config.hold_offset,
                    rotation: transform.rotation,
                },
            ));
            let (
                _,
                item_position,
                item_rotation,
                item_transform,
                body,
                translation_paused,
                rotation_paused,
                collider_disabled,
            ) = pickables
                .get(item)
                .expect("Selected carryable must remain in the interaction query");
            begin_attachment(
                &mut commands,
                item,
                Transform::from_translation(position.0).with_rotation(rotation.0),
                Transform {
                    translation: item_position.0,
                    rotation: item_rotation.0,
                    scale: item_transform.scale,
                },
                *body,
                translation_paused,
                rotation_paused,
                collider_disabled,
            );
            commands.write_message(SoundRequest::new(SoundCue::ParcelPickup, item));
            info!(
                ?character,
                ?item,
                before = "free",
                after = "held",
                distance = distance_squared.sqrt(),
                reason = "interact_action_pickup",
                "Carryable item picked up"
            );
        } else {
            info!(
                ?character,
                reason = "no_visible_pickable_in_range",
                "No pickable item in range"
            );
        }
    }
}

/// 采样物理解算后的实际速度，便于检查加速度、刹车和碰撞反馈。
fn log_character_velocity(
    time: Res<Time<Fixed>>,
    mut next_log_time: Local<f64>,
    characters: Query<(Entity, &LinearVelocity, &CharacterMotion), With<Character>>,
) {
    if time.elapsed_secs_f64() < *next_log_time {
        return;
    }
    *next_log_time = time.elapsed_secs_f64() + 0.5;
    for (entity, velocity, motion) in &characters {
        debug!(?entity, velocity = ?velocity.0, grounded = motion.grounded,
            reason = "physics_sample", "Character velocity sampled");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::physics::{character_body, ground_body, parcel_body, world_collision_layers};
    use bevy::time::TimeUpdateStrategy;
    use std::time::Duration;

    fn test_app() -> App {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, TransformPlugin, GameplayPlugin))
            .insert_resource(Time::<Fixed>::from_hz(60.0))
            .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(
                1.0 / 60.0,
            )));
        let config = app.world().resource::<PrototypeConfig>().clone();
        app.world_mut().spawn((
            ground_body(&config),
            Transform::from_xyz(0.0, config.ground_y, 0.0),
        ));
        // 手动 update 不经过 App::run，需先完成物理插件的资源初始化。
        app.finish();
        app.cleanup();
        app.update();
        app
    }

    fn step(app: &mut App, count: usize) {
        for _ in 0..count {
            app.update();
        }
    }

    fn spawn_character(app: &mut App, position: Vec3, intent: CharacterIntent) -> Entity {
        let config = app.world().resource::<PrototypeConfig>().clone();
        app.world_mut()
            .spawn((
                Character,
                intent,
                CharacterMotion::default(),
                Transform::from_translation(position),
                character_body(&config),
            ))
            .id()
    }

    fn spawn_box(app: &mut App, position: Vec3) -> Entity {
        let config = app.world().resource::<PrototypeConfig>().clone();
        app.world_mut()
            .spawn((
                Parcel,
                Pickable,
                Transform::from_translation(position),
                parcel_body(&config),
            ))
            .id()
    }

    fn interact(app: &mut App, character: Entity) {
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .interact_pending = true;
        step(app, 1);
    }

    #[test]
    fn ground_probe_respects_collision_layers_and_excludes_held_boxes() {
        let mut app = test_app();
        let item = spawn_box(&mut app, Vec3::new(0.0, 0.3, 0.0));
        let character = spawn_character(&mut app, Vec3::new(0.0, 0.6, 0.0), default());
        step(&mut app, 30);
        let grounded = |app: &App| {
            app.world()
                .get::<CharacterMotion>(character)
                .unwrap()
                .grounded
        };
        assert!(grounded(&app), "Free box must support the character");

        // 单独重跑探测，避免改变碰撞层后物理移动影响支撑过滤的断言。
        let mut schedule = Schedule::default();
        schedule.add_systems(update_grounded);
        let character_layers = *app.world().get::<CollisionLayers>(character).unwrap();
        app.world_mut()
            .entity_mut(character)
            .insert(CollisionLayers::NONE);
        schedule.run(app.world_mut());
        assert!(
            !grounded(&app),
            "Character collision filters must be respected"
        );
        app.world_mut()
            .entity_mut(character)
            .insert(character_layers);
        schedule.run(app.world_mut());
        assert!(grounded(&app));

        let item_layers = parcel_collision_layers();
        app.world_mut()
            .entity_mut(item)
            .insert(CollisionLayers::new(
                item_layers.memberships,
                LayerMask::NONE,
            ));
        schedule.run(app.world_mut());
        assert!(
            !grounded(&app),
            "Support collision filters must be respected"
        );
        app.world_mut().entity_mut(item).insert(item_layers);
        schedule.run(app.world_mut());
        assert!(grounded(&app));

        app.world_mut()
            .entity_mut(item)
            .insert((HeldBy(character), held_collision_layers()));
        schedule.run(app.world_mut());
        assert!(!grounded(&app), "Held box cannot support the character");
        // 即使外部代码误改持握碰撞层，持握身份也不能成为支撑。
        app.world_mut().entity_mut(item).insert(item_layers);
        schedule.run(app.world_mut());
        assert!(!grounded(&app));
        app.world_mut().entity_mut(item).remove::<HeldBy>();
        schedule.run(app.world_mut());
        assert!(
            grounded(&app),
            "Released box must become valid support again"
        );
        // 单独重跑 ECS 探测确认代理身份同样不能充当地面，不推进装卸或物理积分。
        app.world_mut()
            .entity_mut(item)
            .insert(crate::carry::HeldCollider(item));
        schedule.run(app.world_mut());
        assert!(
            !grounded(&app),
            "A held collision proxy cannot support the character"
        );
        app.world_mut()
            .entity_mut(item)
            .remove::<crate::carry::HeldCollider>();
        schedule.run(app.world_mut());
        assert!(grounded(&app));
    }

    #[test]
    fn ground_probe_finds_floor_after_a_nearer_wall_hit() {
        let mut app = test_app();
        let wall = app
            .world_mut()
            .spawn((
                RigidBody::Static,
                Collider::cuboid(0.04, 2.0, 2.0),
                world_collision_layers(),
                Transform::from_xyz(0.26, 1.0, 0.0),
            ))
            .id();
        step(&mut app, 2);
        // 先初始化墙面，再生成角色并只跑探测，避免墙面求解先推开角色。
        let character = spawn_character(&mut app, Vec3::ZERO, default());
        let mut schedule = Schedule::default();
        schedule.add_systems(
            (
                move |config: Res<PrototypeConfig>, spatial_query: SpatialQuery| {
                    let closest = spatial_query
                        .cast_shape(
                            &Collider::sphere(config.character_radius * 0.8),
                            Vec3::Y * config.character_radius,
                            Quat::IDENTITY,
                            Dir3::NEG_Y,
                            &ShapeCastConfig::from_max_distance(0.12),
                            &SpatialQueryFilter::from_excluded_entities([character])
                                .with_mask(gameplay_query_layers()),
                        )
                        .unwrap();
                    assert_eq!(closest.entity, wall);
                    assert!(closest.normal1.y < 0.65);
                },
                update_grounded,
            )
                .chain(),
        );
        schedule.run(app.world_mut());
        assert!(
            app.world()
                .get::<CharacterMotion>(character)
                .unwrap()
                .grounded,
            "Side wall must not hide valid floor support"
        );
    }

    #[test]
    fn movement_accelerates_brakes_and_diagonal_speed_is_bounded() {
        let mut app = test_app();
        let straight = spawn_character(&mut app, Vec3::ZERO, default());
        let diagonal = spawn_character(&mut app, Vec3::X * 5.0, default());
        step(&mut app, 30);
        app.world_mut()
            .get_mut::<CharacterIntent>(straight)
            .unwrap()
            .movement = Vec2::Y;
        app.world_mut()
            .get_mut::<CharacterIntent>(diagonal)
            .unwrap()
            .movement = Vec2::ONE;
        step(&mut app, 1);
        let first_speed = app
            .world()
            .get::<LinearVelocity>(straight)
            .unwrap()
            .0
            .length();
        assert!(first_speed > 0.0 && first_speed < 1.0, "{first_speed}");
        step(&mut app, 20);
        let a = app.world().get::<LinearVelocity>(straight).unwrap().0;
        let b = app.world().get::<LinearVelocity>(diagonal).unwrap().0;
        assert!((a.xz().length() - 4.5).abs() < 0.05, "{a:?}");
        assert!(
            (a.xz().length() - b.xz().length()).abs() < 0.05,
            "{a:?} {b:?}"
        );
        app.world_mut()
            .get_mut::<CharacterIntent>(straight)
            .unwrap()
            .movement = Vec2::ZERO;
        step(&mut app, 1);
        let braking = app
            .world()
            .get::<LinearVelocity>(straight)
            .unwrap()
            .0
            .xz()
            .length();
        assert!(braking > 0.0 && braking < a.xz().length());
        step(&mut app, 12);
        assert!(
            app.world()
                .get::<LinearVelocity>(straight)
                .unwrap()
                .0
                .xz()
                .length()
                < 0.05
        );
    }

    #[test]
    fn collision_blocks_character_and_dynamic_boxes_receive_momentum() {
        let mut app = test_app();
        let character = spawn_character(&mut app, Vec3::ZERO, default());
        let item = spawn_box(&mut app, Vec3::new(0.0, 0.3, -1.2));
        step(&mut app, 30);
        app.world_mut().spawn((
            RigidBody::Static,
            Collider::cuboid(8.0, 3.0, 0.5),
            world_collision_layers(),
            Transform::from_xyz(0.0, 1.5, -4.0),
        ));
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .movement = Vec2::Y;
        step(&mut app, 100);
        let position = app.world().get::<Position>(character).unwrap().0;
        assert!(position.z > -3.5, "Character crossed wall: {position:?}");
        let box_position = app.world().get::<Position>(item).unwrap().0;
        assert!(
            box_position.z < -1.4 && box_position.z > -3.8,
            "{box_position:?}"
        );
    }

    #[test]
    fn jump_is_consumed_once_and_gravity_lands_on_collider() {
        let mut app = test_app();
        let character = spawn_character(&mut app, Vec3::ZERO, default());
        step(&mut app, 30);
        assert!(
            app.world()
                .get::<CharacterMotion>(character)
                .unwrap()
                .grounded
        );
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .jump_pending = true;
        step(&mut app, 1);
        let velocity = app.world().get::<LinearVelocity>(character).unwrap().y;
        assert!((velocity - (5.0 - 9.81 / 60.0)).abs() < 0.05, "{velocity}");
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
        step(&mut app, 1);
        assert!(app.world().get::<LinearVelocity>(character).unwrap().y < velocity);
        step(&mut app, 100);
        assert!(
            app.world()
                .get::<CharacterMotion>(character)
                .unwrap()
                .grounded
        );
        assert!(app.world().get::<Position>(character).unwrap().y.abs() < 0.03);
    }

    #[test]
    fn item_specific_grips_align_then_remain_fixed_on_the_shared_body() {
        for grip in [Vec3::new(0.0, 1.3, -0.48), Vec3::new(0.0, 1.3, -0.62)] {
            let mut app = test_app();
            let character = spawn_character(&mut app, Vec3::ZERO, default());
            let item = spawn_box(&mut app, Vec3::new(0.0, 0.3, -1.3));
            app.world_mut().entity_mut(item).insert(CarryGrip(grip));
            step(&mut app, 30);
            let before_pickup = app.world().get::<Position>(item).unwrap().0;
            interact(&mut app, character);
            assert_eq!(app.world().get::<HeldBy>(item).unwrap().0, character);
            assert!(app.world().get::<RigidBody>(item).is_none());
            let proxy = app
                .world()
                .get::<crate::carry::HeldAttachment>(item)
                .unwrap()
                .collider;
            assert_eq!(
                app.world().get::<ColliderOf>(proxy).unwrap().body,
                character
            );
            let after_pickup = app.world().get::<Position>(item).unwrap().0;
            assert!(
                after_pickup.distance(before_pickup) < 0.2,
                "Pickup teleported the item: {before_pickup:?} {after_pickup:?}"
            );
            let initial_error =
                after_pickup.distance(app.world().get::<HeldTarget>(item).unwrap().translation);
            assert!(initial_error > 0.5);
            let fixed_before = app.world().resource::<Time<Fixed>>().elapsed();
            // 执行真实固定步，先安全对齐，再核对组合刚体保存的实际箱体位置。
            step(&mut app, 120);
            assert!(
                app.world().resource::<Time<Fixed>>().elapsed() - fixed_before
                    > Duration::from_secs(1)
            );
            let world = app.world();
            let target = world.get::<HeldTarget>(item).unwrap();
            let actual = world.get::<Position>(item).unwrap().0;
            assert!(
                actual.distance(target.translation) < 0.1,
                "The shared body did not align its held box: {grip:?} {actual:?} {:?}",
                target.translation
            );
            // 静止角色面向 -Z；分别验证真实箱体的高度和距离，不只断言派生目标的公式。
            let relative = actual - world.get::<Position>(character).unwrap().0;
            assert!((relative.y - 1.3).abs() < 0.1, "{grip:?} {relative:?}");
            assert!((relative.z - grip.z).abs() < 0.08, "{grip:?} {relative:?}");
            assert!(world.get::<LinearVelocity>(item).unwrap().0.length() < 0.1);
            let displayed_offset =
                target.translation - world.get::<Transform>(character).unwrap().translation;
            assert!(displayed_offset.abs_diff_eq(grip, 0.00001));
        }
    }

    #[test]
    fn shared_body_blocks_at_wall_and_release_keeps_velocity() {
        let mut app = test_app();
        let character = spawn_character(&mut app, Vec3::ZERO, default());
        let item = spawn_box(&mut app, Vec3::new(0.0, 0.3, -1.3));
        step(&mut app, 30);
        let before = app.world().get::<Position>(item).unwrap().0;
        interact(&mut app, character);
        assert_eq!(app.world().get::<HeldBy>(item).unwrap().0, character);
        assert!(app.world().get::<RigidBody>(item).is_none());
        let proxy = app
            .world()
            .get::<crate::carry::HeldAttachment>(item)
            .unwrap()
            .collider;
        assert_eq!(
            app.world().get::<ColliderOf>(proxy).unwrap().body,
            character
        );
        let after = app.world().get::<Position>(item).unwrap().0;
        assert!(
            after.distance(before) < 0.2,
            "Pickup teleported: {before:?} {after:?}"
        );
        step(&mut app, 100);
        assert!((app.world().get::<Position>(item).unwrap().y - 1.0).abs() < 0.12);
        app.world_mut().spawn((
            RigidBody::Static,
            Collider::cuboid(8.0, 3.0, 0.2),
            world_collision_layers(),
            Transform::from_xyz(0.0, 1.5, -1.6),
        ));
        // 已完成正常持握后持续前进，箱体碰墙应直接阻挡同一刚体的人物。
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .movement = Vec2::Y;
        step(&mut app, 90);
        let position = app.world().get::<Position>(item).unwrap().0;
        assert!(position.z > -1.3, "Held box crossed wall: {position:?}");
        assert_eq!(app.world().get::<HeldBy>(item).unwrap().0, character);
        let holder_position = app.world().get::<Position>(character).unwrap().0;
        assert!(
            holder_position.z > -0.4,
            "Holder entered its blocked box: {holder_position:?}"
        );
        // 直接运行交互系统验证释放瞬间不修改任何速度或位置，不混入随后重力。
        app.world_mut().get_mut::<LinearVelocity>(item).unwrap().0 = Vec3::new(1.0, 2.0, 0.5);
        app.world_mut().get_mut::<AngularVelocity>(item).unwrap().0 = Vec3::new(0.5, 1.0, 0.0);
        let before_release = app.world().get::<Position>(item).unwrap().0;
        let rotation_before_release = app.world().get::<Rotation>(item).unwrap().0;
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .interact_pending = true;
        let mut schedule = Schedule::default();
        schedule.add_systems(handle_interaction);
        schedule.run(app.world_mut());
        assert!(app.world().get::<HeldBy>(item).is_none());
        assert!(app.world().get::<HeldTarget>(item).is_none());
        assert_eq!(
            app.world().get::<LinearVelocity>(item).unwrap().0,
            Vec3::new(1.0, 2.0, 0.5)
        );
        assert_eq!(app.world().get::<Position>(item).unwrap().0, before_release);
        assert_eq!(
            app.world().get::<AngularVelocity>(item).unwrap().0,
            Vec3::new(0.5, 1.0, 0.0)
        );
        assert_eq!(
            app.world().get::<Rotation>(item).unwrap().0,
            rotation_before_release
        );
        // 松手后退离箱体再验证重力；继续向墙走会把自由箱夹住，墙面摩擦可合法承重。
        let holder_before_retreat = app.world().get::<Position>(character).unwrap().0;
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .movement = Vec2::NEG_Y;
        step(&mut app, 120);
        let final_position = app.world().get::<Position>(item).unwrap().0;
        let final_velocity = app.world().get::<LinearVelocity>(item).unwrap().0;
        let holder_position = app.world().get::<Position>(character).unwrap().0;
        let touching_holder = app
            .world()
            .resource::<ContactGraph>()
            .get(item, character)
            .is_some_and(|(_, pair)| pair.is_touching());
        assert!(
            final_position.y < 0.5,
            "Released box did not land: box={final_position:?}, velocity={final_velocity:?}, holder={holder_position:?}, touching_holder={touching_holder}"
        );
        assert!(
            holder_position.z > holder_before_retreat.z + 1.0,
            "The holder must retreat far enough to stop clamping the free box"
        );
    }

    #[test]
    fn holder_despawn_and_external_relation_removal_restore_free_collisions() {
        for despawn in [false, true] {
            let mut app = test_app();
            let character = spawn_character(&mut app, Vec3::ZERO, default());
            let item = spawn_box(&mut app, Vec3::new(0.0, 0.3, -1.3));
            step(&mut app, 30);
            interact(&mut app, character);
            step(&mut app, 60);
            if despawn {
                app.world_mut().despawn(character);
            } else {
                app.world_mut().entity_mut(item).remove::<HeldBy>();
            }
            step(&mut app, 1);
            assert!(app.world().get::<HeldTarget>(item).is_none());
            assert_eq!(
                *app.world().get::<CollisionLayers>(item).unwrap(),
                parcel_collision_layers()
            );
            step(&mut app, 120);
            assert!(app.world().get::<Position>(item).unwrap().y < 0.5);
        }
    }

    #[test]
    fn held_box_collision_stops_the_holder_before_it_enters_the_box() {
        let mut app = test_app();
        let character = spawn_character(&mut app, Vec3::new(0.0, 0.0, 2.0), default());
        let item = spawn_box(&mut app, Vec3::new(0.0, 0.3, 1.1));
        let grip = Vec3::new(0.0, 1.3, -0.48);
        app.world_mut().entity_mut(item).insert(CarryGrip(grip));
        let config = app.world().resource::<PrototypeConfig>().clone();
        let obstacle = app
            .world_mut()
            .spawn((
                RigidBody::Static,
                crate::physics::character_collider(&config),
                world_collision_layers(),
                Transform::IDENTITY,
            ))
            .id();
        step(&mut app, 30);
        interact(&mut app, character);
        step(&mut app, 120);
        let proxy = app
            .world()
            .get::<crate::carry::HeldAttachment>(item)
            .unwrap()
            .collider;
        let before = app.world().get::<Position>(character).unwrap().0;
        app.world_mut()
            .get_mut::<CharacterIntent>(character)
            .unwrap()
            .movement = Vec2::Y;

        let mut solved_contact = false;
        for _ in 0..180 {
            step(&mut app, 1);
            let world = app.world();
            let holder_position = world.get::<Position>(character).unwrap().0;
            let box_position = world.get::<Position>(item).unwrap().0;
            if let Some((_, pair)) = world.resource::<ContactGraph>().get(proxy, obstacle) {
                solved_contact |= pair.is_touching()
                    && pair
                        .manifolds
                        .iter()
                        .any(|manifold| manifold.total_normal_impulse() > 0.001);
            }
            // 使用正常手前偏移和持续移动，不能让人物留在远处、延长手臂来掩盖追入箱体。
            let relative = box_position - holder_position;
            assert!(
                (relative.z - grip.z).abs() < 0.16,
                "The holder moved into its obstructed box: holder={holder_position:?}, box={box_position:?}"
            );
        }
        let after = app.world().get::<Position>(character).unwrap().0;
        assert!(
            before.z - after.z > 0.5,
            "The holder must actually approach"
        );
        assert!(
            solved_contact,
            "The held box must have a solved obstacle contact"
        );
        assert!(after.z > config.character_radius * 2.0 + 0.2);
    }

    #[test]
    fn no_fixed_step_preserves_requests_and_render_rates_share_physics() {
        let simulate = |frame_hz: f64| {
            let mut app = test_app();
            let character = spawn_character(&mut app, Vec3::ZERO, default());
            step(&mut app, 30);
            app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO));
            app.world_mut()
                .get_mut::<CharacterIntent>(character)
                .unwrap()
                .jump_pending = true;
            let before = app.world().get::<Position>(character).unwrap().0;
            step(&mut app, 3);
            assert_eq!(app.world().get::<Position>(character).unwrap().0, before);
            assert!(
                app.world()
                    .get::<CharacterIntent>(character)
                    .unwrap()
                    .jump_pending
            );
            app.world_mut()
                .get_mut::<CharacterIntent>(character)
                .unwrap()
                .movement = Vec2::Y;
            app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(
                1.0 / frame_hz,
            )));
            step(&mut app, frame_hz as usize);
            app.world().get::<Position>(character).unwrap().0
        };
        let a = simulate(60.0);
        let b = simulate(120.0);
        assert!(a.abs_diff_eq(b, 0.1), "{a:?} {b:?}");
    }
}
