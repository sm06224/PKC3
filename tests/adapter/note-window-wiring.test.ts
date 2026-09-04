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
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';

/**
 * ⚠ **state を直に組む** ── `SELECT_ENTRY` は**居ないノートを選ばない**ので、
 *   reducer を通すと `selectedLid` が `null` のままになる(1 稿目で踏んだ)。
 *   ここで確かめたいのは**対象の解決規則**であって、選べるかではない。
 */
function withSelected(lid: string): AppState {
  return { ...initialState, selectedLid: lid };
}

function setup(state: AppState) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher(state);
  const opened: string[] = [];
  bindActions(root, d, { openNoteWindow: (lid) => void opened.push(lid) });
  /** ⚠ 行を模す ── ⋯ は**行の中**から押される(`data-pkc-entry` が親に居る)。 */
  const press = (lid?: string) => {
    const host = document.createElement('div');
    if (lid !== undefined) host.setAttribute('data-pkc-entry', lid);
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'open-note-window');
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
      '別の窓で開くノートがありません',
    );
  });
});
