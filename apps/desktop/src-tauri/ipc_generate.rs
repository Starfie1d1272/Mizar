// Run from src-tauri: rustc --edition=2021 ipc_generate.rs -o <temporary-path> && <temporary-path>
mod ipc_contract;
mod ipc_contract_generate;
fn main() {
    std::fs::write(
        "../../../packages/protocol/src/desktop-ipc.generated.ts",
        ipc_contract_generate::frontend_contract(),
    )
    .expect("write generated lifecycle contracts");
}
