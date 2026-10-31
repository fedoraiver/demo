//! Win32 窗口几何只计算值，供原生桥接与无窗口回归共用。

use super::MIN_LOGICAL_SIZE;
pub(super) use super::{HEIGHT_UNIT, WIDTH_UNIT};

const WINDOWS_BASE_DPI: f64 = 96.0;

/// 外框使用屏幕物理坐标；与 Win32 RECT 的转换仅留在平台桥接内。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Rect {
    pub(super) left: i32,
    pub(super) top: i32,
    pub(super) right: i32,
    pub(super) bottom: i32,
}

/// 用拖边身份决定对边或相对角锚点，不保存额外的全局拖动状态。
#[derive(Clone, Copy, Debug)]
pub(super) enum ResizeEdge {
    Left,
    Right,
    Top,
    Bottom,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct Margins {
    pub(super) left: i32,
    pub(super) top: i32,
    pub(super) right: i32,
    pub(super) bottom: i32,
}

impl Margins {
    pub(super) fn width(self) -> i32 {
        self.left + self.right
    }

    pub(super) fn height(self) -> i32 {
        self.top + self.bottom
    }
}

pub(super) fn minimum_units(dpi: u32) -> i32 {
    let scale = dpi as f64 / WINDOWS_BASE_DPI;
    ((MIN_LOGICAL_SIZE.x as f64 * scale / WIDTH_UNIT as f64)
        .max(MIN_LOGICAL_SIZE.y as f64 * scale / HEIGHT_UNIT as f64)
        .ceil()) as i32
}

pub(super) fn available_units(work: Rect, margins: Margins) -> i32 {
    ((work.right - work.left - margins.width()) / WIDTH_UNIT)
        .min((work.bottom - work.top - margins.height()) / HEIGHT_UNIT)
        .max(1)
}

fn bounded_units(units: i32, dpi: u32, work: Option<Rect>, margins: Margins) -> i32 {
    let maximum = work
        .map(|work| available_units(work, margins))
        .unwrap_or(i32::MAX / WIDTH_UNIT);
    // 低分辨率工作区容不下逻辑最小尺寸时，优先保留完整可见的窗口。
    units.clamp(minimum_units(dpi).min(maximum), maximum)
}

pub(super) fn fit_work_area(work: Rect, margins: Margins) -> Rect {
    let units = available_units(work, margins);
    let width = units * WIDTH_UNIT + margins.width();
    let height = units * HEIGHT_UNIT + margins.height();
    let left = work.left + (work.right - work.left - width) / 2;
    let top = work.top + (work.bottom - work.top - height) / 2;
    Rect {
        left,
        top,
        right: left + width,
        bottom: top + height,
    }
}

pub(super) fn constrain_request(
    rect: Rect,
    margins: Margins,
    dpi: u32,
    work: Option<Rect>,
) -> Rect {
    let units = ((rect.right - rect.left - margins.width()) / WIDTH_UNIT)
        .min((rect.bottom - rect.top - margins.height()) / HEIGHT_UNIT);
    let units = bounded_units(units, dpi, work, margins);
    let width = units * WIDTH_UNIT + margins.width();
    let height = units * HEIGHT_UNIT + margins.height();
    let mut left = rect.left + (rect.right - rect.left - width) / 2;
    let mut top = rect.top + (rect.bottom - rect.top - height) / 2;
    if let Some(work) = work {
        left = left.clamp(work.left, (work.right - width).max(work.left));
        top = top.clamp(work.top, (work.bottom - height).max(work.top));
    }
    Rect {
        left,
        top,
        right: left + width,
        bottom: top + height,
    }
}

pub(super) fn constrain_drag(
    rect: Rect,
    edge: ResizeEdge,
    margins: Margins,
    dpi: u32,
    work: Option<Rect>,
    reference_units: Option<f64>,
) -> Rect {
    let horizontal_units = (rect.right - rect.left - margins.width()) as f64 / WIDTH_UNIT as f64;
    let vertical_units = (rect.bottom - rect.top - margins.height()) as f64 / HEIGHT_UNIT as f64;
    let units = match edge {
        ResizeEdge::Left | ResizeEdge::Right => horizontal_units,
        ResizeEdge::Top | ResizeEdge::Bottom => vertical_units,
        _ => {
            // 角拖拽采用相对拖动起点变化更大的轴；参考不能跟随每次约束更新，否则会反跳。
            if let Some(reference) = reference_units {
                if (horizontal_units - reference).abs() >= (vertical_units - reference).abs() {
                    horizontal_units
                } else {
                    vertical_units
                }
            } else {
                // 窗口查询失败时投影到比例线，不依赖保存的全局拖动状态。
                (horizontal_units * 256.0 + vertical_units * 81.0) / 337.0
            }
        }
    };
    let units = bounded_units(units.round() as i32, dpi, work, margins);
    let width = units * WIDTH_UNIT + margins.width();
    let height = units * HEIGHT_UNIT + margins.height();
    // 单边缩放保持对边与另一轴中心；角缩放保持相对角，避免拖左上角时窗口漂移。
    let left = match edge {
        ResizeEdge::Left | ResizeEdge::TopLeft | ResizeEdge::BottomLeft => rect.right - width,
        ResizeEdge::Top | ResizeEdge::Bottom => rect.left + (rect.right - rect.left - width) / 2,
        _ => rect.left,
    };
    let top = match edge {
        ResizeEdge::Top | ResizeEdge::TopLeft | ResizeEdge::TopRight => rect.bottom - height,
        ResizeEdge::Left | ResizeEdge::Right => rect.top + (rect.bottom - rect.top - height) / 2,
        _ => rect.top,
    };
    Rect {
        left,
        top,
        right: left + width,
        bottom: top + height,
    }
}
