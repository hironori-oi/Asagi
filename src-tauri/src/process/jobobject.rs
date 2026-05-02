//! Windows Job Object — Asagi 終了時に Codex 子プロセスも一括 kill する (AS-133)。
//!
//! Phase 0 POC #5 (DEC-018-010) の事前準備。`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
//! 付き JobObject を作成し、子プロセスを `AssignProcessToJobObject` で紐付ける。
//! `Drop` で `CloseHandle` を呼ぶと、JobObject に属する全プロセスが kernel
//! 由来で kill される。
//!
//! 非 Windows では no-op。

#[cfg(windows)]
mod imp {
    use anyhow::{anyhow, Context, Result};
    use windows::Win32::Foundation::{CloseHandle, BOOL, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_BASIC_LIMIT_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    /// Windows JobObject ハンドル。Drop で CloseHandle → 紐付け済プロセスが全 kill される。
    pub struct WinJobObject {
        handle: HANDLE,
    }

    // SAFETY: HANDLE は Send + Sync ではないので明示的に実装。
    // 実体は kernel handle (i.e. usize)。Asagi 内では Mutex で保護して使う前提。
    unsafe impl Send for WinJobObject {}
    unsafe impl Sync for WinJobObject {}

    impl WinJobObject {
        /// JobObject を作成し、JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE を立てる。
        pub fn create() -> Result<Self> {
            unsafe {
                let h = CreateJobObjectW(None, None)
                    .map_err(|e| anyhow!("CreateJobObjectW failed: {e}"))?;
                if h.is_invalid() {
                    return Err(anyhow!("CreateJobObjectW returned invalid handle"));
                }

                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
                    BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                        LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                        ..Default::default()
                    },
                    ..Default::default()
                };

                let info_ptr: *const _ = &info;
                let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;

                SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    info_ptr as *const _,
                    size,
                )
                .map_err(|e| anyhow!("SetInformationJobObject failed: {e}"))?;

                // 未使用警告抑止
                let _ = &mut info;

                Ok(Self { handle: h })
            }
        }

        /// 子プロセスを JobObject に紐付ける。
        pub fn assign_pid(&self, pid: u32) -> Result<()> {
            unsafe {
                let proc_handle = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, false, pid)
                    .with_context(|| format!("OpenProcess(pid={pid}) failed"))?;
                if proc_handle.is_invalid() {
                    return Err(anyhow!("OpenProcess returned invalid handle for pid={pid}"));
                }

                let res = AssignProcessToJobObject(self.handle, proc_handle)
                    .map_err(|e| anyhow!("AssignProcessToJobObject failed: {e}"));

                // proc_handle は close (jobobject 側が refcount を保持する)
                let _ = CloseHandle(proc_handle);
                res
            }
        }

        pub fn handle(&self) -> HANDLE {
            self.handle
        }
    }

    /// 指定 PID が「いずれかの JobObject」に属しているかを返す（AS-143 検証用）。
    ///
    /// JobHandle に NULL を渡すと、Windows は「any job」をチェックする。
    /// POC #5 の自己検証ロジックと等価（pid → IsProcessInJob(NULL)）。
    /// nested Job として動作した場合も true を返す。
    pub fn is_process_in_any_job(pid: u32) -> Result<bool> {
        unsafe {
            let proc_handle =
                OpenProcess(PROCESS_QUERY_INFORMATION, false, pid).with_context(|| {
                    format!("OpenProcess(PROCESS_QUERY_INFORMATION, pid={pid}) failed")
                })?;
            if proc_handle.is_invalid() {
                return Err(anyhow!(
                    "OpenProcess returned invalid handle for pid={pid} (IsProcessInJob)"
                ));
            }

            let mut result: BOOL = BOOL(0);
            let res = IsProcessInJob(proc_handle, None, &mut result)
                .map_err(|e| anyhow!("IsProcessInJob(pid={pid}) failed: {e}"));
            let _ = CloseHandle(proc_handle);
            res?;
            Ok(result.as_bool())
        }
    }

    impl Drop for WinJobObject {
        fn drop(&mut self) {
            if !self.handle.is_invalid() {
                unsafe {
                    let _ = CloseHandle(self.handle);
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use anyhow::Result;

    /// 非 Windows: no-op。
    pub struct WinJobObject;

    impl WinJobObject {
        pub fn create() -> Result<Self> {
            Ok(Self)
        }
        pub fn assign_pid(&self, _pid: u32) -> Result<()> {
            Ok(())
        }
    }

    /// 非 Windows: 常に false（JobObject 概念なし）。
    pub fn is_process_in_any_job(_pid: u32) -> Result<bool> {
        Ok(false)
    }
}

pub use imp::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn jobobject_create_and_drop_smoke() {
        let job = WinJobObject::create().expect("create job object");
        drop(job); // panic しないこと
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn jobobject_kills_child_on_drop() {
        use std::process::Command;
        use std::time::{Duration, Instant};

        // 60 秒 ping = 長時間プロセス
        let mut child = Command::new("cmd")
            .args(["/c", "ping", "-n", "60", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn child");
        let pid = child.id();

        let job = WinJobObject::create().expect("create job");
        job.assign_pid(pid).expect("assign pid");

        // JobObject を drop → 子が kill されるはず
        drop(job);

        // try_wait で死亡確認 (最大 5 秒待機)
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_status)) => {
                    // killed
                    return;
                }
                Ok(None) => {
                    if start.elapsed() > Duration::from_secs(5) {
                        // 念のため明示 kill して fail
                        let _ = child.kill();
                        panic!("child was not killed by JobObject drop within 5s");
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => panic!("try_wait failed: {e}"),
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn noop_on_non_windows() {
        let job = WinJobObject::create().unwrap();
        job.assign_pid(0).unwrap();
    }
}
