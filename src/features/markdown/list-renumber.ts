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
 * fenced code の開閉を 1 行ぶん進める。`fence` は開いている間だけ**開いた記号の並び**
 * (`` ``` `` / `` ```` `` / `~~~` …)、閉じていれば `''`。呼び側は「空か空でないか」だけ見ればよい。
 *
 * 🔑 **fence 追跡の正本はここ 1 か所**(§7)── 番号の振り直し・Enter でリストを続ける規則
 *   (`quote-assist.ts`)・追記の入り先と目次(`append-target.ts` / `markdown-toc.ts`)が
 *   **同じ判定**で「コードの中か」を決める。
 *   ⚠ 閉じは CommonMark どおり、**開いた記号と同じ種類で、同じ長さ以上の、記号だけの行**
 *   (中身のある行・短い記号・別の種類は閉じではない)。直す前は種類しか見ず、
 *   ```` ```` ````(4 つ)の中の ``` や、``` の中の `~~~` で閉じたことになり、後ろの見出しが消えた(#1087)。
 *   ⚠ 開きの行に ` ` ` が 2 つ目から混ざる(`` ```x``` ``)形は fence ではない(行内のコード)。
 */
export function advanceFence(fence: string, line: string): string {
  if (fence !== '') {
    // 🔑 引用の中で開いた fence は、返す記号の頭に `>` を深さぶん付けて覚える(`>>```` )。
    //   閉じは同じ深さの引用の中だけ。深さが浅い行(`>` が無い行 = 引用が終わった)は、
    //   fence ごと終わったものとして閉じる(閉じ忘れが文書の残りを飲まない)。
    let depth = 0;
    while (fence[depth] === '>') depth += 1;
    const mark = fence.slice(depth);
    const q = depth === 0 ? { depth: 0, rest: line } : unquoteLine(line);
    if (q.depth < depth) return '';
    if (q.depth > depth) return fence;
    const c = /^\s*(`{3,}|~{3,})\s*$/.exec(q.rest);
    return c !== null && c[1]![0] === mark[0] && c[1]!.length >= mark.length ? '' : fence;
  }
  // 開き。⚠ 引用(`> ````)・リストの項目(`- ````)の中の fence も fence である(#1087 M9)。
  //   これを見落とすと、中身の `%%…%%` `||` `__` `+++` が記法として食われる。
  const q = unquoteLine(line);
  let rest = q.rest;
  for (;;) {
    const l = LIST_LEAD.exec(rest);
    if (l === null) break;
    rest = rest.slice(l[0].length);
  }
  const o = /^\s*(`{3,}|~{3,})(.*)$/.exec(rest);
  if (o === null) return '';
  if (o[1]![0] === '`' && o[2]!.includes('`')) return '';
  return '>'.repeat(q.depth) + o[1]!;
}

/**
 * 字下げのコード(行頭 4 SP / タブ)を 1 行ぶん進める(#1087 M9)。fence の外の行だけを渡す。
 *
 * 🔑 CommonMark どおり、**空行の後(または文書の頭)で始まり、リストの中ではない**ものだけをコードとする。
 *   ⚠ 段落の続き(空行なしの 4 SP)・リストの項目の続き(`- a` + 空行 + 4 SP は項目の段落)は
 *   コードではない。リストの中かどうかは**迷ったらコードにしない側**へ倒す(誤って守るより、
 *   守らないほうが従来どおりで害が小さい)。
 */
export interface IndentState {
  /** 直前の行が空行(文書の頭も空行扱い) */
  blank: boolean;
  /** 直前までの塊がリストの項目(その続きの字下げはコードではない) */
  list: boolean;
  /** いま字下げのコードの続きの中 */
  code: boolean;
}

export const INDENT_START: IndentState = { blank: true, list: false, code: false };

export function advanceIndent(s: IndentState, line: string): { state: IndentState; code: boolean } {
  if (line.trim() === '') {
    // 空行はコードの続きを切らない(コードの中の空行)。空行そのものは「コードの行」に数えない
    return { state: { blank: true, list: s.list, code: s.code }, code: false };
  }
  if (/^(?: {4}|\t)/.test(line)) {
    const isCode = s.code || (s.blank && !s.list);
    return { state: { blank: false, list: s.list, code: isCode }, code: isCode };
  }
  // 字下げのない(または浅い)行 ── コードはここで終わる
  const item = LIST_LEAD.test(line);
  const shallow = /^\s/.test(line);
  const list = item ? true : s.blank && !shallow ? false : s.list;
  return { state: { blank: false, list, code: false }, code: false };
}

/** 行頭の `>` の連なりを剥がす(引用の深さと残り)。 */
function unquoteLine(line: string): { depth: number; rest: string } {
  const m = /^((?:\s*>)+ ?)(.*)$/.exec(line);
  if (m === null) return { depth: 0, rest: line };
  return { depth: (m[1]!.match(/>/g) ?? []).length, rest: m[2]! };
}

/**
 * 🔑 **リストの記号の読み取りの正本**(§7)── Enter で続ける規則(`quote-assist.ts`)と
 * 字下げの規則(`indent-assist.ts`)が**同じ綴り**で「リストの行か」を決める。
 * 行頭の字下げ・記号(`-` `*` `+` / `1.` `1)`)・記号の後ろの空白(必須)。
 */
export const LIST_LEAD = /^(\s*)([-*+]|\d+[.)])(\s+)/;

/** 水平線(`---` / `* * *`)。⚠ 記号と空白と中身に**見える**が、リストではない。 */
export const THEMATIC_BREAK = /^\s*([-*_])(?:\s*\1){2,}\s*$/;

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
  const counters = new Map<number, number>();
  let fence = '';
  const indentOf = (l: string): number => /^\s*/.exec(l)![0].length;
  /** 字下げが `w` 以上の段の数えを捨てる(その行は、それらの項目の中身ではない)。 */
  const dropFrom = (w: number): void => {
    for (const d of [...counters.keys()]) if (d >= w) counters.delete(d);
  };

  /** 直前の行が、リストの項目か、その項目に続く段落の行だったか(遅延継続の判定に使う)。 */
  let inItemParagraph = false;
  for (const line of lines) {
    const prevInItem = inItemParagraph;
    inItemParagraph = false;
    const nextFence = advanceFence(fence, line);
    if (fence !== '') {
      out.push(line);
      fence = nextFence;
      continue;
    }
    if (nextFence !== '') {
      fence = nextFence;
      out.push(line);
      // ⚠ 字下げの無いコードの塊はリストを**切る**(前後は別のリストである)。
      //   🔴 項目より深く字下げした塊は**その項目の一部**なので切らない(#1087)
      dropFrom(indentOf(line));
      continue;
    }

    const item = readItem(line);
    if (item === null) {
      // ⚠ 空行**だけ**では切らない(段落を挟んだ 1 つのリストが在る)が、
      //    実のある別の行が来たら切る
      //    🔴 ただし**項目より深く字下げした行**(入れ子の箇条書き・段落・画像)はその項目の中身で、
      //    項目の列を切らない(#1087)── 切るのは、その字下げ以下の段だけ
      // 🔴 **遅延継続**(CommonMark):項目の段落のすぐ下に字下げ無しで続けた行は、その項目の段落の続き(#1087)。
      //    ⚠ 見出し・引用・区切り線・箇条書きの記号で始まる行は段落を切るので、続きにしない
      const lazy =
        prevInItem &&
        line.trim() !== '' &&
        !/^\s*(?:#{1,6}(?:\s|$)|>|[-*+](?:\s|$)|(?:[-*_]\s*){3,}$)/.test(line);
      if (lazy) inItemParagraph = true;
      else if (line.trim() !== '') dropFrom(indentOf(line));
      out.push(line);
      continue;
    }

    const depth = item.indent.length;
    // ⚠ 深い段から浅い段へ戻ったら、深い側の数えは捨てる(戻って続けない)
    for (const d of [...counters.keys()]) if (d > depth) counters.delete(d);
    const n = mode === 'uniform' ? 1 : (counters.get(depth) ?? 0) + 1;
    counters.set(depth, (counters.get(depth) ?? 0) + 1);
    out.push(`${item.indent}${n}${item.sep}${item.rest}`);
    inItemParagraph = true;
  }
  return out.join(eol);
}

/**
 * 本文に番号付きの項目が 1 つでも在るか。⚠ 読み方は `renumberLists` と同じ
 * (fence の中は数えない)── 「無いから変わらなかった」と「揃っているから変わらなかった」を言い分ける。
 */
export function hasNumberedItems(body: string): boolean {
  if (body === '' || !/\d+[.)]/.test(body)) return false;
  let fence = '';
  for (const line of body.split(/\r?\n/)) {
    const nextFence = advanceFence(fence, line);
    if (fence !== '' || nextFence !== '') {
      fence = nextFence;
      continue;
    }
    if (readItem(line) !== null) return true;
  }
  return false;
}
