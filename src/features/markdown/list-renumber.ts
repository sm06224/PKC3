/**
 * 🔴 **番号付きリストの番号を振り直す**(#396、PKC2 領域 6 の移植)。
 *
 * ## user がやりたいこと
 *
 * 番号付きリストの**途中に 1 行挿した**ら、その後ろの番号が全部ずれる。
 * ⚠ 手で振り直すのは、10 項目なら 9 回の書き換えである。
 *
 * ## ⚠ PKC2 の形はそのまま持ち込まない
 *
 * PKC2 は frontmatter(`extractListNumberMode`)で**常時かかる設定**にしていた。
 * 🔑 PKC3 は**明示の 1 手**(押したときだけ)にする ── 理由は編集モデルである:
 * PKC3 のライブエディタは**行ごとに欄を出す**ので、1 行打つたびに全文の番号を
 * 書き換えると、**触っていない行が勝手に変わる**(しかも別の窓が書いていたら
 * それを踏む)。⚠ 常時かける設計は、この編集モデルと噛み合わない。
 *
 * ## 数え方
 *
 * - **続き**(`sequential`): `1. 2. 3.` ── 読んだとおりの番号
 * - **全部 1**(`uniform`): `1. 1. 1.` ── ⚠ 途中に挿しても**差分が汚れない**
 *   (markdown は描画時に数え直すので、見た目は同じ)
 *
 * ⚠ **入れ子は段ごとに数える**(字下げが深くなったら 1 から)。
 * ⚠ **空行や別の塊で切れたら数え直す** ── 離れた 2 つのリストは別物である。
 * ⚠ **fence の中は 1 バイトも触らない**(コードの中の `1.` はコードである)。
 *
 * 🔑 **pure module**。
 */

export type ListNumberMode = 'sequential' | 'uniform';

/** `  3. 中身` を読む。番号付きの項目でなければ `null`。 */
function readItem(line: string): { indent: string; sep: string; rest: string } | null {
  const m = /^(\s*)\d+([.)])(\s+.*)$/.exec(line);
  return m === null ? null : { indent: m[1]!, sep: m[2]!, rest: m[3]! };
}

/**
 * 本文の番号付きリストを振り直す。
 *
 * @returns 振り直した本文。⚠ 番号付きリストが 1 つも無ければ**元のまま**
 */
export function renumberLists(body: string, mode: ListNumberMode = 'sequential'): string {
  const lines = body.split('\n');
  const out: string[] = [];
  /** 字下げの幅 → 次に振る番号。⚠ 深い段から抜けたら捨てる。 */
  let counters = new Map<number, number>();
  let fence = '';

  for (const line of lines) {
    const fenceM = /^\s*([`~]{3,})/.exec(line);
    if (fence !== '') {
      out.push(line);
      if (fenceM && fenceM[1]![0] === fence && /^\s*[`~]{3,}\s*$/.test(line)) fence = '';
      continue;
    }
    if (fenceM) {
      fence = fenceM[1]![0]!;
      out.push(line);
      // ⚠ コードの塊はリストを**切る**(前後は別のリストである)
      counters = new Map();
      continue;
    }

    const item = readItem(line);
    if (item === null) {
      // ⚠ 空行**だけ**では切らない(段落を挟んだ 1 つのリストが在る)が、
      //    実のある別の行が来たら切る
      if (line.trim() !== '') counters = new Map();
      out.push(line);
      continue;
    }

    const depth = item.indent.length;
    // ⚠ 深い段から浅い段へ戻ったら、深い側の数えは捨てる(戻って続けない)
    for (const d of [...counters.keys()]) if (d > depth) counters.delete(d);
    const n = mode === 'uniform' ? 1 : (counters.get(depth) ?? 0) + 1;
    counters.set(depth, (counters.get(depth) ?? 0) + 1);
    out.push(`${item.indent}${n}${item.sep}${item.rest}`);
  }
  return out.join('\n');
}
