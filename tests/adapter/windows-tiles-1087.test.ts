/** @vitest-environment node */
/**
 * 🔴 **起動タイル(アプリ一覧)と 2 ペインの下見が、書込・再読込に追随する**(#1087 A-1 / A-2)。
 *
 * ⚠ 台は reducer(`reduce`)。effect 層は「頼まれた読みを直列の列で実行する」だけなので、
 *   追随するかどうかは**頼む event が出るか**で決まる。
 * 🔑 どの it も、直す前の実装(頼まない / syncShownBodies が下見を見ない)に戻すと落ちる。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { reduce, initialState, type AppState } from '../../src/adapter/state/app-state';
import { BROWSE_MODES, browseScanOf } from '../../src/adapter/ui/render/browse-mode';
import { paneOf } from '../../src/features/relation/dual-pane';

function meta(lid: string, order: number, archetype = 'text', title = 't-' + lid): EntryMeta {
  return {
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
  };
}

const METAS = [meta('a', 1, 'attachment', '資料.pdf'), meta('b', 2), meta('c', 3)];

function booted(): AppState {
  return reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] }).state;
}
const types = (events: readonly { type: string }[]): string[] => events.map((e) => e.type);

describe('🔴 起動タイルが追随する(#1087 A-1)', () => {
  it('SYS_BOOTED: 一度タイルを読んでいれば、タイルとグループを頼み直す(新しい並びで)', () => {
    let st = booted();
    st = reduce(st, { type: 'LAUNCHER_TILES_LOADED', tiles: [] }).state;
    expect(st.launcherTiles, '前提: タイルを読んでいる').not.toBeNull();
    const metas = [meta('a', 1, 'attachment', '新しい名前.pdf'), meta('n', 2, 'attachment', '取り込んだ.pdf')];
    const r = reduce(st, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
    const tiles = r.events.find((e) => e.type === 'REQUEST_LAUNCHER_TILES');
    expect(tiles, 'タイルを頼み直していない').toBeDefined();
    // 新しい metas で数える(古い state から採ると、いま取り込んだ添付が載らない)
    const lids = (tiles as { entries: Array<{ lid: string }> }).entries.map((e) => e.lid);
    expect(lids).toContain('n');
    expect(types(r.events), 'グループ用ノートを頼み直していない').toContain('REQUEST_APP_GROUP_NOTES');
  });

  it('SYS_BOOTED: グループ用ノートも新しい並びで頼む(取り込んだグループが載る)', () => {
    let st = booted();
    st = reduce(st, { type: 'LAUNCHER_TILES_LOADED', tiles: [] }).state;
    const metas = [...METAS, meta('g', 4, 'appgroup', '道具')];
    const r = reduce(st, { type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
    const ev = r.events.find((e) => e.type === 'REQUEST_APP_GROUP_NOTES') as {
      entries: Array<{ lid: string }>;
      gen: number;
    };
    expect(ev.entries.map((e) => e.lid), '新しい metas のグループが載っていない').toEqual(['g']);
    expect(ev.gen, '世代を state から渡していない').toBe(st.appGroupGen);
  });

  it('対照群: 一度もタイルを読んでいなければ、頼まない(使わない user に走査を負わせない)', () => {
    const st = booted();
    expect(st.launcherTiles).toBeNull();
    const r = reduce(st, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
    expect(types(r.events)).not.toContain('REQUEST_LAUNCHER_TILES');
    expect(types(r.events)).not.toContain('REQUEST_APP_GROUP_NOTES');
  });

  it('改名・ごみ箱へ移す: タイルを読んでいれば頼み直す(旧名・消した物のタイルを残さない)', () => {
    let st = booted();
    st = reduce(st, { type: 'LAUNCHER_TILES_LOADED', tiles: [] }).state;
    const renamed = reduce(st, { type: 'RENAME_ENTRY_TITLE', lid: 'a', title: '改名後.pdf' });
    expect(types(renamed.events)).toContain('REQUEST_LAUNCHER_TILES');
    expect(types(renamed.events)).toContain('REQUEST_APP_GROUP_NOTES');
    const deleted = reduce(st, { type: 'DELETE_ENTRY', lid: 'a' });
    expect(types(deleted.events)).toContain('REQUEST_LAUNCHER_TILES');
    // 消した後の並びで頼む(消した物を含めない)
    const req = deleted.events.find((e) => e.type === 'REQUEST_LAUNCHER_TILES') as {
      entries: Array<{ lid: string }>;
    };
    expect(req.entries.map((e) => e.lid)).not.toContain('a');
  });

  it('対照群: タイルを読んでいない間は、改名しても頼まない', () => {
    const st = booted();
    const renamed = reduce(st, { type: 'RENAME_ENTRY_TITLE', lid: 'a', title: '改名後.pdf' });
    expect(types(renamed.events)).not.toContain('REQUEST_LAUNCHER_TILES');
  });

  it('SYS_BOOTED は 1 回だけ頼む(一般の追随と二重にならない)', () => {
    let st = booted();
    st = reduce(st, { type: 'LAUNCHER_TILES_LOADED', tiles: [] }).state;
    const r = reduce(st, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('a', 1, 'attachment', '別名.pdf')],
      relations: [],
    });
    expect(types(r.events).filter((t) => t === 'REQUEST_LAUNCHER_TILES')).toHaveLength(1);
    expect(types(r.events).filter((t) => t === 'REQUEST_APP_GROUP_NOTES')).toHaveLength(1);
  });
});

describe('🔴 tripwire: タブの集め直しは、SYS_BOOTED で頼み直さない物が 0(#1087 A-1)', () => {
  it('BrowseScan の全種類について、「そのタブを開いたときに頼む読み」を SYS_BOOTED も頼む', () => {
    const scans = new Set<string>();
    for (const m of BROWSE_MODES) {
      const s = browseScanOf(m);
      if (s !== null) scans.add(s);
    }
    // 空振り防止: 4 種(アプリ / 予定 / 連絡先 / 録ったもの)が実際に引けている
    expect([...scans].sort()).toEqual(
      ['REFRESH_CAPTURE_SCAN', 'REFRESH_CONTACT_SCAN', 'REFRESH_LAUNCHER_TILES', 'REFRESH_TASK_SCAN'].sort(),
    );
    // 「開いたことがある」状態を全部作る(一度集めた = null でない)
    let st = booted();
    st = reduce(st, { type: 'LAUNCHER_TILES_LOADED', tiles: [] }).state;
    st = { ...st, taskScan: { cards: [] }, contactScan: { cards: [] }, captureItems: [] } as unknown as AppState;
    const boot = types(reduce(st, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] }).events);
    for (const scan of scans) {
      // 期待値は「そのタブを開いたときの頼み」を reducer 自身に出させて採る(手で並べない)
      const wanted = types(reduce(st, { type: scan as never }).events);
      expect(wanted.length, `${scan} が何も頼まない(前提が崩れている)`).toBeGreaterThan(0);
      for (const t of wanted) expect(boot, `${scan} の ${t} を SYS_BOOTED が頼み直さない`).toContain(t);
    }
  });
});

describe('🔴 2 ペインの下見が追随する(#1087 A-2)', () => {
  /** 下見を出して b を指し、本文が届いた状態。 */
  function previewing(): AppState {
    let st = booted();
    st = reduce(st, { type: 'SET_VIEW_MODE', mode: 'dual' }).state;
    st = reduce(st, { type: 'DUAL_SET_PREVIEW', on: true }).state;
    st = reduce(st, { type: 'DUAL_SET_CURSOR', side: 'left', lid: 'b' }).state;
    st = reduce(st, { type: 'DUAL_PREVIEW_LOADED', lid: 'b', body: '古い本文' }).state;
    expect(st.dual.preview, '前提: 下見が出ている').toEqual({ lid: 'b', body: '古い本文' });
    expect(paneOf(st.dual, st.dual.focus).cursor, '前提: 下見の行を指している').toBe('b');
    return st;
  }

  it('SYS_BOOTED: 指している行が在れば、下見を撃ち直す(前の本文は届くまで保つ)', () => {
    const st = previewing();
    const r = reduce(st, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
    expect(r.events).toContainEqual({ type: 'REQUEST_DUAL_PREVIEW', lid: 'b' });
    expect(r.state.dual.preview?.body, 'ちらつかせない').toBe('古い本文');
  });

  it('対照群: 行が消えていれば撃たない / 下見が畳まれていれば撃たない', () => {
    const st = previewing();
    const gone = reduce(st, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a', 1), meta('c', 3)], relations: [] });
    expect(types(gone.events)).not.toContain('REQUEST_DUAL_PREVIEW');
    const off = reduce(st, { type: 'DUAL_SET_PREVIEW', on: false }).state;
    const r = reduce(off, { type: 'SYS_BOOTED', cid: 'c1', metas: METAS, relations: [] });
    expect(types(r.events)).not.toContain('REQUEST_DUAL_PREVIEW');
  });

  it('別タブの書込 / 自分の保存の確認が、下見の本文を差し替える', () => {
    const st = previewing();
    const remote = reduce(st, { type: 'REMOTE_BODY_CHANGED', lid: 'b', body: '別タブが書いた本文' }).state;
    expect(remote.dual.preview).toEqual({ lid: 'b', body: '別タブが書いた本文' });
    const persisted = reduce(st, { type: 'BODY_PERSISTED', lid: 'b', body: '保存した本文' }).state;
    expect(persisted.dual.preview?.body).toBe('保存した本文');
  });

  it('対照群: 別の行の書込では下見は動かない / 同じ本文なら 2 ペインの state を替えない', () => {
    const st = previewing();
    const other = reduce(st, { type: 'REMOTE_BODY_CHANGED', lid: 'c', body: 'x' }).state;
    expect(other.dual.preview).toEqual({ lid: 'b', body: '古い本文' });
    const same = reduce(st, { type: 'REMOTE_BODY_CHANGED', lid: 'b', body: '古い本文' }).state;
    expect(same.dual, '同じ本文なのに 2 ペインの state を作り直した').toBe(st.dual);
  });
});
