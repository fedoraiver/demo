//! 检查器的无窗口回归。

#[cfg(feature = "inspector")]
#[test]
fn inspector_context_follows_recreated_ui_cameras() {
    use bevy::prelude::*;
    use bevy_inspector_egui::bevy_egui::PrimaryEguiContext;

    let mut app = App::new();
    app.add_observer(super::attach_to_ui_camera);
    let old_camera = app.world_mut().spawn(IsDefaultUiCamera).id();
    assert!(app.world().get::<PrimaryEguiContext>(old_camera).is_some());

    app.world_mut().despawn(old_camera);
    let new_camera = app.world_mut().spawn(IsDefaultUiCamera).id();
    assert!(app.world().get::<PrimaryEguiContext>(new_camera).is_some());
}
