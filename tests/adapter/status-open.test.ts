/** @vitest-environment happy-dom */
/**
 * 🔴 **知らせの隣の「開く」**(#668 A。PR #667 の着地前レビュー)。
 *
 * 添付を取り込んだのに本文へ入れられなかった回(開いているのがフォルダ等)は、
 * 「「見積.pdf」を添付にしました(…本文には入れていません)」と言う ── そのとき
 * **その添付へ行く道が画面のどこにも無かった**。この file が守るのは:
 *
 * ① 🔴 器(`shell.ts`)が押し口を持ち、それが **`select-entry` の受け手**へ繋がっている
 *    (実行の口を新しく作らない ── §7)
 * ② 🔴 身元が在れば出て、`data-pkc-entry` に**その lid**が書かれる
 * ③ 🔴 畳む 3 条件 ── 身元が無い / もう開いている / 字が別の知らせに上書きされた
 *
 * ⚠ `main.ts` の配線(`paintOpen`)は test から届かない ── だから判断はここに在る
 *   (CLAUDE.md §2「どの test からも実行されない file に、判断を書かない」)。
 */
import { describe, expect, it } from 'vitest';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { paintStatusOpen } from '../../src/adapter/ui/render/status-open';

const LINE = '「見積.pdf」を添付にしました(開いているのは『フォルダ』なので、本文には入れていません)';

function btn(): HTMLElement {
  const b = document.createElement('button');
  b.hidden = true;
  return b;
}

describe('知らせの隣の「開く」(#668 A)', () => {
  it('🔴 ① 器が押し口を持ち、select-entry の受け手へ繋がっている', () => {
    document.body.textContent = '';
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    const open = regions.statusOpen;
    expect(open.getAttribute('data-pkc-field')).toBe('status-open');
    // 🔑 実行の口は既存の受け手 ── ここが別の名前なら、押しても誰も拾わない
    expect(open.getAttribute('data-pkc-action'), '受け手の無い口').toBe('select-entry');
    expect(open.textContent).toBe('開く');
    expect(open.hidden, '身元が無いのに出ている').toBe(true);
    // ⚠ 状態の行の**中**に居る(知らせの隣に出る)
    expect(regions.status.contains(open), '状態の行の外に居る').toBe(true);
  });

  it('🔴 ② 身元が在れば出て、その lid を受け手が読む属性に書く', () => {
    const b = btn();
    paintStatusOpen(b, { noticeOpen: 'a1', selectedLid: 'f1', notice: LINE }, LINE);
    expect(b.hidden).toBe(false);
    expect(b.getAttribute('data-pkc-entry'), '押しても別の物が開く').toBe('a1');
  });

  it('⚠ ③ 身元が無ければ畳む(添えない知らせに押す口を残さない)', () => {
    const b = btn();
    paintStatusOpen(b, { noticeOpen: 'a1', selectedLid: 'f1', notice: LINE }, LINE);
    paintStatusOpen(b, { noticeOpen: null, selectedLid: 'f1', notice: 'コピーしました' }, 'コピーしました');
    expect(b.hidden).toBe(true);
    expect(b.hasAttribute('data-pkc-entry'), '古い身元が残っている').toBe(false);
  });

  it('🔴 ③ もうそれを開いていたら畳む(開いている物を「開く」と言わない)', () => {
    const b = btn();
    paintStatusOpen(b, { noticeOpen: 'a1', selectedLid: 'a1', notice: LINE }, LINE);
    expect(b.hidden, '開いている物の「開く」が出ている').toBe(true);
  });

  it('🔴 ③ 字が別の知らせ(state を通らない showStatus)に上書きされたら畳む', () => {
    const b = btn();
    paintStatusOpen(b, { noticeOpen: 'a1', selectedLid: 'f1', notice: LINE }, LINE);
    expect(b.hidden, '前提: 出ていない').toBe(false);
    // 「コピーしました」が字だけ上書きした ── state の notice は古いまま残る
    paintStatusOpen(b, { noticeOpen: 'a1', selectedLid: 'f1', notice: LINE }, 'コピーしました');
    expect(b.hidden, '別の知らせの隣に、前の添付の「開く」が残っている').toBe(true);
  });
});
