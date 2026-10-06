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
            _ => "checking",
        }
    }
}
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        self.0 .0.store(0, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_slow_operation_does_not_block_status_readers() {
        let operation = std::sync::Mutex::new(());
        let activity = Activity::default();
        let _operation = operation.lock().unwrap();
        let guard = activity.begin(1);
        assert!(operation.try_lock().is_err());
        assert_eq!(activity.phase(), "starting");
        drop(guard);
        assert_eq!(activity.phase(), "checking");
    }
}
