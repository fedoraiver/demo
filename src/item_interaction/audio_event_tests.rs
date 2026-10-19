//! 无设备反馈回归，直接组合插件使用的接触和握持误差系统。

use super::*;
use crate::game_flow::configure_feature_order;
use crate::game_flow::{AppState, PlayState};

#[test]
fn gameplay_feedback_stays_silent_in_main_menu_and_pause() {
    let mut app = App::new();
    configure_feature_order(&mut app);
    app.init_resource::<PrototypeConfig>()
        .init_resource::<ContactGraph>()
        .insert_resource(Time::<Fixed>::from_hz(60.0))
        .insert_resource(State::new(AppState::MainMenu))
        .insert_resource(State::new(PlayState::Running));
    register_feedback(&mut app);
    app.world_mut()
        .resource_mut::<Time<Fixed>>()
        .advance_by(std::time::Duration::from_secs_f32(0.1));
    let holder = app
        .world_mut()
        .spawn((Character, Position::default(), Transform::default()))
        .id();
    app.world_mut().spawn((
        Parcel,
        <HeldBy as Relationship>::from(holder),
        Position(Vec3::X * 5.0),
    ));
    let parcel = app.world_mut().spawn(Parcel).id();
    let ground = app.world_mut().spawn_empty().id();
    // 只提供已解算的接触数据，验证收集系统的会话门槛，不安装物理或输出设备。
    let mut point = ContactPoint::new(Vec3::ZERO, Vec3::ZERO, Vec3::ZERO, 0.0);
    point.normal_impulse = 2.0;
    app.world_mut()
        .resource_mut::<ContactGraph>()
        .add_edge_with(ContactEdge::new(parcel, ground), |pair| {
            pair.flags.insert(ContactPairFlags::TOUCHING);
            pair.manifolds = vec![ContactManifold::new([point], -Vec3::Y)];
        });
    for _ in 0..20 {
        app.world_mut().run_schedule(FixedUpdate);
        app.world_mut().run_schedule(FixedPostUpdate);
    }
    assert!(app.world().resource::<Messages<SoundRequest>>().is_empty());

    app.insert_resource(State::new(AppState::InGame));
    app.world_mut().run_schedule(FixedUpdate);
    app.world_mut().run_schedule(FixedPostUpdate);
    let cues: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<SoundRequest>>()
        .drain()
        .map(|request| request.cue)
        .collect();
    assert_eq!(cues, [SoundCue::ParcelLand]);

    app.insert_resource(State::new(PlayState::Paused));
    for _ in 0..20 {
        app.world_mut().run_schedule(FixedUpdate);
        app.world_mut().run_schedule(FixedPostUpdate);
    }
    assert!(app.world().resource::<Messages<SoundRequest>>().is_empty());
    app.insert_resource(State::new(PlayState::Running));
    for _ in 0..10 {
        app.world_mut().run_schedule(FixedUpdate);
        app.world_mut().run_schedule(FixedPostUpdate);
    }
    let cues: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<SoundRequest>>()
        .drain()
        .map(|request| request.cue)
        .collect();
    assert_eq!(cues, [SoundCue::InstabilityWarning]);
}

#[test]
fn sustained_strain_warns_once_and_recovery_rearms() {
    let mut app = App::new();
    configure_feature_order(&mut app);
    app.init_resource::<PrototypeConfig>()
        .insert_resource(Time::<Fixed>::from_hz(60.0))
        .add_message::<SoundRequest>()
        .add_systems(FixedUpdate, warn_hold_strain);
    app.world_mut()
        .resource_mut::<Time<Fixed>>()
        .advance_by(std::time::Duration::from_secs_f32(0.1));
    let holder = app
        .world_mut()
        .spawn((Character, Position::default(), Transform::default()))
        .id();
    let parcel = app
        .world_mut()
        .spawn((
            Parcel,
            <HeldBy as Relationship>::from(holder),
            Position(Vec3::X * 5.0),
        ))
        .id();
    for _ in 0..20 {
        app.world_mut().run_schedule(FixedUpdate);
    }
    let cues: Vec<_> = app
        .world_mut()
        .resource_mut::<Messages<SoundRequest>>()
        .drain()
        .collect();
    assert_eq!(cues.len(), 1);
    assert_eq!(cues[0].cue, SoundCue::InstabilityWarning);
    let target = app.world().resource::<PrototypeConfig>().hold_offset;
    app.world_mut().get_mut::<Position>(parcel).unwrap().0 = target;
    app.world_mut().run_schedule(FixedUpdate);
    app.world_mut().get_mut::<Position>(parcel).unwrap().0 = Vec3::X * 5.0;
    for _ in 0..10 {
        app.world_mut().run_schedule(FixedUpdate);
    }
    assert_eq!(
        app.world_mut()
            .resource_mut::<Messages<SoundRequest>>()
            .drain()
            .count(),
        1
    );
    app.world_mut().entity_mut(parcel).remove::<HeldBy>();
    app.world_mut().run_schedule(FixedUpdate);
    assert!(app.world().resource::<Messages<SoundRequest>>().is_empty());
}

#[test]
fn item_grips_allow_normal_lag_and_rearm_after_recovery() {
    // 运行真实反馈系统，覆盖海岛纸箱和木箱的偏移、物理位置与非零水平朝向。
    // 不安装物理、窗口或音频设备；位姿直接表达正常持握和两次持续受阻。
    for grip in [Vec3::new(0.0, 1.3, -0.48), Vec3::new(0.0, 1.3, -0.62)] {
        let mut app = App::new();
        configure_feature_order(&mut app);
        app.init_resource::<PrototypeConfig>()
            .insert_resource(Time::<Fixed>::from_hz(60.0))
            .add_message::<SoundRequest>()
            .add_systems(FixedUpdate, warn_hold_strain);
        app.world_mut()
            .resource_mut::<Time<Fixed>>()
            .advance_by(std::time::Duration::from_secs_f32(0.1));
        let position = Vec3::new(3.0, 0.8, -2.0);
        let rotation = Quat::from_rotation_y(1.2);
        let holder = app
            .world_mut()
            .spawn((
                Character,
                Position(position),
                // 模拟目标必须读 Position，不能误读经过插值的呈现位置。
                Transform {
                    translation: position + Vec3::X,
                    rotation,
                    ..default()
                },
            ))
            .id();
        let target = position + rotation * grip;
        let parcel = app
            .world_mut()
            .spawn((
                Parcel,
                <HeldBy as Relationship>::from(holder),
                CarryGrip(grip),
                Position(target + rotation * Vec3::Z * 0.3),
            ))
            .id();
        let take_cues = |app: &mut App| {
            app.world_mut()
                .resource_mut::<Messages<SoundRequest>>()
                .drain()
                .map(|request| (request.cue, request.source))
                .collect::<Vec<_>>()
        };
        // 小于恢复阈值的正常惯性偏移不应触发持续失稳告警。
        for _ in 0..20 {
            app.world_mut().run_schedule(FixedUpdate);
        }
        assert!(take_cues(&mut app).is_empty(), "grip={grip:?}");

        for _ in 0..2 {
            app.world_mut().get_mut::<Position>(parcel).unwrap().0 = target + Vec3::X * 2.0;
            for _ in 0..20 {
                app.world_mut().run_schedule(FixedUpdate);
            }
            assert_eq!(
                take_cues(&mut app),
                [(SoundCue::InstabilityWarning, parcel)],
                "grip={grip:?}"
            );
            for _ in 0..10 {
                app.world_mut().run_schedule(FixedUpdate);
            }
            assert!(take_cues(&mut app).is_empty(), "grip={grip:?}");

            // 恢复到实际物品目标后重新武装；下一轮受阻仍应发出一条警告。
            app.world_mut().get_mut::<Position>(parcel).unwrap().0 = target;
            app.world_mut().run_schedule(FixedUpdate);
            assert!(take_cues(&mut app).is_empty(), "grip={grip:?}");
        }
    }
}
