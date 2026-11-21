/**
 * 🔴 **探す欄の色ラベルの語**(#1982 段 4 の残り)。`色:緑` / `label:green` / `color:3`(全角のコロンも可)。
 *
 * - 空白で区切った語のうち、`色:` / `label:` / `color:` で始まり名前が読める語を色の条件として取り出す(残りがふつうの語)。
 * - 名前が読めない語(`色:あ`)はふつうの語のまま探す(黙って捨てない)。
 * - 色の名前の表は `note-label.ts` の `noteLabelColorOf` 1 本。複数の色の語は AND(同時に満たせないので 0 件)。
 * - 🔴 判定はここ 1 か所 ── 一覧の絞り込み(`matchesEntry`)・本文検索へ渡す字(`store-effects`)・スマートフォルダが同じ関数を読む。
 *
 * 🔑 pure module。
 */
import { noteLabelColorOf } from '../note-label';

const TERM = /^(?:色|label|color)[:：](.+)$/i;

export interface LabelQuerySplit {
  /** 色の語を除いた残りの問い合わせ(空白は 1 つへ畳む)。 */
  readonly rest: string;
  /** 取り出した色(番号)。重複は 1 つへ。 */
  readonly colors: readonly number[];
}

export function splitLabelQuery(query: string): LabelQuerySplit {
  const colors: number[] = [];
  const rest: string[] = [];
  for (const w of query.normalize('NFKC').split(/\s+/)) {
    if (w === '') continue;
    const m = TERM.exec(w);
    const c = m === null ? null : noteLabelColorOf(m[1]!);
    if (c === null) rest.push(w);
    else if (!colors.includes(c)) colors.push(c);
  }
  return { rest: rest.join(' '), colors };
}
