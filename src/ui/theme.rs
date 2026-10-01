//! 菜单共用的纸张、制服和包裹配色，以及预加载字体。

use bevy::prelude::*;

pub(super) const INK: Color = Color::srgb(0.12, 0.16, 0.22);
pub(super) const CREAM: Color = Color::srgb(0.98, 0.95, 0.86);
pub(super) const PAPER: Color = Color::srgba(0.98, 0.96, 0.90, 0.96);
pub(super) const GOLD: Color = Color::srgb(1.0, 0.78, 0.30);
pub(super) const MUTED: Color = Color::srgb(0.38, 0.41, 0.45);
pub(super) const SUBTLE: Color = Color::srgba(0.43, 0.45, 0.48, 0.12);

/// 字体只加载一次；页面 BSN 直接引用句柄，不启动异步场景任务。
#[derive(Resource, Clone)]
pub(super) struct UiTheme {
    pub heading: Handle<Font>,
    pub body: Handle<Font>,
    pub scale: f32,
}

impl FromWorld for UiTheme {
    fn from_world(world: &mut World) -> Self {
        let assets = world.resource::<AssetServer>();
        Self {
            heading: assets.load("ui/fonts/heading.ttf"),
            body: assets.load("ui/fonts/body.ttf"),
            scale: 1.0,
        }
    }
}

impl UiTheme {
    /// 宽度较小时缩小字号；高度不足交给滚动区域，避免整页文字过小。
    pub fn for_width(&self, width: f32) -> Self {
        Self {
            scale: (width / 1440.0).clamp(0.68, 1.15),
            ..self.clone()
        }
    }

    pub fn size(&self, size: f32) -> f32 {
        size * self.scale
    }
}

/// 低模风格使用清楚的下投影，保证浅色控件在海天背景上可辨认。
pub(super) fn paper_shadow(scale: f32) -> BoxShadow {
    BoxShadow(vec![ShadowStyle {
        color: Color::srgba(0.07, 0.11, 0.18, 0.25),
        x_offset: px(0),
        y_offset: px(5.0 * scale),
        spread_radius: px(0),
        blur_radius: px(10.0 * scale),
    }])
}
