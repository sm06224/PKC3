/**
 * 🔴 **行 → 塊の分割(partition)**(2026-08-05。ライブエディタ S2。
 * 設計 doc `docs/development/live-editor-design-2026-08.md` §7)。
 *
 * ## 何のためか
 * 「クリックした場所が原文の何行目か」「その行を直したらどの塊を描き直すか」を
 * 決める土台。**行番号を DOM に焼かない**のが要点 ── 焼くと行数が変わる編集で
 * 全塊の HTML が変わり、差分反映が全滅する(`apply-blocks.ts` は塊 HTML の
 * 完全一致で差分を取る)。
 *
 * ## 作り
 * `renderMarkdownWithRanges` が `{ html, ranges }` を返す。`ranges` は
 * `SOURCE_LINE_TOKEN_TYPES` の token ぶんが**文書順**に並んだもので、
 * `level === 0` が最上位。`buildBlockPartition` が
 * 「最上位塊 i は原文の [start, end] 行を持つ」表に畳む。
 *
 * ## ⚠ 由来を持たない塊(導出物)
 * 実測で **2 種**ある: 脚注の区切り `<hr class="footnotes-sep">` と
 * 脚注本体 `<section class="footnotes">`。これらは**文書全体から作られ、原文に
 * 対応する行が無い** ── クリックしても差し替えない。**この 2 種に限る**ことを
 * test で pin する。
 * ⚠ 目次(`<nav class="pkc-toc-formal">`)は**導出物に入れない** ── 中身は文書全体
 * から作られるが `:::toc{depth=2}` という原文の行を持つので、編集できるべきである。
 *
 * ## ⚠ 崩れたら「開かない」
 * 検証(全域性 / 重複 0 / 単調性)が落ちたら `ok: false` を返す。呼び側は
 * 行の差し替えを**開かず**、今日の編集画面(全文の textarea)へ退避する
 * ── 壊れた分割の上で編集させると本文が壊れる。
 *
 * ⚠ **pure module**。browser API を使わない。
 */
import { renderMarkdown, type RenderMarkdownOptions, type SourceRange } from './markdown-render';
import type { ContainerSpan } from './source-blocks';

export type { SourceRange };

export interface RenderWithRanges {
  html: string;
  /** 文書順。`level === 0` が最上位塊、深いものは表の行 / 箇条書きの項目など。 */
  ranges: readonly SourceRange[];
}

/**
 * 描画と同時に行の対応表を得る。
 *
 * ⚠ `html` は `renderMarkdown(text, opts)`(対応表なし)と **byte 一致**する
 * ── そこが崩れると「対応表を取ると見た目が変わる」ことになり、
 * 閲覧と編集で面を 1 本に寄せる前提が壊れる(test で pin)。
 */
export function renderMarkdownWithRanges(
  text: string,
  opts: RenderMarkdownOptions = {},
): RenderWithRanges {
  const ranges: SourceRange[] = [];
  const html = renderMarkdown(text, { ...opts, collectRanges: ranges });
  return { html, ranges };
}

/**
 * 導出物(**原文の行を持たない**塊)の見分け。⚠ **閉じた集合**として持つ。
 *
 * ⚠ 目次(`<nav class="pkc-toc-formal">`)は**導出物ではない** ── 中身は文書全体から
 * 作られるが、`:::toc{depth=2}` という**原文の行を持つ**ので、クリックしたら
 * その行を編集できるべきである(1 巡目はここを導出物に入れていて、目次の設定行を
 * 永久に編集できない形になっていた)。
 */
const DERIVED_PATTERNS: readonly { key: string; test: (html: string) => boolean }[] = [
  { key: 'footnotes-sep', test: (h) => /^<hr class="footnotes-sep"/.test(h) },
  { key: 'footnotes', test: (h) => /^<section class="footnotes"/.test(h) },
];

export function derivedKindOf(blockHtml: string): string | null {
  const head = blockHtml.trimStart();
  for (const d of DERIVED_PATTERNS) if (d.test(head)) return d.key;
  return null;
}

export interface BlockPartition {
  /** 検証を通ったか。false のときは行の差し替えを**開かない**。 */
  ok: boolean;
  /** なぜ落ちたか(false のときだけ)。 */
  reason?: string;
  /** 塊 i の開始行(原文・0 始まり)。導出物は -1。 */
  starts: readonly number[];
  /** 塊 i の終了行(含む)。導出物は -1。 */
  ends: readonly number[];
  /** 塊 i が導出物なら、その種類。そうでなければ null。 */
  derived: readonly (string | null)[];
}

/**
 * 最上位塊 ↔ 原文行の分割を組む。
 *
 * ⚠ **単調性を仮定しない**。脚注セクションのように「末尾の塊なのに前の行を指す」
 * ものが在るので、`end = 次の start − 1` を無条件に使わない ── 各塊が持つ
 * range の実値をそのまま使い、順序が崩れていたら `ok: false` にする。
 *
 * @param blocks `splitTopLevelBlocks(html)` の結果
 * @param ranges `renderMarkdownWithRanges` の `ranges`
 * @param lineCount 原文(本文)の行数。全域性の検証に使う
 */
export function buildBlockPartition(
  blocks: readonly string[],
  ranges: readonly SourceRange[],
  lineCount: number,
  /**
   * `scanContainers(text)` の結果。⚠ **渡すこと** ── `:::` の囲いは描画の後処理で
   * 1 塊に畳まれるので、これが無いと「範囲が余った」で必ず検証に落ちる。
   */
  containers: readonly ContainerSpan[] = [],
): BlockPartition {
  const spans = effectiveTopSpans(ranges, containers);
  /**
   * 🔴 **脚注の定義行は「移された」だけで、原文の行を持っている**(2026-08-05 実測)。
   *
   * `[^a]: 注の中身` は描画では**その場に出ず**、末尾の `<section class="footnotes">`
   * の中に集まる。だから最上位の範囲には現れない ── 何もしないと**その行は
   * どの塊にも属さず、永久に編集できない**(1 巡目はそうなっていた)。
   * 最上位のどの範囲にも入らない行を集めて、脚注の塊に持たせる。
   */
  const leftover = ranges.filter(
    (r) => !spans.some((sp) => r.start >= sp.start && r.start <= sp.end),
  );
  const footnoteStart = leftover.length > 0 ? Math.min(...leftover.map((r) => r.start)) : -1;
  const footnoteEnd = leftover.length > 0 ? Math.max(...leftover.map((r) => r.end)) : -1;
  const starts: number[] = [];
  const ends: number[] = [];
  const derived: (string | null)[] = [];
  let ri = 0;
  for (const b of blocks) {
    const kind = derivedKindOf(b);
    if (kind !== null) {
      // 脚注の本体だけは、定義行を持ち主として持つ(区切りの `<hr>` は持たない)
      const owns = kind === 'footnotes' && footnoteStart >= 0;
      starts.push(owns ? footnoteStart : -1);
      ends.push(owns ? footnoteEnd : -1);
      derived.push(kind);
      continue;
    }
    const r = spans[ri];
    ri += 1;
    if (r === undefined) {
      return {
        ok: false,
        reason: `塊 ${blocks.length} 個に対して最上位の範囲が ${spans.length} 個しかない`,
        starts,
        ends,
        derived,
      };
    }
    starts.push(r.start);
    ends.push(r.end);
    derived.push(null);
  }
  if (ri !== spans.length) {
    return {
      ok: false,
      reason: `最上位の範囲が ${spans.length - ri} 個余った(塊と対応していない)`,
      starts,
      ends,
      derived,
    };
  }
  // ── 検証: 由来のある塊は昇順で、重なっておらず、本文の中に収まっていること
  let prevEnd = -1;
  for (let i = 0; i < starts.length; i += 1) {
    // ⚠ 脚注の塊は**文書の末尾に出るのに前の行を指す**(単調でない)── 昇順の
    //    検証から外す。設計 §7-2「spans は単調でない」の実例がこれである
    if (derived[i] !== null) continue;
    const st = starts[i]!;
    const en = ends[i]!;
    if (st < 0 || en < st) {
      return { ok: false, reason: `塊 ${i} の範囲が壊れている(${st}..${en})`, starts, ends, derived };
    }
    if (st <= prevEnd) {
      return {
        ok: false,
        reason: `塊 ${i} が前の塊と重なっている(${st} <= ${prevEnd})`,
        starts,
        ends,
        derived,
      };
    }
    if (en >= lineCount) {
      return {
        ok: false,
        reason: `塊 ${i} が本文の行数(${lineCount})を超えている(end=${en})`,
        starts,
        ends,
        derived,
      };
    }
    prevEnd = en;
  }
  return { ok: true, starts, ends, derived };
}

/**
 * token 由来の最上位範囲を、**囲いの範囲へ集約**する。
 *
 * 🔴 なぜ要るか(実測 2026-08-05): `:::note` は描画の**後処理**で 1 塊に畳まれるが、
 * token の段階では `:::note` の行・中の段落・`:::` の行が**それぞれ独立の段落**として
 * 範囲を持つ。集約しないと「範囲が 6 個余った」で必ず検証に落ちる。
 * ⚠ fence は token 自身が範囲を 1 個持つ(中は parse されない)ので集約不要。
 */
function effectiveTopSpans(
  ranges: readonly SourceRange[],
  containers: readonly ContainerSpan[],
): { start: number; end: number }[] {
  const dirs = containers.filter((c) => c.kind === 'directive');
  const top = ranges.filter((r) => r.level === 0);
  const out: { start: number; end: number }[] = [];
  let i = 0;
  while (i < top.length) {
    const r = top[i]!;
    const box = dirs.find((c) => r.start >= c.start && r.start <= c.end);
    if (box === undefined) {
      out.push({ start: r.start, end: r.end });
      i += 1;
      continue;
    }
    out.push({ start: box.start, end: box.end });
    // 囲いの中に入る範囲は**全部**食べる
    while (i < top.length && top[i]!.start >= box.start && top[i]!.start <= box.end) i += 1;
  }
  return out;
}

/**
 * 原文の行 → その行を持つ塊の添字。持ち主が居なければ null(空行など)。
 *
 * ⚠ 走査で組む(sorted 前提の二分探索を書かない)── 単調性を仮定しないという
 * 上の規律と揃える。塊数は実測で 1 文書あたり中央 61 なので線形で足りる。
 */
export function blockIndexForLine(part: BlockPartition, line: number): number | null {
  for (let i = 0; i < part.starts.length; i += 1) {
    // ⚠ 導出物でも**範囲を持っていれば**引く(脚注の本体は定義行を持つ)。
    //    `starts < 0` = 本当に原文の行を持たない(脚注の区切りの `<hr>` など)
    if (part.starts[i]! < 0) continue;
    if (line >= part.starts[i]! && line <= part.ends[i]!) return i;
  }
  return null;
}

/**
 * 🔴 **描画テキストの n 文字目 → 原文の何文字目か**(設計 §5.5。2 ポインタ)。
 *
 * 規則: 両方の文字が一致したら両方進める / 違ったら**原文だけ**進める
 * (その分が markup)。同期が切れたら**最後に同期した所へ戻す**。
 *
 * 🔑 **誤差の向きが後ろに固定される**。2 ポインタが単調なので**前へ飛び越すことが
 * 原理的に無い** ── PKC2 が撤回した比例割り(誤差が両方向に出る近似)と違うのは
 * ここである。最悪でも「その行の先頭」に落ちる。
 *
 * 実測(9 例すべて正確): `**太字**` / `~~打消~~` / `==印==` / `` `コード` `` /
 * `[リンク](url)` / `![alt](asset:…)` / `A &amp; B` / `## **太字**の見出し`。
 * 外れる構文(`{{vars}}` の置換 / 脚注の参照 / 見出しの自動採番 / 描画された表・図)は
 * **必ず手前へ**丸まる。
 *
 * @param source 原文の 1 行(または連続行)
 * @param visible その範囲の**描画テキスト**(`textContent`)
 * @param visibleOffset 描画テキストの中の位置
 */
export function mapVisibleToSource(
  source: string,
  visible: string,
  visibleOffset: number,
): { offset: number; exact: boolean } {
  const target = Math.max(0, Math.min(visibleOffset, visible.length));
  let s = 0;
  let v = 0;
  let lastSynced = 0;
  while (v < target && s < source.length) {
    if (source[s] === visible[v]) {
      s += 1;
      v += 1;
      lastSynced = s;
    } else {
      s += 1;
    }
  }
  return v === target ? { offset: s, exact: true } : { offset: lastSynced, exact: false };
}
