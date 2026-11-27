/**
 * 🔴 **ウィジェット(sandbox iframe)のファイルの入出力の契約**(v4.1 Phase 1 / PR-4、#2097)。
 *
 * 箱は `sandbox="allow-scripts"` のみ(`allow-downloads` も付けない)なので、箱の中から直接は
 * ファイルを保存できず、ファイルを選ぶ画面も開けない。箱は**親へ頼む**(`postMessage`)だけで、
 * 親は確認バーで user が押したときだけ保存する / 選ばせる。
 *
 * ## ここに置く物(DOM に依存しない純関数)
 *
 * - メッセージの型名(箱 → 親の要求・親 → 箱の答え)
 * - 上限(大きさ・件数・流量・待ち時間)
 * - ファイル名の無害化(`safeName` の 1 本を使う ── 2 本目を書かない)と要注意の拡張子
 * - 要求の検証(壊れた要求・大きすぎる要求を親の手前で断る)
 * - 流量の上限(1 つの箱につき 1 秒に 3 回まで)
 * - 答えの組み立て
 *
 * 🔑 閲覧用 HTML(`pkc3-html.ts`。次の PR)・ポータブル ZIP でも**同じ 1 本の契約**を使えるよう、
 *   画面(確認バー)は adapter の薄い層(`adapter/ui/render/widget-io-bar.ts`)に置き、判断はここに置く。
 */
import { safeName } from '../export/file-name';
import { humanBytes } from '../human-bytes';

/** 保存の要求(箱 → 親):`{ type, id, reqId, name, mime, data }`。 */
export const WIDGET_DL_REQ_MSG_TYPE = 'pkc-widget-dl-req';
/** 保存の答え(親 → 箱):`{ type, reqId, ok, action, reason? }`。 */
export const WIDGET_DL_RES_MSG_TYPE = 'pkc-widget-dl-res';
/** 読み込みの要求(箱 → 親):`{ type, id, reqId, accept?, multiple?, maxBytes? }`。 */
export const WIDGET_FILE_REQ_MSG_TYPE = 'pkc-widget-file-req';
/** 読み込みの答え(親 → 箱):`{ type, reqId, ok, files?, reason? }`。 */
export const WIDGET_FILE_RES_MSG_TYPE = 'pkc-widget-file-res';

/** 保存・読み込みの大きさの上限(50 MB。両方向で同じ値)。 */
export const WIDGET_IO_MAX_BYTES = 50 * 1024 * 1024;
/** 1 回の読み込みで渡せるファイルの数の上限。 */
export const WIDGET_IO_MAX_FILES = 20;
/** 流量の窓(ミリ秒)。 */
export const WIDGET_IO_RATE_WINDOW_MS = 1000;
/** 窓の中で受ける要求の数(1 つの箱あたり)。超えた分は確認バーを出さずに断る。 */
export const WIDGET_IO_RATE_LIMIT = 3;
/** 箱が答えを待つ上限(user が確認バーを操作する猶予)。⚠ 親も同じ時間で確認バーを閉じ、預かった bytes を手放す。 */
export const WIDGET_IO_TIMEOUT_MS = 120_000;
/**
 * 🔴 **確認バーを出した直後に押せない時間**(クリックジャッキング対策)。箱は 1 秒に 3 回まで要求を差し替えられるので、
 * user が「safe.csv」を見て押す直前に「evil.html」へ差し替える、を防ぐ ── 差し替えるたびにこの時間ボタンを押せなくする。
 */
export const WIDGET_IO_PRESS_GUARD_MS = 400;

/** 答えの種類。`save` = PC へ保存 / `attach` = ノートへ添付 / `cancel` = やめた / `rejected` = 断った。 */
export type WidgetDownloadAction = 'save' | 'attach' | 'cancel' | 'rejected';

/** 断りの文(箱へ返す。画面の字と同じ標準の日本語で書く)。 */
export const WIDGET_IO_REASONS = {
  tooLarge: `ファイルが大きすぎます(${humanBytes(50 * 1024 * 1024)} まで)`,
  badData: '保存するデータの形式が正しくありません',
  badAccept: 'ファイルの種類の指定が正しくありません',
  rateLimited: '短い間に要求が多すぎます。少し待ってから、もう一度お試しください',
  replaced: '新しい要求に置き換わりました',
  cancelled: 'キャンセルされました',
  closed: 'ウィジェットが閉じられました',
  timeout: '応答がありませんでした',
  tooMany: `一度に選べるファイルは ${String(WIDGET_IO_MAX_FILES)} 件までです`,
  attachFailed: 'ノートへ添付できませんでした',
  busy: '前の要求を処理しています。終わってから、もう一度お試しください',
  wrongType: '指定された種類のファイルではありません',
  readFailed: 'ファイルを読み込めませんでした',
} as const;

/** MIME → 既定の拡張子(拡張子が無い名前に補う)。⚠ 知らない MIME は `.bin`。 */
const MIME_EXT: Readonly<Record<string, string>> = {
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/html': 'html',
  'text/css': 'css',
  'text/calendar': 'ics',
  'text/vcard': 'vcf',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
};

/** MIME の受け入れ条件(`type/subtype`。引数 `;charset=…` は落とす)。読めなければ `application/octet-stream`。 */
export function normalizeWidgetMime(raw: unknown): string {
  if (typeof raw !== 'string') return 'application/octet-stream';
  const t = raw.split(';')[0]!.trim().toLowerCase();
  if (t.length === 0 || t.length > 100) return 'application/octet-stream';
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(t) ? t : 'application/octet-stream';
}

/** MIME からの既定の拡張子(点なし)。 */
export function widgetExtForMime(mime: string): string {
  return MIME_EXT[normalizeWidgetMime(mime)] ?? 'bin';
}

/** 拡張子として残してよい字(英数字 1〜10 字)。 */
const SAFE_EXT_RE = /^[A-Za-z0-9]{1,10}$/;

/**
 * 🔴 **箱が名乗ったファイル名を、保存してよい名前にする**。
 *
 * - パスの区切り(`/` `\`)より前は捨てる(`../../evil.csv` → `evil.csv`)
 * - 制御文字・OS で使えない字・先頭の `.`・Windows の予約名(`CON` 等)は `safeName` の 1 本で無害化する
 * - 拡張子は英数字だけのときに残し、無ければ MIME から補う(不明なら `.bin`)
 * ⚠ 拡張子を先に切り離す ── `safeName` の 60 字の切り詰めで拡張子を失わない。
 */
export function sanitizeWidgetFileName(rawName: unknown, mime: unknown): string {
  const raw = typeof rawName === 'string' ? rawName : '';
  // ⚠ 区切りは両方の向き(Windows の `\` も)
  const last = raw.split(/[\\/]/).pop() ?? '';
  const dot = last.lastIndexOf('.');
  const extRaw = dot > 0 ? last.slice(dot + 1) : '';
  const ext = SAFE_EXT_RE.test(extRaw) ? extRaw.toLowerCase() : widgetExtForMime(typeof mime === 'string' ? mime : '');
  const stemRaw = dot > 0 && SAFE_EXT_RE.test(extRaw) ? last.slice(0, dot) : last;
  // 🔑 空・字が全部落ちた名前は「download」(`safeName` の既定 `pkc3` はノートの書き出しの名前)
  const stem = stemRaw.replace(/^[-.\s]+/, '').trim() === '' ? 'download' : safeName(stemRaw);
  return `${stem}.${ext}`;
}

/**
 * 実行できる・中で台本が動く形式の拡張子(保存は止めない ── 注意の文を出す)。
 * ⚠ `.html` / `.svg` も含める(ブラウザで開くと台本が動く)。
 */
const RISKY_EXTS = new Set([
  'exe', 'msi', 'msix', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'cjs',
  'wsf', 'wsh', 'sh', 'bash', 'zsh', 'command', 'app', 'dmg', 'pkg', 'deb', 'rpm', 'jar', 'hta', 'html', 'htm', 'xhtml',
  'shtml', 'mht', 'mhtml', 'svg', 'svgz', 'reg', 'lnk', 'url', 'desktop', 'appimage', 'apk', 'dll', 'iso', 'py', 'pl',
  'rb', 'php', 'xlsm', 'docm', 'pptm',
]);

/** 要注意の拡張子か(大文字小文字を区別しない)。 */
export function isRiskyWidgetDownloadExt(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return false;
  return RISKY_EXTS.has(fileName.slice(dot + 1).toLowerCase());
}

/** 要注意の拡張子のときの注意の文(そうでなければ `null`)。 */
export function widgetDownloadRiskNotice(fileName: string): string | null {
  return isRiskyWidgetDownloadExt(fileName)
    ? 'スクリプトや実行コードを含む可能性がある形式です。内容を確認してから保存してください'
    : null;
}

/** 要求の番号(箱が付ける。0 以上の整数だけ)。⚠ 流量の判定で中身を検める前に読む(軽い)。 */
export function reqIdOf(d: Record<string, unknown>): number | null {
  const r = d.reqId;
  return typeof r === 'number' && Number.isInteger(r) && r >= 0 ? r : null;
}

export interface WidgetDownloadRequest {
  readonly id: string;
  readonly reqId: number;
  /** 無害化した名前。 */
  readonly name: string;
  readonly mime: string;
  /** ⚠ 受け取った buffer の上の窓(写さない)。 */
  readonly bytes: Uint8Array;
}

export type ParsedWidgetRequest<T> =
  | { readonly ok: true; readonly req: T }
  /** `reqId` が読めたときだけ答えを返せる(読めなければ黙って捨てる)。 */
  | { readonly ok: false; readonly reqId: number | null; readonly id: string | null; readonly reason: string };

/**
 * 🔴 **保存の要求を検める**。`data` は `ArrayBuffer` / `ArrayBufferView` / 文字列(UTF-8)。
 * ⚠ 大きさは**写す前に**数える(50 MB を超える物は 1 バイトも写さない)。
 */
export function parseWidgetDownloadRequest(
  d: Record<string, unknown>,
  encode: (s: string) => Uint8Array = (s) => new TextEncoder().encode(s),
): ParsedWidgetRequest<WidgetDownloadRequest> {
  const reqId = reqIdOf(d);
  const id = typeof d.id === 'string' ? d.id : null;
  if (d.type !== WIDGET_DL_REQ_MSG_TYPE || reqId === null || id === null)
    return { ok: false, reqId, id, reason: WIDGET_IO_REASONS.badData };
  const data = d.data;
  let bytes: Uint8Array;
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > WIDGET_IO_MAX_BYTES) return { ok: false, reqId, id, reason: WIDGET_IO_REASONS.tooLarge };
    bytes = new Uint8Array(data);
  } else if (ArrayBuffer.isView(data)) {
    if (data.byteLength > WIDGET_IO_MAX_BYTES) return { ok: false, reqId, id, reason: WIDGET_IO_REASONS.tooLarge };
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else if (typeof data === 'string') {
    // ⚠ UTF-8 は 1 字が最大 3 バイト(サロゲートペアは 2 単位で 4 バイト)── 符号化する前に上限で切る
    if (data.length > WIDGET_IO_MAX_BYTES) return { ok: false, reqId, id, reason: WIDGET_IO_REASONS.tooLarge };
    bytes = encode(data);
    if (bytes.byteLength > WIDGET_IO_MAX_BYTES) return { ok: false, reqId, id, reason: WIDGET_IO_REASONS.tooLarge };
  } else {
    return { ok: false, reqId, id, reason: WIDGET_IO_REASONS.badData };
  }
  const mime = normalizeWidgetMime(d.mime);
  return { ok: true, req: { id, reqId, name: sanitizeWidgetFileName(d.name, mime), mime, bytes } };
}

export interface WidgetFileRequest {
  readonly id: string;
  readonly reqId: number;
  /** 受け入れる種類(`<input accept>` の書式)。指定なしは空。 */
  readonly accept: string;
  readonly multiple: boolean;
  /** 1 ファイルあたりの上限(`WIDGET_IO_MAX_BYTES` 以下に丸めた値)。 */
  readonly maxBytes: number;
}

/** `accept` の 1 項(`.csv` / `text/csv` / `image/*`)。 */
const ACCEPT_TOKEN_RE = /^(?:\.[A-Za-z0-9]{1,16}|[a-z0-9][a-z0-9.+-]{0,63}\/(?:\*|[a-z0-9][a-z0-9.+-]{0,63}))$/i;

/** `accept` を検める(読めなければ `null`)。空は空。 */
export function normalizeWidgetAccept(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string' || raw.length > 300) return null;
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (parts.length > 20) return null;
  for (const p of parts) if (!ACCEPT_TOKEN_RE.test(p)) return null;
  return parts.join(',');
}

/** 🔴 **読み込みの要求を検める**。壊れた `accept`(改行・制御文字・長すぎる字)は断る。 */
export function parseWidgetFileRequest(d: Record<string, unknown>): ParsedWidgetRequest<WidgetFileRequest> {
  const reqId = reqIdOf(d);
  const id = typeof d.id === 'string' ? d.id : null;
  if (d.type !== WIDGET_FILE_REQ_MSG_TYPE || reqId === null || id === null)
    return { ok: false, reqId, id, reason: WIDGET_IO_REASONS.badData };
  const accept = normalizeWidgetAccept(d.accept);
  if (accept === null) return { ok: false, reqId, id, reason: WIDGET_IO_REASONS.badAccept };
  const m = d.maxBytes;
  const maxBytes =
    typeof m === 'number' && Number.isFinite(m) && m > 0 ? Math.min(Math.floor(m), WIDGET_IO_MAX_BYTES) : WIDGET_IO_MAX_BYTES;
  return { ok: true, req: { id, reqId, accept, multiple: d.multiple === true, maxBytes } };
}

/** その名前・種類が `accept` に合うか(空の `accept` は何でも合う)。ノートの添付の候補を絞るのに使う。 */
export function widgetAcceptMatches(accept: string, name: string, mime: string): boolean {
  if (accept === '') return true;
  const lower = name.toLowerCase();
  const t = normalizeWidgetMime(mime);
  for (const tok of accept.split(',')) {
    const a = tok.trim().toLowerCase();
    if (a.startsWith('.')) {
      if (lower.endsWith(a)) return true;
    } else if (a.endsWith('/*')) {
      if (t.startsWith(a.slice(0, -1))) return true;
    } else if (a === t) return true;
  }
  return false;
}

/** 確認バーに出す種類の短い説明(`accept` が空なら `null`)。 */
export function widgetAcceptLabel(accept: string): string | null {
  return accept === '' ? null : accept.split(',').join('、');
}

/** 流量の上限(1 つの箱に 1 つ)。`allow(now)` が `false` なら断る。 */
export interface WidgetIoRateLimiter {
  allow(now: number): boolean;
}

/** 🔑 時刻の窓で数える(test で時刻を渡せる純粋な形)。 */
export function createWidgetIoRateLimiter(
  limit: number = WIDGET_IO_RATE_LIMIT,
  windowMs: number = WIDGET_IO_RATE_WINDOW_MS,
): WidgetIoRateLimiter {
  const stamps: number[] = [];
  return {
    allow(now: number): boolean {
      while (stamps.length > 0 && now - stamps[0]! >= windowMs) stamps.shift();
      if (stamps.length >= limit) return false;
      stamps.push(now);
      return true;
    },
  };
}

/** 保存の答え。 */
export function widgetDownloadResponse(
  reqId: number,
  ok: boolean,
  action: WidgetDownloadAction,
  reason?: string,
): Record<string, unknown> {
  return reason === undefined
    ? { type: WIDGET_DL_RES_MSG_TYPE, reqId, ok, action }
    : { type: WIDGET_DL_RES_MSG_TYPE, reqId, ok, action, reason };
}

/** 箱へ渡す 1 ファイル。⚠ `data` は Transferable で渡す(親の手元に残さない)。 */
export interface WidgetIoFile {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly data: ArrayBuffer;
}

/** 読み込みの答え。 */
export function widgetFileResponse(
  reqId: number,
  ok: boolean,
  files: readonly WidgetIoFile[],
  reason?: string,
): Record<string, unknown> {
  const base = { type: WIDGET_FILE_RES_MSG_TYPE, reqId, ok, files: [...files] };
  return reason === undefined ? base : { ...base, reason };
}

/**
 * 🔴 **選ばれたファイルを検める**(数と大きさ)。大きすぎる物が 1 つでも在れば全部を断る
 * (黙って一部だけ渡さない ── 箱が「全部読めた」と取り違えない)。
 */
export function checkWidgetPickedFiles(
  files: readonly { readonly size: number }[],
  req: Pick<WidgetFileRequest, 'multiple' | 'maxBytes'>,
): string | null {
  if (files.length === 0) return WIDGET_IO_REASONS.cancelled;
  const limit = req.multiple ? WIDGET_IO_MAX_FILES : 1;
  if (files.length > limit) return WIDGET_IO_REASONS.tooMany;
  let total = 0;
  for (const f of files) {
    if (f.size > req.maxBytes) return `ファイルが大きすぎます(1 件 ${humanBytes(req.maxBytes)} まで)`;
    total += f.size;
  }
  if (total > WIDGET_IO_MAX_BYTES) return WIDGET_IO_REASONS.tooLarge;
  return null;
}
