/**
 * 追記欄の枠(#1890)の CSS 規則を pin する。幅と折り返しは実ブラウザでしか測れない(happy-dom は 0)ので、
 * ここでは「規則が在る」ことをコメントを剥がした CSS から見る(#496 の再発防止: 追記先の幅を中身で決めない)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** 指定の selector だけを書いた規則の本体(複数あれば連結)。 */
function body(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, 'g');
  const out: string[] = [];
  for (const m of css.matchAll(re)) out.push(m[1]!);
  return out.join('\n');
}

describe('追記欄の枠 (#1890)', () => {
  it('追記先の幅は固定 + 最大幅 + 縮み可 + 省略表示(#496 の再発防止)', () => {
    const b = body("[data-pkc-field='append-target']");
    expect(b).toMatch(/\bwidth:\s*18em/);
    expect(b).toMatch(/max-width:\s*100%/);
    expect(b).toMatch(/min-width:\s*0/);
    expect(b).toMatch(/text-overflow:\s*ellipsis/);
    expect(b, '内容依存の幅にしてはならない').not.toMatch(/max-content|fit-content/);
  });

  it('枠が線を持ち、フォーカスの輪郭は枠(:focus-within)で見せる', () => {
    expect(body("[data-pkc-field='append-form']")).toMatch(/border:\s*1px solid/);
    expect(body("[data-pkc-field='append-form']:focus-within")).toMatch(/border-color:\s*var\(--accent\)/);
    expect(body("[data-pkc-field='append-input']:focus-visible")).toMatch(/outline:\s*none/);
  });

  it('下段は折り返し、押す物は右へ寄る', () => {
    expect(body("[data-pkc-field='append-bar']")).toMatch(/flex-wrap:\s*wrap/);
    expect(body("[data-pkc-field='append-actions']")).toMatch(/margin-left:\s*auto/);
  });

  /** 🔴 台帳 #1443 の残り(Gemini 設計の 3): 追記先は丸いバッジ(ピル)で見せ、見出しを選んでいるときだけ色が付く。 */
  it('追記先は丸いバッジで、見出しを選んでいる間だけ色(アクセント)が付く', () => {
    const b = body("[data-pkc-field='append-target']");
    expect(b).toMatch(/border-radius:\s*999px/);
    expect(body("[data-pkc-field='append-target'][data-pkc-target-chosen]")).toMatch(/border-color:\s*var\(--accent\)/);
    // 幅の固定(#496)は崩さない
    expect(b).toMatch(/\bwidth:\s*18em/);
  });
});
