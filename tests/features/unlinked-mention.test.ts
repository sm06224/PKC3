/**
 * 🔴 **リンクのない言及**(#1966 4-1)の当て方と包み方。
 * user 指示 2026-11-16「コードブロック内や既存の `entry:` リンク内を誤って書き換えないよう境界テストを入れること」。
 */
import { describe, expect, it } from 'vitest';
import {
  findUnlinkedMentions,
  isMentionableTitle,
  linkMentions,
} from '../../src/features/entry-ref/unlinked-mention';

const T = '会議メモ';
const L = 'n42';
const BT = '`';
const FENCE = BT.repeat(3);
const link = (s: string): string => `[${s}](entry:${L})`;
const conv = (body: string, title = T): string => linkMentions(body, title, L).body;
const count = (body: string, title = T): number => findUnlinkedMentions(body, title).length;

describe('包む(ただの字として出ている所)', () => {
  it('🔴 本文の言及をリンクに変える(複数・行をまたいで全部)', () => {
    expect(conv(`今日の${T}を見る\n- ${T} の続き`)).toBe(`今日の${link(T)}を見る\n- ${link(T)} の続き`);
    expect(linkMentions(`${T} と ${T}`, T, L).count).toBe(2);
  });

  it('🔴 英字の大小は区別せずに見つけ、包むときは本文の字のまま', () => {
    expect(conv('see pkc docs', 'PKC docs')).toBe(`see ${link('pkc docs')}`);
  });

  it('⚠ 英数字の題名は語の途中に当てない(PKC は PKC3 / myPKC の中に当たらない)', () => {
    expect(count('PKC3 と myPKC と PKC_x', 'PKC')).toBe(0);
    expect(conv('PKC と PKC。', 'PKC')).toBe(`${link('PKC')} と ${link('PKC')}。`);
  });

  it('🔑 日本語は語の切れ目が無いので、字の並びが同じなら当てる', () => {
    expect(count(`第2回${T}について`)).toBe(1);
  });

  it('⚠ 題名の字が記法を持っていても、リンクの字はエスケープされる', () => {
    expect(conv('メモ a*b の件', 'a*b')).toBe(`メモ ${link('a\\*b')} の件`);
  });
});

describe('🔴 境界: 書き換えない所(user 指示)', () => {
  const untouched: Array<[string, string]> = [
    ['コードフェンス', `${FENCE}\n${T}\n${FENCE}`],
    ['チルダのフェンス', `~~~md\n${T}\n~~~`],
    ['行内コード', `${BT}${T}${BT}`],
    ['4 字下げのコード', `段落\n\n    ${T}\n`],
    ['既存の entry: リンクの字', `[${T}](entry:${L})`],
    ['別のノートへの entry: リンクの字', `[${T}](entry:other)`],
    ['entry: リンクの宛先と章', `[見る](entry:x#${T})`],
    ['URL のリンクの字', `[${T}](https://example.com/)`],
    ['画像の説明', `![${T}](asset:k1)`],
    ['参照形式の使う側', `[${T}][r1]\n\n[r1]: https://example.com`],
    ['参照形式の定義行', `[${T}]: https://example.com`],
    ['[[題名]] のリンク', `[[${T}]]`],
    ['[[題名|表示]] のリンク', `[[別のノート|${T}]]`],
    ['自動リンク', `<https://example.com/${T}>`],
    ['括弧なしの URL', `https://example.com/${T}`],
    ['entry: の語', `entry:${T}`],
    ['HTML のタグの属性', `<span title="${T}">x</span>`],
    ['HTML のコメント', `<!-- ${T} -->`],
    ['数式', `$${T}$`],
    ['先頭の設定行', `---\ntitle: ${T}\n---\n本文`],
    ['角括弧で囲んだ字', `[${T}]`],
    // ⚠ 字の端が `[` `]` に接しない形(端の守りに頼らず、範囲の守りだけで止まることを見る ── 変異試験で生き延びた穴)
    ['リンクの字の途中', `[今日の${T}について](entry:x)`],
    ['URL のリンクの字の途中', `[第2回${T}の資料](https://example.com/)`],
    ['参照形式の使う側の字の途中', `[今日の${T}資料][r1]`],
    ['参照形式の定義行の名前の途中', `[今日の${T}資料]: https://example.com`],
    ['[[題名]] の途中', `[[第2回${T}の件]]`],
    // 🔴 着地前レビューで、包むと記法が壊れることを実際に再現した形(🔴1〜5・⚠6・⚠7)
    ['リストの中の字下げコード', `- a\n\n      ${T}`],
    ['リストの中の字下げコード(3 字の印)', `-   a\n\n        ${T}`],
    ['属性が行をまたぐ HTML のタグ', `<div\n  title="${T}"\n  class="x">`],
    ['行をまたぐ img の alt', `<img\nalt="${T}"\nsrc=x>`],
    ['<pre> の中', `<pre>\n${T}\n</pre>`],
    ['<style> の中', `<style>\na::after { content: "${T}" }\n</style>`],
    ['<script> の中', `<script>var a = "${T}";</script>`],
    ['閉じない HTML のコメント', `<!-- ${T}`],
    ['行内の記法の属性', `:span:[x]{title="${T}"}`],
    ['囲みの開きの属性', `:::figure{#fig caption="${T}"}\n本文\n:::`],
    ['囲みの開きの属性(引用符なし)', `:::note{title=${T}}\n本文\n:::`],
    ['差し込みの名前', `{{vars.${T}}}`],
    ['計算の式', `={${T}}`],
    ['見出しの id', `段落 {#${T}}`],
    ['直前の \\ でエスケープ', `C:\\Docs\\${T}`],
    ['脚注の名前の途中', `本文[^a${T}b]`],
    ['www. の URL', `www.example.com/${T}`],
    ['メールの宛先', `${T}@example.com`],
    ['\\( \\) の数式', `\\(${T}\\)`],
    ['見出しの行', `## ${T} の進め方`],
    ['下線の見出し', `${T} の進め方\n===`],
    ['下線の見出し(---)', `${T} の進め方\n---`],
  ];
  for (const [name, body] of untouched) {
    it(`${name} は書き換えない`, () => {
      expect(count(body), `${name} に当たった`).toBe(0);
      expect(conv(body)).toBe(body);
    });
  }

  it('🔴 同じ本文の中で、守る所と包む所が混ざっていても、包むのは外の字だけ', () => {
    const body = [`${T} を読む`, FENCE, T, FENCE, `[${T}](entry:${L}) と ${BT}${T}${BT} と ${T}`].join('\n');
    expect(conv(body)).toBe(
      [`${link(T)} を読む`, FENCE, T, FENCE, `[${T}](entry:${L}) と ${BT}${T}${BT} と ${link(T)}`].join('\n'),
    );
  });

  it('⚠ 包んだ結果をもう一度通しても、二重に包まない(冪等)', () => {
    const once = conv(`${T} と ${T}`);
    expect(conv(once)).toBe(once);
    expect(count(once)).toBe(0);
  });

  it('⚠ CRLF の本文でも位置がずれない', () => {
    expect(conv(`一行目\r\n${T}\r\n${BT}${T}${BT}`)).toBe(`一行目\r\n${link(T)}\r\n${BT}${T}${BT}`);
  });

  it('⚠ 小文字にすると長さが変わる字が在る本文でも、ほかの字を壊さない', () => {
    expect(conv(`İstanbul と ${T}`)).toBe(`İstanbul と ${link(T)}`);
  });

  it('⚠ 守る範囲の外の言及は包む(守りすぎて、ふつうの本文まで止めない)', () => {
    expect(conv(`- ${T} の件\n    - 入れ子の ${T}`), 'リストの印で始まる深い行まで守った').toBe(
      `- ${link(T)} の件\n    - 入れ子の ${link(T)}`,
    );
    expect(conv(`<b>${T}</b>`), 'タグの間の字まで守った').toBe(`<b>${link(T)}</b>`);
    expect(conv(`見出しの下の ${T}\n\n## 章\n\n${T}`)).toBe(`見出しの下の ${link(T)}\n\n## 章\n\n${link(T)}`);
    expect(conv(`\\\\${T}`), '偶数個の \\ はエスケープではない').toBe(`\\\\${link(T)}`);
  });

  it('⚠ 角括弧の左右の守りは片方ずつ効く(片方だけ消しても落ちる ── 変異試験の穴)', () => {
    expect(count(`[${T} の資料]`), '左の [ に接している').toBe(0);
    expect(count(`[資料の ${T}]`), '右の ] に接している').toBe(0);
  });

  it('⚠ 先頭の設定行の後ろの本文は包む(設定行だけを守る)', () => {
    expect(conv(`---\ntitle: x\n---\n${T}`)).toBe(`---\ntitle: x\n---\n${link(T)}`);
  });
});

describe('探す題名', () => {
  it('⚠ 1 字・数字と記号だけ(日付)・空は探さない', () => {
    expect(isMentionableTitle('A')).toBe(false);
    expect(isMentionableTitle('2026-11-16')).toBe(false);
    expect(isMentionableTitle('001')).toBe(false);
    expect(isMentionableTitle('   ')).toBe(false);
    expect(isMentionableTitle('会議')).toBe(true);
    expect(isMentionableTitle('11月の会議')).toBe(true);
    expect(count('2026-11-16 の記録', '2026-11-16')).toBe(0);
  });
});

describe('⚠ 大きな本文でも止まらない(着地前レビュー ⚠8)', () => {
  it('🔴 `@` の無い 1MB の 1 行でも線形に終わる(メールの正規表現が位置ごとに行末まで読むと止まる ── 実測)', () => {
    const body = `${'あ'.repeat(1_000_000)} ${T}`;
    const t0 = performance.now();
    expect(count(body)).toBe(1);
    expect(performance.now() - t0, '1MB の 1 行に時間がかかりすぎる').toBeLessThan(1500);
  });

  it('記法の多い 1MB の本文でも 1.5 秒以内', () => {
    const body = `[a](x) \`c\` ${T} $ `.repeat(40_000);
    const t0 = performance.now();
    expect(count(body)).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
