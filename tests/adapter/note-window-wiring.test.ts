/** @vitest-environment happy-dom */
/**
 * 🔴 **「別の窓で開く」が、どのノートを開くか**(#685 段②、2026-09-04)。
 *
 * ⚠ 変異試験で **2 件生き延びた**ので足した検査である:
 *   ① ノートが 1 件も無いときに**黙る**(押した人に理由が無い)
 *   ② **押した行**ではなく**選ばれている物**を連れて行く(⋯ は行から開くので、
 *      2 つは違いうる ── 違うノートが別の窓に出る)
 * 🔑 どちらも「窓が開くか」を見る smoke では**区別が付かない**
 *   (smoke は選んでいるノートの上で押すので、2 つが一致してしまう)。
 */
import { describe, expect, it } from 'vitest';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';

/**
 * ⚠ **state を直に組む** ── `SELECT_ENTRY` は**居ないノートを選ばない**ので、
 *   reducer を通すと `selectedLid` が `null` のままになる(1 稿目で踏んだ)。
 *   ここで確かめたいのは**対象の解決規則**であって、選べるかではない。
 */
function withSelected(lid: string, also: readonly string[] = []): AppState {
  return { ...initialState, selectedLid: lid, entryMetas: metasOf([lid, ...also]) };
}

/**
 * ⚠ **`SELECT_ENTRY` は居ないノートを選ばない** ── 戻す先を `entryMetas` に
 *   置いておかないと、`selectedLid` が動かず「戻していない」と読める
 *   (1 稿目で踏んだ ── CLAUDE.md §4「前提が崩れている」で落ちる形にする)。
 */
function metasOf(lids: readonly string[]): ReadonlyMap<string, EntryMeta> {
  return new Map(
    lids.map((lid, i) => [
      lid,
      {
        lid,
        title: lid,
        archetype: 'text',
        createdAt: null,
        updatedAt: null,
        entryOrder: i + 1,
        status: null,
        date: null,
        archived: false,
        bodyChars: 0,
      } satisfies EntryMeta,
    ]),
  );
}

function setup(state: AppState) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher(state);
  const opened: string[] = [];
  bindActions(root, d, { openNoteWindow: (lid) => void opened.push(lid) });
  /**
   * ⚠ **いま `data-pkc-entry` を載せているのは情報ペインのボタン自身**である
   *   (`inspector.ts` が `this.buttons` の全件に `meta.lid` を書く)── ⋯ の
   *   メニューは **root の直下**に出るので持っていない(`context-menu.ts` が
   *   「押した物の中に居ない」と明記している)。
   * 🔑 だからこの検査が守るのは「**行へ埋め込んだ日に `selectedLid` 固定へ
   *   退化しない**」ことである。⚠ **いまの製品では 2 つの枝は常に一致する**
   *   (行のメニューは押す前に行を選ぶ / スマホは `selectedLid` から組む)──
   *   1 稿目のこの docstring は「行を模す」と書いていたが、**その DOM は
   *   製品に存在しない**(#685 着地前レビュー ⚠7、2026-09-04)。
   */
  const press = (lid?: string, prev?: string) => {
    const host = document.createElement('div');
    if (lid !== undefined) host.setAttribute('data-pkc-entry', lid);
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'open-note-window');
    // ⚠ 行のメニューが持たせる「出す前に開いていたノート」(#685 動線レビュー 欠陥 2)
    if (prev !== undefined) b.setAttribute('data-pkc-menu-prev-lid', prev);
    host.append(b);
    root.append(host);
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };
  return { d, opened, press, root };
}

describe('別の窓で開く ── 対象の解決', () => {
  /**
   * 🔴 **押した行が相手**(変異 P6)。⚠ 選ばれている物で代替すると、
   *   一覧の別の行を右クリックしたときに**違うノートが別の窓に出る**。
   * 🔑 規則は隣の `export-entry` / `delete-entry` と同じである
   *   ── 揃えないと「A を書き出して B を開く」が成立する。
   */
  it('🔴 押した行のノートを開く(選ばれている物ではない)', () => {
    const s = setup(withSelected('selected'));
    s.press('pressed');
    expect(s.opened, '押した行ではなく、選ばれている物を開いた').toEqual(['pressed']);
  });

  /** ⚠ 行の外(情報ペインのボタン)から押したときは、選ばれている物が相手。 */
  it('⚠ 行の外から押したら、選ばれているノートを開く', () => {
    const s = setup(withSelected('selected'));
    s.press();
    expect(s.opened).toEqual(['selected']);
  });

  /**
   * 🔴 **無言で終わらせない**(変異 P5)。⚠ 押した人に理由が要る ──
   *   この repo が繰り返し直してきた「無言の dead click」の形である。
   */
  it('🔴 開くノートが無ければ、理由を出す(黙らない)', () => {
    const s = setup(initialState);
    s.press();
    expect(s.opened, '相手が居ないのに窓を開こうとした').toEqual([]);
    expect(s.d.getState().error, '押しても何も起きない(理由が出ていない)').toContain(
      '別のウィンドウで開くノートがありません',
    );
  });

  /**
   * 🔴 **読んでいたノートは退かない**(#685 動線レビュー 欠陥 2、2026-09-04)。
   *
   * ⚠ 一覧の行を右クリックすると `selectEntryOrExplain` が**その行を選ぶ**ので、
   *   中央の本文はその時点で B に入れ替わる。付箋を開くと**同じ B が 2 枚並ぶ** ──
   *   読んでいた A は消えている。
   * ⚠ お知らせには「**開いても、いま読んでいる画面はそのままです**」と書いたので、
   *   直さないと**その 1 文が一覧から開いた回だけ嘘になる**。
   * 🔑 だから行のメニューは「出す前の lid」を持たせ、開いたら戻す。
   */
  describe('読んでいたノートへ戻す(動線レビュー 欠陥 2)', () => {
    it('🔴 行から開いたら、中央は元のノートへ戻る', () => {
      const s = setup(withSelected('pressed', ['reading']));
      expect(
        s.d.getState().entryMetas.has('reading'),
        '前提が崩れた(戻す先が台に居ないので、選び直しは必ず落ちる)',
      ).toBe(true);
      s.press('pressed', 'reading');
      expect(s.opened, '前提が崩れた(付箋を開いていない)').toEqual(['pressed']);
      expect(s.d.getState().selectedLid, '読んでいたノートが退かされたまま').toBe('reading');
    });

    /**
     * ⚠ **対照群 1** ── 印を持たない押し(本文のメニュー / 情報ペインのボタン)は
     *   戻さない。もともと開いているノートを開くので、戻す相手が居ない。
     */
    it('⚠ 印が無ければ現在地は動かさない', () => {
      const s = setup(withSelected('selected'));
      s.press();
      expect(s.opened).toEqual(['selected']);
      expect(s.d.getState().selectedLid, '要らない選び直しが走った').toBe('selected');
    });

    /** ⚠ **対照群 2** ── いま読んでいる行そのものを開いた回も動かさない。 */
    it('⚠ 同じノートなら戻さない', () => {
      const s = setup(withSelected('same'));
      s.press('same', 'same');
      expect(s.d.getState().selectedLid).toBe('same');
    });
  });
});
