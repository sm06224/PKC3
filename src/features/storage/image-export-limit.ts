/**
 * 🔴 **「持ち歩ける 1 枚」が、大きさで詰まったときに言うこと**(#971 段④の残り)。
 *
 * ## 何が起きるか
 *
 * 1 枚に焼くには **DB を丸ごと 1 本の配列**にする必要がある
 * (`sqlite3_js_db_export`)。⚠ wasm は 32bit なので、数 GB は確保できない ──
 * user の保存領域が 4GB を超えたとき、ここは**必ず失敗する**。
 *
 * ## ⚠ 「大きすぎると思うので断る」を、測っていない数でやらない
 *
 * 🔑 確保できる上限は**この箱では測れない**(wasm の設定・端末の空きメモリ・
 *   他のタブの取り分で変わる)。だから**先回りして断らない** ── 試して、
 *   失敗したときに**何が起きたか**と**代わりに何を押せばよいか**を言う。
 * ⚠ 測っていない閾値で断ると、**通ったはずの端末で通らなくなる**
 *   (CLAUDE.md「未確認は assert ではなく診断で出す」と同じ向き)。
 *
 * ## 🔑 行き止まりにしない ── 代わりの道を必ず書く
 *
 * 🔴 **押す所の名前は、画面の字から引く**(2026-09-16 に踏んだ)── 1 稿目は
 * 「**一式を書き出す**」と書いたが、**その字は画面のどこにも無い**
 * (`commands.ts` の label は「**バックアップ**」)。⚠ 探しても見つからないので、
 * 断り文が**そのまま行き止まり**になっていた ── いちばん助けが要る場面で。
 * 🔑 門は `tests/features/image-export-limit.test.ts` ── **`commands.ts` から
 * label を引いて**、断り文がその字を含むことを見る(綴りを写さない)。
 *
 * 1 枚が焼けなくても、**一式の書き出し(`.pkc3-full.zip`)は通る**
 * (2026-09-16 から 4GB の壁が無い。⚠ 末尾は #1017 段④b で `.pkc3.zip` から改名)。
 * 断り文はそこへ送る。
 */
import { humanBytes } from '../human-bytes';

/**
 * 1 枚に焼けなかったときの字。
 *
 * @param bytes 測れた DB の大きさ(⚠ 測れなければ `null` ── **0 と書かない**)
 */
export function imageTooBigMessage(bytes: number | null): string {
  const size =
    bytes === null || !Number.isFinite(bytes) || bytes <= 0
      ? 'いまの中身'
      : `いまの中身(${humanBytes(bytes)})`;
  return (
    `${size}は大きすぎて「持ち歩ける 1 枚」にできませんでした。` +
    '1 枚に焼くときだけ、保存されている中身を丸ごと 1 つの塊にする必要があり、' +
    'そこが確保できませんでした。' +
    '代わりに 左の列の バックアップ(.pkc3-full.zip) をお使いください ── ' +
    'こちらは大きさで止まりません。取り込み直すこともできます。'
  );
}

/**
 * 確保に失敗した種類の error か。
 *
 * ⚠ **何でも「大きすぎる」と言わない** ── 別の理由(DB が壊れている等)まで
 *   この字で覆うと、user は**在りもしない原因**を追うことになる。
 * 🔑 sqlite-wasm は確保の失敗を `WasmAllocError` と名乗り、JS 側の確保は
 *   `RangeError`(配列が大きすぎる)になる ── その 2 つだけを拾う。
 */
export function looksOutOfMemory(err: unknown): boolean {
  if (err instanceof RangeError) return true;
  const name = err instanceof Error ? err.name : '';
  const text = err instanceof Error ? err.message : String(err);
  return (
    name === 'WasmAllocError' ||
    /WasmAllocError|out of memory|Out of memory|Array buffer allocation failed|Invalid (array buffer|typed array) length/.test(
      text,
    )
  );
}

/**
 * 🔴 **もう 1 つの天井 ── 「焼けた」と「読み戻せる」は別である**(#996)。
 *
 * ## なぜこれが要るのか
 *
 * ⚠ この file の上のほうは「**測っていない数で断らない**」と書いてある。
 * 🔑 **その判断は、確保の上限については正しい**(端末で変わるので測れない)。
 * 🔴 **しかし天井は 2 つあって、もう 1 つを数え落としていた。**
 *
 * 焼き込んだ base64 は、読み戻すとき **1 本の JavaScript 文字列**になる
 * (`portable-boot.ts` の `textContent` / `portable-assets.ts` の `textContent`)。
 * ⚠ 文字列には**上限**があり、**これは端末で変わる種類の数ではなく、実測できる定数**である。
 *
 * ## 実測(2026-09-16、この箱の V8)
 *
 * | 長さ | |
 * |---|---|
 * | 536,870,880 字 | 🟢 通る |
 * | 536,870,912 字 | 🔴 `RangeError: Invalid string length` |
 *
 * V8 の定数は 64bit で `(1 << 29) - 24` ── 上の実測はその間に挟まっている。
 * ⚠ **32bit の環境では更に小さい**(`(1 << 28) - 16`)。
 *
 * ## 🔴 なぜ「いちばん甘い側」を採るのか
 *
 * ⚠ **焼く端末と、開く端末は別**である ── だから焼く側で実測しても、
 *   開く側の答えにはならない。
 * 🔑 だから **64bit の上限**を採る:**どの端末でも読めない物だけを断る**。
 *   ⚠ これより小さい端末で開けないことは在りうるが、それは
 *   **もともと断りようがない**(先回りして断ると、開ける端末でも断ることになる)。
 *
 * ## ⚠ ここで断らないと何が起きるか
 *
 * 書く側は base64 を**刻んで `Blob` にする**ので、**天井を超えても書けてしまう** ──
 * 🔴 user は「バックアップを取った」と思い、**必要になった日に初めて開けないと知る**。
 */
export const MAX_EMBED_TEXT_CHARS = (1 << 29) - 24;

/**
 * bytes を base64 にしたときの**字数**。
 *
 * ⚠ **4/3 ではなく「3 バイトごとに 4 字」**である ── 端数は詰め物で埋まるので
 *   切り上げる(`Math.ceil`)。⚠ 逆向き(3/4)に書くと**天井が 1.78 倍に緩む**。
 */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * その bytes を 1 つの `<script>` に焼いたら、**読み戻せなくなる**か。
 *
 * 🔑 境目は **`MAX_EMBED_TEXT_CHARS × 3/4` = 402,653,166 バイト(約 384 MiB)**。
 */
export function tooBigToReadBack(bytes: number): boolean {
  return base64Length(bytes) > MAX_EMBED_TEXT_CHARS;
}

/**
 * 読み戻せない大きさだったときの字。
 *
 * ⚠ **`imageTooBigMessage` と混ぜない** ── あちらは「**確保できなかった**」、
 *   こちらは「**焼けるが開けない**」であり、**user にとって別の出来事**である
 *   (あちらは何も起きていない / こちらは放っておくと**壊れたバックアップが残る**)。
 *
 * @param what 何が大きすぎたか(「いまの中身」「添付」など、user の言葉で)
 */
export function tooBigToReadBackMessage(what: string, bytes: number): string {
  return (
    `${what}(${humanBytes(bytes)})は「持ち歩ける 1 枚」に入れられません。` +
    '1 枚に焼いた中身は、開くときに丸ごと 1 つの文字列として読み直す必要があり、' +
    `そこに入る上限(約 ${humanBytes(Math.floor((MAX_EMBED_TEXT_CHARS * 3) / 4))})を超えています。` +
    'このまま焼くと、ファイルはできても二度と開けません。' +
    '代わりに 左の列の バックアップ(.pkc3-full.zip) をお使いください ── ' +
    'こちらは大きさで止まりません。取り込み直すこともできます。'
  );
}
