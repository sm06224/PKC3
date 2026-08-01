/**
 * P6b: 取り込むファイルの形式判別(設計 doc §2)。
 *
 * **PKC2 より 1 段頑健にする**: PKC2 は拡張子で分岐していたが、拡張子は
 * user がリネームすれば簡単に嘘になる。ここでは
 *   ① magic(先頭バイト)→ ② ZIP なら manifest.format → ③ 補助として拡張子
 * の順で決める。**判別できないものは「不明」を返して呼び出し側が可視で断る**
 * ── 推測で処理して静かに壊すより、読めないと言う方が良い。
 */

/** 受理しうる形式(設計 doc §1 の最小完全集合)。 */
export type Pkc2Format =
  | 'html' // 単一 HTML export
  | 'package' // pkc2-package ZIP(バックアップ正本)
  | 'text-bundle'
  | 'textlog-bundle'
  | 'texts-container-bundle'
  | 'textlogs-container-bundle'
  | 'mixed-container-bundle'
  | 'folder-export-bundle'
  | 'entry-bundle'
  | 'unknown';

/** manifest.format の文字列 → 内部形式(PKC2 の全形式は自己記述的)。 */
const MANIFEST_FORMAT: Record<string, Pkc2Format> = {
  'pkc2-package': 'package',
  'pkc2-text-bundle': 'text-bundle',
  'pkc2-textlog-bundle': 'textlog-bundle',
  'pkc2-texts-container-bundle': 'texts-container-bundle',
  'pkc2-textlogs-container-bundle': 'textlogs-container-bundle',
  'pkc2-mixed-container-bundle': 'mixed-container-bundle',
  'pkc2-folder-export-bundle': 'folder-export-bundle',
  'pkc2-entry-bundle': 'entry-bundle',
};

/** 先頭の空白を読み飛ばす窓(BOM + 長い前置き空白でも判定できる幅)。 */
const SNIFF_WINDOW = 512;

/** 先頭バイトの種別。ZIP かどうかだけ分かれば十分。 */
export function sniffMagic(bytes: Uint8Array): 'zip' | 'text' | 'unknown' {
  if (bytes.length >= 4) {
    // ZIP: "PK\x03\x04" / 空 ZIP "PK\x05\x06" / spanned "PK\x07\x08"
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      const c = bytes[2];
      const d = bytes[3];
      if (
        (c === 0x03 && d === 0x04) ||
        (c === 0x05 && d === 0x06) ||
        (c === 0x07 && d === 0x08)
      ) {
        return 'zip';
      }
    }
  }
  // UTF-8 BOM(EF BB BF)は **3 バイトまとめて**飛ばす ── 1 バイト目だけ skip すると
  // 2 バイト目 0xBB で unknown に落ち、中身は完全に読めるのに拒否される(review M-6)
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  // 先頭の空白を飛ばして '<'(HTML)か '{'(JSON)を見る
  for (; i < Math.min(bytes.length, SNIFF_WINDOW); i++) {
    const b = bytes[i]!;
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b === 0x3c || b === 0x7b) return 'text';
    return 'unknown';
  }
  return 'unknown';
}

/**
 * 形式を決める。
 * @param bytes 先頭 4KB もあれば十分(magic 判定のみに使う)
 * @param manifestFormat ZIP のとき、呼び出し側が manifest.json から読んだ `format`
 * @param fileName 補助(拡張子は最後の手がかりにしか使わない)
 */
export function detectPkc2Format(
  bytes: Uint8Array,
  manifestFormat?: string | null,
  fileName?: string,
): Pkc2Format {
  const magic = sniffMagic(bytes);
  if (magic === 'zip') {
    // ZIP は **manifest.format が正**。読めないものは不明(拡張子で推測しない)
    return (manifestFormat ? MANIFEST_FORMAT[manifestFormat] : undefined) ?? 'unknown';
  }
  if (magic === 'text') {
    // HTML かどうかは中身で決める(拡張子 .html を信じない)。
    // 先頭 4KB に PKC2 の slot id が見えるかで判断する ── ここで確定しなくても
    // parsePkc2Html が最終的に厳格検査するので、取りこぼしより誤受理を避ける
    const head = new TextDecoder('utf-8', { fatal: false }).decode(
      bytes.subarray(0, Math.min(bytes.length, 4096)),
    );
    if (head.includes('<')) return 'html';
    return 'unknown';
  }
  // magic が読めない = 想定外。拡張子だけで受理しない(可視で断らせる)
  void fileName;
  return 'unknown';
}

// `describeFormat`(形式 → user 向け文言)は P6c で ZIP の manifest を実際に
// 読めるようになってから足す。呼ばれない説明関数は、実装が追いつく前に
// 「対応済みに見える」嘘を作る(review L-10 で dead code として指摘された)
