// Run from src-tauri: rustc ipc_generate.rs -o <temporary-path> && <temporary-path>
mod ipc_commands;
fn main() {
    std::fs::write(
        "../../web/src/workspace/desktop-commands.generated.ts",
        ipc_commands::frontend_commands(),
    )
    .expect("write generated frontend commands");
}
