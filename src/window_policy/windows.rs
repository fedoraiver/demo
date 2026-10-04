//! 在 Win32 应用尺寸前约束客户区，保留 winit 的窗口过程与事件投递。

use std::{cell::Cell, rc::Rc};

use bevy::window::RawHandleWrapper;
use raw_window_handle::RawWindowHandle;
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
    Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromRect},
    UI::{
        HiDpi::{AdjustWindowRectExForDpi, GetDpiForWindow},
        Shell::{DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GWL_EXSTYLE, GWL_STYLE, GetMenu, GetWindowLongPtrW, GetWindowRect, MINMAXINFO,
            SC_MAXIMIZE, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
            SetWindowLongPtrW, SetWindowPos, WINDOWPOS, WM_DPICHANGED, WM_ENTERSIZEMOVE,
            WM_EXITSIZEMOVE, WM_GETMINMAXINFO, WM_NCDESTROY, WM_SIZING, WM_SYSCOMMAND,
            WM_WINDOWPOSCHANGING, WMSZ_BOTTOM, WMSZ_BOTTOMLEFT, WMSZ_BOTTOMRIGHT, WMSZ_LEFT,
            WMSZ_RIGHT, WMSZ_TOP, WMSZ_TOPLEFT, WMSZ_TOPRIGHT, WS_MAXIMIZE, WS_MINIMIZE,
        },
    },
};

use super::geometry::{
    HEIGHT_UNIT, Margins, Rect, ResizeEdge, WIDTH_UNIT, available_units, constrain_drag,
    constrain_request, fit_work_area, minimum_units,
};

const SUBCLASS_ID: usize = 0x4953_4c44;

/// guard 和原生回调各持有一个引用；Cell 只在创建窗口的主线程访问。
struct SubclassState {
    installed: Cell<bool>,
    dpi: Cell<u32>,
    drag_start_units: Cell<Option<f64>>,
}

/// 非 Send 的原生策略守护对象，由上层主线程资源持有至窗口销毁或插件释放。
pub(super) struct NativeWindowPolicy {
    hwnd: HWND,
    state: Rc<SubclassState>,
    callback_reference: *const SubclassState,
}

impl NativeWindowPolicy {
    /// 原生窗口销毁后，上层可以清理策略资源而无需再次访问失效 HWND。
    pub(super) fn is_alive(&self) -> bool {
        self.state.installed.get()
    }
}

impl Drop for NativeWindowPolicy {
    fn drop(&mut self) {
        if !self.state.installed.get() {
            return;
        }
        // guard 为 !Send，并由主线程资源持有；只有成功卸载才回收原生回调的引用。
        let removed =
            unsafe { RemoveWindowSubclass(self.hwnd, Some(window_subclass), SUBCLASS_ID) };
        if removed != 0 {
            self.state.installed.set(false);
            // 安装时由 Rc::into_raw 转交给回调的引用只在此处或 WM_NCDESTROY 回收一次。
            unsafe { drop(Rc::from_raw(self.callback_reference)) };
        } else {
            // 卸载失败时保留回调引用至 WM_NCDESTROY，防止 HWND 仍能调用已释放的数据。
            bevy::log::warn!(
                error = %std::io::Error::last_os_error(),
                reason = "subclass_removal_failed",
                "Native window policy removal deferred until window destruction"
            );
        }
    }
}

/// 上层系统以 NonSendMarker 在窗口线程确认后端存在；安装与原生回调均留在该线程。
pub(super) fn install(handle: &RawHandleWrapper) -> Result<NativeWindowPolicy, String> {
    let RawWindowHandle::Win32(handle) = handle.get_window_handle() else {
        return Err("Unsupported native window handle".into());
    };
    let hwnd = handle.hwnd.get() as HWND;
    let mut old_reference = 0;
    // HWND 来自仍存活的 Bevy 主窗口；同一回调与 ID 不允许重复安装并覆盖所有权。
    if unsafe { GetWindowSubclass(hwnd, Some(window_subclass), SUBCLASS_ID, &mut old_reference) }
        != 0
    {
        return Err("Native window policy is already installed".into());
    }
    // Windows 的窗口 DPI 是两个轴共用的缩放因子；失败时使用标准 96 DPI。
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    let dpi = if dpi == 0 { 96 } else { dpi };
    let state = Rc::new(SubclassState {
        installed: Cell::new(true),
        dpi: Cell::new(dpi),
        drag_start_units: Cell::new(None),
    });
    let callback_reference = Rc::into_raw(state.clone());
    // SetWindowSubclass 只保存引用值，不接管 Rust 所有权；失败时立即回收该引用。
    if unsafe {
        SetWindowSubclass(
            hwnd,
            Some(window_subclass),
            SUBCLASS_ID,
            callback_reference as usize,
        )
    } == 0
    {
        unsafe { drop(Rc::from_raw(callback_reference)) };
        return Err(format!(
            "Failed to install native window policy: {}",
            std::io::Error::last_os_error()
        ));
    }
    let policy = NativeWindowPolicy {
        hwnd,
        state,
        callback_reference,
    };
    // 安装期间窗口仍隐藏；一次性调整初始客户区，此后的尺寸都在原生消息应用前约束。
    if let (Some(rect), Some(margins)) = (window_rect(hwnd), window_margins(hwnd, dpi)) {
        let work_area = monitor_rect(rect).map(|info| info.rcWork.into());
        let constrained = constrain_request(rect.into(), margins, dpi, work_area);
        // 原生子类已经持有有效引用，初始化产生的嵌套消息同样经过该策略。
        if unsafe {
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                constrained.left,
                constrained.top,
                constrained.right - constrained.left,
                constrained.bottom - constrained.top,
                SWP_NOZORDER | SWP_NOACTIVATE,
            )
        } == 0
        {
            return Err(format!(
                "Failed to initialize constrained native window size: {}",
                std::io::Error::last_os_error()
            ));
        }
    } else {
        return Err("Failed to inspect native window geometry".into());
    }
    Ok(policy)
}

/// 子类链只拦截窗口管理消息，鼠标、键盘与其他输入继续由 winit 和 Enhanced Input 处理。
unsafe extern "system" fn window_subclass(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _: usize,
    reference_data: usize,
) -> LRESULT {
    // 原生安装引用在卸载前始终有效；临时引用保护嵌套消息期间的资源清理。
    let pointer = reference_data as *const SubclassState;
    unsafe { Rc::increment_strong_count(pointer) };
    let state = unsafe { Rc::from_raw(pointer) };
    if message == WM_NCDESTROY {
        // 先停止未来回调，再释放安装引用；本次临时引用一直保护数据至窗口过程返回。
        if state.installed.replace(false) {
            unsafe { RemoveWindowSubclass(hwnd, Some(window_subclass), SUBCLASS_ID) };
            unsafe { drop(Rc::from_raw(pointer)) };
        }
        return unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
    }

    // Rust panic 不得越过系统 ABI；异常时仍保留原窗口过程的清理和输入处理。
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        process_message(hwnd, message, wparam, lparam, &state)
    }))
    .unwrap_or_else(|_| unsafe { DefSubclassProc(hwnd, message, wparam, lparam) })
}

fn process_message(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    state: &SubclassState,
) -> LRESULT {
    match message {
        WM_ENTERSIZEMOVE => {
            let reference = window_rect(hwnd)
                .zip(window_margins(hwnd, state.dpi.get()))
                .map(|(rect, margins)| {
                    (rect.right - rect.left - margins.width()) as f64 / WIDTH_UNIT as f64
                });
            // 系统拖框沿拖动起点产生请求，整个手势固定参考值，避免上次约束反馈成反向放大。
            state.drag_start_units.set(reference);
            unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
        }
        WM_EXITSIZEMOVE => {
            state.drag_start_units.set(None);
            if let (Some(rect), Some(margins)) =
                (window_rect(hwnd), window_margins(hwnd, state.dpi.get()))
            {
                bevy::log::info!(
                    physical_width = rect.right - rect.left - margins.width(),
                    physical_height = rect.bottom - rect.top - margins.height(),
                    dpi = state.dpi.get(),
                    reason = "window_size_move_completed",
                    "Native window size and position changed"
                );
            }
            unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
        }
        WM_SIZING if lparam != 0 => {
            // lParam 在 WM_SIZING 中由系统提供可写 RECT，改写发生在窗口尺寸应用前。
            let rect = unsafe { &mut *(lparam as *mut RECT) };
            if let Some(margins) = window_margins(hwnd, state.dpi.get()) {
                let work_area = monitor_rect(*rect).map(|info| info.rcWork.into());
                let Some(edge) = resize_edge(wparam as u32) else {
                    return unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
                };
                *rect = constrain_drag(
                    (*rect).into(),
                    edge,
                    margins,
                    state.dpi.get(),
                    work_area,
                    state.drag_start_units.get(),
                )
                .into();
            }
            // 不调用默认 WM_SIZING，避免独立宽高步进再次改变已经约束的比例。
            1
        }
        WM_DPICHANGED => {
            let dpi = wparam as u32 & 0xffff;
            let dpi_before = state.dpi.replace(if dpi == 0 { 96 } else { dpi });
            if let Some(reference) = state.drag_start_units.get() {
                // 跨屏时拖动参考同时换算到新的物理坐标，仍保持同一个逻辑拖动起点。
                state
                    .drag_start_units
                    .set(Some(reference * state.dpi.get() as f64 / dpi_before as f64));
            }
            bevy::log::info!(
                dpi_before,
                dpi_after = state.dpi.get(),
                reason = "window_dpi_changed",
                "Native window policy DPI changed"
            );
            // winit 接收 DPI 消息并保持内部比例与 Bevy 一致；其尺寸请求仍经过本子类约束。
            unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
        }
        WM_SYSCOMMAND if (wparam as u32 & 0xfff0) == SC_MAXIMIZE => {
            if let (Some(rect), Some(margins)) =
                (window_rect(hwnd), window_margins(hwnd, state.dpi.get()))
                && let Some(info) = monitor_rect(rect)
            {
                let expanded = fit_work_area(info.rcWork.into(), margins);
                // 系统最大化转为最大 16:9 普通窗口，避免显示器比例影响游戏客户区。
                let applied = unsafe {
                    SetWindowPos(
                        hwnd,
                        std::ptr::null_mut(),
                        expanded.left,
                        expanded.top,
                        expanded.right - expanded.left,
                        expanded.bottom - expanded.top,
                        SWP_NOZORDER | SWP_NOACTIVATE,
                    )
                };
                if applied != 0 {
                    bevy::log::info!(
                        reason = "maximize_request",
                        "Native window expanded within aspect ratio constraints"
                    );
                } else {
                    bevy::log::error!(
                        error = %std::io::Error::last_os_error(),
                        reason = "maximize_request_failed",
                        "Failed to expand native window within aspect ratio constraints"
                    );
                }
            }
            0
        }
        WM_GETMINMAXINFO if lparam != 0 => {
            // 先保留 winit 配置的原生生命周期处理，再覆写最终的客户区尺寸约束。
            let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            if let (Some(rect), Some(margins)) =
                (window_rect(hwnd), window_margins(hwnd, state.dpi.get()))
                && let Some(info) = monitor_rect(rect)
            {
                // 消息处理期间 MINMAXINFO 指针由系统保证有效且可写。
                let limits = unsafe { &mut *(lparam as *mut MINMAXINFO) };
                let max_rect = fit_work_area(info.rcWork.into(), margins);
                let max_units = available_units(info.rcWork.into(), margins);
                let min_units = minimum_units(state.dpi.get()).min(max_units);
                limits.ptMinTrackSize.x = min_units * WIDTH_UNIT + margins.width();
                limits.ptMinTrackSize.y = min_units * HEIGHT_UNIT + margins.height();
                limits.ptMaxTrackSize.x = max_rect.right - max_rect.left;
                limits.ptMaxTrackSize.y = max_rect.bottom - max_rect.top;
                limits.ptMaxSize = limits.ptMaxTrackSize;
                limits.ptMaxPosition.x = max_rect.left - info.rcMonitor.left;
                limits.ptMaxPosition.y = max_rect.top - info.rcMonitor.top;
            }
            result
        }
        WM_WINDOWPOSCHANGING if lparam != 0 => {
            // 默认过程可能先根据 MINMAXINFO 改写请求，最终约束必须在其后执行。
            let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
            // 系统在应用前提供可写 WINDOWPOS；只改尺寸请求，不事后重新请求 resize。
            let position = unsafe { &mut *(lparam as *mut WINDOWPOS) };
            let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } as u32;
            let size_unchanged = position.flags & SWP_NOSIZE != 0;
            // winit 的样式刷新会以 NOSIZE|FRAMECHANGED 重装边框；外框不变也可能改变客户区。
            if size_unchanged && position.flags & SWP_FRAMECHANGED == 0 && style & WS_MAXIMIZE == 0
            {
                return result;
            }
            if !size_unchanged && (position.cx <= 0 || position.cy <= 0) {
                return result;
            }
            // 最小化的离屏系统尺寸不属于可见游戏客户区，必须继续保留正常最小化流程。
            if style & WS_MINIMIZE != 0 {
                return result;
            }
            let Some(current) = window_rect(hwnd) else {
                return result;
            };
            let x = if position.flags & SWP_NOMOVE == 0 {
                position.x
            } else {
                current.left
            };
            let y = if position.flags & SWP_NOMOVE == 0 {
                position.y
            } else {
                current.top
            };
            let proposed = RECT {
                left: x,
                top: y,
                right: x.saturating_add(if size_unchanged {
                    current.right - current.left
                } else {
                    position.cx
                }),
                bottom: y.saturating_add(if size_unchanged {
                    current.bottom - current.top
                } else {
                    position.cy
                }),
            };
            if style & WS_MAXIMIZE != 0 {
                // ShowWindow 等入口可能绕过 SC_MAXIMIZE，应用前去掉最大化样式并使用普通边框。
                unsafe { SetWindowLongPtrW(hwnd, GWL_STYLE, (style & !WS_MAXIMIZE) as isize) };
                position.flags |= SWP_FRAMECHANGED;
            }
            if let Some(margins) = window_margins(hwnd, state.dpi.get()) {
                let work_area = monitor_rect(proposed).map(|info| info.rcWork.into());
                let constrained = if style & WS_MAXIMIZE != 0 {
                    work_area
                        .map(|work| fit_work_area(work, margins))
                        .unwrap_or(proposed.into())
                } else {
                    constrain_request(proposed.into(), margins, state.dpi.get(), work_area)
                };
                position.x = constrained.left;
                position.y = constrained.top;
                position.cx = constrained.right - constrained.left;
                position.cy = constrained.bottom - constrained.top;
                position.flags &= !(SWP_NOMOVE | SWP_NOSIZE);
            }
            result
        }
        _ => {
            // DefSubclassProc 延续子类链，不能调用 DefWindowProc 跳过 winit 原窗口过程。
            unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
        }
    }
}

fn window_margins(hwnd: HWND, dpi: u32) -> Option<Margins> {
    // 只查询当前 HWND 的边框和菜单样式；这些 API 与下方 RECT 都限于主线程。
    let (style, extended_style, has_menu) = unsafe {
        (
            GetWindowLongPtrW(hwnd, GWL_STYLE) as u32,
            GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32,
            !GetMenu(hwnd).is_null(),
        )
    };
    let mut rect = RECT::default();
    // 按本次 DPI 计算非客户区，而非把标题栏也错误地当成 16:9 内容区域。
    if unsafe { AdjustWindowRectExForDpi(&mut rect, style, has_menu as i32, extended_style, dpi) }
        == 0
    {
        return None;
    }
    Some(Margins {
        left: -rect.left,
        top: -rect.top,
        right: rect.right,
        bottom: rect.bottom,
    })
}

fn window_rect(hwnd: HWND) -> Option<RECT> {
    let mut rect = RECT::default();
    // HWND 仅来自仍存活的原生回调或主线程安装流程；失败不访问未初始化数据。
    (unsafe { GetWindowRect(hwnd, &mut rect) } != 0).then_some(rect)
}

fn monitor_rect(rect: RECT) -> Option<MONITORINFO> {
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    // RECT 是屏幕物理坐标，选择请求所在显示器以覆盖跨屏拖动与系统贴靠。
    let monitor = unsafe { MonitorFromRect(&rect, MONITOR_DEFAULTTONEAREST) };
    (unsafe { GetMonitorInfoW(monitor, &mut info) } != 0).then_some(info)
}

impl From<RECT> for Rect {
    fn from(rect: RECT) -> Self {
        Self {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        }
    }
}

impl From<Rect> for RECT {
    fn from(rect: Rect) -> Self {
        Self {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        }
    }
}

fn resize_edge(edge: u32) -> Option<ResizeEdge> {
    match edge {
        WMSZ_LEFT => Some(ResizeEdge::Left),
        WMSZ_RIGHT => Some(ResizeEdge::Right),
        WMSZ_TOP => Some(ResizeEdge::Top),
        WMSZ_BOTTOM => Some(ResizeEdge::Bottom),
        WMSZ_TOPLEFT => Some(ResizeEdge::TopLeft),
        WMSZ_TOPRIGHT => Some(ResizeEdge::TopRight),
        WMSZ_BOTTOMLEFT => Some(ResizeEdge::BottomLeft),
        WMSZ_BOTTOMRIGHT => Some(ResizeEdge::BottomRight),
        _ => None,
    }
}
