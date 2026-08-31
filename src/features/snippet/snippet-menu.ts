/**
 * 🔴 **雛形の一覧**(#196 / B-2 段②-b)── 「押して選ぶ」ほうの入口。
 *
 * ## なぜ要るか
 *
 * 段② で入れた短縮語 + `Tab` は**覚えている人の近道**である。⚠ 覚えていない人には
 * **入口が 1 つも無かった** ── 自分で作った雛形なのに、本文を開いて写すしかない。
 *
 * ## 🔴 組み込みの雛形も同じ一覧に出す
 *
 * ⚠ 出さないと、雛形を 1 つも作っていない初日の user には**空の一覧**が出る
 * ── それは押しても何も無い dead click である。
 * 🔑 PKC3 は既に**組み込みの雛形**(表 / 図 / コードブロック / リンク)を持っている
 * (`FORMAT_OPS`)。同じ「入れたい塊を選ぶ」用事なので、**同じ一覧に並べる**。
 * ⚠ ただし**挿す仕事は増やさない** ── この module が返すのは「どれを選んだか」だけで、
 *   実際に挿すのは既にある 1 本ずつ(`applyFormat` / `insertSnippet`)である
 *   (CLAUDE.md §7「同じ判定が 2 か所にある」を作らない)。
 *
 * ## ⚠ `/` を打ったら出る形は採らない(段②-b の裁定)
 *
 * 市井の道具(Notion / Obsidian)は `/` で出すが、**PKC3 には補完の機構が 1 つも無い**
 * ── 打鍵に追随して絞り込む非モーダルの浮き物は、`insert-date` が
 * **同じ理由で `@` を退けた**のと同じ規模の新機構である。⚠ そのうえ `/` は
 * 散文で普通に出る字(`A/B` / `2026/08/25` / URL)なので、**誤爆が本業を邪魔する**。
 * 🔑 代わりに失う動線は無い:**押しボタン**(書式の帯)と**鍵の近道**
 * (`insert-snippet` ── 割り当ては user が変えられる)の 2 つで、
 * マウスだけでもキーボードだけでも完結する(不可侵指示「マウスだけで完結し、
 * キーボードは近道」)。
 *
 * 🔑 **pure module**。DOM も DB も知らない。
 */
import { DIAGRAM_TEMPLATES, FORMAT_OPS, type FormatOp } from '@features/markdown/text-ops';
import { SNIPPET_LIMITS, type SnippetItem, type SnippetScan } from './snippet-table';

/**
 * 組み込みの雛形として一覧に出す `FormatOp`。
 *
 * ⚠ **「塊を入れる」ものだけ**を採る ── 見出し / 太字のような**トグル**は
 *   一覧の意味(入れる物を選ぶ)と違う。それらは書式の帯にボタンとして在る。
 */
export const BUILTIN_SNIPPET_OPS: readonly FormatOp[] = ['table', 'mermaid', 'codeblock', 'link'];

/** 一覧の 1 行。⚠ **押した後に何を呼ぶか**が型で分かれている。 */
export type SnippetChoice =
  | { readonly kind: 'snippet'; readonly lid: string; readonly title: string; readonly abbr: string }
  | { readonly kind: 'format'; readonly op: FormatOp; readonly title: string }
  /**
   * 🔴 **UML の雛形**(#528 段①)。⚠ `format` に混ぜない ── あちらは
   *   `applyFormat(op)` が挿し、こちらは `insertBlock(block)` が挿す。
   *   1 つの kind にすると、押した側が「どちらを呼ぶか」を自分で当てることになる。
   */
  | { readonly kind: 'diagram'; readonly id: string; readonly title: string };

/**
 * 一覧を組む。
 *
 * 🔑 **自分の雛形が先、組み込みが後** ── 自分で作った物を探しに来た人が、
 *   毎回 4 行読み飛ばさなくてよいようにする。
 * ⚠ 組み込みの字は `FORMAT_OPS` から引く(**表が正本**)── ここで打ち直すと、
 *   帯のボタンと一覧で名前が食い違う。
 */
export function snippetMenu(items: readonly SnippetItem[]): readonly SnippetChoice[] {
  const mine: SnippetChoice[] = items.map((s) => ({
    kind: 'snippet',
    lid: s.lid,
    title: s.title,
    abbr: s.abbr,
  }));
  const builtin: SnippetChoice[] = [];
  for (const op of BUILTIN_SNIPPET_OPS) {
    const found = FORMAT_OPS.find((f) => f.op === op);
    // ⚠ 表から消えた op は**黙って落とす** ── 帯に無いボタンを一覧にだけ出すと、
    //   押しても `applyFormat` が `sel` をそのまま返す = 無言の dead click になる
    if (found !== undefined) builtin.push({ kind: 'format', op, title: found.label });
  }
  /**
   * 🔴 **UML は組み込みの後ろ**(#528 段①)。
   * ⚠ 「図」(フローチャート)のすぐ後に並ぶよう、`mermaid` を含む組み込みの
   *   **後ろ**へ置く ── 図を探しに来た人が、隣で種類に気づく形にする。
   * ⚠ 字は `DIAGRAM_TEMPLATES` から引く(**表が正本**)── ここで打ち直さない。
   */
  const diagrams: SnippetChoice[] = DIAGRAM_TEMPLATES.map((d) => ({
    kind: 'diagram',
    id: d.id,
    title: d.label,
  }));
  return [...mine, ...builtin, ...diagrams];
}

/**
 * 🔴 **一覧の上に出す 1 行**。
 *
 * ⚠ **黙って減らさない** ── 上限で切ったのに何も言わないと、user は「無い」と読む
 *   (`SnippetScan.truncated` を運んでいるのはこのためである)。
 * ⚠ **無いときは作り方を書く** ── 一覧を開いた人は「自分の雛形を呼びたい」人なので、
 *   ここが**作り方を知る唯一の場所**になる。
 * ⚠ 「取れていません」と「まだ 1 件も作っていません」を**混ぜない** ── 混ぜると、
 *   worker が転んだ日に「作れば直る」と読ませてしまう。
 */
export function snippetMenuNote(scan: SnippetScan | null): string {
  // ⚠ `null` は「読み込み前」と「読めなかった」の両方 ── どちらとも取れる字にする
  if (scan === null) return '自分の雛形は取れていません。組み込みの雛形は使えます。';
  if (scan.truncated)
    return `雛形が多いので、${SNIPPET_LIMITS.notes} 件までにしています。`;
  if (scan.items.length === 0 && scan.total > 0)
    return '雛形のノートはありますが、中身が空か長すぎるので出せません。';
  if (scan.items.length === 0)
    return 'まだ自分の雛形がありません。左上の作成から「雛形」を選ぶと作れます。';
  return '';
}
