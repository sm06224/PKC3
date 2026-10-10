/**
 * 🔴 **別のノートの「見出しの節」を、本文の中へ読み取り専用で描く**(#1459 ①)── 規則だけの pure な側。
 *
 * ## 何が起きるか(画面の言葉)
 *
 * 本文に `![説明](entry:ノートのID#h/見出しの印)` と書くと、その場所に**指した見出しの節**
 * (見出しから、次の同じ深さか浅い見出しの手前まで)の中身が出る。元のノートを直すと追随する。
 * 本文のバイトは 1 つも変えない(書いた字がそのまま正本)。
 *
 * ## 🔑 新しい記法ではない
 *
 * 綴りは描画器が**前から認識していた**画像形の参照(`pkc-transclusion-placeholder`、空の器になっていた)で、
 * 見出しを指す断片(`#h/…`)は `[…](entry:…#h/…)` のリンクが前から使っている綴り(#579)。
 * ⚠ **ふつうのリンク `[字](entry:…)` は展開しない**(`!` の付いた画像形だけ)。
 *
 * ## ⚠ 板(`place-embed.ts`)の作法を引き継ぐ
 *
 * 読み取り専用 / **深さ ≤ 1**(節の中の埋め込みは展開せず題名のリンクへ降ろす)/ `id` は接頭辞つき /
 * 自分自身を指す埋め込みは展開しない。**循環(A→B→A)は深さ ≤ 1 が止める**(二段目はリンク)。
 *
 * ## 🔑 板の抜粋と同じ入れ物(`state.placeBodies`)に乗せる
 *
 * 鍵は `<lid>#h/<印>`(`sectionKey`)。頼む / 読む / 書込に追随する / 上限で手放す、が板の抜粋と
 * **同じ口**を通る(口を 2 本に分けると片方だけ古いまま映す ── `syncShownBodies` の注記)。
 * 節の範囲は追記・章だけ編集と**同じ関数**(`sectionRange`)── 2 つ目の規則を作らない。
 * ⚠ 見出しは 1〜3 段だけ(`scanHeadings` と同じ。4 段以下の見出しは指せない = 「見つかりません」)。
 */
import { parseEntryRef } from '../entry-ref/entry-ref';
import { sectionRange } from './append-target';
import { clipText, type PlaceExcerpt } from './place-embed';

const SEP = '#h/';

/** `placeBodies` の鍵(ノート × 見出しの印)。⚠ lid は `[A-Za-z0-9_-]` だけなので `#` を含まない。 */
export function sectionKey(lid: string, id: string): string {
  return `${lid}${SEP}${id}`;
}

/** 鍵を解く。見出しの鍵でなければ `null`(= 板の抜粋の鍵)。 */
export function parseSectionKey(key: string): { lid: string; id: string } | null {
  const at = key.indexOf(SEP);
  if (at <= 0) return null;
  const id = key.slice(at + SEP.length);
  return id === '' ? null : { lid: key.slice(0, at), id };
}

/** 鍵から読む先のノート(板の抜粋の鍵ならそのまま)。 */
export function baseLidOfKey(key: string): string {
  return parseSectionKey(key)?.lid ?? key;
}

/**
 * ノートの本文から、見出しの節を切り出す。
 * - 見つからない → `{ text: '', cut: false, missing: true }`(黙って空にしない。描く側が断りを出す)
 * - 長い節は板と同じ規則で切る(`clipText`)
 * - 節の末尾の空行は落とす
 */
export function sectionExcerptOf(body: string, id: string): PlaceExcerpt {
  const range = sectionRange(body, id);
  if (range === null) return { text: '', cut: false, missing: true };
  const lines = body.split(/\r?\n/).slice(range.start, range.end);
  while (lines.length > 1 && lines[lines.length - 1]!.trim() === '') lines.pop();
  return clipText(lines.join('\n'));
}

/** 画像形の参照 `![…](entry:…)` の `entry:…` の部分。 */
const EMBED_RE = /!\[[^\]]*\]\((entry:[^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * 本文が展開を求めている見出しの鍵(`sectionKey`)。fence の中は数えない。
 * 用途は「いま画面に出ている本文が要る抜粋を、上限で手放さない」(板の `placeEntryLids` と同じ役)。
 */
export function sectionEmbedKeys(body: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line.includes('![')) continue;
    for (const m of line.matchAll(EMBED_RE)) {
      const ref = parseEntryRef(m[1]!);
      if (ref.kind === 'section') out.push(sectionKey(ref.lid, ref.id));
    }
  }
  return out;
}
