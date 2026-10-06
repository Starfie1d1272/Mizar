#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub fn right(self) -> i32 { self.x + self.width }
    pub fn bottom(self) -> i32 { self.y + self.height }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    pub game: Rect,
    pub left: Rect,
    pub dock: Rect,
}

pub fn workspace_layout(work: Rect) -> Layout {
    let max_width = work.width * 3 / 4;
    let max_height = work.height * 3 / 4;
    let units = (max_width / 16).min(max_height / 9);
    let width = units * 16;
    let height = units * 9;
    let game = Rect { x: work.right() - width, y: work.y, width, height };
    Layout {
        game,
        left: Rect { x: work.x, y: work.y, width: game.x - work.x, height: work.height },
        dock: Rect { x: game.x, y: game.bottom(), width: game.width, height: work.bottom() - game.bottom() },
    }
}

pub fn overlap(a: Rect, b: Rect) -> i64 {
    let width = (a.right().min(b.right()) - a.x.max(b.x)).max(0) as i64;
    let height = (a.bottom().min(b.bottom()) - a.y.max(b.y)).max(0) as i64;
    width * height
}

/// CS2's non-client borders extend beyond its aligned client viewport.
pub fn avoid_game_frame(mut layout: Layout, outer: Rect) -> Layout {
    let bottom = layout.dock.bottom();
    layout.left.width = (outer.x.min(layout.game.x) - layout.left.x).max(0);
    layout.dock.y = outer.bottom().max(layout.game.bottom()).min(bottom);
    layout.dock.height = bottom - layout.dock.y;
    layout
}

pub fn overlay_visible(valid: bool, minimized: bool, client: Rect, foreground_owned: bool) -> bool {
    valid && !minimized && client.width > 0 && client.height > 0 && foreground_owned
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_common_work_areas() {
        for (width, height, game_width, game_height, left_width, dock_height) in [
            (1920, 1080, 1440, 810, 480, 270),
            (2560, 1440, 1920, 1080, 640, 360),
            (3840, 2160, 2880, 1620, 960, 540),
        ] {
            let layout = workspace_layout(Rect { x: 100, y: 50, width, height });
            assert_eq!(layout.game, Rect { x: 100 + left_width, y: 50, width: game_width, height: game_height });
            assert_eq!(layout.left.width, left_width);
            assert_eq!(layout.left.height, height);
            assert_eq!(layout.dock.x, layout.game.x);
            assert_eq!(layout.dock.width, game_width);
            assert_eq!(layout.dock.height, dock_height);
        }
    }
    #[test]
    fn non_widescreen_work_area_and_monitor_intersection() {
        let work = Rect { x: -1280, y: 0, width: 1280, height: 1024 };
        let layout = workspace_layout(work);
        assert_eq!(layout.game.width * 9, layout.game.height * 16);
        assert_eq!(layout.game.right(), work.right());
        assert_eq!(layout.dock.bottom(), work.bottom());
        assert_eq!(overlap(Rect { x: -50, y: 0, width: 100, height: 100 }, work), 5000);
    }
    #[test]
    fn overlay_policy_fails_closed() {
        let area = Rect { x: 0, y: 0, width: 1920, height: 1080 };
        assert!(overlay_visible(true, false, area, true));
        assert!(!overlay_visible(true, true, area, true));
        assert!(!overlay_visible(true, false, area, false));
        assert!(!overlay_visible(false, false, area, true));
    }
    #[test]
    fn game_borders_cannot_cover_the_left_panel_or_dock_at_any_scale() {
        for border in [0, 8, 10, 12, 16] {
            let layout = workspace_layout(Rect { x: -2560, y: 0, width: 2560, height: 1440 });
            let outer = Rect { x: layout.game.x - border, y: -30, width: layout.game.width + border * 2, height: layout.game.height + 30 + border };
            let safe = avoid_game_frame(layout, outer);
            assert_eq!(safe.game, layout.game);
            assert_eq!(safe.left.right(), outer.x);
            assert_eq!(safe.dock.y, outer.bottom());
            assert_eq!(safe.dock.bottom(), 1440);
            assert_eq!(overlap(safe.left, outer), 0);
            assert_eq!(overlap(safe.dock, outer), 0);
        }
    }
}
