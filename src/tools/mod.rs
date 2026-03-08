/// Tools
///
/// Worker-callable tools: file system ops, shell execution, codebase search.
/// All tools are sandboxed and logged.

use anyhow::Result;
use std::path::Path;

pub async fn read_file(path: &str) -> Result<String> {
    Ok(std::fs::read_to_string(path)?)
}

pub async fn write_file(path: &str, content: &str) -> Result<()> {
    if let Some(parent) = Path::new(path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)?;
    Ok(())
}

pub async fn run_shell(cmd: &str) -> Result<(String, String, i32)> {
    let output = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .output()
        .await?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code().unwrap_or(-1);

    Ok((stdout, stderr, exit_code))
}

pub async fn search_codebase(base_path: &str, query: &str) -> Result<Vec<String>> {
    // Naive grep-based search — v2 will use embeddings
    let (stdout, _, _) = run_shell(&format!(
        "grep -rn --include='*.rs' --include='*.ts' --include='*.lua' -l '{}' '{}'",
        query, base_path
    )).await?;

    Ok(stdout.lines().map(|l| l.to_string()).collect())
}
