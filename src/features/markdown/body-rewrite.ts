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
import { frontmatterLineCount, spliceFrontmatterKeys, type FrontmatterValue } from './frontmatter';
import { formatLineDate, insertionForLineDate, readLineDate } from '../schedule/line-date';
import { isScheduleDate } from '../schedule/schedule-date';
import type { RepeatUnit } from '../schedule/repeat';
import { removeInsertedLines } from './append-target';
import { addPlace, insideFence, movePlace, raisePlace, removePlace, resizePlace } from './place-notation';
import { readTags, withTagResult } from '../flavor/tags';
import { acceptsExternalImage, rewriteAdopted } from '../asset/inline-url-adopt';
import { DELIMITER, csvEscapeField, parseCsv, type CsvPositions } from './csv-table';
import { parseRenderableFence } from './markdown-render';
import { containerAtLine, quoteLead } from './source-blocks';
import { cutLines, insertLines, moveLines, type InsertAnchor } from './line-move';
import { gfmCellText } from './html-to-markdown';
import {
  convertTable,
  fencesBelowFrontmatter,
  mdCellGate,
  mdCellSpanAt,
  tableAt,
  tableConvertRefusal,
  type TableFormat,
} from './table-convert';

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
       * 🔴 **板の塊の大きさを変える**(#676)── 開き行の w= / h= だけ。
       * `line` / `openLine` の意味と門は `place-move` と同じ(`place-notation.ts` の 1 本)。
       */
      kind: 'place-size';
      line: number;
      openLine: string;
      w: number;
      h: number;
    }
  | {
      /**
       * 🔴 **板の塊を消す**(#676。user 指示 2026-08-23「片道の操作を作らない」──
       * 置けるなら消せる)。開き行から閉じの `:::` までと隣の空行 1 本が消える。
       * ⚠ 閉じていない塊は `applyBodyRewrite` が `null` = 断る(末尾まで消さない)。
       */
      kind: 'place-remove';
      line: number;
      openLine: string;
    }
  | {
      /**
       * 🔴 **板を前へ出す**(#676 段②)── 他の板の z= の最大 + 1 を開き行の z= に書く。
       * ⚠ 「後ろへ送る」は無い(負の z を描画が捨てるので、下げる向きは他の板の行を触ることになる)。
       */
      kind: 'place-raise';
      line: number;
      openLine: string;
    }
  | {
      /**
       * 🔴 **板の塊を 1 つ足す**(#676)── 本文の末尾に空の塊を書く。
       * ⚠ **行番号を持たない**(足す先は常に末尾。別の窓が上へ足していてもずれない)。
       */
      kind: 'place-add';
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
    }
  | {
      /**
       * 🔴 **行の並びを差し込む**(#684 段②)── 一覧の行を本文へ落とすとリンクになる。
       * ⚠ `toBefore` は**生の body の行番号**(0 始まり。この行の前へ入れる。行数で末尾)。
       *   fence / `:::` の中・frontmatter へは `applyBodyRewrite` が `null` = 断る。
       *   規則の実体は `line-move.ts`(pure)。
       */
      kind: 'insert-lines';
      toBefore: number;
      lines: readonly string[];
      /**
       * 🔴 **落とした時の目印**(#684 段④)── `line` 行目が `text` のままでなければ書かない。
       * ⚠ 差し込みだけが錨を持っていなかった(兄弟は全部 byte 一致を検める)。
       *   段④ は落としてから書くまで待つので、番号だけでは別の行を指す。
       */
      anchor?: InsertAnchor;
      /**
       * 🔴 **取り込みの回の印**(#684 段④)── 同じ印で入れた行は「元に戻す」1 回で
       *   まとめて消える(3 枚まとめて落とした写真は 1 手で戻る)。
       * ⚠ `applyBodyRewrite` は読まない ── 読むのは ack を受ける reducer
       *   (`BODY_REWRITTEN` が `lastAppend` を継ぐ)。⚠ 省略 = 単独の 1 手。
       */
      batch?: string;
    }
  | {
      /**
       * 🔴 **本文の塊を切り取る**(#684 段③ ── 別のノートへ持っていく「元の側」)。
       *
       * ⚠ **単独では撃たない** ── 行き先へ入ったことを確かめてから、同じ 1 op の中で
       *   効果層が撃つ(`REQUEST_BLOCK_HANDOFF`)。切るだけの口を作ると、
       *   入れ損ねた回に本文が消える。
       * ⚠ ここに在るのは **ack の顔**(`BODY_REWRITTEN` が何をしたかを運ぶ)である ──
       *   `applyBodyRewrite` からは撃たれない(効果層が `cutLines` を直に呼ぶ)。
       */
      kind: 'cut-lines';
      start: number;
      end: number;
      lines: readonly string[];
    }
  | {
      /**
       * 🔴 **本文の塊を動かす**(#684 段①)── `start..end` の行を `toBefore` の前へ。
       * ⚠ 座標は**生の body**(`task` と同じ)。掴んだ時点の行そのもの(`lines`)を添え、
       *   disk 側で byte 一致しなければ書かない(`place-move` の `openLine` と同じ作法)。
       * 🔑 落とし先が自分の中なら **body をそのまま返す**(取りやめ ≠ 競合)。
       */
      kind: 'move-lines';
      start: number;
      end: number;
      toBefore: number;
      lines: readonly string[];
    }
  | {
      /**
       * 🔴 **保存したスタックの中の 1 行を、隣のリンク行と入れ替える**(#633 段④)。
       *
       * ⚠ `line` は**原文の行番号**(0 始まり)、`openLine` は**押した時点のその行そのもの** ──
       *   disk 側と byte 一致しなければ書かない(`place-move` と同じ門。別の窓が行を足していれば
       *   番号は別の行を指す)。
       * ⚠ 入れ替える相手も**リンクの箇条書きの行**でなければ動かさない ── 見出しや空行と
       *   入れ替えると入れ物の形が崩れる。端(上が無い / 下が無い)では**同じ本文を返す**
       *   (`null` にすると効果層が「本文が変わっている」と嘘の理由を言う ── `place-move` と同じ)。
       */
      kind: 'link-move';
      line: number;
      openLine: string;
      dir: 'up' | 'down';
    }
  | {
      /**
       * 🔴 **表の形を変える**(#708 段②)── markdown の表 ⇄ csv の囲み。
       *
       * ⚠ `line` は**原文の行番号**(0 始まり)。押した表のどの行でもよい ──
       *   範囲は `table-convert.ts` が原文から引き直す(`csv-shape` と同じ作法で、
       *   **その表の行だけ**を差し替える。同じノートに表が 3 つ在っても他は動かない)。
       * 🔴 **式が在る csv は markdown にしない**(user 裁定 2026-09-04)── ここでも
       *   断る(`null`)。⚠ 理由は押した時に binder が既に出しているが、**読んで
       *   から書くまでの間に別の窓が式を書いた**ら、判定できるのはここだけである。
       */
      kind: 'table-format';
      line: number;
      to: TableFormat;
    };

/**
 * 箇条書きの `entry:` リンクの行か(`- [題名](entry:<lid>)`)。
 * ⚠ 番号つき(`1.`)も受ける ── 読む側(`bodyLinkTargets`)は印を見ないので、記法を狭めない。
 */
const LINK_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[[^\]]*\]\(entry:[A-Za-z0-9_-]+\)/;

/**
 * 🔴 **リンク行を隣と入れ替える**(#633 段④)── 2 行以外は 1 byte も動かさない。
 *
 * ⚠ 門は 4 つ:①行が原文の範囲に在る ②`openLine` と byte 一致 ③その行がリンク行
 *   ④fence の中ではない。1 つでも外れれば `null` = 断る(当てずっぽうで別の行を書かない)。
 * 🔑 端(相手が無い / 相手がリンク行でない)は **`body` をそのまま返す** ── 済んでいる。
 */
function moveLinkLine(
  body: string,
  rw: { line: number; openLine: string; dir: 'up' | 'down' },
): string | null {
  const fm = frontmatterLineCount(body);
  if (!Number.isInteger(rw.line) || rw.line < fm) return null;
  const lines = body.split('\n');
  const cur = lines[rw.line];
  if (cur === undefined || cur !== rw.openLine) return null;
  if (!LINK_LINE.test(cur)) return null;
  if (insideFence(lines, fm, rw.line)) return null;
  const to = rw.dir === 'up' ? rw.line - 1 : rw.line + 1;
  const other = lines[to];
  if (to < fm || other === undefined) return body;
  if (!LINK_LINE.test(other) || insideFence(lines, fm, to)) return body;
  lines[rw.line] = other;
  lines[to] = cur;
  return lines.join('\n');
}

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

/** タグ 1 つに何が起きたか(#640)。⚠ `wrote` 以外は**本文が変わっていない**。 */
export type TagOutcome = 'wrote' | 'unchanged' | 'limit' | 'invalid';

export interface TagsApplied {
  /** 書き換えた本文。⚠ **1 つも動かなければ `null`**(同じ本文を書き直さない)。 */
  readonly body: string | null;
  /** 打った字ごとの結果。⚠ 鍵は**打った字そのもの**(正規化前 ── 画面に出すため)。 */
  readonly outcomes: ReadonlyMap<string, TagOutcome>;
}

/**
 * 🔴 **タグを並びのまま当て、1 つずつの理由も返す**(#640)。
 *
 * ⚠ 直す前は呼び側が `applyBodyRewrite` を 1 タグずつ呼び、返り値の `null` を
 *   数えていた ── その `null` は「**既に付いている**」と「**上限で付かない**」の
 *   両方なので、画面には「0 件に付けました / 1 件は**既に付いていました**」という
 *   **事実と違う字**が出ていた(付いていないのに「既に付いていました」)。
 *
 * 🔑 だから理由を**通す**。⚠ 書く規則そのものは `withTagResult` 1 つで、
 *   ここは並びを畳むだけである(§7 ── 2 本目の規則を書かない)。
 * ⚠ **並びは畳む**(#637)── 途中の 1 つが動かなくても止めない。
 *   1 つでも動いたら書く、1 つも動かなければ `null`。
 */
export function applyTagsToBody(
  body: string,
  tags: readonly string[],
  mode: 'add' | 'remove',
): TagsApplied {
  let cur = readTags(body);
  let moved = false;
  const outcomes = new Map<string, TagOutcome>();
  for (const tag of tags) {
    const r = withTagResult(cur, tag, mode);
    if (!r.ok) {
      outcomes.set(tag, r.reason);
      continue;
    }
    cur = r.tags;
    moved = true;
    outcomes.set(tag, 'wrote');
  }
  if (!moved) return { body: null, outcomes };
  // ⚠ 空になったら **鍵ごと消す**(`tags: []` を残さない ── 読み手が
  //    「空のタグが 1 つ在る」と読む形を作らない)
  return {
    body: spliceFrontmatterKeys(body, { tags: cur.length === 0 ? undefined : cur }),
    outcomes,
  };
}

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
    // 🔑 **書く形と、理由を数える形は同じ 1 本**(#640)── 下の `applyTagsToBody`
    return applyTagsToBody(body, rewrite.tags, rewrite.mode).body;
  }
  if (rewrite.kind === 'repeat-done') return materializeRepeat(body, rewrite);
  if (rewrite.kind === 'place-move') return movePlace(body, rewrite);
  if (rewrite.kind === 'place-size') return resizePlace(body, rewrite);
  if (rewrite.kind === 'place-remove') return removePlace(body, rewrite);
  if (rewrite.kind === 'place-raise') return raisePlace(body, rewrite);
  if (rewrite.kind === 'place-add') return addPlace(body, rewrite.x, rewrite.y);
  if (rewrite.kind === 'link-move') return moveLinkLine(body, rewrite);
  if (rewrite.kind === 'csv-cell') return rewriteCsvCell(body, rewrite);
  if (rewrite.kind === 'csv-shape') return rewriteCsvShape(body, rewrite);
  if (rewrite.kind === 'table-format') return rewriteTableFormat(body, rewrite);
  // 🔑 塊の移動と差し込みは `line-move.ts` の 1 本(#684)── 取りやめは body をそのまま返す
  if (rewrite.kind === 'move-lines') return moveLines(body, rewrite);
  if (rewrite.kind === 'insert-lines')
    return insertLines(body, rewrite.toBefore, rewrite.lines, rewrite.anchor);
  if (rewrite.kind === 'adopt-images') {
    /**
     * ⚠ **規則を書き直さない** ── 拾う側(`externalImageUrls`)と当てる側は
     *   `acceptsExternalImage` の 1 本を共有する(§7「判定を増やさない」)。
     * ⚠ 変わらなければ `null` ── 同じ本文を書き直して更新日時だけ動かさない。
     */
    const next = rewriteAdopted(body, new Map(Object.entries(rewrite.adopted)), acceptsExternalImage);
    return next.text === body ? null : next.text;
  }
  /**
   * 🔴 **切り取り**(#684 段③)。
   *
   * ⚠ **ここは「合流」の口である** ── 保存に失敗した状態(`phase: 'error'`)から
   *   基底へ書換を当て直す経路(`app-state.ts` の `BODY_REWRITTEN`)が通る。
   *   🔴 1 稿目は「配線の取り違えだから何もしない」と書いて `null` を返していたが、
   *   **事実と違った**(着地前レビュー 💭-2)── そこで捨てると基底に切り取りが
   *   反映されず、**再保存で塊が元へ戻って二重になる**。
   * 🔑 撃つ口が増えるわけではない ── 段③ を**始める**のは効果層の 1 か所だけで
   *   (`REQUEST_BLOCK_HANDOFF`。必ず「入れてから」)、ここはその ack を当て直すだけである。
   */
  if (rewrite.kind === 'cut-lines') return cutLines(body, rewrite)?.body ?? null;
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
/**
 * 🔴 **markdown の表の升 1 つを差し替える**(#708 段④)。
 *
 * 🔑 **触る所だけを触る** ── 升の原文の範囲(`mdCellSpan`)だけを splice するので、
 *   同じ行の他の升も、余白も、1 バイトも動かない(`csv-cell` と同じ作法)。
 * 🔴 **書き戻すときに `|` を逃がし直す** ── 読み手(markdown-it)は升の原文から
 *   **`\|` の逃がしだけ外して**渡してくる(実測:`a\|b` → `a|b`)ので、そのまま
 *   書き戻すと**升の中の `|` が列の区切りとして読まれ、表がずれる**。
 *   ⚠ 逃がす規則は `gfmCellText` の 1 本を借りる(§7)── ここに 2 本目を書かない。
 */
function rewriteMdCell(
  lines: string[],
  rewrite: { line: number; col: number; value: string },
): string | null {
  /**
   * 🔑 **門は `mdCellSpanAt` の 1 本だけ**(#747)。⚠ ここに 2 本目を書かない ──
   *   直す前は焼く側が `mdCellSpan` だけ、書く側がここで `mdTableAt` + 区切り行と
   *   **数が違って**おり、引用の中の表は**押せるのに書けなかった**。
   */
  const span = mdCellSpanAt(mdCellGate(lines), rewrite.line, rewrite.col);
  if (span === null) return null;
  const line = lines[rewrite.line];
  if (line === undefined) return null;
  const next = gfmCellText(rewrite.value);
  // ⚠ 同じ字なら書かない(呼び側が「書かない」を選べる ── `csv-cell` と同じ)
  if (line.slice(span.start, span.end) === next) return null;
  lines[rewrite.line] = line.slice(0, span.start) + next + line.slice(span.end);
  return lines.join('\n');
}

function rewriteCsvCell(
  body: string,
  rewrite: { line: number; col: number; value: string },
): string | null {
  const lines = body.split('\n');
  const line = lines[rewrite.line];
  if (line === undefined) return null;
  const table = csvTableAt(body, rewrite.line);
  /**
   * 🔴 **markdown の表の升も、同じ口で打てる**(#708 段④)。
   *
   * ⚠ csv の囲みの中でなければ、**markdown の表かどうか**を原文から引き直す ──
   *   「どんな行も表の行として読める」ので、`tableAt` を通さずに `|` で割ると
   *   **段落の 1 行を表として書き換える**(`csvTableAt` の註記と同じ罠)。
   * ⚠ **区切りの行(`|---|`)は触らない** ── そこを書き換えると表が表でなくなる。
   * ⚠ 升の数が見出しより少ない行では、読み手が**原文を持たない空の升**で埋める ──
   *   そこは `mdCellSpan` が `null` を返すので、無い物を書き換えない。
   */
  if (table === null) return rewriteMdCell(lines, rewrite);
  const { delimiter } = table;
  /**
   * 🔴 **引用の前置きは升ではない**(#775)── `> 品名,数` の `> ` を剥がしてから
   *   csv として読み、書き戻すときに**そのまま付け直す**(前置きは 1 文字も動かない)。
   *
   * ⚠ 剥がす段数は**囲みが居る深さ**であって、行ごとに数え直すのではない ──
   *   素の ` ```csv ` の中に書いた `> a,b` は、読み手も **`> a`** を 1 つ目の升として
   *   渡してくる(実測 2026-09-07)。行ごとに数えると、そこを升の字として食う。
   * ⚠ 段が足りない行は**この囲みの中身ではない**ので断る(`quoteLead` が `null`)。
   */
  const lead = quoteLead(line, table.quote);
  if (lead === null) return null;
  const head = line.slice(0, lead);
  const text = line.slice(lead);
  /**
   * 🔑 **升の切り方は `cellsOf` の 1 本**(#780 で寄せた)── ⚠ 直す前はここに
   *   同じ処理が書き写されており、**片方だけ直す**と静かに食い違う(§7)。
   */
  const spans = csvRowSpans(text, delimiter);
  if (spans === null) return null; // またがっている行(そこへ書くと次の行を巻き込む)
  const next = csvEscapeField(rewrite.value, delimiter);
  const span = spans[rewrite.col];
  if (span === undefined) {
    /**
     * 🔴 **原文に無い升にも打てる**(#780。user 裁定 2026-09-07「押したら打てる」)。
     *
     * ⚠ 読み手は**見出しの列数ぶんに詰め物をして**升を並べるので、升の数が足りない行や
     *   空行にも**押せる印が焼かれる**。直す前はそこを断っていたので、
     *   「**押せる → 打てる → 消える**」だった(実測 2026-09-07:9 升のうち 2 升)。
     * 🔑 だから**足りない区切りを補って書く** ── `1` の 3 列目に `x` なら `1,,x`。
     *   行を足したときにできる空の升と**同じ動き**になる。
     * ⚠ **表の幅を超える依頼は断る** ── 焼く側は幅までしか升を出さないので、
     *   それを超えるのは「別の窓から来た古い依頼」である。
     * ⚠ **空を書いても原文は変わらない**ので断る(「同じ字なら書かない」と同じ向き)。
     */
    if (!Number.isInteger(rewrite.col) || rewrite.col < 0) return null;
    if (rewrite.col >= csvTableWidth(lines, table)) return null;
    if (next === '') return null;
    // ⚠ いまの区切りの数は `len - 1`(空行は 0)── そこから `col` 個まで足す
    const gap = delimiter.repeat(rewrite.col - Math.max(spans.length - 1, 0));
    lines[rewrite.line] = head + text + gap + next;
    return lines.join('\n');
  }
  // ⚠ 範囲は**前置きを剥がした字**の中の位置なので、書き戻しも `text` の上で行う
  if (text.slice(span.start, span.end) === next) return null;
  lines[rewrite.line] = head + text.slice(0, span.start) + next + text.slice(span.end);
  return lines.join('\n');
}

/**
 * 🔴 **その 1 行の升の範囲**(#780)。⚠ **空行は「升 0 個」**である。
 *
 * ⚠ `parseCsv('')` は `null` を返す ── それを「読めない行」と読むと、
 *   **空行の升が永久に打てない**(読み手は詰め物で升を並べているのに)。
 * 🔑 「読めない」(`null` = またがっている)と「升が 0 個」を**分ける**のがここの仕事。
 */
function csvRowSpans(
  text: string,
  delimiter: string,
): Array<{ start: number; end: number }> | null {
  return text === '' ? [] : cellsOf(text, delimiter);
}

/**
 * 🔴 **その表の幅**(#780)── 読み手が升を並べる数。
 *
 * 🔑 **読み手と同じ数え方**にする ── `rowsToHtml` は「全部の行のうち**いちばん
 *   多い升の数**」を幅にして、足りない行を詰め物で埋める。だから同じ物を
 *   **囲みの中身をまとめて**読んで数える(行ごとに数えると詰め物の分を落とす)。
 * ⚠ 前置き(引用)は剥がしてから渡す ── 読み手が受け取るのはその形である。
 */
function csvTableWidth(
  lines: readonly string[],
  table: { first: number; last: number; delimiter: string; quote: number },
): number {
  const body: string[] = [];
  for (let i = table.first; i <= table.last && i < lines.length; i += 1) {
    const l = lines[i];
    if (l === undefined) continue;
    const lead = quoteLead(l, table.quote);
    if (lead === null) continue;
    body.push(l.slice(lead));
  }
  const rows = parseCsv(body.join('\n'), table.delimiter);
  return rows === null ? 0 : rows.reduce((max, r) => Math.max(max, r.length), 0);
}

/**
 * 🔴 **表の形を変える**(#708 段②)── markdown の表 ⇄ csv の囲み。
 *
 * 🔑 **その表の行範囲だけを差し替える**(`csv-shape` と同じ作法)── 範囲も升も
 *   `table-convert.ts` が原文から引くので、同じノートの**別の表は 1 バイトも動かない**。
 *
 * ⚠ **断る条件**(`null` を返す ── 当てずっぽうで別の行を書き換えない):
 *   - その行に表が無い(押した後に別の窓が本文を動かした)
 *   - **もうその形**である(押した時点とは別の本文になっている)
 *   - **式 / 升の中の改行**が在って markdown にできない(`tableConvertRefusal`)
 *   - 組み立てが空(升が 1 つも無い)
 */
function rewriteTableFormat(
  body: string,
  rewrite: { line: number; to: TableFormat },
): string | null {
  const at = tableAt(body, rewrite.line);
  if (at === null) return null;
  if (tableConvertRefusal(at, rewrite.to) !== null) return null;
  const text = convertTable(at, rewrite.to);
  if (text === null) return null;
  const lines = body.split('\n');
  /**
   * 🔴 **引用(`>`)の中の表は、前置きを付け直して差し戻す**(#743)。
   *
   * ⚠ `convertTable` が組むのは**前置きの無い字**である(升の中身しか知らない)。
   *   そのまま差し替えると `>` が 1 つも無い行になり、**表が引用から抜け落ちて
   *   地の本文になる**(引用の縦線も板の色も消える ── user は「変な所へ出た」と
   *   しか読めない)。⚠ **升の字は 1 文字も変わらない**ので、升を数える検査では
   *   見えない ── 見えるのは「表が `blockquote` の中に在るか」である。
   * 🔑 付ける字は**読む側が実際に剥がしたもの**(`at.quoteLead`)── ここで
   *   `> ` と `>` と `>> ` を組み直さない(user が書いた書き方をそのまま返す)。
   */
  lines.splice(
    at.start,
    at.end - at.start + 1,
    ...text.split('\n').map((l) => at.quoteLead + l),
  );
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
): { first: number; last: number; delimiter: string; quote: number } | null {
  /**
   * 🔴 **入れ子の深さを問わない**(#743)。⚠ 直す前は `scanContainers` の
   *   **最上位しか見ていなかった**ので、`:::` の板の中の ` ```csv ` は
   *   **升を押せるのに書けなかった**(打った字が消え、起きていない理由が出る)。
   * 🔴 **引用(`>`)の中も同じ**(#775)── 走査が引用へ降りるようになったので、
   *   `> ```csv ` の中身もここに出る。⚠ そのぶん **`quote` を持ち帰る**:
   *   中身の行は前置きを剥がしてから読む(すぐ下の `rewriteCsvCell`)。
   */
  const fence = containerAtLine(fencesBelowFrontmatter(body), line);
  if (fence === null || line <= fence.start) return null;
  /**
   * 🔴 **閉じが来ていない囲みは、末尾までが中身である**(#775)。
   *
   * ⚠ 直す前は閉じの有無に関わらず `end - 1` にしていた。素の本文では
   *   末尾の空行が**閉じの代わりになって偶然当たっていた**ので気づけなかったが、
   *   実測(2026-09-07)で 2 つの形が割れていた ── ①`\n` で終わらない本文
   *   (` ```csv\na,b `)の**最後の行**②引用の中の閉じない囲み
   *   (`> ```csv\n> a,b `)。どちらも**押せるのに書けない**(打った字が消える)。
   */
  const last = fence.open ? fence.end : fence.end - 1;
  if (line > last) return null;
  const parsed = parseRenderableFence(fence.name);
  if (parsed === null) return null;
  const delimiter = (DELIMITER as Record<string, string | undefined>)[parsed.lang];
  if (delimiter === undefined) return null;
  // ⚠ 中身は**見出しの次から閉じの手前まで**(閉じが無い囲みは末尾まで)
  return { first: fence.start + 1, last, delimiter, quote: fence.quote };
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
  /**
   * 🔴 **引用の前置きを剥がしてから読む**(#775)── `rewriteCsvCell` と同じ作法。
   * ⚠ 剥がさずに `trim()` すると、引用の中の**空の行**(`>`)が「空でない」と読まれ、
   *   表の行として数えられる。
   * @returns 中身(前置きを剥がした字)。段が足りない行は `null`(この表の行ではない)
   */
  const textOf = (at: number): string | null => {
    const l = lines[at];
    if (l === undefined) return null;
    const lead = quoteLead(l, table.quote);
    return lead === null ? null : l.slice(lead);
  };
  /**
   * 表の中身の行。
   *
   * 🔴 **空行も行として数える**(#780。user 裁定 2026-09-07)── 読み手は空行にも
   *   **行を 1 本描いて、行の ＋ × を焼く**ので、数えないと dead click になる
   *   (実測 2026-09-07:押しても何も起きない)。
   * ⚠ 段が足りない行(引用の深さ違い)だけは**この表の行ではない**ので外す。
   */
  const rows: number[] = [];
  for (let i = table.first; i <= table.last && i < lines.length; i += 1) {
    if (textOf(i) !== null) rows.push(i);
  }
  if (!rows.includes(rewrite.line)) return null;
  /** 前置きの字数(⚠ `rows` に居る行だけに使う = 剥がせた行なので `null` にならない)。 */
  const lead = (at: number): number => quoteLead(lines[at]!, table.quote)!;

  if (rewrite.what === 'row') {
    if (rewrite.mode === 'remove') {
      // ⚠ **最後の 1 行は消さない**(表ごと消えて CSV の原文に放り出される)
      if (rows.length <= 1) return null;
      lines.splice(rewrite.line, 1);
      return lines.join('\n');
    }
    // 足すのは**押した行の下**。⚠ 幅は押した行に揃える(でこぼこにしない)
    // ⚠ 空行から足したら**空行**が入る(「押した行に揃える」の素直な帰結。#780)
    const cells = csvRowSpans(textOf(rewrite.line)!, table.delimiter);
    if (cells === null) return null;
    /**
     * ⚠ **足す行にも同じ前置きを付ける**(#775)── 付けないと引用の外へ落ちて、
     *   囲みがそこで閉じる(表が真っ二つになる)。
     */
    const prefix = lines[rewrite.line]!.slice(0, lead(rewrite.line));
    /**
     * ⚠ **空行から足したら空行**(#780)── `cells.length` が 0 のとき `- 1` は **-1** で、
     *   `repeat(-1)` は例外を投げる(実測 2026-09-07:`RangeError: Invalid count value`)。
     * 🔑 0 で止める ── 区切りが 0 個 = 空の行が入る(「押した行に揃える」の素直な帰結)。
     */
    lines.splice(rewrite.line + 1, 0, prefix + table.delimiter.repeat(Math.max(cells.length - 1, 0)));
    return lines.join('\n');
  }

  /**
   * ── 列は**全部の行**を触る。まず全行が読めることを確かめてから当てる。
   *
   * 🔴 **その列を持たない行は飛ばす**(#780)。⚠ 直す前は「1 行でも持っていなければ
   *   丸ごと断る」だったので、**升の数が足りない行が 1 本あるだけで列の ＋ × が
   *   全部死んで**いた(実測 2026-09-07:10 個中 5 個が dead click)。
   * 🔑 飛ばすのであって**埋めない** ── 埋めると「触っていないセルの字は 1 バイトも
   *   動かない」(この file の既存の不変量)が壊れる。
   * ⚠ **またがっている行は今までどおり丸ごと断る** ── 半分だけ当てると、表の形が
   *   行ごとに食い違う(いちばん直しにくい壊れ方)。「読めない」と「持っていない」を
   *   混ぜないのが肝である。
   */
  const parsed: Array<{ at: number; spans: Array<{ start: number; end: number }> }> = [];
  for (const at of rows) {
    const spans = csvRowSpans(textOf(at)!, table.delimiter);
    if (spans === null) return null;
    if (spans[rewrite.col] === undefined) continue;
    parsed.push({ at, spans });
  }
  // ⚠ 押した列を 1 行も持っていなければ、当てる先が無い(押せる印も焼かれていない)
  if (parsed.length === 0) return null;
  /**
   * ⚠ **最後の 1 列は消さない**(消すと表そのものが消えて、CSV の原文に放り出される)。
   *
   * 🔴 **数えるのは「表の幅」である**(#780)。⚠ 直す前は「**どれか 1 行でも升が
   *   1 つしかなければ断る**」だったので、3 列の表に**升が 1 つの行が 1 本**
   *   在るだけで列を消せなかった ── 註記が言っているのは「**表**そのものが
   *   消える」ことなので、行ごとに数えるのは的が違う。
   * 🔑 幅が 1 なら断る / それより広ければ、升の足りない行は**空の行になるだけ**
   *   (空の行は #780 で打てるようになったので、行き止まりにならない)。
   */
  if (rewrite.mode === 'remove' && csvTableWidth(lines, table) <= 1) return null;
  for (const { at, spans } of parsed) {
    const line = lines[at]!;
    // ⚠ 範囲は**前置きを剥がした字**の中の位置 ── 前置きのぶんだけずらして当てる
    const off = lead(at);
    const span = spans[rewrite.col]!;
    if (rewrite.mode === 'add') {
      // 押した列の**右**へ空のセルを 1 つ
      lines[at] = line.slice(0, off + span.end) + table.delimiter + line.slice(off + span.end);
    } else {
      /**
       * ⚠ 区切り字も 1 つ連れて消す ── 最後の列なら**左側**の区切り字を消す。
       * 🔴 **升が 1 つしかない行では、升だけ消して空にする**(#780)。
       *   ⚠ 直す前はここで `spans[-1]` を読んで**例外を投げて**いた
       *   (幅の門が先に断っていたので届いていなかっただけである)。
       */
      const cut =
        rewrite.col + 1 < spans.length
          ? { start: span.start, end: spans[rewrite.col + 1]!.start }
          : rewrite.col > 0
            ? { start: spans[rewrite.col - 1]!.end, end: span.end }
            : { start: span.start, end: span.end };
      lines[at] = line.slice(0, off + cut.start) + line.slice(off + cut.end);
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
