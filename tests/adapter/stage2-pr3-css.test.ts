/** @vitest-environment node */
/**
 * 🔴 **UI/UX 監査の修正の CSS 規則**(Stage 2 PR-3)── 原文を構文で読んで pin する(コメントを剥がし、選択子を丸ごと一致で引く)。
 * 実ブラウザで測る側は `tests/smoke/stage2-pr3.smoke.spec.ts`(幾何・色)。ここは「規則が在り、当たる先が合っている」だけ。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';

const css = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));
const one = (sel: string): string => {
  const hit = blocksFor(css, sel);
  expect(hit.length, `${sel} の規則が無い`).toBe(1);
  return hit[0]!;
};

describe('Stage 2 PR-3 の CSS', () => {
  it('🔴 3: 言語バッジのある枠だけ、pre の上に 1 行ぶんの余白を取る(1 行のコードにバッジが重ならない)', () => {
    const b = one('.pkc-md-rendered .pkc-md-block:has(> .pkc-code-lang) > pre');
    expect(b, '上の余白を取っていない').toMatch(/padding-top\s*:\s*calc\(var\(--s3\) \+ 1\.1em\)/);
    // 対照群: バッジは右上の絶対配置のまま(余白を取る理由が実在する)
    const badge = one('.pkc-md-rendered .pkc-code-lang');
    expect(badge).toMatch(decl('position', 'absolute'));
    expect(badge).toMatch(decl('top', '4px'));
  });

  it('🔴 2: 本体が主でない間、▾ も本体と同じ薄い標準の見た目(地・字・枠・減光 .45)にそろえる', () => {
    const sel =
      "[data-pkc-region='create-bar']:has([data-pkc-field='create-run']:not([data-pkc-variant='primary'])) button[data-pkc-field='create-pick']";
    const b = one(sel);
    expect(b).toMatch(decl('opacity', '0\\.45'));
    expect(b).toContain('color-mix(in srgb, var(--fg) 6%, transparent)');
    // hover / 開いている / 焦点でも緑へ戻らない(同じ規則に束ねてある)
    for (const state of [':hover:not(:disabled)', "[aria-expanded='true']", ':focus-visible']) {
      expect(blocksFor(css, sel + state).length, `${state} が同じ規則に束ねられていない(緑へ戻る)`).toBe(1);
    }
    // 対照群: 本体が主のときの ▾ は今までどおり --accent の地
    expect(one("[data-pkc-region='create-bar'] button[data-pkc-field='create-pick']")).toMatch(decl('background', 'var\\(--accent\\)'));
  });

  it('🔴 1: ▾ の図案も --accent-fg そのもの(色相を混ぜない)', () => {
    const b = one("[data-pkc-region='create-bar'] button[data-pkc-field='create-pick'] [data-pkc-icon]");
    expect(b).toMatch(decl('--pkc-icon-line', 'var\\(--accent-fg\\)'));
    expect(b).not.toContain('--pkc-icon-hue');
  });

  it('🔴 6: 並び順の欄は基準の幅を小さく取り、⇅ と同じ行に収まる', () => {
    const b = one("[data-pkc-region='shell'][data-pkc-layout='phone'] [data-pkc-field='entry-sort']");
    expect(b, '並び順が 2 行目で伸びない').toMatch(decl('flex', '1 1 8em'));
    expect(one("[data-pkc-region='shell'][data-pkc-layout='phone'] [data-pkc-field='entry-filter']"), '探す欄が行の 6 割でない(⇅ が単独で折り返す)').toMatch(decl('flex', '1 1 60%'));
    // 対照群: 広い画面は内容依存のまま(字が切れない)
    expect(one("[data-pkc-field='entry-sort']")).toMatch(decl('flex', '0 1 auto'));
  });
});
