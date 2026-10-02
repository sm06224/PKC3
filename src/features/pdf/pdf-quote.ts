/**
 * PDF の窓で選んだ字を、ノートへ**引く**(#275 段①)── 純粋な規則だけ。
 *
 * 🔑 窓(`public/pdf/`)は text と頁番号を**放送で送るだけ**で、ノートへ書くのは本体側である
 * (sqlite の行を書けるのは writer リースを持つタブだけ)。ここは本体側が使う 2 つの規則:
 * ①どのノートへ引くか ②どんな形で書くか。
 */
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import { STRUCTURAL } from '@features/relation/kinds';
import { isAppendable } from '@features/flavor/append-spec';

/**
 * 1 回に引ける字の上限(byte。UTF-8)。
 * ⚠ 放送は structured clone で丸ごと複製される ── 長い字を黙って通すと、選び間違いの
 *   全選択(数 MB)がそのまま本体へ飛んでノートへ書かれる。
 */
export const PDF_QUOTE_MAX_BYTES = 64 * 1024;

/** 超過したときの断り。⚠ 窓にも本体にも同じ字を出す(綴りを 2 か所に持たない)。 */
export const PDF_QUOTE_TOO_LONG = '選んだ字が長すぎます(64KB まで)。短く選び直してください';

/** UTF-8 での長さ。⚠ `TextEncoder` に頼らない(features は環境に依らず同じ答えを返す)。 */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      // 対になった上位・下位サロゲートは 4 byte(下位を飛ばす)
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i += 1;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** 制御文字を落とす(改行と tab は残す)。⚠ 正規表現に生の制御文字を書かない。 */
function stripControls(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    const keep = c === 0x09 || c === 0x0a || (c >= 0x20 && c !== 0x7f);
    if (keep) out += s[i];
  }
  return out;
}

/**
 * 引用の形に整える。`null` = 引くものが無い(空 / 空白だけ)。
 *
 * 形(複数行の選びは各行に `> `。出典は**最後の行の末尾**):
 *
 *     > 選んだ字(1 行目)
 *     > 選んだ字(2 行目) (p.3、報告書.pdf)
 *
 * ⚠ 頁番号は**必須** ── 出典を落とすと、後から原典へ戻る手がかりが無くなる。
 */
export function formatPdfQuote(text: string, page: number, name: string): string | null {
  const lines = stripControls(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length === 0) return null;
  const p = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  const from = stripControls(name).replace(/\s+/g, ' ').trim();
  const cite = from === '' ? `(p.${String(p)})` : `(p.${String(p)}、${from})`;
  lines[lines.length - 1] = `${lines[lines.length - 1]} ${cite}`;
  return lines.map((l) => `> ${l}`).join('\n');
}

/**
 * 引く先のノート。
 *
 * - 添付に**結びついたノート**があればそれ(意味の関係 / 分類 / 時系列 / 出典のどれか。
 *   居場所(フォルダ)は結びつきではないので数えない)。⚠ 追記できる種類(ノート・ログ)だけ ──
 *   フォルダや別の添付へは足せない。複数あれば**関係の並びが先のもの**。
 * - 無ければ**添付のノート自身**(説明文の末尾へ足す)。
 */
export function resolveQuoteTarget(
  attachmentLid: string,
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): string {
  for (const r of relations) {
    if (r.kind === STRUCTURAL) continue;
    const other =
      r.fromLid === attachmentLid ? r.toLid : r.toLid === attachmentLid ? r.fromLid : null;
    if (other === null || other === attachmentLid) continue;
    if (isAppendable(metas.get(other)?.archetype)) return other;
  }
  return attachmentLid;
}
