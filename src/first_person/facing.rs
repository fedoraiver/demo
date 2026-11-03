//! 将观察角度同步到角色，并处理持物的安全转向。

use super::*;

/// 在固定模拟前及逐帧持握目标同步前设置水平朝向，站立、横移和后退时也跟随视角。
pub(super) fn sync_character_facing(
    mut commands: Commands,
    controllers: Query<(&ControlsCharacter, &ControlsCamera), With<GameplayContext>>,
    mut cameras: Query<&mut FirstPersonCamera>,
    mut characters: Query<(&mut Transform, &Position, Option<&HoldingItems>), With<Character>>,
    items: Query<(
        &Collider,
        &HeldAttachment,
        &LinearVelocity,
        &AngularVelocity,
    )>,
    names: Query<&Name>,
    collision: CarryRotationQuery,
) {
    for (controlled_character, controlled_camera) in &controllers {
        let Ok(mut view) = cameras.get_mut(controlled_camera.camera) else {
            continue;
        };
        if view.target != controlled_character.character {
            continue;
        }
        let Ok((mut transform, position, holding)) =
            characters.get_mut(controlled_character.character)
        else {
            continue;
        };
        let rotation = Quat::from_rotation_y(view.yaw);
        let input_turn = std::mem::take(&mut view.pending_yaw_delta);
        if input_turn.abs() > 0.000001 || !transform.rotation.abs_diff_eq(rotation, 0.000001) {
            let turn = if input_turn != 0.0 {
                input_turn
            } else {
                (rotation * transform.rotation.inverse())
                    .to_euler(EulerRot::YXZ)
                    .0
            };
            // 角色胶囊绕 Y 对称，但前伸箱体必须检查整段转向；受阻先卸载，镜头继续自由观察。
            if let Some(item) = holding.and_then(|holding| holding.iter().next())
                && let Ok((collider, attachment, velocity, angular)) = items.get(item)
                && let Some(blocker) = collision.yaw_path_blocker(
                    collider,
                    position.0,
                    transform.rotation,
                    turn,
                    attachment.local_pose.into(),
                    &[controlled_character.character, item],
                )
            {
                // 仅记录自动放下这一状态变化的阻挡来源，便于区分真实碰障与查询误报。
                info!(target: "demo::camera", ?item, holder = ?controlled_character.character,
                    ?blocker, blocker_name = names.get(blocker).map_or("unnamed", Name::as_str),
                    yaw_delta = turn, reason = "turn_collision", "Held item turn blocked");
                let local = attachment.local_pose;
                let pose = Transform::from_translation(
                    position.0 + transform.rotation * local.translation,
                )
                .with_rotation(transform.rotation * local.rotation)
                .with_scale(local.scale);
                release_item(
                    &mut commands,
                    item,
                    pose,
                    velocity.0,
                    angular.0,
                    "turn_collision",
                );
                commands.write_message(SoundRequest::new(SoundCue::ItemRelease, item));
            }
            transform.rotation = rotation;
            // 只同步安全朝向，不积分平移；延迟命令在同帧持箱同步前应用，避免零固定步状态分裂。
            commands
                .entity(controlled_character.character)
                .insert(Rotation(rotation));
        }
    }
}
