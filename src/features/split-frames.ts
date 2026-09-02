/**
 * 🔴 **読む面を横に並べて、枠ごとに別のノートを出す**(#505 段②。user 指示 2026-08-28)。
 *
 * > 「**ウルトラワイドモニター用に閲覧時にセンターペインを任意分割して、
 * > 複数ドキュメントを開いたり**、一つの縦に長いドキュメントを分割ウィンドウ全体で
 * > スクロールしながら見るオプションが欲しい**」
 *
 * ここは前半 ──「**枠ごとに別のノート**」。⚠ 後半(1 本の本文が枠へ流れる新聞の
 * 段組み)は段① で、`read-columns.ts` が持っている**別物**である。
 * 🔑 **同じ「分割」でも中身が違う** ── 混ぜると設計を外す(#505 本文)。
 *
 * ## 🔑 枠は「主 1 つ + 留めたもの」である
 *
 * | 枠 | 何が出るか | 変わるとき |
 * |---|---|---|
 * | **主**(いちばん左) | `selectedLid` = **いま見ているノート** | 一覧を押すたび |
 * | **留めた枠** | ここに入れたノート | **user が留める / 外すときだけ** |
 *
 * ⚠ **一覧を押しても留めた枠は動かない** ── 動くと「横に並べて突き合わせる」が
 * 成立しない(押した瞬間に相手が消える)。user の物語は
 * 「**資料を横に並べて突き合わせながら読む**」(#505 本文)である。
 *
 * ## 🔴 置けるなら、外せる(user 指示 2026-08-23。不可侵)
 *
 * > 「**なんで双方向にする発想がでねぇんだよ!**」
 *
 * だから `pin` と `unpin` を**対で**置く。⚠ 片道にすると、間違えて留めた物を
 * 外す道が無くなる(= 動線を 1 つ失う)。
 *
 * ## ⚠ 「2 枠固定」にしない
 *
 * #505 本文が名指しで戒めている ──「🔴 **分割数は user が決める(「任意分割」)
 * ── 2 固定にしない**」。だから状態は**並び**で持ち、上限だけ置く。
 * 🔑 上限を置く理由は `read-columns.ts` と同じで、**枠が細くなりすぎると読めない**から
 * である(幅を選ばせず、数を選ばせる)。
 *
 * ⚠ **pure module**。browser API を使わない(保存と DOM は adapter 側)。
 */

import { READ_COLUMN_GAP_PX, readColumnMinPx } from './read-columns';

/**
 * 🔴 **枠の総数の上限**(主 1 + 留め 3)。
 *
 * ⚠ `READ_COLUMN_CHOICES` が 1〜4 段なのに揃えてある ── **同じ器を割る話**なので、
 * 上限が違うと「4 段は選べるのに 4 枠は置けない」という説明のつかない差になる。
 */
export const SPLIT_FRAME_MAX = 4;

/** **横に出せる**数(= 総数 − 主 1)。⚠ 積める数(`STACK_MAX`)とは別物である。 */
export const SPLIT_PINNED_MAX = SPLIT_FRAME_MAX - 1;

/**
 * 🔴 **スタックに積める数**(#633 段①。user 裁定 2026-09-02「4 問とも A」)。
 *
 * ⚠ **横に出せる数(`SPLIT_PINNED_MAX` = 3)と分ける** ── 直す前は同じ数だったので、
 *   4 件目を載せようとすると「横に並べられるのは 3 件までです」と断られていた。
 *   🔑 裁定④「新しく載せた物が本文のすぐ隣に来る」= **載せるのはいつでも通り、
 *   横に出るのは先頭から入るぶんだけ**である(出ない物は帯に札で残る)。
 * ⚠ それでも上限は要る ── 無限に積むと帯が読めなくなり、端末の保存も膨らむ。
 *   20 は「帯 1 行に札が並ぶ現実的な数」であって、測って決めた数ではない。
 */
export const STACK_MAX = 20;

/**
 * 枠と枠のすき間(px)。
 * ⚠ **2 つ目の 16 を書かない**(CLAUDE.md §7)── 段組みのすき間と**同じ `--s5`** である。
 */
export const SPLIT_FRAME_GAP_PX = READ_COLUMN_GAP_PX;

/**
 * 🔴 **留めた枠が飾りに取られる幅**(px。#608)。
 *
 * 留めた枠だけ `border-left: 1px` + `padding-left: var(--s5)` が付く
 * (`app.css` の `[data-pkc-split-lid]`)。⚠ `box-sizing: border-box` なので、
 * これは**枠の中身から引かれる** ── 数えないと、判定より**中身が狭い**枠が並ぶ。
 *
 * 🔴 **実測(2026-08-30)**:窓 1428px / 面の中身 915px で、判定は
 * 「2 枠入る」(448×2 + 16 = 912 ≤ 915)なのに、実際の中身は**両枠とも 441px** ──
 * **下限を 7px 割っていた**。飾りを数えると 448×2 + 16 + 17 = 929 > 915 で畳む。
 * ⚠ #608 は「~11px 足りない計算」と書いていたが、**実測は 7px** である
 * (`flex-basis: 0` は飾りを**中身の外**へ置くので、痩せるのは 1 枠ぶんだけ)。
 *
 * ⚠ **16 を 2 つ目に書かない** ── 余白は gap と**同じ `--s5`** である。
 */
export const SPLIT_PINNED_CHROME_PX = 1 + SPLIT_FRAME_GAP_PX;

/**
 * 留めた並びを整える ── **空を捨て、重複を捨て、上限で切る**。
 *
 * ⚠ **主の lid は捨てない** ── 同じノートを主と留めた枠の両方に出すのは
 * 「長い文書の 2 か所を見比べる」で実際に要る(user が選んだ形を、こちらの
 * 都合で禁じない)。
 *
 * @param lids 留めたい並び(順は「留めた順」)
 */
export function normalizeSplitLids(lids: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const lid of lids) {
    if (typeof lid !== 'string' || lid === '') continue;
    if (out.includes(lid)) continue;
    out.push(lid);
    // ⚠ 切るのは**積める上限**(`STACK_MAX`)── 横に出せる数で切ると、
    //    帯に残すはずの札まで捨てる(#633 段①)
    if (out.length >= STACK_MAX) break;
  }
  return out;
}

/**
 * 🔴 **スタックに載せる ── 先頭が一番上**(#633 段①。user 裁定 2026-09-02 ②④)。
 *
 * ⚠ 直す前は**末尾に足し**、既に在れば**並びを変えなかった**。裁定は
 *   「**新しく載せた物が本文のすぐ隣に来て、それまで隣に在った物は右へずれる**」
 *   なので、**先頭へ入れる**。既に在る物を載せ直したときは**先頭へ上げる**
 *   (押したのに何も起きない、を作らない ── 直す前は無反応だった)。
 * ⚠ **件数は増えない**(上げるだけ)── 対照群として test に置く。
 * ⚠ 上限(`STACK_MAX`)に達していたら**足さない** ── いちばん古いものを黙って
 *   落とすと「押したのに増えず、別の物が消えた」になる(呼び側が満杯を user に言う)。
 */
export function pinSplitLid(cur: readonly string[], lid: string): readonly string[] {
  if (lid === '') return cur;
  // 🔑 既に一番上なら**同じ配列をそのまま返す**(描き直しの指紋を動かさない)
  if (cur[0] === lid) return cur;
  if (cur.includes(lid)) return normalizeSplitLids([lid, ...cur]);
  if (cur.length >= STACK_MAX) return cur;
  return normalizeSplitLids([lid, ...cur]);
}

/** 外す。⚠ 居なければ**同じ配列をそのまま返す**(描き直しの指紋を動かさない)。 */
export function unpinSplitLid(cur: readonly string[], lid: string): readonly string[] {
  return cur.includes(lid) ? cur.filter((l) => l !== lid) : cur;
}

/**
 * 🔴 **消えたノートを指し続けない**。
 *
 * ⚠ 留めたノートを消すと、その枠は**開けない lid** を指したままになる。
 * 🔑 呼び側(描く直前)で当てる ── 保存した並びは触らずに、**出す前に落とす**
 * (⚠ 保存を書き換えると、別のタブで消したものが**こちらの留めも巻き添えで消える**)。
 */
export function knownSplitLids(
  lids: readonly string[],
  known: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): readonly string[] {
  const has = (l: string): boolean => ('has' in known ? known.has(l) : false);
  return lids.every(has) ? lids : lids.filter(has);
}

/**
 * 🔴 **その器で、実際に何枠出せるか**(#505「狭い画面で壊れない」)。
 *
 * ⚠ 段組み(`columnsFit`)と**判定の形が違う**。あちらは「2 段置けなければ
 * 段組みごと止める」= **全か無か**だが、こちらは**枠を減らす**:
 * 留めた 3 枚が入らない画面でも、1 枚なら並べられる ── そこで丸ごと 1 枠へ
 * 落とすと、**user が留めたものが画面から消える**(= さっきまでやっていたことが消える)。
 *
 * ⚠ 減らすのは**後ろから** ── 並びは「留めた順」なので、**先に留めた物が残る**。
 * 🔑 減らしたことは呼び側が user に言う(黙って消さない ── #551 で
 * 「黙って解除される」を実害として直したのと同じ規律)。
 *
 * @param paneWidth 読む面の器の幅(px)
 * @param wanted 出したい枠の総数(主 + 留め)
 * @param fontPx 本文の器の `font-size`(px)。⚠ 既定値を持たせない(#509 と同じ)
 */
export function fittingSplitFrames(paneWidth: number, wanted: number, fontPx: number): number {
  const want = Math.min(Math.max(Math.floor(wanted), 1), SPLIT_FRAME_MAX);
  if (want <= 1) return 1;
  if (!Number.isFinite(paneWidth) || paneWidth <= 0) return 1;
  const min = readColumnMinPx(fontPx);
  for (let n = want; n >= 2; n -= 1) {
    /**
     * ⚠ **飾りも引く**(#608)── 留めた枠は n − 1 枚あり、それぞれ
     * `border-left` + `padding-left` を**中身の外**に持つ。
     * 🔑 数えないと「入る」と読んで**下限を割った枠**を並べる(実測 441px)。
     */
    const need = min * n + (SPLIT_FRAME_GAP_PX + SPLIT_PINNED_CHROME_PX) * (n - 1);
    if (paneWidth >= need) return n;
  }
  return 1;
}

/** 保存の形(1 行)。⚠ lid に空白は無いので空白区切りで足りる。 */
export function serializeSplitLids(lids: readonly string[]): string {
  return normalizeSplitLids(lids).join(' ');
}

/** 保存から読む。⚠ 壊れていても**例外を投げない**(起動を止めない)。 */
export function parseSplitLids(raw: string | null | undefined): readonly string[] {
  if (typeof raw !== 'string' || raw === '') return [];
  return normalizeSplitLids(raw.split(/\s+/));
}
