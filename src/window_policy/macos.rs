//! AppKit 直接限制内容区比例，保留窗口装饰与 Winit 原有事件代理。

use bevy::window::RawHandleWrapper;
use objc2::{MainThreadMarker, rc::Retained};
use objc2_app_kit::{NSView, NSWindow, NSWindowCollectionBehavior};
use objc2_foundation::NSSize;
use raw_window_handle::RawWindowHandle;

use super::{HEIGHT_UNIT, MIN_LOGICAL_SIZE, WIDTH_UNIT};

// AppKit 内容区使用逻辑点；只校准超过此误差的系统尺寸请求。
const CONTENT_SIZE_TOLERANCE_POINTS: f64 = 0.5;

/// 保持原生窗口有效，并在守护对象释放时还原安装前的约束。
pub(super) struct NativeWindowPolicy {
    window: Retained<NSWindow>,
    previous_aspect: NSSize,
    previous_min: NSSize,
    previous_max: NSSize,
    previous_behavior: NSWindowCollectionBehavior,
    available: Option<NSSize>,
}

/// 由主线程系统确认 WINIT_WINDOWS 中仍存活的窗口后调用，不能用于伪造句柄。
pub(super) fn install(handle: &RawHandleWrapper) -> Result<NativeWindowPolicy, String> {
    let _main_thread = MainThreadMarker::new().ok_or("window_thread_required")?;
    let RawWindowHandle::AppKit(raw) = handle.get_window_handle() else {
        return Err("appkit_window_handle_required".into());
    };
    // 句柄来自仍在 WinitWindows 中的主窗口；此处只在主线程借用真实 NSView。
    let view = unsafe { &*raw.ns_view.as_ptr().cast::<NSView>() };
    let window = view.window().ok_or("native_window_not_ready")?;
    let mut guard = NativeWindowPolicy {
        previous_aspect: window.contentAspectRatio(),
        previous_min: window.contentMinSize(),
        previous_max: window.contentMaxSize(),
        previous_behavior: window.collectionBehavior(),
        window,
        available: None,
    };
    guard
        .window
        .setContentAspectRatio(NSSize::new(f64::from(WIDTH_UNIT), f64::from(HEIGHT_UNIT)));
    // 非 16:9 屏幕的全屏／平铺会绕过普通缩放，保留普通比例窗口的 Zoom。
    let mut behavior = guard.previous_behavior;
    behavior.remove(
        NSWindowCollectionBehavior::FullScreenPrimary
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::FullScreenAllowsTiling,
    );
    behavior.insert(
        NSWindowCollectionBehavior::FullScreenNone
            | NSWindowCollectionBehavior::FullScreenDisallowsTiling,
    );
    guard.window.setCollectionBehavior(behavior);
    guard.refresh_bounds();
    Ok(guard)
}

impl NativeWindowPolicy {
    pub(super) fn is_alive(&self) -> bool {
        // Retained 保证 NSWindow 存活；是否仍属游戏由父模块的实体／后端查询决定。
        true
    }

    /// 跨屏时更新工作区约束；也检查系统 Zoom 等请求是否绕过用户拖拽约束。
    pub(super) fn refresh_bounds(&mut self) {
        let Some(screen) = self.window.screen() else {
            return;
        };
        let frame = self.window.frame();
        let content = self.window.contentRectForFrameRect(frame);
        let visible = screen.visibleFrame();
        let available = NSSize::new(
            (visible.size.width - (frame.size.width - content.size.width))
                .max(f64::from(WIDTH_UNIT)),
            (visible.size.height - (frame.size.height - content.size.height))
                .max(f64::from(HEIGHT_UNIT)),
        );
        let maximum = fit_size(available);
        // 工作区不足最小支持尺寸时，以能完整放入屏幕为先，并记录该边界。
        let minimum = NSSize::new(
            f64::from(MIN_LOGICAL_SIZE.x).min(maximum.width),
            f64::from(MIN_LOGICAL_SIZE.y).min(maximum.height),
        );
        if self.available != Some(available) {
            self.available = Some(available);
            if minimum.width < f64::from(MIN_LOGICAL_SIZE.x) {
                bevy::log::warn!(
                    width = maximum.width,
                    height = maximum.height,
                    reason = "small_work_area",
                    "Window size below supported UI minimum"
                );
            }
            self.window.setContentMinSize(minimum);
            self.window.setContentMaxSize(maximum);
        }
        // 普通拖拽已由 contentAspectRatio 限制；仅校准绕过该属性的系统尺寸请求。
        let size = content.size;
        let width = size.width.clamp(minimum.width, maximum.width);
        let height = (width * f64::from(HEIGHT_UNIT) / f64::from(WIDTH_UNIT))
            .clamp(minimum.height, maximum.height);
        let constrained = NSSize::new(
            height * f64::from(WIDTH_UNIT) / f64::from(HEIGHT_UNIT),
            height,
        );
        if (size.width - constrained.width).abs() > CONTENT_SIZE_TOLERANCE_POINTS
            || (size.height - constrained.height).abs() > CONTENT_SIZE_TOLERANCE_POINTS
        {
            self.window.setContentSize(constrained);
            bevy::log::info!(
                width_before = size.width,
                height_before = size.height,
                width_after = constrained.width,
                height_after = constrained.height,
                reason = "window_manager_size",
                "Native window size constrained"
            );
        }
    }
}

/// 内容区扣除标题栏后，选择工作区内最大的整数 16:9 尺寸。
pub(super) fn fit_size(available: NSSize) -> NSSize {
    let unit = (available.width / f64::from(WIDTH_UNIT))
        .min(available.height / f64::from(HEIGHT_UNIT))
        .floor()
        .max(1.0);
    NSSize::new(unit * f64::from(WIDTH_UNIT), unit * f64::from(HEIGHT_UNIT))
}

impl Drop for NativeWindowPolicy {
    fn drop(&mut self) {
        self.window.setContentAspectRatio(self.previous_aspect);
        self.window.setContentMinSize(self.previous_min);
        self.window.setContentMaxSize(self.previous_max);
        self.window.setCollectionBehavior(self.previous_behavior);
    }
}
