/**
 * 🔴 **追記の「入る先」を選べるようにする**(#395 段①)。
 *
 * > user の物語: 長い議事録の「決定事項」の節に **1 行だけ**足したい。
 * > いまは「編集」を押して本文を開き、目で節を探すしかない ──
 * > その間、**組んだ本文は消えている**(読みながら書けない)。
 *
 * CLAUDE.md が PKC2 の核の 3 番目として名指ししている「**開かずに済ませる道**」の
 * 実体である(「編集の大半は追記と差し挟み(Vim 的発想)」)。
 *
 * ## 🔴 行番号ではなく**見出しの印**で指す
 *
 * ⚠ 追記は `getBody` → 足す → 書込 の順に進み、**その間に別の窓が書いていれば
 *   読み直して足し直す**(`store-effects.ts` の `tryAppend`)。
 *   そこで**行番号を握っていると、足し直しで別の場所へ入る** ── しかも
 *   user から見て「変な所に入った」だけで、なぜかは分からない。
 * 🔑 だから指すのは**印(slug)**で、**そのつど本文から解く**。
 * 🔴 **解けなければ足さない**(末尾へ落とさない)── 「選んだ先が消えているのに、
 *   黙って別の場所へ入る」が、この機構でいちばんやってはいけない負け方である。
 *
 * ## ⚠ 印の作り方は**目次と同じ**(2 つ目の命名規則を作らない)
 *
 * `makeSlugCounter()` を使う ── 目次・本文のアンカーと同じ綴りになるので、
 * 「目次で見えている節の名前」と「追記で選ぶ名前」が食い違わない。
 *
 * 🔑 **pure module**。DOM も窓も知らない。
 */
import { makeSlugCounter, makeLegacySlugCounter, stripMismatchedIfBlocks } from './markdown-toc';
import { classifyDirectiveOpen } from './directive-open';
import { extractHeadingNumberConfig } from './document-globals';
import { extractVars, frontmatterLineCount, parseFrontmatter } from './frontmatter';
import { expandVarsInText } from './var-expand';
import { fenceStep } from './list-renumber';
import { stripComments, preprocessHeadingNumbers } from './markdown-render';

/** 追記の入り先 1 つ。 */
export interface AppendTarget {
  /** 印。⚠ **目次と同じ綴り**(`makeSlugCounter`)。 */
  readonly slug: string;
  /** 見出しの字(画面に出す)。 */
  readonly text: string;
  /** 1〜3。字下げの深さに使う。 */
  readonly level: 1 | 2 | 3;
}

/** 見出し 1 つの居場所(内部用 ── 行番号は**その場で**しか使わない)。 */
interface HeadingAt extends AppendTarget {
  /** 見出しそのものの行(0 起点、**原文の**行番号)。 */
  readonly line: number;
  /** 古い名前(記号を抜いただけの綴り / 見出し番号つきの綴り)。既に書かれたリンクを読み続けるための別名。 */
  readonly legacySlug: string;
  /**
   * 🔴 この見出しを包む `:::note` などの囲みの深さ(0 = 囲みの外)。章の範囲は、囲みの中の見出しでは切らない
   * (台帳 #1852 束 R1、依頼 272 A)。
   */
  readonly depth: number;
  /** 包む囲みの閉じの行(**原文の**行番号)。囲みの外なら `Infinity`。章はこの行を越えない。 */
  readonly limit: number;
}

/**
 * 🔴 **閉じを持つ囲み(`:::note` `:::details` …)の範囲を、行ごとに引く**(依頼 272 A)。
 *
 * 返すのは各行について「包んでいる囲みの数」と「いちばん内側の囲みの閉じの行」。
 * ⚠ 開きは `classifyDirectiveOpen` が `container` と言う物だけ(描画が閉じを消費する物と同じ判定 1 本)。
 *   `:::toc` の直後の `:::` はその toc の閉じなので数えない。**閉じの無い開きは囲みにしない**
 *   (描画も字のまま出す ── 後ろの見出し全部が「囲みの中」になって章が切れなくなるのを避ける)。
 */
function containerSpans(lines: readonly string[]): { depth: number[]; closeAt: number[] } {
  const depth = new Array<number>(lines.length).fill(0);
  const closeAt = new Array<number>(lines.length).fill(-1);
  const spans: Array<[number, number]> = [];
  const stack: number[] = [];
  let fence = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const st = fenceStep(fence, line);
    fence = st.next;
    if (st.inside) continue;
    if (/^[ \t]*:::+[ \t]*$/.test(line)) {
      const open = stack.pop();
      if (open !== undefined) spans.push([open, i]);
      continue;
    }
    const kind = classifyDirectiveOpen(line.trim());
    if (kind === 'container') stack.push(i);
    else if (kind === 'self-contained' && /^[ \t]*:::+[ \t]*$/.test(lines[i + 1] ?? '')) i += 1;
  }
  // 開きが先のものから塗る ── 内側の囲みが後から上書きして、いちばん内側が残る
  spans.sort((a, b) => a[0] - b[0]);
  for (const [open, close] of spans) {
    for (let k = open + 1; k < close; k++) {
      depth[k]!++;
      closeAt[k] = close;
    }
  }
  return { depth, closeAt };
}

/**
 * 原文から見出しを拾う。⚠ **原文の行番号**を持つ(frontmatter を剥がさない)。
 *
 * ⚠ `extractHeadingsFromMarkdown` は使えない ── あちらは frontmatter を剥がし
 *   `{{vars}}` を展開してから拾うので、**行番号が原文とずれる**(目次には要らないが、
 *   ここでは行を切るので致命的である)。🔑 代わりに**印の作り方だけ**を借りる。
 * ⚠ fence の中は見ない(コードの中の `# x` は見出しではない)。閉じは開きと同じ記号で同じ長さ以上
 *   (`advanceFence` が正本 ── 目次と同じ判定。#1087)。
 * ⚠ frontmatter の中も見ない(`title: # x` を見出しに数えない)。
 * 🔴 **目次・描画と同じ見出しの集合にする**(#1087)── 食い違うと、目次で見えている節の
 *   名前が追記で選べない / 見えない節が選べて、字が思わぬ節へ入る:
 *   ① 下線の見出し(`題` + `===` / `---`)も拾う ② 描画が捨てる部分(`:::comment` / `%%%`)の
 *   中の `# x` は拾わない(目次と同じ `stripComments`。捨てた行は `lineMap` で原文の行へ戻す)
 *   ③ `$$` の塊と `<pre>` 等の HTML の塊の中は、描画が見出しにしない(markdown-it の規則)ので拾わない。
 * ⚠ 引用・リストの中の `> # x` は拾わない(目次は拾うが、そこへ平文を挟むと引用が切れる)。
 */
function scanHeadings(body: string): HeadingAt[] {
  const stripped = stripComments(body);
  // 🔴 画面(html)に出ない `:::if{format=docx}` の中の見出しは、描画が見出しにしない ── 数えない(依頼 272 A)。
  //   行は空行で残す(行数が変わらない)
  const lines = stripMismatchedIfBlocks(stripped.transformed, 'html', true).split(/\r?\n/);
  const spans = containerSpans(lines);
  const origin = (i: number): number => stripped.lineMap[i] ?? i;
  // 🔑 frontmatter の**行数**だけ借りて、その先から見る(剥がした本文は使わない)
  const fm = parseFrontmatter(stripped.transformed);
  const skip = fm.found ? lines.length - fm.body.split(/\r?\n/).length : 0;
  // 🔴 見出し番号つきの文書は、番号を除いた字から名前を作る(描画・目次と同じ ── 台帳 #1852 束 R1、依頼 279 / 351)
  const numberCfg = extractHeadingNumberConfig(body);
  const slugCounter = makeSlugCounter({ stripNumber: numberCfg !== null });
  const legacyCounter = makeLegacySlugCounter();
  // 古い名前は、描画が番号を前置した後の字から作られていた ── 同じ前置きを(本文の行だけに)掛けて読む
  const numberedLines =
    numberCfg === null
      ? lines
      : [
          ...lines.slice(0, skip),
          ...preprocessHeadingNumbers(lines.slice(skip).join('\n'), numberCfg.start).split('\n'),
        ];
  // 🔴 id は描画と同じく**変数を展開した字**から作る(#1087 N2)── 生の `{{vars.x}}` で作ると
  //   描画の id と食い違い、埋め込みが「見出しが見つかりません」になる。展開は描画と同じ関数・その本文自身の vars。
  const vars = extractVars(body);
  const slugOf = (t: string): string => slugCounter(expandVarsInText(t, vars));
  const legacyOf = (t: string): string => legacyCounter(expandVarsInText(t, vars));
  const out: HeadingAt[] = [];
  const limitOf = (i: number): number => {
    const c = spans.closeAt[i] ?? -1;
    return c < 0 ? Infinity : origin(c);
  };
  let fence = '';
  // 下線の見出しの本文候補(記法を持たない素の行の並び)と、その最初の行(原文)
  let para: string[] = [];
  let paraAt = 0;
  let paraI = 0;
  for (let i = skip; i < lines.length; i++) {
    const line = lines[i]!;
    const wasIn = fence !== '';
    const st = fenceStep(fence, line);
    fence = st.next;
    if (st.inside) {
      if (wasIn !== (fence !== '')) para = [];
      continue;
    }
    // `$$` だけの行で開き、`$$` だけの行で閉じる塊(閉じが無ければ塊ではない)
    if (line.trim() === '$$') {
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trim() === '$$') {
          close = j;
          break;
        }
      }
      if (close >= 0) {
        i = close;
        para = [];
        continue;
      }
    }
    // HTML の塊(`<pre>` など)は閉じタグの行まで(閉じが無ければ末尾まで)
    const html = /^ {0,3}<(pre|script|style|textarea)(?:[\s>]|$)/i.exec(line);
    if (html) {
      const closeTag = `</${html[1]!.toLowerCase()}>`;
      let j = i;
      while (j < lines.length && !lines[j]!.toLowerCase().includes(closeTag)) j++;
      i = Math.min(j, lines.length - 1);
      para = [];
      continue;
    }
    const u = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (u && para.length > 0) {
      const text = para.join(' ').trim();
      const at = paraAt;
      para = [];
      if (text !== '') {
        // 下線の見出しの囲みは、字の最初の行のもの(段落の中で囲みは変わらない)
        const paraIdx = paraI;
        out.push({
          slug: slugOf(text),
          legacySlug: legacyOf(text),
          text,
          level: u[1]![0] === '=' ? 1 : 2,
          line: at,
          depth: spans.depth[paraIdx] ?? 0,
          limit: limitOf(paraIdx),
        });
      }
      continue;
    }
    // 見出しにならなかった `---` / `===`(水平線)は段落ではない
    if (u) {
      para = [];
      continue;
    }
    // 段落の素の行だけを溜める(記法の行・空行で切る)
    if (line.trim() === '' || /^\s{0,3}(?:#|>|[-*+][ \t]|\d+[.)][ \t]|\||:::|%%|<)/.test(line)) para = [];
    else {
      if (para.length === 0) {
        paraAt = origin(i);
        paraI = i;
      }
      para.push(line.trim());
    }
    // 閉じの `#` は前に空白が要る(`## C#` の `#` は見出しの字)
    const m = /^ {0,3}(#{1,3})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (!m) continue;
    const text = m[2]!.trim();
    if (text === '') continue;
    const seen = /^ {0,3}#{1,3}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(numberedLines[i] ?? line);
    out.push({
      slug: slugOf(text),
      legacySlug: legacyOf((seen?.[1] ?? text).trim()),
      text,
      level: m[1]!.length as 1 | 2 | 3,
      line: origin(i),
      depth: spans.depth[i] ?? 0,
      limit: limitOf(i),
    });
  }
  return out;
}

/**
 * 選べる入り先を並べる(**末尾は含まない** ── 画面側が既定として先に置く)。
 *
 * ⚠ 同じ字の見出しが 2 つあっても**別の印**になる(`makeSlugCounter` が
 *   `決定事項` / `決定事項-1` と振る)── 潰すと user が選んだほうと違う所へ入る。
 */
export function listAppendTargets(body: string): readonly AppendTarget[] {
  return scanHeadings(body).map(({ slug, text, level }) => ({ slug, text, level }));
}

/** 章の原文の行範囲(0 起点)。`start` は見出し自身、`end` は**含まない**。 */
export interface SectionRange {
  readonly start: number;
  readonly end: number;
}

/**
 * 🔴 **章の範囲(見出し 〜 次の同格以上の見出しの手前)**(#1044 段2)。
 *
 * ⚠ `resolveAppendAt` の**末尾を巻き戻す前**の範囲そのもの ── 章だけ編集(#1044)が
 *   「見出しから、次の同じ深さか浅い見出しの手前まで」を**この関数 1 本**から引く。
 *   `resolveAppendAt` はこの関数の `end` から**さらに**空行を巻き戻すので、2 つは
 *   同じ 1 つの計算(下)を土台にしている(2 つ目の規則を作らない ── CLAUDE.md §7)。
 *
 * @returns 印が解けなければ `null`
 */
export function sectionRange(body: string, slug: string): SectionRange | null {
  const heads = scanHeadings(body);
  let at = heads.findIndex((h) => h.slug === slug);
  // 🔴 古い名前でも読む(記号を抜いただけの綴り / 見出し番号つきの綴り。依頼 255 / 279)
  if (at < 0) at = heads.findIndex((h) => h.legacySlug === slug);
  if (at < 0) return null;
  const me = heads[at]!;
  const lines = body.split(/\r?\n/);
  // 次の**同格以上**の見出し(深い見出しは自分の節の中身なので跨ぐ)
  let end = lines.length;
  for (let i = at + 1; i < heads.length; i++) {
    const h = heads[i]!;
    // 🔴 自分より内側の囲み(`:::note` など)の中の見出しでは切らない ── 囲みは丸ごと 1 つの章に入る(依頼 272 A)
    if (h.depth > me.depth) continue;
    if (h.level <= me.level) {
      end = h.line;
      break;
    }
  }
  // 🔴 自分が囲みの中の見出しなら、その囲みの閉じを越えない
  if (me.limit < end) end = me.limit;
  return { start: me.line, end };
}

/**
 * その節の**終わり**(= 次の同格以上の見出しの直前)の行を返す。
 *
 * @returns 挿す位置の行(0 起点、**その行の前**に入る)。印が無ければ `null`
 *
 * ⚠ 末尾の空行は**跨がない** ── 節の末尾に空行が 2 つあるとき、その後ろに入れると
 *   見た目が節の外になる。🔑 **実のある最後の行の次**に入れる。
 */
export function resolveAppendAt(body: string, slug: string): number | null {
  const range = sectionRange(body, slug);
  if (range === null) return null;
  const lines = body.split(/\r?\n/);
  // 実のある最後の行まで巻き戻す(空行の下に置かない)
  let last = range.end - 1;
  while (last > range.start && lines[last]!.trim() === '') last--;
  return last + 1;
}

/**
 * 選んだ節の末尾へ一塊を差し挟む。
 *
 * @returns 新しい本文。⚠ **印が解けない / 中身が空**なら `null`
 *   ── 呼び側は**理由を出して止める**(末尾へ落とさない)。
 *
 * ⚠ `appendBlock`(末尾)と**別の関数**にしてある ── 末尾は「後ろに足す」、
 *   こちらは「間に挟む」で、前後の空行の作法が違う。1 つにまとめると
 *   どちらかが不自然になる。
 */
export function appendIntoSection(
  base: string,
  slug: string,
  heading: string | null,
  text: string,
): string | null {
  const body = text.replace(/\s+$/, '');
  if (body === '') return null;
  const at = resolveAppendAt(base, slug);
  if (at === null) return null;
  const lines = base.split('\n');
  /**
   * 🔴 **CRLF の本文へは CRLF で挟む**(#1087)。直す前は LF の行を挟み、改行が混ざった
   *   (`replaceSectionByHeading` は元の改行を守る ── 同じ作法)。`split('\n')` は行末の `\r` を残すので、
   *   挟む行にも `\r` を足す。本文の最後の行(改行なし)の後ろへ挟むときだけ、前の行に `\r` を足し、
   *   最後の行には足さない(終わりの改行の有無を変えない)。
   */
  const crlf = base.includes('\r\n');
  const cr = crlf ? '\r' : '';
  const inner = crlf ? (s: string): string => s.replace(/\r?\n/g, '\r\n') : (s: string): string => s;
  const block = (heading === null ? [inner(body)] : [inner(heading), '', inner(body)]).map((l) => l + cr);
  if (crlf && at >= lines.length && at > 0) {
    lines[at - 1] = lines[at - 1]!.endsWith('\r') ? lines[at - 1]! : lines[at - 1]! + '\r';
    block[block.length - 1] = block[block.length - 1]!.slice(0, -1);
  }
  /**
   * ⚠ **前に 1 行空ける**(直前が空行でなければ)。空けないと、直前の段落と
   *   繋がって**1 つの段落として描かれる**(user から見て「くっついた」)。
   * ⚠ **後ろにも 1 行空ける**(次が在って空行でなければ)── 次の見出しと
   *   くっつかないように。
   */
  const before = at > 0 && lines[at - 1]!.trim() !== '' ? [cr] : [];
  const after = at < lines.length && lines[at]!.trim() !== '' ? [cr] : [];
  return [...lines.slice(0, at), ...before, ...block, ...after, ...lines.slice(at)].join('\n');
}

/**
 * 🔴 **足した行そのものを取り出す**(#395 段①、取り消しのため)。
 *
 * > user 指示 2026-08-23「**片道の操作を作らない**」
 *
 * ⚠ **結果から導く**(挿し込みの規則を書き写さない)── 前後の空行を足す作法を
 *   ここで再現すると、規則が 2 か所になり片方だけ古くなる(§7)。
 *   🔑 `base` と `next` の**共通の前後**を削れば、残るのが挿し込んだ run である。
 *
 * @returns 挿し込まれた行の並び。⚠ **純粋な挿入でなければ `null`**
 *   (置換・削除が混ざっていたら、取り消しの材料にしてはいけない)
 */
export function insertedLines(base: string, next: string): readonly string[] | null {
  return insertedRun(base, next)?.lines ?? null;
}

/**
 * 🔴 **足した行と、足した位置**(#1087)。位置は `next` の行番号(0 起点)で、`lines` の先頭が居る所。
 * ⚠ 取り消しが「いちばん後ろの一致」を消すと、同じ字を別の節にも足していたとき**別の節の行**が消える
 *   (B に「済」→ A に「済」→ 取り消し、で B の「済」が消えた)。🔑 足した所を覚えて、そこを先に見る。
 */
export function insertedRun(
  base: string,
  next: string,
): { readonly at: number; readonly lines: readonly string[] } | null {
  const a = base.split('\n');
  const b = next.split('\n');
  if (b.length <= a.length) return null;
  let head = 0;
  while (head < a.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  // ⚠ 前後を削って **`a` 側が空になる**ときだけ「純粋な挿入」である
  if (head + tail !== a.length) return null;
  const run = b.slice(head, b.length - tail);
  return run.length > 0 ? { at: head, lines: run } : null;
}

/**
 * 🔴 **足した行を取り消す**(#395 段①)。
 *
 * ⚠ **行番号で消さない** ── 追記のあとに別の窓が上へ足していれば番号はずれる。
 *   🔑 **その行の並びが在る所**を探して消す(無ければ消さない)。
 * ⚠ **いちばん後ろの一致**を消す ── 同じ字を 2 回足したとき、消えるのは
 *   **さっき足したほう**であってほしい(user が押した「元に戻す」は直前の 1 手である)。
 *
 * 🔴 **`at`(足した位置)が在れば、まずそこを見る**(#1087)。そこが `run` と一致しなくなっていたとき
 *   (別の窓が上へ足した等)だけ、上の「いちばん後ろの一致」へ落ちる。
 *
 * @returns 消したあとの本文。⚠ **見つからなければ `null`**(黙って別の所を消さない)
 */
export function removeInsertedLines(body: string, run: readonly string[], at?: number): string | null {
  if (run.length === 0) return null;
  const lines = body.split('\n');
  if (at !== undefined && at >= 0 && at + run.length <= lines.length && run.every((l, i) => lines[at + i] === l)) {
    return [...lines.slice(0, at), ...lines.slice(at + run.length)].join('\n');
  }
  for (let from = lines.length - run.length; from >= 0; from--) {
    let hit = true;
    for (let i = 0; i < run.length; i++) {
      if (lines[from + i] !== run[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return [...lines.slice(0, from), ...lines.slice(from + run.length)].join('\n');
  }
  return null;
}

/**
 * 🔴 **その行が居る節を引く**(#495。Alt+クリックで追記の入り先を指す)。
 *
 * > user 裁定 2026-08-27「**センターペインの追記位置指定は Alt+クリックにしましょう**」
 *
 * 押した所から**いちばん近い上の見出し**を返す ── 深い見出しの中で押したら
 * その深い見出しが返る(`resolveAppendAt` が「次の同格以上の見出しの直前」まで
 * を節と数えるので、**選んだ節の末尾**は押した所を含む節の末尾になる)。
 *
 * @param line **原文の**行番号(0 起点)。⚠ 描く面は frontmatter を剥がした側を
 *   見ているので、呼び側が `frontmatterLineCount` を足してから渡す ──
 *   ずらす値は 1 か所(`detail.ts` の `fmLines` と同じ規律)。
 * @returns その節の見出し。⚠ **上に見出しが 1 つも無ければ `null`**
 *   ── 呼び側は**入り先を変えない**(「末尾」へ落とすと、上のほうを押したのに
 *   文書のいちばん下へ入る = いちばん静かな取り違えになる)。
 */
export function sectionAt(body: string, line: number): AppendTarget | null {
  let hit: HeadingAt | null = null;
  for (const h of scanHeadings(body)) {
    if (h.line > line) break;
    hit = h;
  }
  if (hit === null) return null;
  return { slug: hit.slug, text: hit.text, level: hit.level };
}

/**
 * 🔴 **章だけの保存を、見出しの名前で本文へ差し替える**(#1044 段2 3巡目の修理、S1)。
 *
 * ⚠ **`SAVE_SECTION_DRAFT` の reducer が持っていた「探し直し・比較・差し替え」を
 *   ここへ移した**(2 本目の規則を作らない ── §7)。effect が **disk から読み直した
 *   本文**をここへ渡す ── reducer は `state.openBody.body`(画面の古い写し)を
 *   一切使わない(追記 `REQUEST_APPEND` と同じ「本文は event に載せず、書く瞬間に
 *   disk から読み直す」作法)。
 *
 * 🔑 手順:①見出しの**名前**で、渡された本文から章を探し直す(何番目かではなく ──
 *   別の窓が上の方の見出しを増減させていても、名前なら追える)②見出しが
 *   **0 個 / 2 個以上**なら断る(どの章か決まらない)③いまの章の中身が
 *   **開いたときの原文と一致するか**を見る(一致しなければ、別の場所で
 *   書き換えられている ── 1 文字も書かずに断る)④一致していれば、その範囲を
 *   `text` で丸ごと差し替える。
 *
 * @param body 差し替え先の本文(**disk から読んだ最新の本文** ── frontmatter を含む)
 * @param heading 章を探す見出しの字(`SectionDraft.heading`)
 * @param original 開いたときに控えた、この章の原文(`SectionDraft.original`)
 * @param text 箱に打たれていた新しい中身(見出し行を含む)
 */
export type ReplaceSectionResult =
  | { readonly ok: true; readonly body: string }
  /**
   * `missing` = 見出しが 0 個(消えた / 変わった)。`ambiguous` = 見出しが 2 個以上
   * (どの章か決まらない)。`mismatch` = 見出しは 1 個だが中身が原文と違う(別の場所で
   * 書き換えられている)。⚠ 呼び側は**理由を分けて言ってよい**が、字は 1 か所
   * (`app-state.ts` の断り文)に寄せる ── ここでは種類だけ返す。
   */
  | { readonly ok: false; readonly reason: 'missing' | 'ambiguous' | 'mismatch' };

export function replaceSectionByHeading(
  body: string,
  heading: string,
  original: string,
  text: string,
): ReplaceSectionResult {
  const matches = listAppendTargets(body).filter((h) => h.text === heading);
  if (matches.length === 0) return { ok: false, reason: 'missing' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous' };
  const range = sectionRange(body, matches[0]!.slug);
  if (range === null) return { ok: false, reason: 'missing' };
  const lines = body.split(/\r?\n/);
  const current = lines.slice(range.start, range.end).join('\n');
  if (current !== original) return { ok: false, reason: 'mismatch' };
  /**
   * 🔴 **触っていない章の改行は 1 バイトも変えない**(#1087、本文の書換の見直し)。
   * ⚠ 直す前は全行を `\n` で繋ぎ直していたので、CRLF の本文は章を 1 つ保存しただけで**全部** LF になった。
   * 🔑 行を**終わりの改行ごと**持ち回り、差し替える章の中だけを組み直す。章の中の改行は、
   *   その章の 1 行目が使っていた改行に揃える(混在した本文でも、ほかの章には触らない)。
   */
  const parts = body.split(/(?<=\n)/);
  const eolOf = (p: string | undefined): string => (p === undefined ? '' : p.endsWith('\r\n') ? '\r\n' : p.endsWith('\n') ? '\n' : '');
  const eol = eolOf(parts[range.start]) || (body.includes('\r\n') ? '\r\n' : '\n');
  // 章の最後の行に改行が在ったか(本文の終わりの章で、最後に改行が無ければ足さない)
  const tail = range.end > range.start ? eolOf(parts[range.end - 1]) : '';
  const newBody =
    parts.slice(0, range.start).join('') +
    text.split(/\r?\n/).join(eol) +
    tail +
    parts.slice(range.end).join('');
  return { ok: true, body: newBody };
}

/**
 * 🔴 **押した見出しを、行番号ではなく「字 + 同じ字の中で何番目か」で覚える**
 *   (#1044 段2 3巡目の修理、S1)。
 *
 * > user の物語:1 章目に 2 行足して保存し、続けて 2 章目を編集したい。
 *
 * ⚠ **`shiftLineAfterSectionSave`(行のずらし算)を置き換える** ── 保存後の本文は
 *   `SAVE_SECTION_DRAFT` の effect が **disk から読み直した**ものなので、
 *   「保存する前の本文 + 増減した行数」という前提そのものが崩れている
 *   (別の窓が保存の合間に上へ書いていれば、行の増減はこちらの章の分だけでは済まない)。
 * 🔑 だから**行を計算しない**。押した見出しを名前で覚え、**保存後の本文からもう一度
 *   引き直す**(`resolveHeadingRef`)── 追記の入り先と同じ「そのつど本文から解く」作法
 *   (#395 段①)。
 *
 * ⚠ 同じ字の見出しが 2 つ以上あるとき、**どちらを押したか**を残すために
 *   `ordinal`(同じ字の中で何番目、0 起点)を持つ。
 *
 * @param line 押した見出しの行(frontmatter を剥がした側。`sectionAt` の呼び手と同じ規約)
 * @returns 押した所に見出しが無ければ `null`
 */
export interface HeadingRef {
  readonly text: string;
  readonly ordinal: number;
}

export function headingRefAt(body: string, line: number): HeadingRef | null {
  const hit = sectionAt(body, line + frontmatterLineCount(body));
  if (hit === null) return null;
  const sameText = listAppendTargets(body).filter((h) => h.text === hit.text);
  const ordinal = sameText.findIndex((h) => h.slug === hit.slug);
  return ordinal < 0 ? null : { text: hit.text, ordinal };
}

/**
 * `headingRefAt` で覚えた見出しを、**別の(保存後の)本文から**引き直す。
 * ⚠ 同じ字の見出しの数が変わっていれば(押した回より減った等)`null`。
 */
export function resolveHeadingRef(body: string, ref: HeadingRef): AppendTarget | null {
  const sameText = listAppendTargets(body).filter((h) => h.text === ref.text);
  return sameText[ref.ordinal] ?? null;
}

/**
 * その見出し(`slug`)の行(frontmatter を剥がした側)。⚠ **開く口**
 * (`OPEN_SECTION_DRAFT` / `startSectionEditAt` の `line`)と同じ規約に揃える。
 *
 * @returns 印が解けなければ `null`
 */
export function headingLine(body: string, slug: string): number | null {
  const range = sectionRange(body, slug);
  return range === null ? null : range.start - frontmatterLineCount(body);
}

/** 章の別ウィンドウが出す範囲(#1044 段4)。行は **frontmatter を剥がした側**。 */
export interface ChapterLines {
  /** 見出しの印(描画が見出しに刻む id と同じ綴り)。 */
  readonly slug: string;
  /** 見出しの字。 */
  readonly text: string;
  /** 見出し自身の行(含む)。 */
  readonly from: number;
  /** 次の同じ深さか浅い見出しの行 / 末尾(含まない)。 */
  readonly to: number;
}

/**
 * 🔴 **覚えた見出しの章を、いまの本文から引き直す**(#1044 段4、章の別ウィンドウ)。
 *
 * 🔑 **章の欄と同じ 2 本を通すだけ** ── 見出しは `resolveHeadingRef`(字 + 何番目か)、
 *   範囲は `sectionRange`(追記の入り先と同じ)。窓のために 3 本目の規則を作らない
 *   (CLAUDE.md §7)。
 * ⚠ 行は**描画の刻印と同じ座標**(frontmatter を剥がした本文)へ直して返す ──
 *   受け手は `data-pkc-source-line` で塊を拾う(`section-box.ts` の `blocksInRange`)。
 *
 * @returns 見出しを見失った(字が変わった / 消えた / 同じ字の見出しの数が変わった)ら `null`
 */
export function chapterLinesOf(
  body: string,
  ref: HeadingRef,
  /**
   * 🔴 **開いた時の「同じ字の見出しの数」**(#1044 段4 着地前レビュー)。
   * ⚠ `resolveHeadingRef` が見失うのは**数が減ったとき**だけ ── 開いた章より**前**に
   *   同じ字の見出しを足すと、同じ「何番目」に**別の見出し**が来て、窓は黙って別の章を出す
   *   (実測:前に `## 二` を挟むと、挟んだ方の中身が出た)。章の欄は保存の前に中身を比べるので
   *   取り違えても断れるが、**読むだけの窓には比べる相手が無い**。
   * 🔑 だから数が変わったら**見失った**と扱う(後ろに足した場合も見失うが、それは
   *   「黙って別の章を出す」より安全な側の外し方である)。省略すると数を見ない。
   */
  sameCount?: number,
): ChapterLines | null {
  if (sameCount !== undefined && sameHeadingCount(body, ref.text) !== sameCount) return null;
  const hit = resolveHeadingRef(body, ref);
  if (hit === null) return null;
  const range = sectionRange(body, hit.slug);
  if (range === null) return null;
  const fm = frontmatterLineCount(body);
  return { slug: hit.slug, text: hit.text, from: range.start - fm, to: range.end - fm };
}

/** その字の見出し(`#`〜`###`)が本文にいくつ在るか(#1044 段4 ── `chapterLinesOf` の `sameCount`)。 */
export function sameHeadingCount(body: string, text: string): number {
  return listAppendTargets(body).filter((h) => h.text === text).length;
}
