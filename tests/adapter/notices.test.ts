/** @vitest-environment happy-dom */
/**
 * 複数件の注意を**全部**見せる面(P6c review H-2)。
 *
 * ⚠ これが無かった間、status footer(1 行・textContent 上書き)に `notes[0]` だけを
 * 載せており、**2 件目以降はどこにも出力されていなかった**。段④ で warning に
 * 「どのファイルか」を冠したのは件数が内側 bundle 数に比例するからで、
 * 出口が 1 行のままでは設計が空振りする ── だから出口の側を pin する。
 */
import { describe, expect, it } from 'vitest';
import { showNotices, clearNotices } from '../../src/adapter/ui/render/notices';

const region = (): HTMLElement => document.createElement('section');
const items = (r: HTMLElement): string[] =>
  [...r.querySelectorAll('[data-pkc-notice]')].map((n) => n.textContent ?? '');

describe('showNotices', () => {
  it('🔑 **全件**を出す(1 件目だけにしない)', () => {
    const r = region();
    const notes = Array.from({ length: 12 }, (_, i) => `n${i + 1}.text.zip: 添付がありません`);
    showNotices(r, '取込時の注意', notes);
    expect(items(r)).toEqual(notes);
    expect(r.hidden).toBe(false);
    // 件数も見せる(「注意がある」ことに気づく手掛かり)
    expect(r.querySelector('[data-pkc-field="notices-title"]')!.textContent).toContain('12 件');
  });

  it('0 件なら何も出さない(空の枠を残さない)', () => {
    const r = region();
    showNotices(r, 't', []);
    expect(r.hidden).toBe(true);
    expect(r.textContent).toBe('');
  });

  it('前回の内容を持ち越さない', () => {
    const r = region();
    showNotices(r, 't', ['古い 1', '古い 2']);
    showNotices(r, 't', ['新しい']);
    expect(items(r)).toEqual(['新しい']);
  });

  it('閉じられる(閉じる導線が無いと画面を占有し続ける)', () => {
    const r = region();
    showNotices(r, 't', ['a']);
    expect(r.querySelector('[data-pkc-action="dismiss-notices"]')).not.toBeNull();
    clearNotices(r);
    expect(r.hidden).toBe(true);
    expect(items(r)).toEqual([]);
  });

  /**
   * 🔴 **閉じるは、流れる一覧の外に在る**(#151 の同型。お知らせ側と揃える)。
   *
   * ⚠ この面は 200 件の注意が出うる(`app.css` の注記にその実例が書いてある)。
   * 閉じるが一覧の中に在ると、**読み下ろした時点で上へ流れて消える** ──
   * お知らせの帯で実機報告された欠陥とまったく同じ形である。
   * 🔑 流れるのは `ul` だけなので、閉じるが**その中に居ないこと**を pin する。
   */
  it('🔴 閉じるは見出しの行に在り、流れる一覧の中に入っていない', () => {
    const r = region();
    showNotices(r, 't', ['a', 'b']);
    const close = r.querySelector('[data-pkc-action="dismiss-notices"]')!;
    const head = r.querySelector('[data-pkc-field="notices-title"]')!;
    const list = r.querySelector('ul')!;
    // ⚠ 空振り防止 ── 一覧そのものが在ること
    expect(list, '流れる一覧が無い').not.toBeNull();
    expect(head.contains(close), '閉じるが見出しの行に無い').toBe(true);
    expect(list.contains(close), '閉じるが流れる一覧の中に在る(読み下ろすと消える)').toBe(false);
    // 🔑 **順も pin する**(お知らせ側と同文)── 包含関係を保ったまま
    //    見出しを一覧の後ろへ回すと、「同じものが同じ場所」が崩れる
    expect(
      head.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
      '見出しが一覧より後ろに在る',
    ).toBeTruthy();
  });

  it('本文は textContent で入る(HTML として解釈しない)', () => {
    // 注意文には user 由来のファイル名が入る ── markup として解釈させない
    const r = region();
    showNotices(r, 't', ['<img src=x onerror=alert(1)>.text.zip: 壊れています']);
    expect(r.querySelector('img')).toBeNull();
    expect(items(r)[0]).toContain('<img src=x onerror=alert(1)>');
  });
});
