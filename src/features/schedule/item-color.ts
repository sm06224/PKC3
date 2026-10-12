/**
 * 🔴 **予定の左の縦線の色を決める**(#855。Gemini 裁定 = #1163 の依頼 20-A「両方」)。
 *
 * 決め方は 2 段で、上が勝つ:
 *
 * | 順 | 何の色か | 例 |
 * |---|---|---|
 * | 1 | 🔑 **項目の行に書いたタグ**の色(設定で決めた色。`features/tag-color.ts`) | `- [ ] @2026-10-12 14:00 #仕事 打ち合わせ` |
 * | 2 | **そのノートの色** ── 1 つのノートの予定は同じ色になる | タグの無い行 / 色を決めていないタグの行 |
 *
 * ## ノートの色はどこから来るか
 *
 * ノートに色を持たせる仕組みは今のところ無い(実測: `EntryMeta` にも frontmatter にも色の欄が無い)。
 * 新しい設定を足さず、**ノートの id から自動で決める**(同じノートはいつも同じ色)。
 * 色は `tokens.css` の `--note-1` 〜 `--note-8`(テーマごとに、地に対して 3:1 以上になる色を持つ)から選ぶので、
 * ここが返すのは**色そのものではなく、CSS 変数の名前**である。
 *
 * ⚠ 色が出るのは**左の細い縦線だけ**(地は無彩色のまま ── 「色は情報にだけ使う」)。
 * 🔑 **pure module**。browser API を使わない。
 */
import { tagColorOf, type TagColorEntry } from '../tag-color';

/** ノートの色の数(`tokens.css` の `--note-1` 〜 `--note-N` と同じ数)。 */
export const NOTE_COLOR_COUNT = 8;

/**
 * 項目の字に書いてあるタグ(`#仕事`)を、書いた順に返す。
 * ⚠ 語頭の `#` だけ(`C#` や URL の `#fragment` はタグではない)。`#` だけの語・`##` は拾わない。
 */
export function inlineTagsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[\s\u3000])#([^\s\u3000#]+)/gu)) out.push(m[1]!);
  return out;
}

/** そのノートの色の番号(1 〜 `NOTE_COLOR_COUNT`)。同じ lid はいつも同じ番号。 */
export function noteColorIndex(lid: string): number {
  // FNV-1a(32 bit)。⚠ 乱数・時刻・出現順は使わない ── 開くたびに色が変わらないように
  let h = 0x811c9dc5;
  for (let i = 0; i < lid.length; i++) {
    h ^= lid.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % NOTE_COLOR_COUNT) + 1;
}

/** ノートの色(CSS 変数)。 */
export function noteColorVar(lid: string): string {
  return `var(--note-${noteColorIndex(lid)})`;
}

export interface ItemColor {
  /** 縦線に塗る色。`tag` のときは `#rrggbb`、`note` のときは `var(--note-N)`。 */
  readonly color: string;
  /** どちらの色か。 */
  readonly from: 'tag' | 'note';
}

/**
 * 予定 1 件の縦線の色。行のタグに色が決めてあればそれ(複数あれば先に書いたもの)、無ければノートの色。
 * ⚠ 色を決めていないタグだけが書いてある行は、ノートの色になる(灰色や無色にはしない)。
 */
export function resolveItemColor(
  item: { readonly lid: string; readonly text: string },
  tagColors: readonly TagColorEntry[],
): ItemColor {
  for (const tag of inlineTagsOf(item.text)) {
    const c = tagColorOf(tagColors, tag);
    if (c !== null) return { color: c, from: 'tag' };
  }
  return { color: noteColorVar(item.lid), from: 'note' };
}
