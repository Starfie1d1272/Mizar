// Run from src-tauri: rustc --edition=2021 ipc_generate.rs -o <temporary-path> && <temporary-path>
mod ipc_commands;
mod ipc_lifecycle_contract;
mod ipc_lifecycle_generate;
fn main() {
    std::fs::write(
        "../../web/src/workspace/desktop-commands.generated.ts",
        ipc_commands::frontend_commands(),
    )
    .expect("write generated frontend commands");
    std::fs::write(
        "../../../packages/protocol/src/desktop-lifecycle.generated.ts",
        ipc_lifecycle_generate::frontend_lifecycle(),
    )
    .expect("write generated lifecycle contracts");
}
