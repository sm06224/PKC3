/**
 * 🔴 **元の md へ書き戻す**の中身(#732、2026-09-05 に `main.ts` から取り出した)。
 *
 * ## なぜ取り出したか
 *
 * 直す前は `main.ts` に直書きで、**飛んでいる書込を待たずに** disk の本文を読んでいた
 * ── つまり保存の直後に押すと、**保存前の本文が user のファイルへ書かれる**。
 * ⚠ 確認文言が言うとおり「**ファイルの元の内容は失われます(取り消せません)**」なので、
 *   これは PKC3 で**いちばん取り返しのつかない**読み違いである。
 * ⚠ そして `main.ts` は**どの test からも実行されない**(原文を読む test しか無い ──
 *   CLAUDE.md §2)。直しても、その直しを守る物が 1 つも無かった。
 * 🔑 だから**順番を持つ部分だけ**をここへ出す ── 待つ / 読む / 書く の 3 つは
 *   注入されるので、`tests/adapter/write-back.test.ts` が**書かれた中身**で見られる。
 *
 * ## ⚠ `settle` は optional にしない
 *
 * 渡し忘れても tsc が黙る形にすると、戻ってくる症状は
 * 「**保存したのに古い本文でファイルが上書きされた**」── いちばん気づけない壊れ方である
 * (2026-08-17 に書き出しで踏んだ形と同じ)。
 */

import { isBlankBody } from '@features/markdown/frontmatter';
import { diffCounts, diffRows } from '@features/revision/diff-view';
import { CHANGED_OUTSIDE_WRITE_BACK_NOTE } from '@adapter/platform/launched-files';
import type { ConfirmDiff } from '../render/app-dialog';

/**
 * 🔴 **本文が空のときの断り文**(#215 段③)。⚠ 画面に出る字なので 1 か所に置く。
 * 「空にしたいときは」まで言う ── 押して何も起きない dead click にしない。
 * ⚠ 「消したいとき」と書くと**ファイルを消す**と読める(#1264 末尾)── 言っているのは中身を空にすること。
 */
export const WRITE_BACK_EMPTY_NOTE =
  '本文が空なので、元ファイルへは書き戻しません(空にしたいときはパソコン側で空にしてください)';

/**
 * 🔴 **上書きの確認の字**(#1264 §2 欠陥 1)。⚠ `main.ts` に直書きしない(`main.ts` は
 * どの unit からも実行されない)。取り込んだ後にパソコン側で変わっていたら、**1 行足す**。
 */
export function writeBackConfirmMessage(name: string, changedOutside: boolean): string {
  return (
    `「${name}」を、いまのノートの内容で上書きします。\n\n` +
    (changedOutside ? `${CHANGED_OUTSIDE_WRITE_BACK_NOTE}\n\n` : '') +
    'ファイルの元の内容は失われます(取り消せません)。よろしいですか?'
  );
}

/** 差分を出す行数の上限(#1231 段②)。超えたぶんは「…ほか N 行」にする。 */
export const WRITE_BACK_DIFF_MAX_ROWS = 500;

/** 違いが無いときの 1 行。⚠ 押せるが**意味が無い**ことまで言う(#1231 段②)。 */
export const WRITE_BACK_SAME_NOTE =
  '違いはありません(ファイルとノートは同じ中身です。書き戻しても何も変わりません)';

/**
 * 🔴 **書き戻す前の差分**(#1231 段②)。`from` = **いまのファイルの中身**、`to` = **これから書く本文**。
 * 行の差し引きは履歴の面と同じ `diffRows`(新しい描画器・比較器を作らない)── `+` が書き込まれる行、
 * `−` が消える行。
 *
 * ⚠ `fileText` が `null`(読めない / 大きすぎる)なら **`null` を返す** ── 差分なしで今までどおりの確認。
 *   「違いはありません」と**言わない**(読めなかったのに「同じ」と言うのは嘘である)。
 * ⚠ 長いときは**先頭から** `WRITE_BACK_DIFF_MAX_ROWS` 行で切る。切った行数は畳み(`gap`)の
 *   `skipped` を含めて**行数で**数える(畳みを 1 と数えると「ほか N 行」が少なく言える)。
 */
export function buildWriteBackDiff(fileText: string | null, body: string): ConfirmDiff | null {
  if (fileText === null) return null;
  if (fileText === body) return { summary: WRITE_BACK_SAME_NOTE, rows: [], more: null };
  const { added, removed } = diffCounts(fileText, body);
  const all = diffRows(fileText, body);
  const shown = all.slice(0, WRITE_BACK_DIFF_MAX_ROWS);
  let hidden = 0;
  for (const row of all.slice(WRITE_BACK_DIFF_MAX_ROWS)) hidden += row.kind === 'gap' ? (row.skipped ?? 0) : 1;
  return {
    summary: `いまのファイルとのちがい: +${added} −${removed}(+ が書き込まれる行、− が消える行)`,
    rows: shown,
    more: hidden > 0 ? `…ほか ${hidden} 行` : null,
  };
}

/** 書き戻しの結果(`platform/launched-files.ts` の `WriteBackResult` と同じ形)。 */
export type WriteBackOutcome = { ok: true } | { ok: false; reason: string };

export interface WriteBackDeps {
  /**
   * 🔴 **飛んでいる書込が着地するまで待つ**(`connectStoreEffects().settled()`)。
   * ⚠ **必須**(上の docstring)。
   */
  readonly settle: () => Promise<void>;
  /** disk の本文を読む。⚠ 画面が持っている下書きではない。 */
  readonly getBody: () => Promise<string | null>;
  /** user のファイルへ書く。 */
  readonly write: (body: string) => Promise<WriteBackOutcome>;
  /**
   * 上書きの確認(取り消せない操作なので必ず通す)。⚠ 字は `writeBackConfirmMessage` が組んで渡す。
   * `diff` = 本文の上に出す行ごとのちがい(#1231 段②)。`null` = 出さない(ファイルを読めなかった)。
   */
  readonly confirm: (message: string, diff: ConfirmDiff | null) => Promise<boolean>;
  /**
   * 🔴 **書き戻す直前の、ファイルの今の姿**(#1264 §2 欠陥 1 / #1231 段②)。
   * `changed` = 取り込んだ後にパソコン側で変わったか / `text` = 今の中身(差分の相手)。
   * ⚠ **必須**(渡し忘れても tsc が黙る形にすると、外での直しを**黙って消す**元の欠陥が戻る)。
   * 読めない・比べられないときは `{ changed: false, text: null }`。⚠ **1 回だけ**読む(押した 1 件の、書く直前)。
   */
  readonly inspectFile: () => Promise<{ changed: boolean; text: string | null }>;
  /** 済んだことを画面へ出す。 */
  readonly done: (message: string) => void;
  /** 理由つきで断る / 失敗を出す。 */
  readonly fail: (message: string) => void;
  /** user に見せるファイル名(文言に出る)。 */
  readonly name: string;
}

/**
 * **飛んでいる書込を待つ** → disk の本文を読む → 空なら断る → 確認 →
 * (もう一度待って読み直す)→ ファイルへ書く。
 *
 * 🔴 **空の門は確認の前**に置く(#215 段③)── 空の本文を書くと元のファイルが
 *   空で上書きされる(取り消せない)。user は「空にしたまま押した」だけなので、
 *   確認の窓を出して「よろしいですか?」と聞くのではなく、**押せて、理由を言って、
 *   書かない**(ボタンを隠すと無言の dead click になる)。
 * ⚠ 門を確認の前へ置くには disk の本文が要る ── だから**待ちも確認の前に 1 回**要る
 *   (保存の直後に押しても、保存した本文で判定するため。#732 の順番と同じ向き)。
 * 🔴 **確認の後にもう一度待って読む** ── 確認の窓が開いている間に本文が変わりうる
 *   ので、**書く物そのもの**を読み直し、それにも同じ門を通す
 *   (確認の前に読んだ物を書くと、確認の間の変更を巻き戻す)。
 * ⚠ 門の判定は `isBlankBody` の 1 本(空白だけ。⚠ 設定行だけは空ではない = #1266)。
 * 🔴 **確認の前に、パソコン側で変わっていないかを読む**(#1264 §2 欠陥 1)── 変わっていたら
 *   確認の字へ 1 行足す(書き戻すと、外での直しが消える)。⚠ 止めはしない(user が選ぶ)。
 * 🔴 **同じ読みで、ファイルの今の中身も採って、確認の本文の上に差分を出す**(#1231 段②)。
 *   「取り消せない」操作の前に、**何が消えて何が書かれるか**を見せる ── 外で変わったという
 *   1 行だけでは、user は**消える変更が何か**を知れない。
 */
export async function writeBackEntry(deps: WriteBackDeps): Promise<void> {
  const readForWrite = async (): Promise<string | null> => {
    await deps.settle();
    const body = await deps.getBody();
    if (body === null) {
      deps.fail('本文が見つかりません(整理された可能性)');
      return null;
    }
    if (isBlankBody(body)) {
      deps.fail(WRITE_BACK_EMPTY_NOTE);
      return null;
    }
    return body;
  };
  const first = await readForWrite();
  if (first === null) return;
  const file = await deps.inspectFile();
  // ⚠ 見せるのは**確認の前に読んだ本文**との差 ── 確認の間に変わったら、書くのは読み直した本文(下)
  if (!(await deps.confirm(writeBackConfirmMessage(deps.name, file.changed), buildWriteBackDiff(file.text, first)))) return;
  const body = await readForWrite();
  if (body === null) return;
  const result = await deps.write(body);
  if (result.ok) deps.done(`書き戻しました: 「${deps.name}」`);
  else deps.fail(`${deps.name}: ${result.reason}`);
}
