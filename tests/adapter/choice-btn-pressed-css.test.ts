/**
 * 🔴 **選ばれているボタンの濃さは、kind-bar と設定の選択列で「同じ 1 本」**
 * (#1038 段J-2。着地前レビュー「実ブラウザでは選んでいるボタンが他と見分けが
 * 付かない」)。
 *
 * `choice-buttons.ts` の `buildPressedButton()` が kind-bar の札にも設定の
 * 選択列にも `data-pkc-choice-btn` を立てる ── だから CSS 側は**この属性の
 * 1 本**だけが濃さを決めてよい。⚠ region 名指しでもう 1 本コピーされたら、
 * 設定の選択列は再び「aria-pressed は付くが色が変わらない」に戻る
 * (2026-09-26 に実ブラウザ smoke 3 本が落ちて判明した実害そのもの)。
 *
 * ⚠ **CSS は構文で読む**(`tests/helpers/css-blocks.ts` の手法。CLAUDE.md §1
 *   「`toContain` で file 全体を見ると、コメントに満たされて空振りする」)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, stripComments, decl } from '../helpers/css-blocks';

const css = (): string => stripComments(readFileSync('src/styles/app.css', 'utf-8'));

describe('選ばれているボタンの濃さ(kind-bar / 設定の選択列で共有)', () => {
  it('🔴 [data-pkc-choice-btn][aria-pressed="true"] が濃い地・字色を持つ', () => {
    const blocks = blocksFor(css(), "[data-pkc-choice-btn][aria-pressed='true']");
    expect(blocks, '共有の濃さの規則が無い').toHaveLength(1);
    expect(decl('background', 'var\\(--accent\\)').test(blocks[0]!)).toBe(true);
    expect(decl('color', 'var\\(--accent-fg\\)').test(blocks[0]!)).toBe(true);
  });

  it('🔴 kind-bar だけを狙い撃つ「濃さ」の規則が、もう 1 本コピーされていない', () => {
    // ⚠ 直す前はここに 2 本目があった(region 名指し) ── 復活を等値 pin で防ぐ
    const dup = blocksFor(css(), "[data-pkc-region='kind-bar'] button[aria-pressed='true']");
    expect(dup, 'kind-bar だけの濃さの規則が復活している(2 本目のコピー)').toHaveLength(0);
  });

  it('🔴 [data-pkc-choice-btn]:hover も 1 本だけ(kind-bar 専用の :hover を作らない)', () => {
    const shared = blocksFor(css(), '[data-pkc-choice-btn]:hover');
    expect(shared, '共有の hover 規則が無い').toHaveLength(1);
    expect(decl('border-color', 'var\\(--accent\\)').test(shared[0]!)).toBe(true);
    const dup = blocksFor(css(), "[data-pkc-region='kind-bar'] button:hover");
    expect(dup, 'kind-bar だけの hover 規則が復活している(2 本目のコピー)').toHaveLength(0);
  });
});
