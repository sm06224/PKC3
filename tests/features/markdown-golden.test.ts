import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  renderMarkdown,
  renderMarkdownInline,
  hasMarkdownSyntax,
} from '../../src/features/markdown/markdown-render';
import { parseFrontmatter, extractVars } from '../../src/features/markdown/frontmatter';

/**
 * PKC-Markdown 移植の parity pin(P3-3)。
 * golden は **PKC2 の renderMarkdown(markdown-it 14.3.0)から採取**した実出力
 * (manual ch12 全文 1,431 行 + fixture 3 種 + 方言の縁スニペット 20 種)。
 * 採取手順: tests/fixtures/markdown-goldens/harvest-from-pkc2.ts(手順は同ファイル冒頭)。
 * ⚠ markdown-it のバージョンを動かすと golden ごと再検証が必要。
 * 🔴 **PKC3 は 15.0.0、採取元の PKC2 は 14.3.0 のまま**(#78、2026-08-22)── つまり
 *   この golden は「**別の版の markdown-it の出力**」との突合になった。移行で動いたのは
 *   下の一覧の 5 番(1 セル)だけで、残り 24 件は byte 一致のままである。
 *   ⚠ 版が違う以上、次に上流を上げたときは「PKC2 と違えた」ではなく
 *   「**上流が変えた**」が先に疑うべき原因になる ── 差の全数は
 *   `tests/features/markdown-linkify.test.ts` に実測して pin してある。
 *
 * ⚠ **PKC2 と意図的に違えた点は golden 側を更新して記録する**(丸写し禁止 ──
 * user 指示 2026-07-30「流用 + 総合的見直し」)。
 * ⚠ **この散文は数を書かない**(2026-08-08 に直した)── 「差分は 2 つ」と書いて
 *   3 項目を並べており、しかも 4 種類目が増えても更新されなかった。
 *   🔑 **機械可読な台帳は下の `pkc3Diverges` 検査**(件数と理由の実在をそこが守る)。
 *   ここは「なぜ違えたか」を人が読むための control であり、**足したら必ず 1 項目書く**:
 *
 *   1. タスクのチェック欄に `disabled` を付けた(P8 段⑳)。PKC2 は押せる形で
 *      出していたが、**押しても本文が 1 文字も変わらない** ── 移動 / 追記 /
 *      再読込で全部外れる「チェックしたのに消えた」だった。押せないものは
 *      押せない形にする。
 *   2. 空行マーカー(`_N`)に `style="--pkc-blank-count: N"` を足した(2026-08-05)。
 *      CSS の規則は `height: calc(1.45em * var(--pkc-blank-count, 1))` で**この変数**を
 *      読むのに、出力側は属性しか書いておらず、**`_3` と `_1` が同じ高さ**だった。
 *      PKC2 も同じ形なので、これは PKC2 のバグをそのまま引いていた箇所である。
 *   3. **外部の画像を既定で読み込まない**(2026-08-06、user 裁定)。本文の `img` は
 *      `src` を `data-pkc-external-src` へ退避し、` ```html` の箱の CSP は
 *      `img-src` を `data: blob:` に絞る。PKC2 は無条件に読み込んでいた ──
 *      ノートを開いた瞬間に「この端末がいまこれを開いた」が第三者へ飛ぶ形である。
 *      動いた golden は `snippet-figure-ref`(本文の画像)と `snippet-html-fence`(箱)。
 *      ⚠ `reform-stress-sample` の `pkc://asset/…` は**動かない** ── PKC 自身の
 *        scheme は要求を飛ばさないので「外」ではない(嘘の確認を出さないため)。
 *   4. **行頭アラインの属性値を `end` → `opposite` にした**(2026-08-08、user 指摘)。
 *      裁定で `|>` の意味が「グローバルの寄せを反対にする」になった以上、logical end を
 *      表す `end` と同じ値にしておけない ── 説明的な形 `:::paragraph{align=end}` と
 *      値が同じだと、**寛容さ(typo を意味に通す性質)を持たない説明的な形にまで
 *      反転が漏れる**。PKC2 は旧意味(logical end 固定)のままなので分岐する。
 *      動いた golden は `reform-stress-sample` / `simple-notation-sample` /
 *      `snippet-align-indent` の 3 件(差は属性値だけ)。
 *   5. **スキームの無い文字列を自動リンクしない**(2026-08-22、#78 の markdown-it 15
 *      移行)。v15 で linkify の `fuzzyLink` が既定 off になった。PKC2(14.3.0)は
 *      `.info` が TLD であるため `console.info` を
 *      `<a href="http://console.info" target="_blank">` に焼いており、**押すと
 *      空白のタブが開くだけの壊れた外部リンク**だった(`README.md` / `main.rs` /
 *      `build.sh` も同じ ── 開発ノートで日常的に書く形が全部リンクになる)。
 *      ⚠ しかも PKC3 自身の `hasMarkdownSyntax` は FI-08.x(D-FB1=B)以来
 *      「**スキームがあるものだけが URL**」と判定しており、fuzzyLink はその判定と
 *      食い違っていた ── 釣り合いが崩れていたほうを直した形になる。
 *      動いた golden は `manual-ch12` の 1 セルだけ。
 *      🔑 スキーム付き(`https://…`)は今までどおりリンクになる。
 *

 * 🔴 **golden は「PKC2 と同じ」を守る道具であって、「正しい」を守る道具ではない。**
 * PKC2 のバグはそのまま期待値になる ── 落ちたら「壊した」ではなく
 * **「PKC2 と違えた」**を疑い、上の一覧に足してから golden を更新すること。
 * ⚠ 実例(**既に解決済み** ── 現在形で読まないこと): csv fence のセルに脚注が漏れる件
 * (`docs/development/user-reports-2026-08-05.md` §2-1)は**漏れた HTML が golden**に
 * なっていたが、2026-08-06 に直して golden も更新し、`full-pkc-fixture` の
 * `pkc3Diverges.why` に記録してある。
 */
interface GoldenCase {
  name: string;
  input: string;
  options: {
    vars?: Record<string, string>;
    sourceLineAnchors?: boolean;
  };
  html: string;
  hasSyntax: boolean;
  /**
   * 🔴 **PKC2 と意図的に分岐した case**(2026-08-06)。
   *
   * golden は PKC2 の出力から採取したものなので、**PKC2 のバグごと固定**される
   * (この 2 件がそうだった)。バグを直すと golden が落ちるが、そこで
   * 「golden を採り直す」と PKC2 のバグが戻ってくる ── PKC2 は read-only なので
   * **PKC3 側の正しい出力で更新し、理由を残す**のが唯一の道である。
   * ⚠ `why` の無い分岐を作らせない(下の test が件数と理由を pin する)。
   */
  pkc3Diverges?: { since: string; why: string };
}

/**
 * render ごとに変わる設計の一意 ID(checkbox/label 対・sandbox iframe)だけを
 * 安定トークンへ正規化する。**それ以外は byte 一致を要求**。
 *
 * - **逐次番号化**: 同一 ID は同一 alias に写す(初出順に 1, 2, …)。単一トークンへの
 *   置換だと checkbox `id` / label `for` の対応や ID の出現順の壊れを検出できない
 * - **負の先読み**: `pkc-html-render-id`(属性名)/ `pkc-html-render-resize`
 *   (postMessage 型)は乱数 ID ではなく固定トークン ── 正規化で潰すと
 *   これらの契約が変わっても test が通ってしまう
 */
function makeIdAliaser(prefix: string): (match: string) => string {
  const seen = new Map<string, string>();
  return (match) => {
    let alias = seen.get(match);
    if (!alias) {
      alias = `${prefix}${seen.size + 1}`;
      seen.set(match, alias);
    }
    return alias;
  };
}

function normalizeUniqueIds(html: string): string {
  return html
    .replace(/pkc-rv-(?!resize\b|id\b)[a-z0-9]+/g, makeIdAliaser('pkc-rv-'))
    .replace(
      /pkc-html-render-(?!resize\b|id\b)[a-z0-9]+/g,
      makeIdAliaser('pkc-html-render-'),
    );
}

const goldens = JSON.parse(
  readFileSync(
    join(__dirname, '../fixtures/markdown-goldens/goldens.json'),
    'utf8',
  ),
) as {
  cases: GoldenCase[];
  inlineGolden: { input: string; html: string };
};

beforeAll(() => {
  // 寛容 parse(PKC2005〜2011)の console 通知は仕様どおりの出力 ──
  // stderr 0 行規律のため test 中は黙らせる(挙動には影響しない)
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('PKC-Markdown golden parity vs PKC2 (25 cases)', () => {
  for (const c of goldens.cases) {
    it(`renders "${c.name}" byte-identically`, () => {
      const fm = parseFrontmatter(c.input);
      // 正準系列(PKC2 detail-presenter.ts:96 と同形): vars は raw 全文から抽出
      const vars = c.options.vars ?? extractVars(c.input);
      const html = renderMarkdown(fm.body, {
        vars,
        sourceLineAnchors: c.options.sourceLineAnchors,
      });
      expect(normalizeUniqueIds(html)).toBe(normalizeUniqueIds(c.html));
      expect(hasMarkdownSyntax(fm.body)).toBe(c.hasSyntax);
    });
  }

  /**
   * 🔴 **「golden を採り直して緑にする」を塞ぐ**(2026-08-06)。
   *
   * golden が落ちたとき、正しい対応は 2 つに 1 つ ── ①実装の後退なら実装を直す
   * ②PKC2 のバグを直したのなら **理由を書いて** golden を更新する。
   * ⚠ 理由なしで更新できると、後退を「PKC2 と違うから」で押し通せてしまう。
   * だから**分岐している件数と、その理由の実在**を pin する。
   */
  /**
   * ⚠ **2026-08-06 に一度 4 件へ増やして、2 件へ戻した**。増やした理由(行頭アライン
   * `<|` を start にする)が**記法の正本と食い違っていた**ためで、user の指摘で revert した
   * (経緯は `docs/development/user-reports-2026-08-05.md` §3-1 m-2)。
   * 🔑 この test が守っているのは件数ではなく「**理由なしに golden を採り直せない**」こと ──
   * 実際、私は理由を書いて採り直したが、その理由が誤りだった。件数だけでは止められない。
   */
  it('🔴 PKC2 と分岐した case は理由つきで 10 件だけ', () => {
    const diverged = goldens.cases.filter((c) => c.pkc3Diverges);
    expect(diverged.map((c) => c.name).sort()).toEqual([
      'full-pkc-fixture',
      'full-pkc-fixture-anchors',
      // 🔴 2026-08-22(#78): markdown-it 15 で fuzzyLink が既定 off。
      //    スキームの無い `console.info` が自動リンクされなくなった。
      'manual-ch12',
      // 🔴 2026-08-08: 行頭アラインの象形的な形が `end` → `opposite`(user 裁定 +
      //    user 指摘)。PKC2 は旧意味(logical end 固定)のままなので分岐する。
      //    ⚠ **この分岐は隠してはいけない** ── 直前まで CSS だけで反転させて
      //    byte 一致を保っていたが、それは「説明的な形にも反転が漏れる」実装の
      //    裏返しだった。属性を分けたことで、分岐が台帳に見えるようになった。
      'reform-stress-sample',
      'simple-notation-sample',
      'snippet-align-indent',
      'snippet-break-and-blank',
      'snippet-figure-ref',
      'snippet-html-fence',
      'snippet-task-and-footnote',
    ]);
    for (const c of diverged) {
      expect(c.pkc3Diverges!.since, `${c.name} に分岐した日付が無い`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.pkc3Diverges!.why.length, `${c.name} に理由が無い`).toBeGreaterThan(40);
    }
  });

  it('renderMarkdownInline parity', () => {
    expect(renderMarkdownInline(goldens.inlineGolden.input)).toBe(
      goldens.inlineGolden.html,
    );
  });
});
