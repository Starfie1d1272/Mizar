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

#[cfg(test)]
mod tests {
    use super::*;
    const SESSION: Session = Session {
        pid: 42,
        created: 100,
    };

    #[test]
    fn first_entry_is_consumed_even_when_focus_fails_or_user_switched_away() {
        let mut entry = Entry::default();
        let mut calls = 0;
        assert!(!entry
            .request(SESSION, 10)
            .unwrap()
            .attempt(SESSION, 10, true, |_| {
                calls += 1;
                false // Windows may deny foreground activation.
            }));
        assert!(entry.request(SESSION, 10).is_none());
        assert_eq!(calls, 1);
        let next = Session {
            created: 101,
            ..SESSION
        };
        assert!(entry.request(next, 0).is_none());
        assert!(entry.request(next, 10).is_none());
    }

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

    #[test]
    fn explicit_action_can_try_again_without_rearming_automatic_entry() {
        let mut entry = Entry::default();
        let _ = entry.request(SESSION, 0);
        let mut calls = 0;
        assert!(Request::new(SESSION, 20)
            .unwrap()
            .attempt(SESSION, 20, true, |source| {
                calls += 1;
                assert_eq!(source, 20);
                true
            }));
        assert_eq!(calls, 1);
        assert!(entry.request(SESSION, 20).is_none());
    }
}
