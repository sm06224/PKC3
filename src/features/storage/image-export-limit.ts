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
    `${size}は大きすぎて「PKC3 入り HTML」にできませんでした。` +
    'PKC3 入り HTML にするときだけ、保存されている中身を丸ごと 1 つのデータにする必要があり、' +
    'そこが確保できませんでした。' +
    '代わりに 左のペインの バックアップ(.pkc3-full.zip) をお使いください。' +
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
 * 焼き込んだ物は、読み戻すとき **1 本の JavaScript 文字列**になる経路が残っている。
 * ⚠ 文字列には**上限**があり、**これは端末で変わる種類の数ではなく、実測できる定数**である。
 *
 * ## 🔑 何が 1 本の文字列になるか(#1416 §7-4 で DB 画像を割ってから、場所によって違う)
 *
 * | 読む場所 | 1 本になる物 | この上限が効くか |
 * |---|---|---|
 * | **取り込み**(`features/import/portable-html.ts`) | **HTML ファイル全体**(`File.text()`) | 🔴 効く(DB 画像を割っても、ファイル全体は 1 本) |
 * | **開く**(`portable-boot.ts`)の DB 画像 | 3MiB ごとの要素 1 つ | 効かない(割ってある。割る前の版が焼いた 1 本物は効く) |
 * | **開く**(`portable-assets.ts`)の添付 | 3MiB ごとの要素 1 つ | 効かない(割ってある。#1416 §7-4d。割る前の版が焼いた 1 本物は効く) |
 *
 * ⚠ だから**ここの門は残している**(安全側)。ただし理由は「開けない」だけではない ──
 *   DB 画像は**開く**ことはできても、**取り込み直せない** 1 枚になりうる。
 *   門の数は DB 画像の bytes を base64 にした字数で見ており、ファイル全体(アプリ本体 約 12MB と
 *   添付を足した字数)ではないので、**ファイル全体の上限そのものではない**(近似)。
 *   添付は断らない。合計(雛形 + DB 画像 + 添付)が超えたら全部焼いて 1 度だけ警告する(`notImportableBackMessage`)。
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
    `${what}(${humanBytes(bytes)})は「PKC3 入り HTML」に入れられません。` +
    'PKC3 入り HTML にした中身は、開くときや取り込み直すときに丸ごと 1 つの文字列として読み込む必要があり、' +
    `そこに入る上限(約 ${humanBytes(Math.floor((MAX_EMBED_TEXT_CHARS * 3) / 4))})を超えています。` +
    'このまま作ると、ファイルはできても、開けない・取り込み直せないことがあります。' +
    '代わりに 左のペインの バックアップ(.pkc3-full.zip) をお使いください。' +
    'こちらは大きさで止まりません。取り込み直すこともできます。'
  );
}

/**
 * 焼いた **ファイル全体**が、取り込み直すときに読める上限を超えたときの字(#1416 §7-4d)。
 *
 * ⚠ 添付は割って焼くので、**開く**ことは大きさで詰まらない ── 中身は 1 つも落としていない。
 *   詰まるのは取り込み直し(`File.text()` が 1 本の文字列にする)だけなので、**開けることを先に言う**。
 * ⚠ `tooBigToReadBackMessage` と混ぜない(あちらは「焼かなかった」、こちらは「全部焼いた」)。
 * @param chars 焼いたファイルのおよその字数(≒ bytes)
 */
export function notImportableBackMessage(chars: number): string {
  return (
    `この PKC3 入り HTML(約 ${humanBytes(chars)})は開けますが、PKC3 に取り込み直せないことがあります` +
    `(取り込み直すときに読める上限は約 ${humanBytes(Math.floor((MAX_EMBED_TEXT_CHARS * 3) / 4))}です)。` +
    'データを移すときは、左のペインの バックアップ(.pkc3-full.zip) をお使いください。' +
    'こちらは大きさで止まりません。'
  );
}
