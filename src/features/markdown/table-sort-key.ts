/**
 * 🔴 **表の並べ替えで「数として読むか」の規則**(#1150 / #1087)── 読む面(`adapter/ui/render/table-sort.ts`)と、
 *   書き出した HTML の閲覧側(`features/export/pkc3-html.ts`。#1163 依頼 223)が**同じ 1 本**を使う。
 * ⚠ 書き出した HTML は閲覧側の小さなスクリプトで並べ替えるので、規則を書き写すと必ずずれる ── 正規表現の字は
 *   ここから渡す({@link PLAIN_DECIMAL} / {@link MINUS_LIKE})。
 */

/** マイナスに見える字(NFKC でも `-` にならない)。 */
export const MINUS_LIKE = /[\u2212\u2010-\u2015\uFE63]/g;

/** ソート可能な値の判別結果。 */
export interface ComparableValue {
  readonly num: number;
  readonly isNum: boolean;
  readonly str: string;
}

/** 符号 / 通貨記号 / 数字(桁区切り可)と小数部 / 末尾の円か % ── これ以外は数ではない。 */
export const PLAIN_DECIMAL =
  /^\s*(?:([+-])\s*)?(?:[¥$€£]\s*(?:([+-])\s*)?)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)\s*[円%]?\s*$/;

/**
 * セル文字列から数値と文字列を判別する。
 * カンマ区切り数値、通貨記号、パーセントなどを安全に解析する。
 */
export function parseComparable(raw: string): ComparableValue {
  const str = raw.trim();
  if (str === '') {
    return { num: NaN, isNum: false, str: '' };
  }
  /**
   * 🔴 **全角を半角へ寄せてから、素直な 10 進数だけを数と読む**(#1087)。
   * - 全角の数字・通貨記号・カンマ・% は NFKC で半角になる。⚠ マイナス記号 U+2212 は
   *   NFKC では動かないので自分で `-` にする。
   * - ⚠ `Number()` に任せない ── `0x1F` / `1e3` / `12E5` が数になり、**部品番号が数として
   *   並ぶ**(`12E5` が 1200000 になる)。許すのは「符号・桁区切りの付いた数字・小数部・
   *   先頭の通貨記号・末尾の `円` / `%`」だけ。
   */
  const half = str
    .normalize('NFKC')
    .replace(MINUS_LIKE, '-');
  const m = PLAIN_DECIMAL.exec(half);
  const num = m === null ? NaN : Number(`${m[1] ?? m[2] ?? ''}${(m[3] ?? '').replace(/,/g, '')}`);
  const isNum = m !== null && isFinite(num);
  return { num, isNum, str };
}

