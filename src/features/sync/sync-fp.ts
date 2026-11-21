/**
 * 🔴 **端末間の同期(#2000)段 2 ── 指紋の作り方(1 か所)**。
 *
 * 書き出す側・取り込む側・worker の現在の状態の測り方が**同じ関数**を通る(別々に書くと、同じノートの指紋が食い違って
 * 「変わっていないのに変更」が出る)。材料と正規化は `change-set.ts` の `entryFingerprintTexts`、ハッシュは `sha256.ts`。
 * ⚠ pure module。
 */
import { entryFingerprintTexts, relationFingerprintText, type EntryFacet, type Fp } from './change-set';
import { sha256Hex } from './sha256';

/** ノートの指紋(内容 + 親フォルダの 2 欄)。 */
export function entryFp(facet: EntryFacet): Fp {
  const t = entryFingerprintTexts(facet);
  return { content: sha256Hex(t.content), place: sha256Hex(t.place) };
}

/** 親フォルダの欄だけの指紋(取り込みで宛先が無く、ルートへ置いたときの欄の値に使う)。 */
export function placeFp(parentLid: string | null): string {
  return sha256Hex(entryFingerprintTexts({ title: '', archetype: '', parentLid, body: '' }).place);
}

/** つながりの指紋(定数)。 */
export function relationFp(): Fp {
  return { content: sha256Hex(relationFingerprintText()) };
}
