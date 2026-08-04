/**
 * 取り込んだ HTML の**文字コードを見つける**(P8 段⑭)。
 *
 * 🔴 これは実測で見つけた欠損である。起動経路は `blob.text()` を通っていたが、
 * `Blob.text()` は **UTF-8 固定 decode** で、外殻が `<meta charset="utf-8">` を
 * 宣言するため srcdoc 文書の encoding は**外殻から継承**される ── アプリ自身の
 * `<meta charset>` は 1 ミリも効かない。実測:
 *
 * ```
 * <meta charset="shift_jis"> の Shift_JIS ファイル(本文「日本語」)
 *   直接開く: characterSet=Shift_JIS  codes=[26085,26412,35486]   ← 読める
 *   srcdoc  : characterSet=UTF-8      codes=[65533,65533,65533,…] ← 不可逆に化ける
 * ```
 *
 * UTF-16 が通っていたのは `blob.text()` の **BOM 判別に救われた**だけで、
 * BOM の無い Shift_JIS / EUC-JP には救い手がいない。手元の HTML アプリを
 * Shift_JIS で保存してある領域は実在するので、ここは塞ぐ。
 *
 * 🔑 **pure module**。bytes を受け取ってラベルを返すだけ(decode は呼び側)。
 */

/** BOM。⚠ 先頭バイト列そのもので見る(decode 後の文字で見ては遅い)。 */
const BOMS: readonly { bytes: readonly number[]; label: string }[] = [
  { bytes: [0xef, 0xbb, 0xbf], label: 'utf-8' },
  { bytes: [0xff, 0xfe], label: 'utf-16le' },
  { bytes: [0xfe, 0xff], label: 'utf-16be' },
];

/**
 * `<meta>` を探す範囲。HTML 仕様の prescan は先頭 1024 バイトまでと決めており、
 * ブラウザもそこで打ち切る ── **同じ範囲にする**(ブラウザが見つけないものを
 * こちらが見つけると、「直接開いたときと違う」がまた生まれる)。
 */
const PRESCAN_BYTES = 1024;

/**
 * 使えるラベルか(`TextDecoder` が受けるか)を確かめる。
 * ⚠ 知らないラベルで `TextDecoder` を作ると **RangeError で起動ごと落ちる**ので、
 * ここで確かめてから返す。
 */
function usable(label: string): boolean {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

/**
 * bytes から文字コードのラベルを決める。見つからなければ `'utf-8'`。
 *
 * 順番はブラウザと同じ ── ① BOM ② `<meta charset>` / `<meta http-equiv>` ③ 既定。
 * ⚠ ②の prescan は **ASCII 互換の範囲でしか読めない**ので、`latin1` で読んでから
 * 正規表現に掛ける(UTF-8 で decode すると壊れたバイトが置換文字になり、
 * 後ろの `<meta>` を見失う)。
 */
export function detectHtmlCharset(bytes: Uint8Array): string {
  for (const bom of BOMS) {
    if (bom.bytes.every((b, i) => bytes[i] === b)) return bom.label;
  }
  const head = bytes.subarray(0, PRESCAN_BYTES);
  let text = '';
  for (const b of head) text += String.fromCharCode(b);

  // `<meta charset="…">`
  const direct = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(text);
  if (direct?.[1] !== undefined && usable(direct[1])) return direct[1].toLowerCase();

  // `<meta http-equiv="content-type" content="…; charset=…">` も同じ正規表現で拾える。
  // ⚠ **別の規則を書かない** ── 2 通り書くと片方だけが直る(この repo の規律)
  return 'utf-8';
}

/**
 * bytes を**アプリ自身の宣言どおりに**文字列へ。
 * ⚠ BOM は落とす(`ignoreBOM: false` が既定 = 落ちる)── 残すと本文の先頭に
 * 見えない文字が付き、`<!doctype>` の判定が外れる。
 */
export function decodeHtml(bytes: Uint8Array): string {
  const label = detectHtmlCharset(bytes);
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // ⚠ 読めない宣言でも**中身は出す**(白紙にしない)
    return new TextDecoder('utf-8').decode(bytes);
  }
}
