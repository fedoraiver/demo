//! 英文游戏菜单：BSN 声明页面，动作消息连接导航、设置与游戏生命周期。

mod backdrop;
mod lifecycle;
mod navigation;
mod pages;
mod pointer;
mod requests;
mod scroll;
mod style;

#[cfg(test)]
mod tests;
mod theme;
mod volume;
mod widgets;

use bevy::{picking::hover::Hovered, prelude::*, ui_widgets::Button};

use crate::{
    audio::{AudioPreview, SoundRequest},
    settings::{SettingKey, SettingsDraft, SettingsFile},
};

/// 当前菜单页面；设置和帮助不改变游戏会话的生命周期。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MenuPage {
    #[default]
    Main,
    Hidden,
    Settings,
    Help,
    Pause,
}

/// 设置分类只展示已接通的能力。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SettingsTab {
    #[default]
    Graphics,
    Audio,
    Controls,
    Accessibility,
}

/// 页面数据与返回来源；焦点单独保存，避免导航时重建整个页面。
#[derive(Resource, Debug, Default)]
pub struct MenuState {
    pub page: MenuPage,
    pub tab: SettingsTab,
    pub return_page: MenuPage,
    pub status: Option<String>,
}

/// 当前可操作按钮的序号，由键盘导航和鼠标悬停共同维护。
#[derive(Resource, Default)]
pub struct MenuFocus {
    pub index: usize,
}

/// 输入来源单独决定焦点是否可见；鼠标离开后仍保留序号供后续导航使用。
#[derive(Resource, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum MenuInputSource {
    #[default]
    Pointer,
    Navigation,
}

/// 鼠标与 Enhanced Input 共用的菜单语义，避免两条路径分别执行业务。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum UiAction {
    StartGame,
    OpenSettings,
    OpenHelp,
    Quit,
    Resume,
    ReturnToMenu,
    #[default]
    Back,
    ApplySettings,
    RestoreDefaults,
    SelectTab(SettingsTab),
    Adjust(SettingKey, i8),
    /// 滑条拖动只更新草稿，释放时统一反馈，避免每像素都播放确认音。
    SetVolume(SettingKey, u8),
    FinishVolumeEdit,
    TestSfx,
}

/// 菜单实体保存动作与导航序号，系统不依赖显示文字或实体名称。
#[derive(Component, Clone, Default)]
#[require(Button, Node, Hovered, BackgroundColor, BorderColor)]
pub struct MenuButton {
    pub action: UiAction,
    pub index: usize,
}

/// 页面根实体；页面更换时连同视觉子树一起销毁。
#[derive(Component, Clone, Default)]
pub struct MenuRoot;

/// 输入系统只产生请求，集中处理系统修改状态或保存设置。
#[derive(Message)]
pub struct UiRequest {
    pub action: UiAction,
}

/// 请求在 PreUpdate 消费后，Update 依次生成 BSN 页面并更新视觉焦点。
#[derive(SystemSet, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UiSystems {
    Build,
    Pointer,
    Style,
}

/// 组装菜单功能，不安装窗口或重复初始化会话日志。
pub struct GameUiPlugin;

impl Plugin for GameUiPlugin {
    fn build(&self, app: &mut App) {
        register_menu(app);
        backdrop::register(app);
    }
}

/// 注册菜单的真实状态、输入、页面和视觉行为，便于不装展示舞台的无窗口集成夹具复用。
pub(crate) fn register_menu(app: &mut App) {
    lifecycle::register(app);
    app.init_resource::<MenuInputSource>()
        .init_resource::<SettingsDraft>()
        .init_resource::<SettingsFile>()
        .init_resource::<AudioPreview>()
        .add_message::<UiRequest>()
        .add_message::<SoundRequest>()
        // 新树及其延迟销毁先完成，再读取指针，最后刷新当前输入来源的视觉状态。
        .configure_sets(
            Update,
            (UiSystems::Build, UiSystems::Pointer, UiSystems::Style).chain(),
        );
    navigation::register(app);
    requests::register(app);
    pointer::register(app);
    pages::register(app);
    style::register(app);
    scroll::register(app);
    volume::register(app);
}
