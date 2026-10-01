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

/**
 * fenced code の開閉を 1 行ぶん進める。`fence` は開いている間だけ記号(`` ` `` か `~`)、
 * 閉じていれば `''`。
 *
 * 🔑 **fence 追跡の正本はここ 1 か所**(§7)── 番号の振り直しと、Enter でリストを
 *   続ける規則(`quote-assist.ts`)が**同じ判定**で「コードの中か」を決める。
 *   ⚠ 閉じは**開いた記号と同じ種類で、記号だけの行**(中身のある行は閉じではない)。
 */
export function advanceFence(fence: string, line: string): string {
  const m = /^\s*([`~]{3,})/.exec(line);
  if (fence !== '') {
    return m && m[1]![0] === fence && /^\s*[`~]{3,}\s*$/.test(line) ? '' : fence;
  }
  return m ? m[1]![0]! : '';
}

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
  // 🔴 高速化: 番号付きリストの記号が本文に無ければ、行配列化・走査を行わずに即時脱出 (#1110)
  if (body === '' || !/\d+[.)]/.test(body)) return body;

  const isCrlf = body.includes('\r\n');
  const eol = isCrlf ? '\r\n' : '\n';
  const lines = isCrlf ? body.split('\r\n') : body.split('\n');
  const out: string[] = [];
  /** 字下げの幅 → 次に振る番号。⚠ 深い段から抜けたら捨てる。 */
  let counters = new Map<number, number>();
  let fence = '';

  for (const line of lines) {
    const nextFence = advanceFence(fence, line);
    if (fence !== '') {
      out.push(line);
      fence = nextFence;
      continue;
    }
    if (nextFence !== '') {
      fence = nextFence;
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
  return out.join(eol);
}
