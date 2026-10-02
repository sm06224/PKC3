/**
 * 添付の先頭の bytes が**字として読めるか**を、字として出す前に見る(#1220)。
 *
 * > 何が起きていたか:添付の種類(mime)が `text/*` と登録されていると、画面は
 * > 先頭 200KB をそのまま字にして `<pre>` へ出していた。⚠ **種類は信じられない値**である
 * > ── 取り込む側が名乗らせた値(自動操作が `type: 'text/plain'` と渡した PDF など)で、
 * > bytes の持ち主が言った物ではない。PDF の生の bytes(`%PDF-1.7 %äüöß …`)が
 * > 画面に字で出た。
 *
 * 🔑 **種類ではなく中身を見る**。見るのは 3 つだけ ── ① 先頭の**印**(PDF / 画像 / zip)
 * ② **NUL**(字の文書は持たない)③ **UTF-8 として読めない割合**。
 * ⚠ **誤爆しない向きに倒す**:BOM つき / CRLF / 日本語 / 空は全部「字」。
 * 判定に使うのは先頭だけ(呼び側が渡す塊)── 全量を読まない(heap に載せない規律)。
 *
 * ⚠ **pure module**(`TextDecoder` は標準語で browser API ではない ── 他の features
 * 層も使っている)。bytes を受けて答えを返すだけで、DOM も Blob も触らない。
 */

/** 印で言い当てた中身の種類。`null` = 印には当たらなかったが、字でもない。 */
export type SniffedKind = 'pdf' | 'png' | 'jpeg' | 'gif' | 'zip';

export type TextSniff =
  /** 字として出してよい。`text` は decode 済み(呼び側が 2 度 decode しない)。 */
  | { kind: 'text'; text: string }
  /** 字ではない。`guess` は印で分かったときだけ(分からなければ `null`)。 */
  | { kind: 'binary'; guess: SniffedKind | null };

/** 先頭の印。⚠ 並びは判定の順番ではない(どれも先頭の数 byte で互いに排他)。 */
const SIGNATURES: readonly { kind: SniffedKind; bytes: readonly number[] }[] = [
  { kind: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { kind: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] }, // \x89PNG
  { kind: 'jpeg', bytes: [0xff, 0xd8] },
  { kind: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { kind: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] }, // PK\x03\x04(docx / xlsx も)
];

/**
 * UTF-8 として読めなかった字(U+FFFD)の割合がこれを超えたら字ではない。
 *
 * 🔑 値の根拠:普通の文書に紛れる壊れた字は**数個**(1% に届かない)。一方、
 *   別の文字コード(Shift_JIS)や圧縮物は**半分前後**が読めない。その間の 5% に置く。
 * ⚠ 字の側に誤爆するより**字でない側へ倒す**ほうが害が小さい ── 倒れた先は
 *   「ダウンロードして開いてください」で、道は残る(読めない字の羅列を出さない)。
 */
const BROKEN_RATIO = 0.05;

/**
 * 先頭の bytes を見て、字として出してよいかを答える。
 *
 * @param head 先頭の塊(200KB 程度。全量でなくてよい)
 * @param truncated `head` が全体の**先頭だけ**か ── 末尾で切れた多 byte の字を
 *   「壊れている」と数えないために要る(切っただけの文書を字でないと言わない)
 */
export function sniffText(head: Uint8Array, truncated: boolean): TextSniff {
  for (const s of SIGNATURES) {
    if (head.length >= s.bytes.length && s.bytes.every((b, i) => head[i] === b)) {
      return { kind: 'binary', guess: s.kind };
    }
  }
  if (head.includes(0)) return { kind: 'binary', guess: null };
  // ⚠ `stream: true` = 末尾の**途切れた多 byte 列を保留する**(U+FFFD にしない)。
  //   全体が入っているときは保留せず、末尾の欠けも壊れとして数える
  const text = new TextDecoder('utf-8').decode(head, { stream: truncated });
  if (text.length === 0) return { kind: 'text', text };
  let broken = 0;
  for (let i = text.indexOf('�'); i !== -1; i = text.indexOf('�', i + 1)) broken++;
  return broken / text.length > BROKEN_RATIO
    ? { kind: 'binary', guess: null }
    : { kind: 'text', text };
}

/**
 * 印で分かった種類を、**本来の見せ方**へ回す(#1220)。
 *
 * ⚠ `null` = 回せない(zip は画面に出す枝が無い / 印が無かった)── 呼び側が断る。
 * ⚠ mime は**付け替える先**(`<object>` はリソースの種類を見るので、登録のままでは
 *   文字として開かれる)。画像は種類の違いで描き方が変わらないので、印のとおりに付ける。
 */
export function sniffedPreview(
  guess: SniffedKind | null,
): { kind: 'image' | 'pdf'; mime: string } | null {
  switch (guess) {
    case 'pdf':
      return { kind: 'pdf', mime: 'application/pdf' };
    case 'png':
      return { kind: 'image', mime: 'image/png' };
    case 'jpeg':
      return { kind: 'image', mime: 'image/jpeg' };
    case 'gif':
      return { kind: 'image', mime: 'image/gif' };
    default:
      return null;
  }
}
