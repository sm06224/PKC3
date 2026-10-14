/**
 * 🔴 **取り込む文字の file を、文字コードを見分けて読む**(#1087、取り込みの見直し)。
 *
 * ⚠ 直す前は `file.text()`(UTF-8 固定)で読んでいたので、Shift_JIS の .vcf(日本の携帯電話の書き出しは
 *   これが普通)や UTF-16 の .md / .ics は、題名も本文も `�` だらけのまま**黙って**取り込まれていた。
 *
 * 🔑 順番:① 先頭の BOM で決まるものは BOM に従う(UTF-8 / UTF-16LE / UTF-16BE)①' BOM の無い UTF-16 を NUL の並びで見分ける ② 無ければ UTF-8 として
 *   **厳密に**読み、1 バイトでも読めなければ ③ Shift_JIS として読む。
 * ⚠ ③でも読めない字が残るときは、UTF-8 の読み(`�` 入り)を返す ── 直す前と同じ結果より悪くしない。
 * ⚠ 純関数(`TextDecoder` だけを使う)。
 */
export function decodeImportText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  const bomless = utf16WithoutBom(bytes);
  if (bomless !== null) return new TextDecoder(bomless).decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    /* UTF-8 ではない ── 下で Shift_JIS を試す */
  }
  try {
    return new TextDecoder('shift_jis', { fatal: true }).decode(bytes);
  } catch {
    // どちらでも読み切れない ── 直す前と同じ読み(読めない字は `�`)にする
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * BOM の無い UTF-16 を見分ける(メモ帳の古い書き出しなど)。
 * ⚠ NUL は UTF-8 としても正しいバイトなので、厳密な UTF-8 の読みを素通りしてしまう ── 先に見る。
 * 🔑 文字の file に NUL はまず出ない。先頭 4096 バイトで、偶数位置か奇数位置の片側だけに NUL が
 *   3 割以上並んでいれば UTF-16 とみなす(ASCII が混じる UTF-16 は、片側がほぼ全部 NUL になる)。
 */
function utf16WithoutBom(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const n = Math.min(bytes.length, 4096) & ~1;
  if (n < 4) return null;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) even++;
    if (bytes[i + 1] === 0) odd++;
  }
  const pairs = n / 2;
  if (odd >= pairs * 0.3 && even === 0) return 'utf-16le';
  if (even >= pairs * 0.3 && odd === 0) return 'utf-16be';
  return null;
}

/** `File` / `Blob` から読む口(取り込みの 3 経路が通る 1 本)。 */
export async function readImportText(file: Blob): Promise<string> {
  return decodeImportText(new Uint8Array(await file.arrayBuffer()));
}
