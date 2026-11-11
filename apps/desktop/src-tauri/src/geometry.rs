#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub fn right(self) -> i32 {
        self.x + self.width
    }
    pub fn bottom(self) -> i32 {
        self.y + self.height
    }
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
    let game = Rect {
        x: work.right() - width,
        y: work.y,
        width,
        height,
    };
    Layout {
        game,
        left: Rect {
            x: work.x,
            y: work.y,
            width: game.x - work.x,
            height: work.height,
        },
        dock: Rect {
            x: game.x,
            y: game.bottom(),
            width: game.width,
            height: work.bottom() - game.bottom(),
        },
    }
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
