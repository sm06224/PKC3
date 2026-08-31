/**
 * 🔴 **本文の構造化書換を 1 本にする**(#276 / #277)。
 *
 * ## なぜ 1 本にするか
 *
 * frontmatter の鍵を書く(カレンダーの日付 / todo の状態)のも、チェックの印を
 * 付け外しするのも、**「読む → 原文を splice → 書く」**という同じ手順である。
 * ⚠ 経路を分けると、直列 queue・唯一の抽出経路・未達 commit との合流という
 *   **書込の作法が 2 つに割れる**(CLAUDE.md §7)。実際 2026-08-19 の 1 日で
 *   同じ形の要求が 3 つ(状態 / 日付 / チェック)出た。
 *
 * 🔑 **pure module**。ここは「どう書き換えるか」だけを決め、いつ・誰が書くかは
 *   effect 層が持つ。⚠ 純関数なので unit で全部試せる。
 */
import { spliceFrontmatterKeys, type FrontmatterValue } from './frontmatter';
import { formatLineDate, insertionForLineDate, readLineDate } from '../schedule/line-date';
import { isScheduleDate } from '../schedule/schedule-date';
import type { RepeatUnit } from '../schedule/repeat';
import { removeInsertedLines } from './append-target';
import { movePlace } from './place-notation';
import { readTags, withTag } from '../flavor/tags';
import { acceptsExternalImage, rewriteAdopted } from '../asset/inline-url-adopt';
import { DELIMITER, csvEscapeField, parseCsv, type CsvPositions } from './csv-table';
import { parseRenderableFence } from './markdown-render';
import { scanContainers } from './source-blocks';

/** 何をするか。⚠ **やり直せる形で持つ**(未達 commit との合流に要る)。 */
export type BodyRewrite =
  | {
      /**
       * 🔴 **タグを 1 つ足す / 外す**(#402 ①)。
       *
       * > user の物語: フォルダで 12 件選んだ。全部に `#請求済` を付けたい。
       *
       * ⚠ **本文を読んでから書く**必要があるので、面が自分で組まずにここへ寄せる
       *   ── 書込は `REQUEST_BODY_REWRITE` の 1 本を通る(§7)。
       * 🔴 **双方向**(user 指示 2026-08-23)── `add` があるなら `remove` も要る。
       *   付けるだけだと、12 件に間違えて付けたものを 12 回開いて消すことになる。
       */
      kind: 'tag';
      /**
       * 🔴 **並びで受ける**(#637。着地前の動線レビューで判明)。
       *
       * ⚠ 直す前は `tag: string` で、`#買い物 #家事` は **2 回に分けて撃って**いた。
       *   書き込みは正しく届くが、**知らせが 1 通ずつ出て後の 1 通が前を塗り潰す**
       *   ── 12 件に「請求」が付いたのに、画面に残るのは
       *   「0 件に付けました / 12 件は既に付いていました」(= 2 つ目のタグの話)だった。
       * 🔑 **1 回の頼みは 1 回で答える** ── 並びをここまで運べば、
       *   読み書きも 1 往復で済み、知らせも 1 通で全部を語れる(§7)。
       */
      tags: readonly string[];
      mode: 'add' | 'remove';
    }
  | {
      /**
       * 🔴 **追記を取り消す**(#395 段①。user 指示 2026-08-23
       * 「**片道の操作を作らない**」)。
       *
       * ⚠ **行番号を持たない** ── 追記のあとに別の窓が上へ足していれば番号はずれる。
       *   持つのは**足した行そのもの**で、それが在る所だけを消す
       *   (`removeInsertedLines`)。
       * ⚠ 見つからなければ `applyBodyRewrite` が `null` を返す = **断る**
       *   ── 「取り消したつもりで別の行が消えた」を作らない。
       */
      kind: 'undo-append';
      lines: readonly string[];
    }
  | {
      kind: 'frontmatter';
      /** ⚠ `undefined` はその鍵を**消す**(`spliceFrontmatterKeys` の作法)。 */
      keys: Record<string, FrontmatterValue | undefined>;
    }
  | {
      /** チェックの印を反転する。`line` は**原文の行番号**(0 始まり)。 */
      kind: 'task';
      line: number;
    }
  | {
      /**
       * 🔴 **板の塊を動かす**(#283 P4-b)── `.pkc-place` の format 開き行の
       * x= / y= だけを書き換える。
       *
       * ⚠ `line` は**原文の行番号**(0 始まり。描画が焼く `data-pkc-source-line` +
       *   frontmatter ぶん ── `task` と同じ座標系)。掴んだ時点の**開き行そのもの**を
       *   添え、disk 側で byte 一致しなければ書かない(`undo-append` の
       *   「足した行そのものを持つ」と同じ作法)。規則の実体は `place-notation.ts`(pure)。
       */
      kind: 'place-move';
      line: number;
      openLine: string;
      x: number;
      y: number;
    }
  | {
      /**
       * 🔴 **表のセルを 1 つ書き換える**(#418 段①)。
       *
       * > user の物語: 「表」を作って A1 に「品名」と打ちたい。押したら
       * > **CSV の原文**が出て、どのカンマが A1 かを目で数えることになっていた。
       *
       * ⚠ `line` は**原文の行番号**(0 始まり)、`col` はその行の中の**何番目のセルか**。
       * 🔑 **書き換えるのはそのセルの範囲だけ** ── 行を組み直すと
       *   `"a"` が `a` になるなど、**触っていないセルの字が黙って変わる**
       *   (`kind: 'task'` が「印の 1 文字だけ」を書き換えるのと同じ作法)。
       * 🔴 **双方向**(user 指示 2026-08-23)── 空の字を渡せば**セルを空にできる**。
       *   打てるだけだと、間違えて打った字を原文まで開かないと戻せない。
       */
      kind: 'csv-cell';
      line: number;
      col: number;
      value: string;
    }
  | {
      /**
       * 🔴 **表の行・列を足す / 消す**(#418 段①)。
       *
       * 🔑 **打てるだけでは動線が元に戻る** ── 5 列で足りなくなった瞬間に
       *   CSV の原文へ帰ることになる。⚠ そして user 指示 2026-08-23
       *   「**片道の操作を作らない**」に従い、足せるなら**消せる**。
       * ⚠ `line` / `col` は**押した所**(行を足すならその行の下、列を足すならその列の右)。
       * ⚠ **最後の 1 行 / 1 列は消さない** ── 消すと表そのものが消えて、
       *   user は CSV の原文に放り出される(戻す口が無くなる)。
       */
      kind: 'csv-shape';
      line: number;
      col: number;
      what: 'row' | 'col';
      mode: 'add' | 'remove';
    }
  | {
      /**
       * 🔴 **その行の日付を書き換える**(user 指示 2026-08-23「**なんで双方向に
       * する発想がでねぇんだよ**」)。
       *
       * ⚠ 1 稿目の設計は「予定は本文に書く。**面はそれを映すだけ**」だったが、
       *   **面から書けなくする理由がどこにも無かった** ── しかも同じ面の
       *   **チェックの印は既に本文へ書いている**(`kind: 'task'`)。
       *   日付だけ読み取り専用にする理屈は無い。
       * 🔑 正本が本文であるとは「**面が別のデータを持たない**」ということであって、
       *   「面が書かない」ということではない。
       *
       * ⚠ `date: null` は**日付を外す**(「日付なし」へ落とす)。
       */
      kind: 'line-date';
      line: number;
      date: string | null;
      /** ⚠ `date` が `null` なら無視される。⚠ `until` が在るときも無視される(期間に時刻は無い)。 */
      time?: string | null;
      /**
       * 🔴 **期間の終わり**(#344 段①)。単日にするなら渡さないか `null`。
       * ⚠ `date` が `null`(= 日付を外す)なら無視される。
       */
      until?: string | null;
      /**
       * 🔴 **刻み**(#344 段②)。⚠ **渡さなければ元の刻みを保つ** ── 日付だけ
       *   動かしたつもりで `毎週` が黙って消えたら、それは user が頼んでいない変更である。
       *   はっきり `null` を渡したときだけ外す。
       */
      repeat?: RepeatUnit | null;
    }
  | {
      /**
       * 🔴 **繰り返しの「その回」を、本文の実体の行にする**(#344 段②)。
       *
       * ⚠ 規則の行(`- [ ] ゴミ出し @2026-08-31 毎週`)の印は**押さない** ──
       *   押すと「この繰り返しは終わり」の意味になり、**以後の回が全部消える**。
       * 🔑 代わりに**その日ぶんの行を 1 本増やす**(`- [x] ゴミ出し @2026-09-07`)。
       *   ⚠ こうすると例外日の記法が要らない ── 実体の行が在る日は、
       *   束ねる側が**その日を飛ばす**(`materializedDates`)。
       * ⚠ そして**外せる**:増えた行は普通のチェック項目なので、
       *   もう一度押せば印が外れる(片道の操作を作らない ── user 指示 2026-08-23)。
       */
      kind: 'repeat-done';
      line: number;
      /** どの回か(`YYYY-MM-DD`)。⚠ 規則の行の日付ではない。 */
      date: string;
    }
  | {
      /**
       * 🔴 **外部の画像を手元の添付へ差し替える**(#264 段①)。
       *
       * ⚠ **行番号を持たない** ── 取りに行っている間に別の窓が行を足していれば
       *   番号はずれる。持つのは **`url → asset:<key>` の対応**で、
       *   `link-scan` が**いま disk に在る本文**から同じ宛先を探して当てる。
       * 🔴 **当てるのは画像だけ**(`acceptsExternalImage`)── 同じ URL を
       *   `[記事](https://…)` とリンクでも書いていたら、そちらは**触らない**
       *   (押していないのに、リンクが添付のダウンロード導線に化ける)。
       * ⚠ 1 件も当たらなければ `null` = **断る**(effect が「本文が変わっている」と言う)。
       */
      kind: 'adopt-images';
      /** ⚠ `Map` ではなく素の record ── event に載るので、比べやすい形にする。 */
      adopted: Readonly<Record<string, string>>;
    };

/**
 * チェック項目の行かどうか。
 *
 * 🔑 **箇条書きの印 + `[ ]` / `[x]`** で見る(markdown-it の task 規則と同じ形)。
 * ⚠ 行番号は**描いた時の原文**のものなので、書き換わっていれば当たらない ──
 *   だから「当たらなかったら `null`」で返し、**当てずっぽうで別の行を書き換えない**。
 *
 * 🔴 **引用(`>`)の前置きも受ける**(2026-08-19 のレビューで判明した穴)。
 *
 * ⚠ 直す前は前置きを見ておらず、**`> - [ ] やること` は札に出るのに押しても
 *   書き換わらなかった** ── 数える側(`task-count.ts` の `QUOTE`)は引用を剥がして
 *   から判定するのに、書き換える側だけが剥がしていなかった(§7「同じ判定が 2 か所」)。
 * ⚠ 症状は**いちばん質が悪い形**だった:ブラウザが印を付ける → 本文は変わらない →
 *   帯に「本文が変わっているため反映できませんでした(開き直してください)」という
 *   **嘘の理由**が出る → 開き直しても永久に直らない。
 *   `markdown-render.ts` が明文で禁じている「押せるのに本文が変わらない」そのもの。
 * 🔑 前置きは `m[1]` にまとめて入るので、印の位置(`m[1].length + 1`)は自然に追従する。
 *   parity は `tests/features/task-count.test.ts`「札に出た行は必ず書き換えられる」が守る。
 */
const TASK_LINE = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](\s|$)/;

/**
 * 書き換える。⚠ **できなければ `null`**(呼び側が「何も起きなかった」を
 * user に言えるようにする ── 黙って別の行を書き換えない)。
 */
export function applyBodyRewrite(body: string, rewrite: BodyRewrite): string | null {
  if (rewrite.kind === 'frontmatter') {
    const next = spliceFrontmatterKeys(body, rewrite.keys);
    return next === body ? null : next;
  }
  if (rewrite.kind === 'line-date') return rewriteLineDate(body, rewrite);
  if (rewrite.kind === 'undo-append') return removeInsertedLines(body, rewrite.lines);
  if (rewrite.kind === 'tag') {
    /**
     * ⚠ **読む規則も書く規則も既存の 1 本**(`readTags` / `withTag` /
     *   `spliceFrontmatterKeys`)── ここで 2 本目を書かない。
     * ⚠ 変わらないとき(既に在る / 元から無い)は `null` ── 呼び側が
     *   「書かない」を選べる(同じ本文を書き直して更新日時だけ動かさない)。
     */
    /**
     * ⚠ **並びは畳む**(#637)── 途中の 1 つが `null`(既に在る / 元から無い)でも
     *   止めない。1 つでも動いたら書く、1 つも動かなければ `null`。
     */
    let cur = readTags(body);
    let moved = false;
    for (const tag of rewrite.tags) {
      const next = withTag(cur, tag, rewrite.mode);
      if (next === null) continue;
      cur = next;
      moved = true;
    }
    if (!moved) return null;
    const next = cur;
    // ⚠ 空になったら **鍵ごと消す**(`tags: []` を残さない ── 読み手が
    //    「空のタグが 1 つ在る」と読む形を作らない)
    return spliceFrontmatterKeys(body, { tags: next.length === 0 ? undefined : next });
  }
  if (rewrite.kind === 'repeat-done') return materializeRepeat(body, rewrite);
  if (rewrite.kind === 'place-move') return movePlace(body, rewrite);
  if (rewrite.kind === 'csv-cell') return rewriteCsvCell(body, rewrite);
  if (rewrite.kind === 'csv-shape') return rewriteCsvShape(body, rewrite);
  if (rewrite.kind === 'adopt-images') {
    /**
     * ⚠ **規則を書き直さない** ── 拾う側(`externalImageUrls`)と当てる側は
     *   `acceptsExternalImage` の 1 本を共有する(§7「判定を増やさない」)。
     * ⚠ 変わらなければ `null` ── 同じ本文を書き直して更新日時だけ動かさない。
     */
    const next = rewriteAdopted(body, new Map(Object.entries(rewrite.adopted)), acceptsExternalImage);
    return next.text === body ? null : next.text;
  }
  const lines = body.split('\n');
  const line = lines[rewrite.line];
  if (line === undefined) return null;
  const m = TASK_LINE.exec(line);
  if (m === null) return null;
  const checked = m[2]!.toLowerCase() === 'x';
  /**
   * ⚠ **書き換えるのは印の 1 文字だけ** ── 行を組み直すと、
   *   `-   [ ]  やること` のような空白の入れ方が勝手に整形される
   *   (本文を byte 無傷で戻す規律)。
   */
  const at = m[1]!.length + 1; // `[` の次
  lines[rewrite.line] = line.slice(0, at) + (checked ? ' ' : 'x') + line.slice(at + 1);
  return lines.join('\n');
}

/**
 * 🔴 **1 行の日付を書き換える**(面から予定を動かす ── 双方向の実体)。
 *
 * ⚠ **チェック項目の行だけ**を書き換える。散文の行に日付を挿さない ──
 *   盤面に出ているのはチェック項目だけなので、それ以外の行を触る道が無い。
 *   ⚠ そして行番号は**描いた時**のものなので、ずれていたら `null` を返して
 *   **当てずっぽうで別の行を書き換えない**(`kind: 'task'` と同じ作法)。
 *
 * ⚠ **原文を splice する**(行を組み直さない)── 組み直すと
 *   `-   [ ]  やること` のような空白の入れ方が勝手に整形される。
 */
function rewriteLineDate(
  body: string,
  rewrite: {
    line: number;
    date: string | null;
    time?: string | null;
    until?: string | null;
    repeat?: RepeatUnit | null;
  },
): string | null {
  const lines = body.split('\n');
  const line = lines[rewrite.line];
  if (line === undefined) return null;
  if (!TASK_LINE.test(line)) return null;
  const found = readLineDate(line);
  let next: string;
  if (rewrite.date === null) {
    // 日付を外す。⚠ 元から無ければ**何も起きていない**
    if (found === null) return null;
    const before = line.slice(0, found.start);
    const after = line.slice(found.end);
    /**
     * ⚠ **区切りに置いた空白 1 つだけを戻す。**
     * 🔑 両側が空白のときだけ 1 つ落とす ── 落とさないと空白が 2 つ空き、
     *   落としすぎると `- [ ]` の印と中身がくっつく(**行の意味が変わる**)。
     */
    next =
      /[ \t]$/.test(before) && (after === '' || /^[ \t]/.test(after))
        ? before.slice(0, -1) + after
        : before + after;
  } else if (found === null) {
    // 日付を付ける。⚠ 区切りの空白は `insertionForLineDate` 1 か所が決める(§7)
    next =
      line +
      insertionForLineDate(line, rewrite.date, rewrite.time, rewrite.until, rewrite.repeat);
  } else {
    // 日付を差し替える。⚠ **記法の範囲だけ**を入れ替える(前後の字は 1 バイトも動かさない)
    next =
      line.slice(0, found.start) +
      formatLineDate(
        rewrite.date,
        rewrite.time,
        rewrite.until,
        // 🔴 **渡されていなければ元の刻みを保つ**(#344 段②)── 日を動かしただけで
        //    `毎週` が消えたら、user は「勝手に消された」と読む(時刻と同じ向き)
        rewrite.repeat === undefined ? found.repeat : rewrite.repeat,
      ) +
      line.slice(found.end);
  }
  if (next === line) return null;
  lines[rewrite.line] = next;
  return lines.join('\n');
}

/**
 * 🔴 **繰り返しの「その回」を実体の行にする**(#344 段②)。
 *
 * ⚠ 増やした行は**規則の行のすぐ下**に入れる ── 2 つの理由がある:
 *   ① 規則と記録が並ぶので、本文だけ読んでも意味が取れる
 *   ② 🔑 **規則の行の行番号が動かない** ── 動くと、画面に出ている他の札の
 *     行番号がずれ、次に押した 1 手が**別の行を書き換える**(いちばん静かな破壊)。
 * ⚠ だから並びは**新しい回が上**になる。時系列は日付の字で読める。
 */
function materializeRepeat(
  body: string,
  rewrite: { line: number; date: string },
): string | null {
  const lines = body.split('\n');
  const line = lines[rewrite.line];
  if (line === undefined) return null;
  const m = TASK_LINE.exec(line);
  if (m === null) return null;
  const found = readLineDate(line);
  // ⚠ 繰り返しの行でなければ**何もしない** ── 普通の項目は `kind: 'task'` の仕事
  if (found === null || found.repeat === null) return null;
  // ⚠ 読めない日は書かない(当てずっぽうの日付を本文へ残さない)
  if (!isScheduleDate(rewrite.date)) return null;
  /**
   * ⚠ 記法だけ**その日の単日**へ差し替える(刻みは落とす ── 実体の行が
   *   また繰り返したら、回が無限に増える)。⚠ 時刻は**持ち越す**
   *   (`14:00 毎週` の回は 14:00 の予定である)。
   */
  const swapped =
    line.slice(0, found.start) +
    formatLineDate(rewrite.date, found.time, null, null) +
    line.slice(found.end);
  /**
   * ⚠ 印の位置は**元の行**で数えてよい ── 記法は必ず `[ ]` より後ろに在るので、
   *   差し替えても前置きの長さは 1 バイトも動かない。
   */
  const at = m[1]!.length + 1; // `[` の次
  const done = swapped.slice(0, at) + 'x' + swapped.slice(at + 1);
  /**
   * 🔴 **同じ行が既に在るなら増やさない**(押しっぱなし / 二度押しの相打ち)。
   * ⚠ 判定は**作った字そのもの**で見る ── 二度押しは同じ規則の行から
   *   同じ日を作るので、生まれる字は 1 バイトまで同じである(だから当たる)。
   */
  if (lines.includes(done)) return null;
  lines.splice(rewrite.line + 1, 0, done);
  return lines.join('\n');
}

/** その行がチェック項目か(呼び側の事前判定用)。 */
export function isTaskLine(body: string, line: number): boolean {
  return TASK_LINE.test(body.split('\n')[line] ?? '');
}


/**
 * 🔴 **表のセルを 1 つ書き換える**(#418 段①)。
 *
 * 🔑 **その行だけを読み直して、そのセルの範囲だけを差し替える。**
 *   行を組み直さないので、触っていないセルは 1 バイトも動かない。
 *
 * ⚠ **断る条件**(`null` を返す ── `kind: 'task'` と同じ作法で、
 *   当てずっぽうで別の行を書き換えない):
 *   - その行が無い
 *   - その行が**表の行として読めない**(空行など)
 *   - その行が**次の行へ続いている**(引用が閉じていない = またがる行)
 *   - **そのセルが無い**(列が足りない)── 黙って足さない。列を増やすのは別の操作である
 *   - 書き換えても**同じ字**になる(呼び側が「書かない」を選べる)
 */
function rewriteCsvCell(
  body: string,
  rewrite: { line: number; col: number; value: string },
): string | null {
  const lines = body.split('\n');
  const line = lines[rewrite.line];
  if (line === undefined) return null;
  const table = csvTableAt(body, rewrite.line);
  if (table === null) return null;
  const { delimiter } = table;
  const out: CsvPositions = { rowLines: [], cellSpans: [] };
  const rows = parseCsv(line, delimiter, out);
  /**
   * ⚠ **1 行を渡して、閉じた 1 行が返ること**を検める。
   *   返らない / 2 行になる / **引用が閉じていない**形は、
   *   「この行だけでは表の行として決まらない」= **次の行へまたがっている**
   *   ということである(`\"あ` がそれ)── そこへ書くと次の行まで巻き込む。
   */
  if (rows === null || rows.length !== 1 || out.unterminated === true) return null;
  const spans = out.cellSpans?.[0];
  const cells = rows[0]!;
  if (spans === undefined || spans.length !== cells.length) return null;
  const span = spans[rewrite.col];
  if (span === undefined) return null;
  const next = csvEscapeField(rewrite.value, delimiter);
  if (line.slice(span.start, span.end) === next) return null;
  lines[rewrite.line] = line.slice(0, span.start) + next + line.slice(span.end);
  return lines.join('\n');
}

/**
 * 🔴 **その行を含む表の囲みを引く**(#418 段①)。表の中でなければ `null`。
 *
 * ⚠ **どんな行も CSV の 1 行として読めてしまう** ── だから「この行が csv の
 *   囲みの**中身**に在るか」を先に確かめないと、**囲みの見出しの行**
 *   (` ```csv-render noheader `)そのものを書き換えられる
 *   (実際、最初に書いたときは書き換えられた)。
 * 🔑 囲みの切り方も見出しの読み方も**既に在るもの**を通す(§7)──
 *   `scanContainers` と `parseRenderableFence`。ここに 2 本目を書かない。
 * ⚠ 区切り字も**呼び手に決めさせない** ── tsv / psv の表をカンマで
 *   組み直して壊す道を残さない。
 */
function csvTableAt(
  body: string,
  line: number,
): { first: number; last: number; delimiter: string } | null {
  const fence = scanContainers(body).find(
    (c) => c.kind === 'fence' && line > c.start && line < c.end,
  );
  if (fence === undefined) return null;
  const parsed = parseRenderableFence(fence.name);
  if (parsed === null) return null;
  const delimiter = (DELIMITER as Record<string, string | undefined>)[parsed.lang];
  if (delimiter === undefined) return null;
  // ⚠ 中身は**見出しの次から閉じの手前まで**(閉じが無い囲みは末尾まで)
  return { first: fence.start + 1, last: fence.end - 1, delimiter };
}

/**
 * 🔴 **表の行・列を足す / 消す**(#418 段①)。
 *
 * 🔑 **触る所だけを触る** ── 行を足すのは 1 行の挿入、列は各行の
 *   **そのセルの範囲**の surgery で済ませる。組み直すと、触っていないセルの
 *   `\"a\"` が `a` になるなど**字面が黙って変わる**。
 * ⚠ **またがっている行が 1 つでもあれば、列の操作は丸ごと断る** ──
 *   半分だけ当てると、表の形が行ごとに食い違う(いちばん直しにくい壊れ方)。
 */
function rewriteCsvShape(
  body: string,
  rewrite: { line: number; col: number; what: 'row' | 'col'; mode: 'add' | 'remove' },
): string | null {
  const table = csvTableAt(body, rewrite.line);
  if (table === null) return null;
  const lines = body.split('\n');
  /** 表の中身の行(空行は行として数えない ── 描かれていないので押されない)。 */
  const rows: number[] = [];
  for (let i = table.first; i <= table.last && i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() !== '') rows.push(i);
  }
  if (!rows.includes(rewrite.line)) return null;

  if (rewrite.what === 'row') {
    if (rewrite.mode === 'remove') {
      // ⚠ **最後の 1 行は消さない**(表ごと消えて CSV の原文に放り出される)
      if (rows.length <= 1) return null;
      lines.splice(rewrite.line, 1);
      return lines.join('\n');
    }
    // 足すのは**押した行の下**。⚠ 幅は押した行に揃える(でこぼこにしない)
    const cells = cellsOf(lines[rewrite.line]!, table.delimiter);
    if (cells === null) return null;
    lines.splice(rewrite.line + 1, 0, table.delimiter.repeat(cells.length - 1));
    return lines.join('\n');
  }

  // ── 列は**全部の行**を触る。まず全行が読めることを確かめてから当てる
  const parsed: Array<{ at: number; spans: Array<{ start: number; end: number }> }> = [];
  for (const at of rows) {
    const spans = cellsOf(lines[at]!, table.delimiter);
    if (spans === null) return null;
    if (spans[rewrite.col] === undefined) return null;
    parsed.push({ at, spans });
  }
  if (rewrite.mode === 'remove' && parsed.some((r) => r.spans.length <= 1)) return null;
  for (const { at, spans } of parsed) {
    const line = lines[at]!;
    const span = spans[rewrite.col]!;
    if (rewrite.mode === 'add') {
      // 押した列の**右**へ空のセルを 1 つ
      lines[at] = line.slice(0, span.end) + table.delimiter + line.slice(span.end);
    } else {
      // ⚠ 区切り字も 1 つ連れて消す ── 最後の列なら**左側**の区切り字を消す
      const cut =
        rewrite.col + 1 < spans.length
          ? { start: span.start, end: spans[rewrite.col + 1]!.start }
          : { start: spans[rewrite.col - 1]!.end, end: span.end };
      lines[at] = line.slice(0, cut.start) + line.slice(cut.end);
    }
  }
  return lines.join('\n');
}

/**
 * その 1 行のセルの範囲。⚠ **1 行として閉じていなければ `null`**
 * (次の行へまたがっている ── そこへ書くと次の行まで巻き込む)。
 */
function cellsOf(
  line: string,
  delimiter: string,
): Array<{ start: number; end: number }> | null {
  const out: CsvPositions = { cellSpans: [] };
  const rows = parseCsv(line, delimiter, out);
  if (rows === null || rows.length !== 1 || out.unterminated === true) return null;
  const spans = out.cellSpans?.[0];
  if (spans === undefined || spans.length !== rows[0]!.length) return null;
  return spans;
}
