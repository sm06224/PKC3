/**
 * 🔴 **本文に図案を置く字**(`:home:` → 家の絵。#853 段①、2026-09-13)。
 *
 * ## 何を求められていたか(user 指示 2026-09-12。こちらの解釈)
 *
 * 図案が使えるのは **PKC が描く所**(ボタン / タブ / 一覧の行の頭 / アプリのタイル)
 * だけで、**user が自分のノートの本文に置く道が 1 つも無かった**。
 * 書体(76 種)も選ぶ表(49 種)も**既に入っていた**ので、足りないのは
 * **本文との間の 1 本**だけである。
 *
 * ## ⚠ 受けるのは**表に在る 49 語だけ**(user 裁定 2026-09-12)
 *
 * `:` で囲む形は**絵文字の短縮記法**として世に広く在る(`:smile:` / `:+1:`)ので、
 * 受ける語を広げると **user が前から書いていた字が、ある日勝手に絵に変わる**。
 * 🔑 だから受けるのは `TILE_ICON_CHOICES`(押して選べる 49 種)**だけ**で、
 *   それ以外は**字のまま**にする。
 *
 * ⚠ ここは `PKC_SYMBOLS`(76 種)を読まない ── あちらは「打てば当たる」表で、
 *   `trash`(削除)`close`(やめる)のように**操作の意味が固まった絵**を含む。
 *   本文に `:trash:` と書けてしまうと、読む人には**押せる物**に見える。
 * 🔑 **押して選べる物と、打って当たる物を、本文では同じにする** ── 挿し込まれる
 *   字がそのまま手で打てる字である(user 裁定「書き方を案内する」)。
 *
 * ## ⚠ 索引は原文のまま(#853 の「検索に引っかかるか」)
 *
 * 絵に置き換えるのは**描くときだけ**で、保存も索引も `:home:` のままである
 * ── だから「home」で引ける。ここは**純関数だけ**を置き、DOM を知らない。
 */
import { TILE_ICON_CHOICES } from './tile-icons';
import type { IconName } from './symbols';

/**
 * 受ける語の対応表(名前 → 画面に出す日本語)。
 *
 * ⚠ **`TILE_ICON_CHOICES` から作る** ── 語を手で並べ直すと、絵を 1 つ足した日に
 *   **片方だけ増える**(CLAUDE.md §7「同じ判定が複数の場所にある」)。
 */
const LABELS: ReadonlyMap<string, string> = new Map(
  TILE_ICON_CHOICES.map((c) => [c.name as string, c.label]),
);

/** 語に使える字。⚠ **小文字と数字と `-` だけ**(`check-box` が唯一の `-` 入り)。 */
const NAME_RE = /^:([a-z][a-z0-9-]{0,23}):/;

export interface IconShortcode {
  /** 図案の名前(内部語)。 */
  readonly name: IconName;
  /** 画面に出す名前(日本語)。⚠ 読み上げに使う。 */
  readonly label: string;
  /** 消費する字数(`:` を含む)。 */
  readonly length: number;
}

/**
 * `src[start..]` の先頭が図案の字なら読む。
 *
 *   iconShortcodeAt(':home: へ帰る', 0) → { name: 'home', label: '家', length: 6 }
 *   iconShortcodeAt(':smile:', 0)       → null(表に無い ── 字のまま)
 *   iconShortcodeAt(':sup:[2]', 0)      → null(下の「役の字に手を出さない」)
 *
 * ⚠ **`[` か `{` が続くときは受けない。** `:role:[content]{attrs}` は既に在る
 *   記法(`inline-role-parser.ts`)で、`:list:[…]` のように**語がぶつかりうる**。
 *   🔑 先に在る記法を壊さない ── 動線を 1 つも減らさない(user 裁定 2026-08-07)。
 */
export function iconShortcodeAt(src: string, start: number): IconShortcode | null {
  if (src.charCodeAt(start) !== 0x3a /* : */) return null;
  const m = NAME_RE.exec(src.slice(start));
  if (m === null) return null;
  const name = m[1]!;
  const label = LABELS.get(name);
  if (label === undefined) return null;
  const after = src.charCodeAt(start + m[0]!.length);
  // 0x5b = `[` / 0x7b = `{`
  if (after === 0x5b || after === 0x7b) return null;
  return { name: name as IconName, label, length: m[0]!.length };
}

/** 本文へ挿し込む字を組む。⚠ **挿す側と読む側で綴りを分けない**(§7)。 */
export function iconShortcodeFor(name: string): string {
  return `:${name}:`;
}

/** その語を本文で受けるか。⚠ 表を呼び側に読ませない(§7)。 */
export function isBodyIconName(name: string): boolean {
  return LABELS.has(name);
}
