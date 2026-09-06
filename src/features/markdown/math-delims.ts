/**
 * 🔴 **数式の区切り(`$…$` / `$$…$$`)の判定**(#707。user 裁定 2026-09-06「入れる」)。
 *
 * ## なぜ 1 file に切り出すか
 *
 * ⚠ **開きと閉じは別の判定**である ── #707 のコメントに「`$` の直後が `{` なら
 * 開きと読まない」と書いたが、**それは開きしか塞いでいなかった**:
 *
 * ```
 * 料金は $100 です。${宛名} 様。
 *        └─ 開き候補 ─┘   ここが「閉じ」になり「100 です。」が数式になる
 * ```
 *
 * ⚠ `${宛名}` は雛形の差し込みが**わざと本文に残す印**である
 * (`snippet-expand.ts` ── 剥がして位置を覚えると、user が 1 文字打つたびに
 * その位置が全部ずれるため)。つまり**雛形を使う人の本文にだけ出る**
 * = いちばん再現報告が来にくい形だった。
 *
 * 🔑 だから判定を**ここ 1 か所**に置き、開き・閉じの両方をここで書く
 * (CLAUDE.md §7「同じ問いに答える口を 2 つ作らない」)。
 *
 * ## 規則(pandoc と同じ形 + この repo 固有の門 1 つ)
 *
 * | | 数式にしない条件 |
 * |---|---|
 * | **開き `$`** | 直前が `\`(逃がし)/ 直後が空白 / 直後が数字(`$100`)/ 🔴 **直後が `{`**(`${date}`) |
 * | **閉じ `$`** | 直前が `\` / 直前が空白 / 直後が数字(`$5 と $10`)/ 🔴 **直後が `{`** |
 * | 中身 | 空 / 改行を含む |
 *
 * ⚠ **`{` の門はこの repo 固有**である ── 差し込みの記法(`${…}`)が在るのは
 * PKC だけなので、pandoc の規則をそのまま持ってくると 9 件当たる(実測 2026-09-06)。
 * 🔴 そして **`{` は開きと閉じの両方に要る** ── 1 稿目は開きだけに置いて
 * `残りは $x です。${宛名} 様。` を数式にしていた。**`${` の `$` は区切りではない。**
 *
 * ⚠ コード(`` `$X$` ``)と fence の中は**ここでは見ない** ── markdown-it が
 * code を先に tokenize するので、inline rule には届かない(`markdown-render.ts`
 * の L-2 のコメントが「自然な escape」と書いている当のもの)。
 * 🔑 だから**前処理で置換してはいけない**(置換すると、その守りを自分で捨てる)。
 */

/** 空白(改行を含む)か。 */
function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

/** 数字か。 */
function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

/**
 * `\` で逃がされているか。
 * ⚠ **`\` の数を数える** ── `\\$` は「逃がした `\`」+「素の `$`」なので、
 *   `$` は逃げていない(直前 1 文字だけ見ると取り違える)。
 */
export function isEscaped(src: string, i: number): boolean {
  let n = 0;
  for (let k = i - 1; k >= 0 && src[k] === '\\'; k--) n++;
  return n % 2 === 1;
}

/**
 * 位置 `i` の `$` が**開き**として使えるか。
 * ⚠ `$$` の 2 文字目は開きにしない(呼び側が `$$` として扱う)。
 */
export function opensMath(src: string, i: number): boolean {
  if (src[i] !== '$') return false;
  if (isEscaped(src, i)) return false;
  const next = src[i + 1];
  if (isSpace(next)) return false;
  // 🔴 差し込みの記法(`${date}` / `${宛名}`)を飲まない ── この repo 固有の門
  if (next === '{') return false;
  // 金額(`$100`)を開きにしない
  if (isDigit(next)) return false;
  return true;
}

/**
 * 位置 `i` の `$` が**閉じ**として使えるか。
 * 🔴 **開きと同じ条件ではない**(ここを共通化すると `${…}` の穴が戻る)。
 */
export function closesMath(src: string, i: number): boolean {
  if (src[i] !== '$') return false;
  if (isEscaped(src, i)) return false;
  if (isSpace(src[i - 1])) return false;
  const next = src[i + 1];
  // 🔴 **差し込みの記法は「閉じ」にもさせない**(着地前調査 2026-09-06)。
  //    ⚠ 開き側だけ塞いだ 1 稿目は `残りは $x です。${宛名} 様。` で
  //    `x です。` を数式にしていた ── **`${` の `$` は区切りではない**、が正しい。
  if (next === '{') return false;
  // 金額(`$5 と $10`)の 2 つ目を閉じにしない
  if (isDigit(next)) return false;
  return true;
}

/** 見つかった数式の範囲(`src` の添字)。 */
export interface MathSpan {
  /** 中身の開始(区切りの直後)。 */
  from: number;
  /** 中身の終わり(区切りの直前、この添字は含まない)。 */
  to: number;
  /** 区切りの終わり(次に読む位置)。 */
  end: number;
  /** `$$…$$` なら true(段落の途中に書かれた形。行内へ降ろす)。 */
  display: boolean;
}

/**
 * `start` から始まる数式を 1 つ読む。読めなければ `null`。
 *
 * ⚠ **改行を跨がない**(`markdown-render.ts` の inline rule 全部の作法)。
 * ⚠ `posMax` は markdown-it の inline state のもの ── そこを超えて読まない。
 */
export function readMathAt(src: string, start: number, posMax: number): MathSpan | null {
  if (src[start] !== '$') return null;
  if (isEscaped(src, start)) return null;
  const display = src[start + 1] === '$';
  const dl = display ? 2 : 1;
  const from = start + dl;
  if (display) {
    // ⚠ `$$` は「直後が空白」を許す(`$$ x $$` と書く人が居る)。
    //    ⚠ ただし `${` の門は**開きの直後**を見るので、`$$` では効かない
    //    ── 2 文字目が `$` である時点で差し込みの記法ではありえない。
    if (isEscaped(src, start + 1)) return null;
  } else if (!opensMath(src, start)) {
    return null;
  }
  for (let i = from; i < posMax; i++) {
    const ch = src[i];
    if (ch === '\n') return null; // 改行を跨がない
    if (ch !== '$') continue;
    if (isEscaped(src, i)) continue;
    if (display) {
      if (src[i + 1] !== '$') continue;
      if (i === from) return null; // 中身が空
      return { from, to: i, end: i + 2, display: true };
    }
    if (!closesMath(src, i)) continue;
    if (i === from) return null; // 中身が空
    return { from, to: i, end: i + 1, display: false };
  }
  return null;
}
