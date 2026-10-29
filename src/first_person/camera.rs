//! 观察角度、镜头跟随与人物可见性。

use super::*;

/// Fire 已携带本帧汇总位移，直接更新角度；有向水平转角留给下一次碰撞检查消费。
pub(super) fn on_camera_look(
    event: On<Fire<LookAction>>,
    settings: Res<GameSettings>,
    time: Res<Time>,
    mut next_log_at: Local<f64>,
    controllers: Query<&ControlsCamera, With<GameplayContext>>,
    mut cameras: Query<(&mut FirstPersonCamera, &MouseLookState)>,
) {
    let Ok(controlled) = controllers.get(event.context) else {
        return;
    };
    let Ok((mut view, state)) = cameras.get_mut(controlled.camera) else {
        return;
    };
    if !state.active || state.skip_motion {
        return;
    }
    let before_yaw = view.yaw;
    let before_pitch = view.pitch;
    let delta = event.value * settings.camera.mouse_sensitivity;
    view.pending_yaw_delta -= delta.x;
    view.yaw = (view.yaw - delta.x).rem_euclid(TAU);
    let vertical = if settings.camera.invert_y {
        -delta.y
    } else {
        delta.y
    };
    view.apply_vertical_look(vertical);
    // 连续角度只采样调试日志，捕获和失效状态仍逐次记录。
    if time.elapsed_secs_f64() >= *next_log_at {
        debug!(target: "demo::camera", camera = ?controlled.camera, character = ?view.target,
            controller = ?event.context, yaw_before = before_yaw, yaw_after = view.yaw,
            pitch_before = before_pitch, pitch_after = view.pitch,
            reason = "mouse_motion_sample", "Camera look angles changed");
        *next_log_at = time.elapsed_secs_f64() + 0.5;
    }
}

/// 镜头使用本帧插值后的人物位置与观察角度；互斥过滤避免 Transform 查询读写冲突。
pub(super) fn follow_first_person_camera(
    characters: Query<&Transform, With<Character>>,
    mut cameras: Query<(&FirstPersonCamera, &mut Transform), Without<Character>>,
) {
    for (view, mut transform) in &mut cameras {
        if let Ok(character) = characters.get(view.target) {
            *transform = view.transform(character.translation);
        }
    }
}

/// 第一人称只隐藏自身视觉子树，保留业务根与独立木箱。
pub(super) fn sync_character_visibility(
    controllers: Query<(&ControlsCharacter, &ControlsCamera), With<GameplayContext>>,
    cameras: Query<&FirstPersonCamera>,
    characters: Query<(), With<Character>>,
    mut visuals: Query<(Entity, &ChildOf, &mut Visibility), With<CharacterVisual>>,
) {
    for (visual, parent, mut visibility) in &mut visuals {
        let character = parent.parent();
        let hide_visual = controllers
            .iter()
            .any(|(controlled_character, controlled_camera)| {
                characters.contains(character)
                    && controlled_character.character == character
                    && cameras
                        .get(controlled_camera.camera)
                        .is_ok_and(|view| view.target == character)
            });
        let after = if hide_visual {
            Visibility::Hidden
        } else {
            Visibility::Inherited
        };
        if *visibility != after {
            info!(target: "demo::camera", ?visual, ?character, before = ?*visibility, ?after,
                reason = "first_person_visibility", "Character visual visibility changed");
            *visibility = after;
        }
    }
}
