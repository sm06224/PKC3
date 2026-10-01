/**
 * #1207 の「良くできる所」のうち、**CSS と配線**で守る分(画面の道中は各 unit が持つ)。
 *
 * - I2: 消えたリンクだけ**薄い字 + 点線**。⚠ 本文の `@日付` も点線だが、あちらは**押せる印**なので
 *   字の色は本文のまま ── 同じ点線が逆の意味にならないよう、薄くするのは押せない側だけ。
 * - I6: 「全部出しています」の一言は押下表示の左隣(余白を 2 つで割らない)。
 * - I4: 添付の元の file 名を引く口を main が渡している(main.ts はどの test からも走らないので原文で pin)。
 *
 * ⚠ CSS は**構文で**読む(注釈を剥ぎ、選択子リストを割って**丸ごと一致**を見る ── `helpers/css-blocks.ts`)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';
import { codeOnly } from '../helpers/code-only';

const css = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf8')));

const MISSING = '.pkc-md-rendered [data-pkc-link-missing]';
const DATE_LINK = '[data-pkc-prose] .pkc-date-link';

describe('I2: 点線は 2 つの逆の意味を持たない(#1207)', () => {
  it('🔴 消えたリンクは薄い字(--muted)+ 点線', () => {
    const blocks = blocksFor(css, MISSING);
    expect(blocks.length, '消えたリンクの規則が無い(空振り)').toBe(1);
    expect(blocks[0]).toMatch(decl('color', 'var\\(--muted\\)'));
    expect(blocks[0]).toMatch(decl('text-decoration', 'underline dotted'));
  });

  it('🔴 対照群: 押せる @日付 は字の色のまま点線(薄くしない)', () => {
    const blocks = blocksFor(css, DATE_LINK);
    expect(blocks.length, '@日付の規則が無い(空振り)').toBe(1);
    expect(blocks[0]).toMatch(decl('color', 'inherit'));
    expect(blocks[0]).toMatch(decl('text-decoration', 'underline dotted'));
    expect(blocks[0], '押せる字まで薄くした').not.toContain('--muted');
  });
});

describe('マニュアルの言い分が見た目と揃っている(#1207)', () => {
  const manual = readFileSync('docs/manual.md', 'utf8');
  it('🔴 消えたリンクは「薄い字 + 点線の下線」と書く(2 か所)。「字の色は変わりません」と言い残さない', () => {
    expect(manual.split('薄い字 + 点線の下線').length - 1, '説明が 2 か所そろっていない').toBe(2);
    // 旧い言い分(色は変わらない)が消えたリンクの節に残っていない
    const at = manual.indexOf('#### リンク先が無いリンク');
    expect(at, '節が見つからない(空振り)').toBeGreaterThan(-1);
    const section = manual.slice(at, at + 400);
    expect(section).not.toContain('字の色は変わりません');
  });
  it('🔴 見出し名と一言を書いている', () => {
    expect(manual).toContain('右の「本文で使う添付」の行');
    expect(manual).toContain('全部出しています(N 件)');
  });
});

describe('I6: 「全部出しています」の一言の置き方(#1207)', () => {
  const NOTE = "[data-pkc-region='filer-breadcrumb'] [data-pkc-field='filer-flatten-note']";
  const GROUP = "[data-pkc-region='filer-breadcrumb'] [data-pkc-field='filer-flatten-group']";
  const BUTTON = "[data-pkc-region='filer-breadcrumb'] [data-pkc-field='filer-flatten']";

  it('🔴 一言は薄い字。一言と押し口の塊が右へ寄り、塊の中の押し口は余白を持たない', () => {
    const note = blocksFor(css, NOTE);
    expect(note.length, '一言の規則が無い(空振り)').toBe(1);
    expect(note[0]).toMatch(decl('color', 'var\\(--muted\\)'));
    const group = blocksFor(css, GROUP);
    expect(group.length, '塊の規則が無い(別々に寄せると折り返しで押し口だけ左へ落ちる)').toBe(1);
    expect(group[0]).toMatch(decl('margin-inline-start', 'auto'));
    const inner = blocksFor(css, `${GROUP} [data-pkc-field='filer-flatten']`);
    expect(inner.length, '塊の中の押し口の規則が無い').toBe(1);
    expect(inner[0]).toMatch(decl('margin-inline-start', '0'));
    // 対照群: 押し口の素の規則は右端寄せのまま(一言が無いときの見え方を変えていない)
    const plain = blocksFor(css, BUTTON);
    expect(plain.length).toBe(1);
    expect(plain[0]).toMatch(decl('margin-inline-start', 'auto'));
  });
});

describe('I4: 添付の元の file 名を引く口を main が渡している(#1207)', () => {
  it('🔴 inspector へ resolver を渡し、持ち主の逆引き(findAssetOwner)の name を返す', () => {
    const main = codeOnly(readFileSync('src/main.ts', 'utf8'));
    const at = main.indexOf('inspector.setAssetNameResolver(');
    expect(at, '口を渡していない(説明文の空の添付が id のままになる)').toBeGreaterThan(-1);
    const call = main.slice(at, at + 400);
    expect(call).toContain("op: 'findAssetOwner'");
    expect(call, '返すのは name(lid ではない)').toMatch(/\.name\b/);
  });
});
