/**
 * 🔴 **別の窓が書いたことを、編集中のタブが知る**(#178。2026-08-22)。
 *
 * ## user から見た物語
 *
 * 本文を書いている。⚠ **その隣で、別窓のカレンダーが同じノートに日付を付ける**
 * (#300 段③ で組み込みアプリは既定で別窓になったので、これは特殊な使い方ではない)。
 * そのまま保存すると、**日付は上書きされる**。
 *
 * 直す前は、そのとき**画面に何も出なかった** ── user から見ると
 * 「カレンダーで付けた日付が消えた」であり、**戻せることを知る道が無い**。
 *
 * ## 何を守るか
 *
 * ① 🔴 編集中のタブが**印(`diskAhead`)を受け取る**(直す前は先送りされて届かなかった)
 * ② 🔴 **下書きには 1 バイトも触らない**(打っている字を奪わない)
 * ③ 🔴 保存したら**黙らない** ── 履歴に残したことを言う
 * ④ 🔴 その断り文を**本当にする** ── `checkpoint` を強制して必ず履歴へ積む
 * ⑤ ⚠ **無駄に本文を読まない**(自分のノートでない `changed` で読みに行かない)
 *
 * ⚠ 「上書きされた版が本当に履歴へ入るか」は**実物の worker で**見ている
 * (`tests/adapter/storage-worker.test.ts` の「別の窓が書いた版は…履歴から戻せる」)
 * ── ここは app 層の判断だけを見る。
 */
import { describe, expect, it, vi } from 'vitest';
import { noteRemoteChange } from '../../src/adapter/state/remote-change';
import { reduce, initialState, type AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

/** 「e1 を開いて編集中、下書きは打鍵済み」まで進めた state を作る。 */
function editing(draft = '# 打鍵中'): AppState {
  let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1')], relations: [] })
    .state;
  s = reduce(s, { type: 'SELECT_ENTRY', lid: 'e1' }).state;
  s = reduce(s, { type: 'BODY_LOADED', lid: 'e1', body: '# 読んだ本文' }).state;
  s = reduce(s, { type: 'START_EDIT' }).state;
  s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: draft }).state;
  return s;
}

describe('別の窓の書込を編集中のタブが受け取る(#178)', () => {
  it('🔴 印が立ち、下書きは 1 バイトも変わらない', () => {
    const before = editing();
    const after = reduce(before, {
      type: 'REMOTE_BODY_CHANGED',
      lid: 'e1',
      body: '# 読んだ本文\ndate: 2026-08-22',
    }).state;
    expect(after.openBody?.diskAhead, '別の窓が書いたのに印が立たない').toBe(true);
    expect(after.openBody?.persisted, 'disk の内容を憶えていない').toBe(
      '# 読んだ本文\ndate: 2026-08-22',
    );
    expect(after.openBody?.body, '打っている下書きを奪った').toBe('# 打鍵中');
    expect(after.phase, '編集を勝手に終わらせた').toBe('editing');
  });

  /** ⚠ **自分の ack では印を立てない**(自分と衝突することはない)。 */
  it('🔴 disk の内容が既に知っているものなら、印は立てない', () => {
    let s = editing();
    s = reduce(s, { type: 'REMOTE_BODY_CHANGED', lid: 'e1', body: '# 読んだ本文' }).state;
    expect(s.openBody?.diskAhead, '同じ内容で印が立った(自分の ack で誤爆する)').toBe(false);
  });

  it('⚠ 開いていない別のノートの知らせは捨てる', () => {
    const s = editing();
    const after = reduce(s, { type: 'REMOTE_BODY_CHANGED', lid: 'e2', body: 'x' }).state;
    expect(after.openBody?.diskAhead).toBe(false);
    expect(after.openBody?.persisted).toBe('# 読んだ本文');
  });

  it('⚠ 編集中でなければ受けない(reloadSnapshot の仕事と二重にしない)', () => {
    let s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('e1')],
      relations: [],
    }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'e1' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'e1', body: '# 読んだ本文' }).state;
    expect(s.phase, '前提が崩れている(編集中になっている)').toBe('ready');
    const after = reduce(s, { type: 'REMOTE_BODY_CHANGED', lid: 'e1', body: '# 別の版' }).state;
    expect(after.openBody?.diskAhead).toBe(false);
  });
});

describe('重なったまま保存したときに、黙らない(#178)', () => {
  /** 印が立った状態から「打った字ごと」保存する。 */
  function commitOverRemote(): { state: AppState; events: readonly { type: string }[] } {
    let s = editing('# 打鍵中');
    s = reduce(s, {
      type: 'REMOTE_BODY_CHANGED',
      lid: 'e1',
      body: '# 読んだ本文\ndate: 2026-08-22',
    }).state;
    expect(s.openBody?.diskAhead, '前提が崩れている(印が立っていない)').toBe(true);
    const r = reduce(s, { type: 'COMMIT_EDIT' });
    return { state: r.state, events: r.events };
  }

  it('🔴 保存はできる(打った字は捨てさせない)', () => {
    const { state, events } = commitOverRemote();
    expect(state.phase).toBe('ready');
    const persist = events.find((e) => e.type === 'PERSIST_ENTRY') as
      | { type: 'PERSIST_ENTRY'; entry: { body: string }; checkpoint?: boolean }
      | undefined;
    expect(persist, '保存を撃っていない(打った字が消える)').toBeDefined();
    expect(persist!.entry.body, '打った字で保存していない').toBe('# 打鍵中');
  });

  /**
   * 🔴 **断り文を本当にする。**
   *
   * ⚠ **1 稿目のこの test は空振りしていた**(変異試験 N5 が SURVIVED で教えた)──
   *   普通のノートは `checkpoint` が**どのみち true** なので、強制を丸ごと外しても
   *   緑だった(CLAUDE.md §1「救い手が別に居る」)。
   * 🔑 だから**普通なら false になる形**で見る ── 新規作成の初回 commit
   *   (`freshLid === lid`)は「flavor seed へ戻すだけの復元先」を作らないために
   *   **積まない**規則になっている。そこで別の窓が書いていたら、**本当に消える**。
   */
  it('🔴 新規ノートでも、別の窓の版は履歴へ積む(普通なら積まない場面)', () => {
    let s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [],
      relations: [],
    }).state;
    s = reduce(s, {
      type: 'CREATE_ENTRY',
      lid: 'n1',
      archetype: 'text',
      title: '新しいノート',
    }).state;
    expect(s.freshLid, '前提が崩れている(新規の印が立っていない)').toBe('n1');
    s = reduce(s, { type: 'START_EDIT' }).state;
    s = reduce(s, { type: 'UPDATE_OPEN_BODY', body: '# 打鍵中' }).state;

    // ⚠ **対照群** ── 別の窓が書いていなければ、ここは積まない(それが規則)
    const plain = reduce(s, { type: 'COMMIT_EDIT' }).events.find(
      (e) => e.type === 'PERSIST_ENTRY',
    ) as { checkpoint?: boolean } | undefined;
    expect(plain?.checkpoint, '前提が崩れている(新規でも積む規則になっている)').toBe(false);

    const withRemote = reduce(s, {
      type: 'REMOTE_BODY_CHANGED',
      lid: 'n1',
      body: '# 別の窓が書いた',
    }).state;
    expect(withRemote.openBody?.diskAhead, '印が立っていない').toBe(true);
    const persist = reduce(withRemote, { type: 'COMMIT_EDIT' }).events.find(
      (e) => e.type === 'PERSIST_ENTRY',
    ) as { checkpoint?: boolean } | undefined;
    expect(persist?.checkpoint, '履歴へ積まずに上書きした(本当に消える)').toBe(true);
  });

  it('🔴 画面に理由が出て、戻し方まで書いてある', () => {
    const { state } = commitOverRemote();
    expect(state.error, '黙って上書きした(user は日付が消えたとしか見えない)').toBeTruthy();
    expect(state.error, '何が起きたか書いていない').toContain('別の窓');
    expect(state.error, '戻し方が書いていない').toContain('履歴');
  });

  /** ⚠ **対照群** ── 重なっていない普通の保存では、何も言わない。 */
  it('⚠ 重なっていない保存では黙っている(常に出る帯にしない)', () => {
    const s = editing('# 打鍵中');
    const r = reduce(s, { type: 'COMMIT_EDIT' });
    expect(r.state.error, '普通の保存でも理由が出る(帯が意味を失う)').toBeNull();
  });
});

describe('誰に聞きに行くかの判断(#178)', () => {
  function bench(editingLid: string | null, body: string | null = '# disk') {
    const applied: Array<{ lid: string; body: string }> = [];
    const getBody = vi.fn(async () => body);
    return {
      applied,
      getBody,
      deps: {
        editingLid: () => editingLid,
        getBody,
        apply: (lid: string, b: string) => applied.push({ lid, body: b }),
      },
    };
  }

  it('🔴 編集中の自分のノートが対象なら、読んで渡す', async () => {
    const b = bench('e1');
    expect(await noteRemoteChange(['e1', 'e2'], b.deps)).toBe(true);
    expect(b.applied).toEqual([{ lid: 'e1', body: '# disk' }]);
  });

  it('🔴 範囲が分からない知らせ(null)でも読む', async () => {
    const b = bench('e1');
    expect(await noteRemoteChange(null, b.deps)).toBe(true);
    expect(b.applied).toHaveLength(1);
  });

  /** ⚠ **無駄に読まない** ── 他人のノートの本文を読むのは丸損である。 */
  it('🔴 自分のノートが対象でなければ、本文を読みに行かない', async () => {
    const b = bench('e1');
    expect(await noteRemoteChange(['e9'], b.deps)).toBe(false);
    expect(b.getBody, '関係の無いノートの本文を読んだ').not.toHaveBeenCalled();
  });

  it('🔴 編集中でなければ、本文を読みに行かない(reloadSnapshot の仕事)', async () => {
    const b = bench(null);
    expect(await noteRemoteChange(null, b.deps)).toBe(false);
    expect(b.getBody).not.toHaveBeenCalled();
  });

  it('⚠ 読めなかった(消えていた)回は黙って何もしない', async () => {
    const b = bench('e1', null);
    expect(await noteRemoteChange(['e1'], b.deps)).toBe(true);
    expect(b.applied).toEqual([]);
  });
});
