/**
 * 🔴 **描くたびに console へ書かない**(#710、2026-09-05)。
 *
 * ## 何を守っているか
 *
 * `:::note` / `:::danger` / `:align:{…}` は**支えている記法**である
 * (`tests/smoke/layout.smoke.spec.ts` が `:::note` の地と左の罫まで pin している)。
 * ⚠ それを描くたびに `[PKC2009]` / `[PKC2007]` を `console.info` へ書いていた ──
 * user に直す所は 1 つも無く、しかも **smoke の収集は `error` 以外を捨てる**
 * (`tests/smoke/helpers.ts` の `msg.type() !== 'error'` で return)ので、
 * **増えても誰にも見えない**。だから溜まった。
 *
 * 実測(2026-09-05、smoke を全量 1 回・`page.on('console')` を全種で採った):
 * `markdown-worker` の chunk から
 * `[PKC2009] tolerant alias :::note accepted.` /
 * `[PKC2007] tolerant alias :align: accepted` が出ていた。
 *
 * ## ⚠ 空振りしない形にする
 *
 * 「0 行」だけを見ると、**寛容 parse が 1 度も走らなかった回**でも通る ── だから
 * ① **別名の経路を実際に通ったこと**(描かれた HTML の印)を先に確かめ、
 * ② **頼めば出る**(対照群)ことも見る。②が無いと「emit ごと消す」変異が生き延びる
 * (CLAUDE.md §1「空振りを直したら『今度は何に救われていないか』を問う」)。
 */
import { describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '@features/markdown/markdown-render';

/** `console` の 3 口を丸ごと採る。⚠ 戻すのは呼び側の責任(`finally`)。 */
function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const push = (...a: unknown[]): void => {
    lines.push(a.map(String).join(' '));
  };
  const spies = (['info', 'warn', 'log'] as const).map((k) =>
    vi.spyOn(console, k).mockImplementation(push),
  );
  return {
    lines,
    restore: () => {
      for (const s of spies) s.mockRestore();
    },
  };
}

/** 寛容 parse を**全部**通す本文(別名 3 系統 + 行頭の寄せ)。 */
const SRC = [
  ':::note',
  '注記',
  ':::',
  '',
  ':::danger',
  '危険',
  ':::',
  '',
  ':::callout{type=tip}',
  '助言',
  ':::',
  '',
  ':::admonition{type=info title="表題"}',
  '案内',
  ':::',
  '',
  /**
   * ⚠ **`:align:` は経路が 2 本ある**(行そのもの / 段落の中)── 両方入れる。
   *   行のほうは次の段落へ寄せを登録するだけで `data-pkc-canonical` を出さないので、
   *   下の空振り防止は**段落の中**のほうで見る(1 稿目はここで落ちた)。
   */
  ':align:{position=center}',
  '',
  '寄せた段落',
  '',
  '本文 :align:{position=center} の続き',
  '',
].join('\n');

describe('🔴 描くたびに console へ書かない (#710)', () => {
  it('🔴 既定では 1 行も書かない(支えている記法を描いただけで通知しない)', () => {
    const cap = captureConsole();
    let html: string;
    try {
      html = renderMarkdown(SRC);
    } finally {
      cap.restore();
    }
    /**
     * ⚠ **空振り防止を先に置く** ── 別名が `:::section{role=…}` へ書き換わって
     *   いなければ、下の「0 行」は**何も主張していない**。
     */
    expect(html, ':::note が callout として描かれていない(台の空振り)').toContain(
      'pkc-section-note',
    );
    expect(html, ':::danger が callout として描かれていない(台の空振り)').toContain(
      'pkc-section-danger',
    );
    expect(html, ':::callout{type=tip} が別名として受理されていない').toContain(
      'pkc-section-tip',
    );
    expect(html, ':align: の canonical 属性が出ていない(寛容 parse を通っていない)').toContain(
      'data-pkc-canonical=',
    );
    expect(cap.lines, `描画が console へ書いた: ${cap.lines.join(' / ')}`).toEqual([]);
  });

  it('🔴 頼めば出る(hint を読む道具の口は残っている)', () => {
    const cap = captureConsole();
    try {
      renderMarkdown(SRC, { silentHallucinationWarnings: false });
    } finally {
      cap.restore();
    }
    // ⚠ 対照群 ── これが無いと「emit ごと消す」変異が上の test を素通りする
    expect(
      cap.lines.filter((l) => l.includes('PKC2009')).length,
      '別名の hint を頼んでも出ない(口ごと消えている)',
    ).toBeGreaterThanOrEqual(1);
    expect(
      cap.lines.filter((l) => l.includes('PKC2007')).length,
      ':align: の hint を頼んでも出ない',
    ).toBeGreaterThanOrEqual(1);
  });
});
