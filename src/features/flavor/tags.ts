/**
 * タグ(#182 / 台帳 #180 の A-2)。
 *
 * 🔴 **新しい概念を足さない。** PKC3 は frontmatter が本文の中にあるので、
 * タグは `tags: [買い物, 家事]` と**書けば済む** ── PKC2 のように record へ
 * `tags?: string[]` という別の場所を作らない(founding「JSON 文字列 body を作らない」
 * と同じ向き)。
 *
 * ⚠ **フレーバー固有ではない。** todo にも text にも添付にも付けられる ──
 * だから `FlavorSpec.extract`(フレーバーごと)ではなく、**保存経路で 1 回**
 * 呼ぶ独立の関数にする。フレーバーごとに書くと、書き忘れたフレーバーだけ
 * タグが効かない(§7 の型)。
 */
import { parseFrontmatter } from '@features/markdown/frontmatter';

/** 1 ノートのタグ数の上限。⚠ 上限が無いと、事故った本文が一覧を埋め尽くす。 */
export const MAX_TAGS = 32;
/** 1 タグの長さの上限(文字)。 */
export const MAX_TAG_CHARS = 40;

/**
 * タグを正規化する。⚠ **前後の空白を落とし、小文字化しない** ──
 * 日本語に大小は無く、英語のタグは user が書いたとおりに見せたい。
 * 突き合わせだけ `toLowerCase()` する(`sameTag`)。
 */
function normalize(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** 同じタグか(表示は原文、突き合わせは大小無視)。 */
export function sameTag(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * body の frontmatter からタグを読む。
 *
 * 受ける形は 2 つ ── **user がどちらで書いても通す**(記法を減らさない):
 * - 配列: `tags: [買い物, 家事]`
 * - 文字列: `tags: 買い物, 家事`(カンマ区切り)
 *
 * ⚠ 空・重複・長すぎるものは落とす。⚠ 順序は**書いた順**を保つ(並べ替えない ──
 * user が意味のある順に書いていることがある)。
 */
export function readTags(body: string): string[] {
  const { meta } = parseFrontmatter(body);
  const raw = meta.tags;
  if (raw === undefined || raw === null) return [];
  /**
   * ⚠ **空の要素は `null` で来る**(frontmatter の parser がそう返す)。
   * そのまま `String()` すると **`"null"` という名前のタグ**が生まれる
   * (test が捕まえた)── 値の無いものは先に落とす。
   */
  const parts: string[] = Array.isArray(raw)
    ? raw.filter((v) => v !== null && v !== undefined).map((v) => String(v))
    : String(raw).split(',');
  const out: string[] = [];
  for (const part of parts) {
    const t = normalize(part);
    if (t === '' || [...t].length > MAX_TAG_CHARS) continue;
    if (out.some((x) => sameTag(x, t))) continue;
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * 抽出列へ入れる形。⚠ **区切りは空白ではなく制御文字を避けた私用文字**にしない
 * ── SQL の LIKE で「タグの丸ごと一致」を引くために、**前後に区切りを付けた形**
 * (`|買い物|家事|`)にする。こうすると `%|買い物|%` が部分一致を誤爆しない
 * (`買い物リスト` というタグに `買い物` が当たらない)。
 * ⚠ タグ自体に `|` が含まれうるので、正規化で落とす。
 */
export const TAG_SEP = '|';

export function encodeTags(tags: readonly string[]): string {
  const safe = tags.map((t) => t.split(TAG_SEP).join(' ')).filter((t) => t !== '');
  return safe.length === 0 ? '' : TAG_SEP + safe.join(TAG_SEP) + TAG_SEP;
}

export function decodeTags(encoded: string | null): string[] {
  if (!encoded) return [];
  return encoded.split(TAG_SEP).filter((t) => t !== '');
}
