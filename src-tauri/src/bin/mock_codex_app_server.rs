//! `cargo run --bin mock-codex-app-server` で stdio JSON-RPC 2.0 mock を起動する。
//! AS-132。

fn main() -> anyhow::Result<()> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    rt.block_on(asagi_lib::codex_sidecar::mock_server::run_stdio_server())
}
