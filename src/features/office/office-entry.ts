/**
 * 添付の器に出す **Office の入口**を決める(#88 / 統合設計 O3)。
 *
 * 🔴 user 裁定「**少なくとも閲覧はしーむれすたいけんにしたいなぁ**」──
 * ただし「シームレス」は**同じ窓に描くこと**ではなく、
 * **添付を押したら余計な手順なしで読める状態になる**ことである(設計 doc §3)。
 * したがって入口は常に同じ場所(添付の器)に置き、面は別窓で開く。
 *
 * ## この module は**決めるだけ**(描かない・開かない)
 *
 * 「何を出すか」を純粋な関数で決め、描画と実行は adapter に任せる。
 * ⚠ ここに DOM も window も持ち込まない ── そうしないと test が実機依存になる。
 */

/** 添付が Office 文書かどうかの判定に使う MIME。 */
const OFFICE_MIMES: ReadonlySet<string> = new Set([
  // OOXML
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // 旧形式
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  // ODF
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.graphics',
  'application/rtf',
]);

/** 拡張子での判定。⚠ MIME は環境によって `application/octet-stream` に落ちる。 */
const OFFICE_EXTS: readonly string[] = [
  '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt',
  '.odt', '.ods', '.odp', '.odg', '.fodt', '.fods', '.fodp', '.rtf',
];

/**
 * この添付は Office 文書か。
 *
 * 🔑 **誤差の向きを決める。** ここは「入口を出すか」を決めるだけで、
 * 押しても開けなければ Office 側が理由を出す ── つまり**取りこぼしのほうが痛い**。
 * よって **MIME か拡張子のどちらかが合えば拾う**(false-keep 側)。
 * ⚠ 逆に「どのファイルを Office で開くか」を決める場所でこの規則を流用しないこと
 * (CLAUDE.md「判定を増やさない。誤差の向きを両側に使い回さない」)。
 * ⚠ `.csv` は**入れない** ── PKC3 は csv を自前で表として描くので、
 * ここで拾うと user の動線を横取りする。
 */
export function isOfficeAttachment(mime: string, fileName: string): boolean {
  if (OFFICE_MIMES.has(mime.trim().toLowerCase())) return true;
  const name = fileName.trim().toLowerCase();
  return OFFICE_EXTS.some((ext) => name.endsWith(ext));
}

/** 実行環境に足りないもの(空なら足りている)。 */
export interface OfficeCapability {
  readonly crossOriginIsolated: boolean;
  readonly sharedArrayBuffer: boolean;
  /** `WebAssembly.Suspending` ── **JSPI**。この LibreOffice の必須条件。 */
  readonly jspi: boolean;
  readonly decompressionStream: boolean;
}

export interface OfficeEntryInput {
  readonly mime: string;
  readonly fileName: string;
  /** 一式が配備済みか(`OfficePackStore.isInstalled()`)。 */
  readonly packInstalled: boolean;
  readonly capability: OfficeCapability;
}

export type OfficeEntry =
  /** Office の添付ではない ── 何も出さない。 */
  | { readonly kind: 'none' }
  /** 押せば開ける。 */
  | { readonly kind: 'open'; readonly label: string }
  /** 一式がまだ無い ── 設置カードを出す(⚠ 勝手に取得を始めない)。 */
  | { readonly kind: 'setup'; readonly label: string; readonly reason: string }
  /** この環境では動かない ── **理由を名指しで**出す。 */
  | { readonly kind: 'unsupported'; readonly reason: string; readonly missing: readonly string[] };

/** 足りないものを、user に読める言葉で並べる。 */
export function missingCapabilities(cap: OfficeCapability): string[] {
  const out: string[] = [];
  if (!cap.crossOriginIsolated) out.push('分離(cross-origin isolation)');
  if (!cap.sharedArrayBuffer) out.push('SharedArrayBuffer');
  if (!cap.jspi) out.push('JSPI(WebAssembly の Promise 統合)');
  if (!cap.decompressionStream) out.push('DecompressionStream');
  return out;
}

/**
 * 添付の器に何を出すかを決める。
 *
 * ⚠ **順序が意味を持つ。** 「使えない環境」を「未配備」より**先**に見る ──
 * 動かない環境で「入れてください」と促すのは、user に 77MB を無駄に取らせる。
 * 🔑 そして **ボタンだけ出して押しても何も起きない、を作らない** ──
 * 出すのは常に「押せる」か「理由」のどちらかである。
 */
export function officeEntry(input: OfficeEntryInput): OfficeEntry {
  if (!isOfficeAttachment(input.mime, input.fileName)) return { kind: 'none' };

  const missing = missingCapabilities(input.capability);
  if (missing.length > 0) {
    return {
      kind: 'unsupported',
      reason: `この環境では Office 表示を使えません(足りないもの: ${missing.join(' / ')})`,
      missing,
    };
  }
  if (!input.packInstalled) {
    return {
      kind: 'setup',
      label: 'Office 表示を使えるようにする',
      reason: 'Office 表示にはひとそろい(約 77MB)が要ります。設定から入れてください。',
    };
  }
  return { kind: 'open', label: 'Office で開く' };
}

/** いまの window から能力を読む。⚠ **判定は上の純粋関数**に任せる。 */
export function readOfficeCapability(w: typeof globalThis): OfficeCapability {
  const wasm = (w as { WebAssembly?: { Suspending?: unknown } }).WebAssembly;
  return {
    crossOriginIsolated: (w as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
    sharedArrayBuffer: typeof (w as { SharedArrayBuffer?: unknown }).SharedArrayBuffer === 'function',
    jspi: typeof wasm?.Suspending === 'function',
    decompressionStream:
      typeof (w as { DecompressionStream?: unknown }).DecompressionStream === 'function',
  };
}
