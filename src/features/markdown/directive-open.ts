/**
 * 🔴 **`:::` の開きを見分ける判定を、1 か所に置く**(2026-08-07)。
 *
 * ## なぜ独立した module なのか
 *
 * この判定は **2 人の読み手**が要る:
 *
 * | 読み手 | 何に使うか |
 * |---|---|
 * | `markdown-render.ts` | 囲いを畳むときに**入れ子の深さを数える** |
 * | `source-blocks.ts`(ライブエディタ) | 原文の囲いの範囲を出す |
 *
 * ⚠ **`source-blocks.ts` は `markdown-render.ts` を import できない** ── あちらは
 * module scope で `MarkdownIt` を作るので、**編集中の走査経路に markdown-it が入る**。
 * だから判定だけをここへ降ろし、**両方がこれを引く**。
 *
 * 🔑 **これが無かったときに起きていたこと**(2026-08-07 実測):
 * 走査器は `:::name` を**一律に囲いと見なして**いたが、renderer が畳むのは
 * **知っている名前 + Tier 0(語彙)+ Tier 1(class 連結)**だけ。だから
 * `:::foo` のような**畳まれない名前**を書くと、走査器だけが 1 塊に畳んで
 * 釣り合いが崩れ、**行ごとの編集が全文の入力欄へ落ちて**いた(user の動線が落ちる)。
 *
 * ⚠ **表を 2 つ持たない**(CLAUDE.md「判定を増やさない」)。名前を足すときはここだけ。
 *   両者が同じ判定を引いていることは `tests/features/directive-open-parity.test.ts` が
 *   機械で守る。
 * ⚠ **pure module**。browser API を使わない(ライブエディタが読む)。
 */
import { parseBlockDirectiveOpen, parseTier1FormatOpen } from './block-directive-attrs';

const SIMPLE_INLINE_VOCAB_KEYWORDS = new Set([
  'bold', 'italic', 'underline', 'strikethrough', 'strike', 'code',
  'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl',
  'serif', 'sans', 'mono',
]);

// L-6 size token は body text に対する **相対 size**(em-based)。
// `--fs-*` は chrome 用 fixed rem scale で body と差が出にくいため使わない。
// markdown 本文での「ここだけ大きく / 小さく」を素直に表現するため em 比率で固定。
const SIZE_KEYWORD_TO_EM: Record<string, string> = {
  'xs':  '0.75em',
  'sm':  '0.875em',
  'md':  '1em',
  'lg':  '1.25em',
  'xl':  '1.5em',
  '2xl': '1.875em',
  '3xl': '2.5em',
};

// 自由値 size token: `120%` / `1.5em` / `0.5rem` / `12px` を許容。
const SIZE_VALUE_RE = /^\d+(?:\.\d+)?(?:%|em|rem|px)$/;

// Phase 1 で validate する CSS named color の curated list(~50 色)。
// 他のレアな color name を使う場合は #hex / rgb() で指定する旨を spec 記載。
const NAMED_COLORS = new Set([
  'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'brown',
  'black', 'white', 'gray', 'grey', 'silver', 'gold',
  'cyan', 'magenta', 'lime', 'navy', 'teal', 'aqua', 'maroon', 'olive',
  'transparent', 'crimson', 'salmon', 'tomato', 'coral', 'lavender', 'turquoise',
  'indigo', 'violet', 'fuchsia',
  'aliceblue', 'azure', 'beige', 'ivory', 'khaki',
  'darkred', 'darkgreen', 'darkblue', 'darkgray', 'darkgrey',
  'lightgray', 'lightgrey', 'lightblue', 'lightgreen', 'lightyellow', 'lightpink',
  'currentcolor', 'inherit',
]);

const COLOR_VALUE_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d.,\s]+\))$/;

function isValidColor(c: string): boolean {
  return NAMED_COLORS.has(c.toLowerCase()) || COLOR_VALUE_RE.test(c);
}

// attrs を top-level comma または 空白で split(parens 内 separator は保護)。
// Q7(v4 spec §16、user direction 2026-05-25):inline / block 両 vocabulary 形で
// comma / 空白 / 混在 全部 accept。`bold red` / `bold,red` / `bold, red` / `bold , red` 等は
// 全て同 token 列に正規化、対称性原則 §1.1 を inline / block で統一。
// rgb(255, 0, 0) / rgb( 255 0 0 ) 等の parens 内 separator は depth 保護で 1 token のまま。
export function splitAttrs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === ',' || c === ' ' || c === '\t')) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out.filter(Boolean);
}

/**
 * Vocabulary tokens を style mapping(Record<string, string>)に変換。
 * 全 token が valid vocabulary なら styles を返す、1 つでも未知なら null。
 *
 * v4 §12 stack PR 6:Tier 0 vocabulary form `:::red,bg-yellow,1.2em` でも共有、
 * inline `:T:vocab,vocab:` と完全対称な vocab → style mapping 経路。
 */
export function parseVocabularyTokensToStyles(tokens: string[]): Record<string, string> | null {
  if (tokens.length === 0) return null;
  const styles: Record<string, string> = {};
  for (const t of tokens) {
    if (SIMPLE_INLINE_VOCAB_KEYWORDS.has(t)) {
      switch (t) {
        case 'bold': styles['font-weight'] = 'bold'; break;
        case 'italic': styles['font-style'] = 'italic'; break;
        case 'underline': styles['text-decoration'] = 'underline'; break;
        case 'strikethrough': case 'strike': styles['text-decoration'] = 'line-through'; break;
        case 'code': styles['font-family'] = 'monospace'; break;
        case 'xs': case 'sm': case 'md': case 'lg': case 'xl': case '2xl': case '3xl':
          styles['font-size'] = SIZE_KEYWORD_TO_EM[t]!;
          break;
        case 'serif': styles['font-family'] = 'serif'; break;
        case 'sans': styles['font-family'] = 'sans-serif'; break;
        case 'mono': styles['font-family'] = 'monospace'; break;
      }
    } else if (SIZE_VALUE_RE.test(t)) {
      // 自由値 size: `120%` / `1.5em` / `12px` / `0.75rem`
      styles['font-size'] = t;
    } else if (t.startsWith('bg-')) {
      const c = t.slice(3);
      if (!isValidColor(c)) return null;
      styles['background-color'] = c;
    } else if (isValidColor(t)) {
      styles['color'] = t;
    } else {
      return null;
    }
  }
  return styles;
}

/**
 * v4 §12 stack PR 6:Tier 0 vocabulary form `:::red,bg-yellow,1.2em` を styles に parse。
 *
 * 入力:`:::vocab,vocab,vocab` または `:::vocab vocab vocab`(Q7 separator 寛容)。
 * 戻り値:`{ styles }` 全 token が valid vocabulary なら / null 未知 token / 形式不一致。
 *
 * 注意:vocabulary check は inline `:T:vocab:` と同経路(`parseVocabularyTokensToStyles`)、
 * 完全対称(Q3 priority、user direction 2026-05-25)。Tier 1 class chain よりも先に試行
 * (vocabulary を優先)、未知 token 含むなら Tier 1 へ fallthrough。
 */
export function parseTier0FormatOpen(line: string): { styles: Record<string, string> } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(':::')) return null;
  const rest = trimmed.slice(3).trim();
  if (rest.length === 0) return null;
  // brace 形({...})は Tier 1 経路に任せる(Pandoc fenced div、class/id 専用)
  if (rest.startsWith('{')) return null;
  // dot 始まり(`.cls`)は Tier 1 class chain
  if (rest.startsWith('.')) return null;
  // splitAttrs(Q7 寛容、comma / 空白 両 accept、parens 内 separator は depth 保護)
  const tokens = splitAttrs(rest);
  if (tokens.length === 0) return null;
  // 全 token が vocabulary match なら Tier 0、1 つでも未知なら null(Tier 1 fallthrough)
  const styles = parseVocabularyTokensToStyles(tokens);
  if (!styles) return null;
  return { styles };
}

/**
 * 🔴 **`:::` の開きを 1 か所で見分ける**(2026-08-07)。
 *
 * ## なぜ要るか
 *
 * 各 directive の前処理は「中身を飲む」ときに閉じ `:::` を探すが、直す前は
 * **最初に出会った `:::` で止めていた**。だから中に別の `:::` を書くと、
 * **内側の閉じを自分の閉じとして食い**、外側の閉じが最上位へ漏れる。
 * 実測(2026-08-07、外×内の 112 通り)で **48 通りが壊れていた** ──
 * 交差した HTML(`</blockquote>` が `</section>` より先)になるか、
 * 内側が literal のまま残るかのどちらかで、どちらも
 * **ライブエディタの釣り合いが崩れて行ごとの編集が開かなくなる**。
 *
 * ## 数える対象は「閉じを消費する開き」だけ
 *
 * ⚠ **`parseBlockDirectiveOpen` で代用してはいけない。** あれは `:::foo` のような
 * **どの処理も畳まない名前**にも一致するので、数えると「閉じないものの閉じ」を
 * 待って `:::` を 1 つ余計に食う。⚠ 逆に Tier 0(`:::red`)/ Tier 1(`:::.hl`)は
 * `processFormatBlocks` が畳む**のに**、名前の正規表現に一致しないので
 * 数え落とされていた(これが 48 通りのうち 20 通りの原因)。
 *
 * ⚠ **`:::break` は数えない** ── `+++` へ書き換わる 1 行の記法で、閉じを持たない。
 * ⚠ **`:::toc` は `'self-contained'`** ── 中を飲まないが、**直後に `:::` があれば
 *   それは toc のもの**。呼び手は「次の行が閉じなら 2 行まとめて飛ばす」を守る
 *   (`source-blocks.ts` の走査器と同じ規則)。
 *
 * 🔑 **判定はここ 1 か所**(CLAUDE.md「判定を増やさない」)。名前を足すときは
 * `tests/features/markdown-nesting.test.ts` の全数表も一緒に増える。
 */
export type DirectiveOpenKind = 'container' | 'self-contained';

/**
 * 閉じ `:::` を消費する directive の名前。
 * ⚠ **alias(`:::note` 等)も入れる** ── `processIfBlocks` は
 * `processAdmonitionAliases` より**前**に走るので、書き換え前の名前で出会う。
 */
const CONTAINER_DIRECTIVE_NAMES: ReadonlySet<string> = new Set([
  'comment', 'if', 'section', 'quote', 'details', 'figure', 'table', 'equation',
  'format', 'frontmatter', 'body', 'paragraph', 'callout', 'admonition',
  // admonition の短名(`ADMONITION_ALIASES` と同じ 8 個。あちらは書き換えの表、
  // ここは「閉じを消費するか」の表なので、役割が違うため別に持つ)
  'note', 'warning', 'tip', 'info', 'caution', 'important', 'danger', 'summary',
]);

export function classifyDirectiveOpen(line: string): DirectiveOpenKind | null {
  const named = parseBlockDirectiveOpen(line);
  if (named) {
    if (named.name === 'toc') return 'self-contained';
    if (CONTAINER_DIRECTIVE_NAMES.has(named.name)) return 'container';
    /**
     * ⚠ **名前の形に一致しても、まだ終わりではない**(2026-08-07 に実測で踏んだ)。
     * Tier 0 の語彙は `:::red` / `:::code` のように**名前と同じ形**なので、
     * ここで `null` を返すと `processFormatBlocks` が畳む当のものを数え落とす。
     * 「畳まれない名前」(`:::foo`)と区別できるのは**語彙の照合だけ**である。
     */
    return parseTier0FormatOpen(line) ? 'container' : null;
  }
  // 名前の形に一致しない開き ── Tier 0(空白区切り)/ Tier 1(class chain)は畳まれる
  if (parseTier0FormatOpen(line)) return 'container';
  if (parseTier1FormatOpen(line)) return 'container';
  return null;
}
