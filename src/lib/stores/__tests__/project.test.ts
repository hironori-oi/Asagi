import { describe, it, expect, beforeEach } from 'vitest';
import { useProjectStore, PROJECT_COLORS, type RegisteredProject } from '../project';

/**
 * RegisteredProject CRUD と localStorage persist の基本動作テスト (AS-META-02).
 *
 * v0.1.0 の DUMMY_PROJECTS をリセットしながら CRUD を検証する。
 */

function reset() {
  // store には setProjects があるので、ダミー 0 件相当に戻す。
  useProjectStore.setState({
    projects: [],
    activeProjectId: '',
  });
  // localStorage も洗い替え。
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem('asagi-project-registry');
  }
}

describe('useProjectStore', () => {
  beforeEach(() => {
    reset();
  });

  it('PROJECT_COLORS は 8 色を提供する', () => {
    expect(PROJECT_COLORS).toHaveLength(8);
    for (const c of PROJECT_COLORS) {
      expect(c).toMatch(/^oklch\(/);
    }
  });

  it('upsert は新規プロジェクトを追加する', () => {
    const p: RegisteredProject = {
      id: 'p1',
      path: 'C:/dev/p1',
      title: 'Project 1',
      colorIdx: 0,
    };
    useProjectStore.getState().upsert(p);
    expect(useProjectStore.getState().projects).toHaveLength(1);
    expect(useProjectStore.getState().projects[0]?.id).toBe('p1');
  });

  it('upsert は既存プロジェクトを置換する', () => {
    const p: RegisteredProject = {
      id: 'p1',
      path: 'C:/dev/p1',
      title: 'Project 1',
      colorIdx: 0,
    };
    useProjectStore.getState().upsert(p);
    useProjectStore.getState().upsert({ ...p, title: 'Renamed' });
    expect(useProjectStore.getState().projects).toHaveLength(1);
    expect(useProjectStore.getState().projects[0]?.title).toBe('Renamed');
  });

  it('setActive はアクティブ ID を切替える', () => {
    const a: RegisteredProject = { id: 'a', path: '/a', title: 'A', colorIdx: 0 };
    const b: RegisteredProject = { id: 'b', path: '/b', title: 'B', colorIdx: 1 };
    useProjectStore.getState().upsert(a);
    useProjectStore.getState().upsert(b);
    useProjectStore.getState().setActive('b');
    expect(useProjectStore.getState().activeProjectId).toBe('b');
  });

  it('remove は active project を削除した場合に最初の残存に切替える', () => {
    const a: RegisteredProject = { id: 'a', path: '/a', title: 'A', colorIdx: 0 };
    const b: RegisteredProject = { id: 'b', path: '/b', title: 'B', colorIdx: 1 };
    useProjectStore.getState().upsert(a);
    useProjectStore.getState().upsert(b);
    useProjectStore.getState().setActive('a');
    useProjectStore.getState().remove('a');
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(['b']);
    expect(useProjectStore.getState().activeProjectId).toBe('b');
  });

  it('remove は非 active を削除しても active を保持する', () => {
    const a: RegisteredProject = { id: 'a', path: '/a', title: 'A', colorIdx: 0 };
    const b: RegisteredProject = { id: 'b', path: '/b', title: 'B', colorIdx: 1 };
    useProjectStore.getState().upsert(a);
    useProjectStore.getState().upsert(b);
    useProjectStore.getState().setActive('a');
    useProjectStore.getState().remove('b');
    expect(useProjectStore.getState().activeProjectId).toBe('a');
  });
});
