//! Windows Job Object — Asagi 終了時に Codex 子プロセスも一括 kill する。
//!
//! **Phase 0 POC #5 通過後に本実装**（DEC-018-010 / 014）。
//! macOS / Linux では no-op。
//!
//! 関連: dev-v0.1.0-scaffold-design.md § 6.3

#[cfg(windows)]
pub mod imp {
    use anyhow::Result;

    /// JobObject を作成し、JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE を立てる。
    /// **POC #5 通過後実装**。
    pub fn create_job_object() -> Result<JobObject> {
        unimplemented!("[POC pending: AS-121 / jobobject 連携]")
    }

    /// 子プロセスを JobObject に紐付けて、Asagi が落ちたら子も死ぬようにする。
    pub fn assign_process_to_job(_job: &JobObject, _pid: u32) -> Result<()> {
        unimplemented!("[POC pending]")
    }

    pub struct JobObject {
        // POC 通過後に handle を保持
    }
}

#[cfg(not(windows))]
pub mod imp {
    use anyhow::Result;

    /// 非 Windows では no-op。
    pub fn create_job_object() -> Result<JobObject> {
        Ok(JobObject)
    }

    pub fn assign_process_to_job(_job: &JobObject, _pid: u32) -> Result<()> {
        Ok(())
    }

    pub struct JobObject;
}

pub use imp::*;
