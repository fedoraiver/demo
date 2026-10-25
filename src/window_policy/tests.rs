//! 无窗口验证主窗口配置与平台尺寸约束。

use super::*;

#[test]
fn primary_window_has_supported_aspect_and_minimum_size() {
    let window = primary_window();
    assert_eq!(
        window.resolution.physical_width() * 9,
        window.resolution.physical_height() * 16
    );
    assert_eq!(window.resize_constraints.min_width, 960.0);
    assert_eq!(window.resize_constraints.min_height, 540.0);
    assert_eq!(window.mode, bevy::window::WindowMode::Windowed);
}

#[test]
fn headless_policy_does_not_require_native_window_or_create_one() {
    let mut app = App::new();
    app.add_plugins((MinimalPlugins, WindowPolicyPlugin));
    let entity = app
        .world_mut()
        .spawn((primary_window(), PrimaryWindow))
        .id();
    app.update();
    assert_eq!(
        app.world()
            .get::<Window>(entity)
            .unwrap()
            .resolution
            .physical_size(),
        INITIAL_SIZE
    );
    assert_eq!(
        app.world_mut().query::<&Window>().iter(app.world()).count(),
        1
    );
}

mod geometry_tests {
    use super::super::MIN_LOGICAL_SIZE;
    use super::super::geometry::*;

    const MARGINS: Margins = Margins {
        left: 8,
        top: 31,
        right: 8,
        bottom: 8,
    };

    fn assert_aspect(rect: Rect) {
        let width = rect.right - rect.left - MARGINS.width();
        let height = rect.bottom - rect.top - MARGINS.height();
        assert_eq!(width * HEIGHT_UNIT, height * WIDTH_UNIT);
    }

    #[test]
    fn drag_edges_and_corners_keep_opposite_anchors() {
        let proposed = Rect {
            left: 100,
            top: 200,
            right: 1468,
            bottom: 1024,
        };
        for edge in [
            ResizeEdge::Left,
            ResizeEdge::Right,
            ResizeEdge::Top,
            ResizeEdge::Bottom,
            ResizeEdge::TopLeft,
            ResizeEdge::TopRight,
            ResizeEdge::BottomLeft,
            ResizeEdge::BottomRight,
        ] {
            let result = constrain_drag(proposed, edge, MARGINS, 96, None, Some(80.0));
            assert_aspect(result);
            if matches!(
                edge,
                ResizeEdge::Left | ResizeEdge::TopLeft | ResizeEdge::BottomLeft
            ) {
                assert_eq!(result.right, proposed.right);
            }
            if matches!(
                edge,
                ResizeEdge::Right | ResizeEdge::TopRight | ResizeEdge::BottomRight
            ) {
                assert_eq!(result.left, proposed.left);
            }
            if matches!(
                edge,
                ResizeEdge::Top | ResizeEdge::TopLeft | ResizeEdge::TopRight
            ) {
                assert_eq!(result.bottom, proposed.bottom);
            }
            if matches!(
                edge,
                ResizeEdge::Bottom | ResizeEdge::BottomLeft | ResizeEdge::BottomRight
            ) {
                assert_eq!(result.top, proposed.top);
            }
            if matches!(edge, ResizeEdge::Left | ResizeEdge::Right) {
                assert!((result.top + result.bottom - proposed.top - proposed.bottom).abs() <= 1);
            }
            if matches!(edge, ResizeEdge::Top | ResizeEdge::Bottom) {
                assert!((result.left + result.right - proposed.left - proposed.right).abs() <= 1);
            }
        }
    }

    #[test]
    fn minimum_client_size_scales_with_dpi_and_stays_exact() {
        let tiny = Rect {
            left: 100,
            top: 100,
            right: 200,
            bottom: 200,
        };
        for dpi in [96, 120, 144, 168, 192] {
            let result = constrain_drag(
                tiny,
                ResizeEdge::BottomRight,
                MARGINS,
                dpi,
                None,
                Some(80.0),
            );
            assert_aspect(result);
            assert!(
                (result.right - result.left - MARGINS.width()) as f64
                    >= MIN_LOGICAL_SIZE.x as f64 * dpi as f64 / 96.0
            );
            assert!(
                (result.bottom - result.top - MARGINS.height()) as f64
                    >= MIN_LOGICAL_SIZE.y as f64 * dpi as f64 / 96.0
            );
        }
    }

    #[test]
    fn corner_drag_can_shrink_by_either_single_axis() {
        let current = Rect {
            left: 100,
            top: 200,
            right: 100 + 80 * WIDTH_UNIT + MARGINS.width(),
            bottom: 200 + 80 * HEIGHT_UNIT + MARGINS.height(),
        };
        for edge in [
            ResizeEdge::TopLeft,
            ResizeEdge::TopRight,
            ResizeEdge::BottomLeft,
            ResizeEdge::BottomRight,
        ] {
            for horizontal in [true, false] {
                let mut proposed = current;
                if horizontal {
                    if matches!(edge, ResizeEdge::TopLeft | ResizeEdge::BottomLeft) {
                        proposed.left += WIDTH_UNIT;
                    } else {
                        proposed.right -= WIDTH_UNIT;
                    }
                } else if matches!(edge, ResizeEdge::TopLeft | ResizeEdge::TopRight) {
                    proposed.top += HEIGHT_UNIT;
                } else {
                    proposed.bottom -= HEIGHT_UNIT;
                }
                let result = constrain_drag(proposed, edge, MARGINS, 96, None, Some(80.0));
                assert_aspect(result);
                assert_eq!(
                    result.right - result.left - MARGINS.width(),
                    79 * WIDTH_UNIT
                );
                assert_eq!(
                    result.bottom - result.top - MARGINS.height(),
                    79 * HEIGHT_UNIT
                );
            }
        }
    }

    #[test]
    fn repeated_corner_drag_requests_shrink_without_feedback_growth() {
        let start = Rect {
            left: 100,
            top: 200,
            right: 100 + 80 * WIDTH_UNIT + MARGINS.width(),
            bottom: 200 + 80 * HEIGHT_UNIT + MARGINS.height(),
        };
        for edge in [
            ResizeEdge::TopLeft,
            ResizeEdge::TopRight,
            ResizeEdge::BottomLeft,
            ResizeEdge::BottomRight,
        ] {
            for horizontal in [true, false] {
                let mut previous_units = 80;
                for pixels in [16, 18, 24, 32, 48, 64] {
                    let mut proposed = start;
                    if horizontal {
                        if matches!(edge, ResizeEdge::TopLeft | ResizeEdge::BottomLeft) {
                            proposed.left += pixels;
                        } else {
                            proposed.right -= pixels;
                        }
                    } else if matches!(edge, ResizeEdge::TopLeft | ResizeEdge::TopRight) {
                        proposed.top += pixels;
                    } else {
                        proposed.bottom -= pixels;
                    }
                    let result = constrain_drag(proposed, edge, MARGINS, 96, None, Some(80.0));
                    assert_aspect(result);
                    let units = (result.right - result.left - MARGINS.width()) / WIDTH_UNIT;
                    assert!(
                        units <= previous_units,
                        "corner drag grew from {previous_units} to {units}"
                    );
                    previous_units = units;
                }
                assert!(previous_units < 80);
            }
        }
    }

    #[test]
    fn expansion_and_snap_fit_non_widescreen_work_areas() {
        for work in [
            Rect {
                left: 0,
                top: 0,
                right: 1440,
                bottom: 860,
            },
            Rect {
                left: -1200,
                top: 0,
                right: 0,
                bottom: 1920,
            },
            Rect {
                left: 0,
                top: 0,
                right: 800,
                bottom: 560,
            },
        ] {
            let expanded = fit_work_area(work, MARGINS);
            let snap = constrain_request(work, MARGINS, 144, Some(work));
            for rect in [expanded, snap] {
                assert_aspect(rect);
                assert!(rect.left >= work.left && rect.top >= work.top);
                assert!(rect.right <= work.right && rect.bottom <= work.bottom);
                let repeated = constrain_request(rect, MARGINS, 144, Some(work));
                assert_eq!(
                    [rect.left, rect.top, rect.right, rect.bottom],
                    [repeated.left, repeated.top, repeated.right, repeated.bottom]
                );
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod macos_tests {
    use objc2_foundation::NSSize;

    use super::super::macos::fit_size;

    #[test]
    fn work_area_fit_keeps_aspect_on_wide_and_tall_screens() {
        for available in [
            NSSize::new(1920.0, 1055.0),
            NSSize::new(1512.0, 930.0),
            NSSize::new(2560.0, 1055.0),
            NSSize::new(720.0, 1280.0),
        ] {
            let size = fit_size(available);
            assert_eq!(size.width * 9.0, size.height * 16.0);
            assert!(size.width <= available.width && size.height <= available.height);
            assert!(size.width + 16.0 > available.width || size.height + 9.0 > available.height);
        }
    }
}
