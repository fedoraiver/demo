//! 第一人称控制：设备动作路由到角色，捕获、朝向与镜头各自同步。

use std::f32::consts::TAU;

use avian3d::prelude::{AngularVelocity, Collider, LinearVelocity, Position, Rotation};
use bevy::{
    input::{InputSystems, mouse::MouseButtonInput},
    prelude::*,
    window::{CursorGrabMode, CursorOptions, PrimaryWindow, WindowFocused},
};
use bevy_enhanced_input::prelude::{
    ContextActivity, EnhancedInputSystems, Fire, InputContextAppExt,
};
use bevy_inspector_egui::bevy_egui::{
    EguiContext, EguiInput, EguiPreUpdateSet, PrimaryEguiContext, egui,
};

use crate::{
    audio::{SoundCue, SoundRequest},
    character::{Character, CharacterIntent},
    game_flow::{AppState, FixedGameplaySystems, PlayState, PresentationSystems, gameplay_running},
    item_interaction::{CarryRotationQuery, HeldAttachment, HoldingItems, release_item},
    settings::GameSettings,
};

mod actions;
mod camera;
mod capture;
mod facing;

pub(crate) use actions::{GameplayContext, spawn_keyboard_controller};
use actions::{
    LookAction, ReleasePointerAction, clear_cancelled_movement, clear_completed_movement,
    record_movement, request_interaction, request_jump,
};
use camera::{follow_first_person_camera, on_camera_look, sync_character_visibility};
use capture::{filter_captured_egui_input, release_pointer_for_inspector, sync_mouse_capture};
use facing::sync_character_facing;

/// 独立于本次运行实体标识的玩家身份。
#[derive(Component, Reflect, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[reflect(Component)]
pub(crate) struct PlayerId(pub u64);

/// 控制者当前关联的角色，设备和角色状态分别保存。
#[derive(Component, Reflect)]
#[reflect(Component)]
pub(crate) struct ControlsCharacter(#[entities] pub Entity);

/// 控制者当前关联的第一人称相机。
#[derive(Component, Reflect)]
#[reflect(Component)]
pub(crate) struct ControlsCamera(#[entities] pub Entity);

/// 相机仅隐藏受控角色的视觉子树。
#[derive(Component, Reflect, Default, Clone)]
#[reflect(Component)]
pub(crate) struct CharacterVisual;

/// 观察角度的唯一来源；有向转角保留到下一次安全朝向同步。
#[derive(Component, Reflect)]
#[reflect(Component)]
pub(crate) struct FirstPersonCamera {
    #[entities]
    pub(crate) target: Entity,
    yaw: f32,
    #[reflect(ignore)]
    pending_yaw_delta: f32,
    pitch: f32,
    eye_height: f32,
}

impl FirstPersonCamera {
    /// 初始平视，眼位相对角色脚底保持固定高度。
    pub(crate) fn new(target: Entity) -> Self {
        Self {
            target,
            yaw: 0.0,
            pending_yaw_delta: 0.0,
            pitch: 0.0,
            eye_height: 1.65,
        }
    }

    /// 根据角色世界位置派生镜头姿态。
    pub(crate) fn transform(&self, target_position: Vec3) -> Transform {
        Transform::from_translation(target_position + Vec3::Y * self.eye_height)
            .with_rotation(Quat::from_rotation_y(self.yaw) * Quat::from_rotation_x(-self.pitch))
    }

    fn apply_vertical_look(&mut self, delta: f32) {
        self.pitch = (self.pitch + delta).clamp(-85.0_f32.to_radians(), 85.0_f32.to_radians());
    }
}

/// 每个相机的捕获状态；恢复捕获的第一帧跳过自由光标位移。
#[derive(Component, Default)]
pub(crate) struct MouseLookState {
    active: bool,
    initialized: bool,
    skip_motion: bool,
    target_available: bool,
}

/// 注册第一人称动作、捕获、朝向与镜头，不安装输入基础设施或物理插件。
pub(crate) struct FirstPersonPlugin;

impl Plugin for FirstPersonPlugin {
    fn build(&self, app: &mut App) {
        register_input_actions(app);
        app.init_resource::<GameSettings>()
            .register_type::<PlayerId>()
            .register_type::<ControlsCharacter>()
            .register_type::<ControlsCamera>()
            .register_type::<CharacterVisual>()
            .register_type::<FirstPersonCamera>()
            .add_message::<WindowFocused>()
            .add_observer(on_camera_look)
            .add_observer(release_pointer_for_inspector)
            .add_systems(Startup, log_pose_synchronization)
            .add_systems(
                PreUpdate,
                filter_captured_egui_input
                    .after(EguiPreUpdateSet::ProcessInput)
                    .before(EguiPreUpdateSet::BeginPass),
            )
            .add_systems(
                PreUpdate,
                sync_mouse_capture
                    .after(InputSystems)
                    .after(EguiPreUpdateSet::BeginPass)
                    .before(EnhancedInputSystems::Prepare),
            )
            .add_systems(
                FixedUpdate,
                sync_character_facing
                    .in_set(FixedGameplaySystems::Facing)
                    .run_if(gameplay_running),
            )
            .add_systems(
                RunFixedMainLoop,
                (
                    sync_character_facing.in_set(PresentationSystems::Facing),
                    follow_first_person_camera.in_set(PresentationSystems::Camera),
                    sync_character_visibility.in_set(PresentationSystems::Visibility),
                )
                    .run_if(gameplay_running),
            )
            .add_systems(OnEnter(AppState::MainMenu), suspend_controls)
            .add_systems(OnEnter(PlayState::Paused), suspend_controls)
            .add_systems(OnEnter(PlayState::Running), resume_capture);
    }
}

fn register_input_actions(app: &mut App) {
    app.add_input_context::<GameplayContext>()
        .add_observer(record_movement)
        .add_observer(clear_completed_movement)
        .add_observer(clear_cancelled_movement)
        .add_observer(request_jump)
        .add_observer(request_interaction);
}

fn log_pose_synchronization() {
    info!(target: "demo::camera", simulation_schedule = "FixedUpdate",
        carry_schedule = "FixedUpdate", grip_mode = "shared_body", physics_schedule = "FixedPostUpdate",
        presentation_schedule = "RunFixedMainLoop",
        presentation_order = "interpolation_character_facing_carry_pose_camera_visibility", reason = "initialization",
        "Camera pose synchronization configured");
}

fn suspend_controls(
    mut commands: Commands,
    controllers: Query<Entity, With<GameplayContext>>,
    mut captures: Query<&mut MouseLookState>,
    mut cursors: Query<&mut CursorOptions>,
) {
    for entity in &controllers {
        commands
            .entity(entity)
            .insert(ContextActivity::<GameplayContext>::INACTIVE);
    }
    for mut capture in &mut captures {
        capture.active = false;
        capture.skip_motion = true;
    }
    for mut cursor in &mut cursors {
        cursor.visible = true;
        cursor.grab_mode = CursorGrabMode::None;
    }
}

fn resume_capture(mut captures: Query<&mut MouseLookState>) {
    for mut capture in &mut captures {
        capture.initialized = false;
        capture.skip_motion = true;
    }
}

#[cfg(test)]
mod action_tests;
#[cfg(test)]
mod pose_tests;
