/**
 * 🔴 **探す欄の色ラベルの語**(#1982 段 4 の残り)。`色:緑` / `label:green` / `color:3`(全角のコロンも可)。
 *
 * - 空白で区切った語のうち、`色:` / `label:` / `color:` で始まり名前が読める語を色の条件として取り出す(残りがふつうの語)。
 * - 名前が読めない語(`色:あ` / `label:foo`)はふつうの語のまま探す(黙って捨てない)。
 * - 🔴 **字そのものを探したいときは引用符で囲む**(`"label:green"` → 引用符を外した `label:green` を探す)。
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
  let changed = false;
  // 🔴 語の区切りと取り出しは**元の字**の上で行う(`normalize` は色の語かどうかを見分けるときだけ ──
  //   残りの語は 1 字も変えない。`①` `㈱` が `1` `(株)` に化けて別の語を探すのを避ける)
  for (const m of query.matchAll(/\S+/g)) {
    const w = m[0];
    const norm = w.normalize('NFKC');
    // 🔴 引用符で囲んだ色の語(`"label:green"`)は、色ではなく字そのもの(引用符を外した字)を探す
    if (norm.length >= 2 && norm.startsWith('"') && norm.endsWith('"') && colorOf(norm.slice(1, -1)) !== null) {
      rest.push(w.slice(1, -1));
      changed = true;
      continue;
    }
    const c = colorOf(norm);
    if (c === null) rest.push(w);
    else {
      changed = true;
      if (!colors.includes(c)) colors.push(c);
    }
  }
  // 変えた物が無ければ、問い合わせはそのまま返す(空白の畳みも含めて触らない)
  return { rest: changed ? rest.join(' ') : query, colors };
}

function colorOf(token: string): number | null {
  const m = TERM.exec(token);
  return m === null ? null : noteLabelColorOf(m[1]!);
}
