//! A lock-free operation label shared by all desktop windows.
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
        match self.0.load(Ordering::Acquire) {
            1 => "starting",
            2 => "restoring",
            3 => "checking",
            _ => "idle",
        }
    }
}
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        self.0 .0.store(0, Ordering::Release);
    }
}
