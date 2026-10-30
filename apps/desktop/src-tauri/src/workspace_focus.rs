//! Focus is a consumed user intent, never a worker retry or layout side effect.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Session {
    pub pid: u32,
    pub created: u64,
}

#[derive(Default)]
pub struct Entry {
    attempted: Option<Session>,
}
impl Entry {
    pub fn request(&mut self, session: Session, source: isize) -> Option<Request> {
        if self.attempted == Some(session) {
            return None;
        }
        // Even an unavailable target or a user who has switched away consumes
        // initial entry. Only a new explicit action may attempt focus again.
        self.attempted = Some(session);
        Request::new(session, source)
    }
}

pub struct Request {
    session: Session,
    source: isize,
}
impl Request {
    pub fn new(session: Session, source: isize) -> Option<Self> {
        (source != 0).then_some(Self { session, source })
    }
    pub fn attempt(
        self,
        session: Session,
        foreground: isize,
        eligible: bool,
        focus: impl FnOnce(isize) -> bool,
    ) -> bool {
        eligible && self.session == session && foreground == self.source && focus(self.source)
    }
}

/// Wait for the render window, not for permission to steal foreground.
/// This runs before panel presentation, off the UI thread. Terminal decisions
/// stay terminal even if the operator later returns to the preparation window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadinessState {
    Waiting,
    Ready,
    Cancelled,
    TimedOut,
}
pub struct Readiness {
    source: isize,
    deadline: std::time::Instant,
    state: ReadinessState,
}
impl Readiness {
    pub fn new(source: isize, now: std::time::Instant) -> Self {
        Self {
            source,
            deadline: now + std::time::Duration::from_secs(30),
            state: ReadinessState::Waiting,
        }
    }
    pub fn poll(
        &mut self,
        now: std::time::Instant,
        foreground: isize,
        eligible: bool,
        window_ready: bool,
    ) -> ReadinessState {
        if self.state != ReadinessState::Waiting {
            return self.state;
        }
        self.state = if !eligible || self.source == 0 || foreground != self.source {
            ReadinessState::Cancelled
        } else if now >= self.deadline {
            ReadinessState::TimedOut
        } else if window_ready {
            ReadinessState::Ready
        } else {
            ReadinessState::Waiting
        };
        self.state
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SESSION: Session = Session {
        pid: 42,
        created: 100,
    };

    #[test]
    fn queued_request_cannot_override_new_selection_exit_or_reused_pid() {
        for (session, foreground, eligible) in [
            (SESSION, 20, true),  // Another panel or external app selected.
            (SESSION, 10, false), // Hidden, exiting or game activity began.
            (
                Session {
                    created: 101,
                    ..SESSION
                },
                10,
                true,
            ),
        ] {
            assert!(!Request::new(SESSION, 10).unwrap().attempt(
                session,
                foreground,
                eligible,
                |_| panic!("stale intent must not activate a window")
            ));
        }
    }
}
