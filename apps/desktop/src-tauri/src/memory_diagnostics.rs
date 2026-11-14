//! Read-only system commitment and this Host's memory; no unrelated process inventory.
use windows::Win32::System::{
    ProcessStatus::{
        GetPerformanceInfo, GetProcessMemoryInfo, PERFORMANCE_INFORMATION,
        PROCESS_MEMORY_COUNTERS_EX,
    },
    Threading::GetCurrentProcess,
};

pub fn snapshot() -> serde_json::Value {
    let mut process = PROCESS_MEMORY_COUNTERS_EX::default();
    let mut system = PERFORMANCE_INFORMATION::default();
    let process_result = unsafe {
        GetProcessMemoryInfo(
            GetCurrentProcess(),
            (&mut process as *mut PROCESS_MEMORY_COUNTERS_EX).cast(),
            std::mem::size_of_val(&process) as u32,
        )
    };
    let system_result = unsafe {
        GetPerformanceInfo(
            &mut system,
            std::mem::size_of::<PERFORMANCE_INFORMATION>() as u32,
        )
    };
    serde_json::json!({
        "host": match process_result {
            Ok(()) => serde_json::json!({
                "privateBytes": process.PrivateUsage,
                "workingSetBytes": process.WorkingSetSize,
            }),
            Err(error) => serde_json::json!({"error": error.to_string()}),
        },
        "system": match system_result {
            Ok(()) => serde_json::json!({
                "commitBytes": system.CommitTotal.saturating_mul(system.PageSize),
                "commitLimitBytes": system.CommitLimit.saturating_mul(system.PageSize),
                "physicalTotalBytes": system.PhysicalTotal.saturating_mul(system.PageSize),
                "physicalAvailableBytes": system.PhysicalAvailable.saturating_mul(system.PageSize),
            }),
            Err(error) => serde_json::json!({"error": error.to_string()}),
        },
        "scope": "host process and system totals; excludes per-process WebView2, CS2 and OBS memory",
    })
}

pub fn record(log: &crate::startup_log::DesktopLog, reason: &str) {
    log.event("memory_snapshot", reason, Some(&snapshot().to_string()));
}
