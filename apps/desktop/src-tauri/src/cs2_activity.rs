//! A lock-free operation label shared by all desktop windows.
use crate::desktop_types::Cs2ActivityPhase;
use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Default)]
pub struct Activity(AtomicU8);
pub struct Guard<'a>(&'a Activity);
impl Activity {
    pub fn begin(&self, phase: u8) -> Guard<'_> {
        self.0.store(phase, Ordering::Release);
        Guard(self)
    }
    pub fn phase(&self) -> &'static str {
        self.phase_value().name()
    }
    pub fn phase_value(&self) -> Cs2ActivityPhase {
        match self.0.load(Ordering::Acquire) {
            1 => Cs2ActivityPhase::Starting,
            2 => Cs2ActivityPhase::Restoring,
            3 => Cs2ActivityPhase::Checking,
            _ => Cs2ActivityPhase::Idle,
        }
    }
}
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        self.0 .0.store(0, Ordering::Release);
    }
}
