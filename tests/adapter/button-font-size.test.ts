/**
 * 🔴 **ボタンの字の大きさは 3 段だけ**(#722 P2-10 の一部、2026-09-05)。
 *
 * ## なぜ要るか
 *
 * cowork の実測で **10 / 12 / 12.5 / 13 / 17.55px の 5 種**が混在していた。
 * 調べたら 2 つは**出所がある**:
 *
 * | 見えた値 | 出所 | どうしたか |
 * |---|---|---|
 * | 12.5px | **打つ欄**(`append-input` / `editor-body` / `row-source` / `fm-source`)── ボタンではない | 触らない |
 * | 17.55px | **見出しの畳み**が `.pkc-md-rendered h1`(1.35em)を継いだ値。実測 h1 17.55 / h2 15.6 / h3 14.04 | 触らない(見出しに追従するのが意図) |
 * | 11.5px / 14px | **どこにも理由が書かれていない** | トークンへ寄せた |
 *
 * ## この test が守っているもの / 守っていないもの
 *
 * 🔑 守る:**ボタンを名指しする規則が、素の px を書かないこと**(= 段が増えない)。
 * ⚠ 守らない:**継承で決まる大きさ**(器の `font-size` を継ぐボタン)は見ていない ──
 *   `button { font: inherit }` なので大半のボタンは器の値を継ぐ。それは
 *   「面の中で揃っている」という別の規律であって、ここの主張ではない。
 * ⚠ 守らない:選択子が `button` の語も既知の field も含まない**新しい書き方**は
 *   走査から漏れる(下の `SCAN` の限界。漏れたら段が静かに増える)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blocksFor, stripComments, withoutMedia } from '../helpers/css-blocks';

const APP = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));
const TOKENS = stripComments(readFileSync('src/styles/tokens.css', 'utf-8'));

/**
 * 🔴 **ボタンを名指ししている選択子**の見分け方。
 *
 * ⚠ `button` の語で拾うだけでは足りない ── `data-pkc-field` / `data-pkc-action` だけで
 *   名指しされたボタンが在る。🔑 **身元で足す**(件数ではなく名前 ── 直したら消せる)。
 *
 * 🔴 **頭と尻を両方留める**(CLAUDE.md §1「同じ名前の別物に満たされる」)。
 * ⚠ 1 稿目は `sel.includes('dual-crumb')` と書いたので、**器のほう**
 *   (`[data-pkc-region='dual-crumbs']` ── `<div>` であってボタンではない)に当たり、
 *   「素の px を書いたボタンが在る」と嘘を言った。閉じ括弧まで書けば分かれる。
 */
const BUTTON_SELECTOR_PARTS: readonly string[] = [
  "[data-pkc-field='diagram-save']",
  "[data-pkc-field='task-unschedule']",
  "[data-pkc-region='pane-grip']",
  "[data-pkc-action='dual-crumb']",
];

const SCAN = (sel: string): boolean =>
  /\bbutton\b/.test(sel) ||
  // ⚠ クラスは後ろに伸びうる(`…-btn-2`)ので、続く字が無いことまで見る
  /\.pkc-md-copy-btn(?![\w-])/.test(sel) ||
  BUTTON_SELECTOR_PARTS.some((f) => sel.includes(f));

/** `選択子 { 宣言 }` を全部読み、ボタンを名指しして `font-size` を書く規則を返す。 */
function buttonFontRules(): { sel: string; value: string }[] {
  const out: { sel: string; value: string }[] = [];
  for (const m of APP.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!.trim().replace(/\s+/g, ' ');
    const fs = m[2]!.match(/(?:^|;)\s*font-size:\s*([^;]+)/);
    if (fs && SCAN(sel)) out.push({ sel, value: fs[1]!.trim() });
  }
  return out;
}

/** `:root` のトークンを引く(`var(--x)` を px へ解く)。 */
function tokenPx(name: string): string {
  const m = TOKENS.match(new RegExp(`(?:^|;|\\{)\\s*${name}:\\s*([^;]+);`));
  expect(m, `${name} が tokens.css に無い`).not.toBeNull();
  return m![1]!.trim();
}

/** 🔴 **トークンを使わなくてよい所**(理由つきで、身元で pin する)。 */
const LITERAL_OK: ReadonlyMap<string, string> = new Map([
  // 幅 8px の縦帯に `⋮` を収める ── 11px では印が帯からはみ出す
  ["[data-pkc-region='pane-grip']", '10px'],
  // 🔑 「札と同じ大きさ」が意図である ── 段を 1 つ増やすのではなく、器に追従させる
  ["[data-pkc-field='stack-card'] button", 'inherit'],
]);

describe('🔴 ボタンの字の大きさは 3 段だけ(#722 P2-10)', () => {
  it('🔴 ボタンを名指しする規則は、トークンか「理由つきの例外」しか書かない', () => {
    const rules = buttonFontRules();
    // 空振り防止 ── 走査が壊れて 0 件になったら、この test は何も見ていない
    expect(rules.length, 'ボタンの font-size を 1 件も引けない(走査が壊れている)').toBeGreaterThan(
      10,
    );
    const bad = rules.filter((r) => {
      if (r.value.startsWith('var(--btn-fs')) return false;
      return LITERAL_OK.get(r.sel) !== r.value;
    });
    expect(
      bad.map((r) => `${r.sel} → ${r.value}`),
      '素の px を書いたボタンの規則が在る(段を増やしている)',
    ).toEqual([]);
  });

  /**
   * 🔴 **解けた値が 3 種であること。**
   * ⚠ トークンの名前だけ見ても意味が無い ── 3 つとも同じ値にする / 4 つ目を足す、
   *   のどちらでも上の test は通る。**px の集合**で pin する。
   */
  it('🔴 解けた大きさは 13 / 12 / 11px の 3 段(+ 理由つきの 10px)', () => {
    expect([tokenPx('--btn-fs'), tokenPx('--btn-fs-bar'), tokenPx('--btn-fs-sm')]).toEqual([
      '13px',
      '12px',
      '11px',
    ]);
    // ⚠ 例外は 2 件だけ(増えたらここに理由ごと足す)
    expect([...LITERAL_OK.values()]).toEqual(['10px', 'inherit']);
  });

  /**
   * 🔴 **3 段が全部使われている**(死んだトークンを作らない)。
   * ⚠ これが無いと、1 段へ潰す変異(全部 `--btn-fs-bar` にする)が上の 2 件を素通りする。
   */
  it('🔴 3 段とも実際に使われている', () => {
    const used = new Set(buttonFontRules().map((r) => r.value));
    for (const t of ['var(--btn-fs)', 'var(--btn-fs-bar)', 'var(--btn-fs-sm)']) {
      expect(used.has(t), `${t} を使っている規則が 1 つも無い(死んだ段)`).toBe(true);
    }
  });

  /**
   * ⚠ **12.5px はボタンではない**(cowork の 5 種のうち 1 つ)── 打つ欄の値である。
   * 🔑 これを pin しておくと、**次に 12.5px のボタンが生えたとき**に気づける
   *   (上の test でも落ちるが、こちらは**理由が読める**形で落ちる)。
   */
  it('⚠ 12.5px を書いている規則は、どれもボタンではなく打つ欄', () => {
    const owners: string[] = [];
    for (const m of APP.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/(?:^|;)\s*font-size:\s*12\.5px/.test(m[2]!)) {
        owners.push(m[1]!.trim().replace(/\s+/g, ' '));
      }
    }
    expect(owners.length, '12.5px が 1 件も無い(前提が変わった ── 表を書き直す)').toBeGreaterThan(
      0,
    );
    expect(owners.filter((s) => SCAN(s)), '12.5px のボタンが生えた').toEqual([]);
  });

  /**
   * 🔴 **17.55px の出所を pin する。**
   * ⚠ 実測(2026-09-05、`chromium` / 地の字 13px):`.pkc-md-rendered h1` は 17.55px で、
   *   その中の `heading-fold` も 17.55px(h2 15.6 / h3 14.04)。
   * 🔑 だから守るのは **①見出しが `em` で決まること ②畳みが `font: inherit` であること**
   *   の 2 つ ── どちらかが px になった日に、追従が静かに切れる。
   */
  it('🔴 見出しの畳みは、見出しの大きさを継ぐ(17.55px の出所)', () => {
    // ⚠ どちらの選択子も規則を**複数**持つ(色・位置・大きさが別の節に在る)ので、
    //    「1 件だけ」を要求しない ── 見るのは**その宣言を持つ節が在るか**である
    const h1 = blocksFor(APP, '.pkc-md-rendered h1');
    expect(h1.length, '見出しの規則が引けない(走査が壊れている)').toBeGreaterThan(0);
    expect(
      h1.filter((b) => /(?:^|;)\s*font-size:\s*1\.35em/.test(b)).length,
      '見出しが em をやめた(畳みの追従が切れる)',
    ).toBe(1);
    const fold = blocksFor(APP, "[data-pkc-field='heading-fold']");
    expect(fold.length, '畳みの規則が引けない').toBeGreaterThan(0);
    expect(
      fold.filter((b) => /(?:^|;)\s*font:\s*inherit/.test(b)).length,
      '畳みが font: inherit をやめた(見出しに追従しなくなる)',
    ).toBe(1);
  });
});
