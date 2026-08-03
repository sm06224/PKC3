/**
 * 描いた HTML を**塊に切って差分を取る**(P8 段⑩)。
 *
 * > user 指示 2026-08-03「**1 打鍵ではなく、3 秒周期で差分反映してください /
 * > 1 打鍵では、そんなことしたら、重たくなるし、レンダリングで画面がガクガクする**」
 *
 * 🔴 頻度を落とすだけでは**ガクガクは消えない**。1 回の反映で 302KB の HTML を
 * 丸ごと作り直しているのが原因で、そのたびに
 *  - DOM が全部捨てられて作り直される(scroll 位置が飛ぶ)
 *  - 図(mermaid)が全部焼き直しになる(画像が一瞬消える)
 * が起きる。**変わった塊だけ差し替える**のが効く。
 *
 * ## 切り方
 *
 * markdown-it の出力は「最上位のブロック要素の並び」なので、**深さ 0 の
 * 要素境界**で切れる。⚠ text 中の `<` `>` は markdown-it が実体参照へ escape
 * するので、生の `<` はタグ以外に現れない。属性値の中の `>` だけは引用符を
 * 見て避ける必要がある。
 *
 * ⚠ **切って戻せることを test が保証する**(`join('') === html`)── ここが
 * 崩れると preview が静かに壊れる。壊れ方が「一部が消える」なので気づきにくい。
 */

/** 閉じタグを持たない要素(HTML5)。 */
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** 中身を「生テキスト」として読む要素(中の `<` はタグではない)。 */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

/** `<` から始まるタグの終わり(`>` の次の位置)。⚠ 引用符の中の `>` は跨ぐ。 */
function endOfTag(html: string, start: number): number {
  let quote = '';
  for (let i = start + 1; i < html.length; i++) {
    const c = html[i]!;
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i + 1;
  }
  return html.length;
}

/** タグ名(小文字)。`</div>` なら `div`。 */
function tagNameAt(html: string, start: number): string {
  let i = start + 1;
  if (html[i] === '/') i += 1;
  let out = '';
  for (; i < html.length; i++) {
    const c = html[i]!;
    if (c === '>' || c === ' ' || c === '\n' || c === '\t' || c === '/') break;
    out += c;
  }
  return out.toLowerCase();
}

/**
 * 最上位のブロックへ切る。⚠ **必ず元へ戻せる**(空白・改行も落とさない)。
 * 塊の境目に挟まる空白は**直前の塊の末尾**に付ける(戻したとき同じになる)。
 */
export function splitTopLevelBlocks(html: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    // タグの外(空白 / 改行)は、直前の塊へくっつける
    if (html[i] !== '<') {
      const next = html.indexOf('<', i);
      const tail = next === -1 ? html.slice(i) : html.slice(i, next);
      if (out.length > 0) out[out.length - 1] += tail;
      else out.push(tail);
      if (next === -1) break;
      i = next;
      continue;
    }
    // コメント(`<!-- ... -->`)と宣言(`<!...>`)
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i);
      const stop = end === -1 ? html.length : end + 3;
      out.push(html.slice(i, stop));
      i = stop;
      continue;
    }
    const name = tagNameAt(html, i);
    const afterOpen = endOfTag(html, i);
    // 単独要素・自己終了 ── 開始タグだけで 1 つの塊
    if (VOID.has(name) || html.slice(i, afterOpen).endsWith('/>')) {
      out.push(html.slice(i, afterOpen));
      i = afterOpen;
      continue;
    }
    // 対応する閉じタグまで(同名の入れ子を数える)
    let depth = 1;
    let j = afterOpen;
    while (j < html.length && depth > 0) {
      const lt = html.indexOf('<', j);
      if (lt === -1) {
        j = html.length;
        break;
      }
      const n = tagNameAt(html, lt);
      const after = endOfTag(html, lt);
      if (n === name) {
        if (html[lt + 1] === '/') depth -= 1;
        // 生テキスト要素は中身にタグが無い前提 ── 入れ子を数えない
        else if (!RAW_TEXT.has(name) && !html.slice(lt, after).endsWith('/>')) depth += 1;
      }
      j = after;
    }
    out.push(html.slice(i, j));
    i = j;
  }
  return out;
}

/**
 * 差し替える範囲。**前後の一致を削って真ん中だけ**を返す。
 *
 * 🔑 実際の編集は 1 か所に固まるので、これで十分に絞れる(LCS は要らない)。
 * ⚠ 変わっていなければ `middle` が空で `prefix + suffix === 全数` になる。
 */
export interface BlockPatch {
  /** 先頭から何個そのまま残すか。 */
  prefix: number;
  /** 末尾から何個そのまま残すか。 */
  suffix: number;
  /** 真ん中に入れる新しい塊(空 = 削除だけ)。 */
  middle: readonly string[];
  /** 取り除く古い塊の数(= old.length - prefix - suffix)。 */
  removed: number;
}

export function diffBlocks(
  oldBlocks: readonly string[],
  newBlocks: readonly string[],
): BlockPatch {
  const max = Math.min(oldBlocks.length, newBlocks.length);
  let prefix = 0;
  while (prefix < max && oldBlocks[prefix] === newBlocks[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldBlocks[oldBlocks.length - 1 - suffix] === newBlocks[newBlocks.length - 1 - suffix]
  )
    suffix += 1;
  return {
    prefix,
    suffix,
    middle: newBlocks.slice(prefix, newBlocks.length - suffix),
    removed: oldBlocks.length - prefix - suffix,
  };
}
