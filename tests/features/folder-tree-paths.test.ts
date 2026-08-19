/**
 * 移動先の一覧(2026-08-05、user 報告「フォルダ整理のための導線がない」)。
 *
 * ここで守るのは 2 つ:
 *   ① **道が読める**こと(同名フォルダを取り違えない)
 *   ② **選ばせてはいけない先を出さない**こと(自分・自分の子孫 = 輪になる)
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import { listFolderPaths, listMoveTargets } from '@features/relation/tree';

const meta = (lid: string, order: number, archetype = 'text', title = lid): EntryMeta => ({
  lid,
  title,
  archetype,
  createdAt: null,
  updatedAt: null,
  entryOrder: order,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

const rel = (id: string, from: string, to: string, kind = 'structural'): Relation => ({
  id,
  fromLid: from,
  toLid: to,
  kind,
  createdAt: null,
  updatedAt: null,
});

const asMap = (ms: EntryMeta[]): Map<string, EntryMeta> =>
  new Map(ms.map((m) => [m.lid, m]));

describe('listFolderPaths', () => {
  const METAS = asMap([
    meta('work', 1, 'folder', '仕事'),
    meta('docs', 2, 'folder', '資料'),
    meta('priv', 3, 'folder', '私用'),
    meta('pdocs', 4, 'folder', '資料'), // ⚠ **同名**(道が無いと区別できない)
    meta('n1', 5),
  ]);
  const RELS = [
    rel('r1', 'work', 'docs'),
    rel('r2', 'priv', 'pdocs'),
    rel('r3', 'work', 'n1'),
  ];

  it('深さ優先・道つきで並ぶ(同名フォルダが道で見分けられる)', () => {
    const out = listFolderPaths(METAS, RELS);
    expect(out.map((f) => f.lid)).toEqual(['work', 'docs', 'priv', 'pdocs']);
    expect(out.map((f) => f.depth)).toEqual([0, 1, 0, 1]);
    // 🔴 同名の 2 件が**別の道**を持つ ── ここが潰れると user は取り違える
    expect(out.map((f) => f.path)).toEqual(['仕事', '仕事 / 資料', '私用', '私用 / 資料']);
    expect(new Set(out.map((f) => f.path)).size).toBe(out.length);
  });

  it('folder でない entry は出さない', () => {
    expect(listFolderPaths(METAS, RELS).some((f) => f.lid === 'n1')).toBe(false);
  });

  it('🔴 輪の中の folder も必ず出す(直せなくならない)', () => {
    // a → b → a。root から辿れないので、素朴な深さ優先だと**消える**
    const metas = asMap([
      meta('a', 1, 'folder', 'A'),
      meta('b', 2, 'folder', 'B'),
      meta('top', 3, 'folder', 'T'),
    ]);
    const rels = [rel('x', 'a', 'b'), rel('y', 'b', 'a')];
    const out = listFolderPaths(metas, rels);
    expect(out.map((f) => f.lid).sort()).toEqual(['a', 'b', 'top']);
  });

  it('structural 以外の辺は階層に効かない', () => {
    const metas = asMap([meta('p', 1, 'folder', 'P'), meta('c', 2, 'folder', 'C')]);
    const out = listFolderPaths(metas, [rel('s', 'p', 'c', 'semantic')]);
    expect(out.map((f) => f.depth)).toEqual([0, 0]); // どちらも root 直下
  });
});

describe('listMoveTargets', () => {
  //  top ── mid ── low、別に other
  const METAS = asMap([
    meta('top', 1, 'folder', '上'),
    meta('mid', 2, 'folder', '中'),
    meta('low', 3, 'folder', '下'),
    meta('other', 4, 'folder', '別'),
    meta('n1', 5),
  ]);
  const RELS = [rel('r1', 'top', 'mid'), rel('r2', 'mid', 'low'), rel('r3', 'top', 'n1')];

  it('🔴 自分自身は出さない(自分の中には入れない)', () => {
    expect(listMoveTargets('mid', METAS, RELS).map((f) => f.lid)).not.toContain('mid');
  });

  it('🔴 自分の子孫は出さない(輪ができて枝ごと見えなくなる)', () => {
    const ids = listMoveTargets('top', METAS, RELS).map((f) => f.lid);
    expect(ids).not.toContain('mid');
    expect(ids).not.toContain('low'); // ⚠ **孫**も除く(直下だけ見ると漏れる)
    expect(ids).toEqual(['other']);
  });

  it('folder でないものは、すべての folder へ動かせる', () => {
    expect(listMoveTargets('n1', METAS, RELS).map((f) => f.lid)).toEqual([
      'top',
      'mid',
      'low',
      'other',
    ]);
  });
});
