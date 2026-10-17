/**
 * PDF ビューアのページの一覧に、選ぶチェックを出す(#1626 の 6。Gemini 裁定 = #1163 の依頼 34 の Q6)。
 *
 * ⚠ `public/pdf/reader.js` は pdf.js の窓の中で動き、unit からは実行できない(実ブラウザは smoke の
 *   `pdf-reader.smoke.spec.ts`)。ここは**配線の原文 pin** ── 弱いと自覚して使う。守るのは:
 * ① 各ページの行に、↻ × と同じ並び(`thumb-act`)で「選ぶ」ボタンが組まれている
 * ② 押した先が Ctrl+クリックと同じ `pickToggle`(選びを切り替える 1 本)
 * ③ 選びの見た目(☐ / ☑ と `aria-pressed`)を、選びが変わる口(`paintSelected`)が書く
 * ④ 窓の CSS に置き場がある
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const code = (file: string): string =>
  readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

describe('PDF ビューアの「選ぶ」チェック(#1626)', () => {
  const js = code('public/pdf/reader.js');

  it('① 行ごとに ↻ × と同じ並びのボタンを組む', () => {
    expect(js).toContain("pick.className = 'thumb-act thumb-pick';");
    expect(js).toContain("pick.setAttribute('data-pkc-field', 'pdf-page-pick');");
    expect(js).toContain('cell.append(item, turn, drop, up, down, pick);');
  });

  it('🔴 ② 押すと、Ctrl+クリックと同じ「選びを切り替える」1 本へ行く', () => {
    expect(js).toContain("else if (field === 'pdf-page-pick') void pickToggle(which);");
    // Ctrl / ⌘ +クリックも同じ口(口を 2 本にしない)
    expect(js).toContain('void pickToggle(n);');
  });

  it('③ 選びが変わる口が ☐ / ☑ と aria-pressed を書く', () => {
    const at = js.indexOf('function paintSelected(p) {');
    expect(at, '前提: 口が見つからない').toBeGreaterThan(-1);
    const body = js.slice(at, js.indexOf('\n}\n', at));
    expect(body).toContain("pick.textContent = selected.has(p) ? '☑' : '☐';");
    expect(body).toContain("pick.setAttribute('aria-pressed'");
  });

  it('④ 窓の CSS に置き場がある(×の下)', () => {
    const html = readFileSync('public/pdf/host.html', 'utf-8');
    expect(html).toContain('.thumb-pick { right: 8px; top: 32px }');
  });
});
