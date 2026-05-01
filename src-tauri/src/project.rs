//! Project registry。
//!
//! M1 では `default` 1 件固定。M2 AS-200 で `~/.asagi/registry.json` に
//! 任意ディレクトリを登録できるようにする。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    pub path: String,
    pub color_index: u8,
}

impl ProjectMeta {
    pub fn default_project() -> Self {
        Self {
            id: "default".to_string(),
            name: "Default".to_string(),
            path: String::new(),
            color_index: 0,
        }
    }
}

/// M1: default 1 件のみ返す。M2 で registry.json から読込予定。
pub fn list_projects() -> Vec<ProjectMeta> {
    vec![ProjectMeta::default_project()]
}
