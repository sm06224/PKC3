/**
 * 印刷レイアウト表示の「紙の継ぎ目」(`+++` で紙が 2 枚に分かれて見える)と「ページ設定 ▾」の置き場所。
 * - CSS は**コメントを剥がして**、対象の選択子の規則だけを見る(コメント内の字で満たさない)
 * - 置き場所は純粋関数 `computePanelPosition` で数値を突き合わせる
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computePanelPosition } from '@adapter/ui/render/page-setup-panel';

const CSS = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** 選択子に `selectorPart` を含む規則の本体(`{}` の中)を返す。 */
function rulesFor(selectorPart: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(CSS); m !== null; m = re.exec(CSS)) if (m[1]!.includes(selectorPart)) out.push(m[2]!);
  return out;
}

describe('紙の継ぎ目の CSS', () => {
  it('🔴 改ページの hr はカウンタを進め、::after が「N ページ目」を出す(画面だけ)', () => {
    const hr = rulesFor('hr.pkc-section-break').filter((b) => b.includes('counter-increment: pkc-sheet'));
    expect(hr.length).toBe(1);
    const after = rulesFor('hr.pkc-section-break::after');
    expect(after.some((b) => /content:\s*counter\(pkc-sheet\)\s*' ページ目'/.test(b))).toBe(true);
    // 本文の頭で 1 にする(最初の紙 = 1。最初の改ページの後が 2)
    expect(rulesFor('detail-body').some((b) => /counter-reset:\s*pkc-sheet 1/.test(b))).toBe(true);
    // 印刷には出さない: カウンタを進める規則の直前の @media は screen
    const at = CSS.indexOf('counter-increment: pkc-sheet');
    const lastMedia = [...CSS.slice(0, at).matchAll(/@media[^{]+\{/g)].pop()![0];
    expect(lastMedia.trim()).toBe('@media screen {');
  });
  it('左右へ突き出す(負のマージン)・作業台の地色・上下の影を持つ', () => {
    const b = rulesFor('hr.pkc-section-break').find((x) => x.includes('counter-increment'))!;
    expect(b).toMatch(/margin-inline:\s*calc\(-1 \*/);
    expect(b).toContain('var(--surface-2)');
    expect(b).toContain('linear-gradient(to bottom');
  });
  it('2 択のボタンは押された側を薄い地色 + アクセントの下線で示す(塗りつぶさない)', () => {
    const b = rulesFor("[data-pkc-print-layout-segment] > button[aria-pressed='true']");
    expect(b.length).toBe(1);
    expect(b[0]).toContain('border-bottom-color: var(--accent)');
    expect(b[0]).toContain('color-mix(in srgb, var(--accent)');
  });
  it('帯の 2 択は 1100px 以下でだけ出す', () => {
    expect(rulesFor("[data-pkc-field='bar-print-layout']").some((b) => /display:\s*none/.test(b))).toBe(true);
    const m = /@media \(max-width: 1100px\)\s*\{\s*\[data-pkc-field='bar-print-layout'\]\s*\{\s*display:\s*inline-flex/.exec(CSS);
    expect(m).not.toBeNull();
  });
});

describe('computePanelPosition(ページ設定 ▾ の置き場所)', () => {
  const view = { width: 1000, height: 800 };
  const panel = { width: 320, height: 300 };
  it('ボタンの左端にそろえ、真下に置く', () => {
    expect(computePanelPosition({ left: 400, top: 100, bottom: 130 }, panel, view)).toEqual({ x: 400, y: 134 });
  });
  it('右端からはみ出すなら内側へ寄せる / 左端は余白で止める', () => {
    expect(computePanelPosition({ left: 900, top: 100, bottom: 130 }, panel, view).x).toBe(1000 - 8 - 320);
    expect(computePanelPosition({ left: -50, top: 100, bottom: 130 }, panel, view).x).toBe(8);
  });
  it('下が足りなければボタンの上へ回す', () => {
    expect(computePanelPosition({ left: 400, top: 700, bottom: 730 }, panel, view).y).toBe(700 - 4 - 300);
  });
});
