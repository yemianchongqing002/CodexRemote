//! Host process support; absent from store builds.
use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
pub(crate) fn run(
    program: &str,
    args: &[String],
    input: Option<&str>,
    seconds: u64,
) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|_| format!("无法启动 {program}，请先安装系统 OpenSSH 客户端"))?;
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let reader = |stream: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let mut stream = stream;
            let mut buf = [0; 4096];
            while let Ok(n) = stream.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if bytes.len() < 1048576 {
                    bytes.extend_from_slice(&buf[..n.min(1048576 - bytes.len())]);
                }
            }
            String::from_utf8_lossy(&bytes).into_owned()
        })
    };
    let stdout = reader(Box::new(out));
    let stderr = reader(Box::new(err));
    let writer = input.map(|text| {
        let text = text.to_owned();
        let mut stdin = child.stdin.take().unwrap();
        std::thread::spawn(move || stdin.write_all(text.as_bytes()))
    });
    drop(child.stdin.take());
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("SSH 进程状态读取失败".into());
            }
        }
        if start.elapsed() > Duration::from_secs(seconds) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("SSH 操作超时；安装结果可能未确认，请检查目标机器后重试".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    if let Some(writer) = writer {
        if !matches!(writer.join(), Ok(Ok(()))) {
            return Err("安装脚本传输未完成，请核对目标机器".into());
        }
    }
    let output = stdout.join().unwrap_or_default();
    let errors = stderr.join().unwrap_or_default();
    if !status.success() {
        return Err(format!(
            "SSH 操作失败：{}",
            errors
                .lines()
                .chain(output.lines())
                .take(12)
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    Ok(output)
}
