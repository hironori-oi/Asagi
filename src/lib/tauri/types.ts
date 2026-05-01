/**
 * Rust 側 struct と一致させる TypeScript 型定義。
 * 拡張は src-tauri/src/ 内の serde 定義と同期させる。
 */

export interface SessionRow {
  id: string;
  title: string;
  project_id: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  created_at: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  path: string;
  color_index: number;
}
