/**
 * 🔴 **端末間の同期(#2000)段 1 ── 端末 id・連番・墓標・前回の合意の置き場と純関数**。
 *
 * ## 裁定: スキーマを変えない(`DB_SCHEMA_VERSION` を上げない)
 *
 * 足りない物は 4 つ ── 端末 id / 端末ごとの連番 / 墓標 / 相手ごとの前回の合意。
 * どれも **`settings` 表(scope = `SYNC_SCOPE`)の行**で持てる。理由:
 *
 * - 版を上げると旧ビルドが同じ DB を開けなくなる(`schema.ts` 冒頭の #286 の教訓)。足すだけの行なら旧ビルドは知らずに動く。
 * - 同期が OFF の間は**行を 1 本も書かない**(既定の端末のデータは今と同一)。
 * - `settings` 表は backup(.pkc3-*.zip)に入らない ── 端末 id がバックアップ経由で別の端末へ複製されない。
 *   ⚠ OPFS の DB ファイルそのものを複製した場合だけ id が重なる → 相手の id が自分と同じなら**再生成**する(`isSameDevice`)。
 *
 * ## 裁定: 時計(updated_at)ではなく「内容の指紋 + 端末 id + 端末ごとの連番」
 *
 * - 変更の有無・競合の判定は指紋の三者比較だけ(`change-set.ts`)。時計は見ない → 時計ずれ・巻き戻しで結果が変わらない。
 * - 連番は端末ごとに単調増加(時計が戻っても進む)。墓標・差分ファイルの順序づけ(「連番 N より後」)に使い、
 *   相手の連番を見たら `max` に追い付く(`advanceSeq`)。updated_at は表示専用のまま。
 *
 * ## 墓標: ゴミ箱の版だけでは足りない
 *
 * 消すと履歴にゴミ箱の版が残るが、**ゴミ箱を空にするとその版も消える** ── 版だけを墓標にすると、
 * 空にした後に他の端末の古いコピーが「新しいノート」として復活する。だから消した事実は**別に**
 * 墓標として持ち、ゴミ箱を空にしても消さない(`pruneTombstones` は期限・件数でだけ消す)。
 * 書く側(削除の経路)は段 2 で、同期が ON のときだけ書く。
 *
 * ⚠ pure module。乱数・保存は呼び手が持つ。
 */
import type { Baseline, Tombstone } from './change-set';

/** `settings` 表の scope。`__fts__` と同じ作法(アプリ自身の行)。 */
export const SYNC_SCOPE = '__sync__';
export const SYNC_KEY_DEVICE = 'device';
export const SYNC_KEY_SEQ = 'seq';
/** 墓標の行: `tomb:<key>`。値は `encodeTombstone`。 */
export const SYNC_KEY_TOMB_PREFIX = 'tomb:';
/** 前回の合意の行: `base:<相手の端末 id>`。値は `encodeBaseline`。 */
export const SYNC_KEY_BASE_PREFIX = 'base:';

/** 墓標を残す上限(件数)と期間(日)。超えたら古い順に捨てる(ゴミ箱を空にしても残すが、無限には持たない)。 */
export const TOMBSTONE_MAX = 5000;
export const TOMBSTONE_KEEP_DAYS = 180;

const DEVICE_ID_RE = /^[0-9a-f]{16}$/;

/** 乱数 8 バイトから端末 id(16 桁の 16 進)。⚠ 乱数の取得は adapter(`crypto.getRandomValues`)。 */
export function deviceIdFromBytes(bytes: ArrayLike<number>): string {
  if (bytes.length !== 8) throw new Error('端末 id は 8 バイトから作る');
  let s = '';
  for (let i = 0; i < 8; i++) s += ((bytes[i] as number) & 0xff).toString(16).padStart(2, '0');
  return s;
}

export function isDeviceId(v: unknown): v is string {
  return typeof v === 'string' && DEVICE_ID_RE.test(v);
}

/** 相手の id が自分と同じ = DB の複製。自分の id を作り直す合図。 */
export function isSameDevice(own: string, peer: string): boolean {
  return own === peer;
}

/** 連番の読み込み。壊れた値・負数は 0 から。 */
export function parseSeq(v: string | null | undefined): number {
  if (!v || !/^\d{1,15}$/.test(v)) return 0;
  return Number(v);
}

/** 自分の変更で連番を 1 つ進める。 */
export function nextSeq(current: number): number {
  return current + 1;
}

/** 相手の連番を見たとき、自分の連番を追い付かせる(戻さない)。 */
export function advanceSeq(own: number, seen: number): number {
  return Math.max(own, seen);
}

export function encodeTombstone(t: Tombstone, deletedAtIso: string): string {
  return JSON.stringify({ h: t.lastHash, d: t.device, s: t.seq, t: deletedAtIso });
}

/** 墓標の行の読み込み。形が違えば `null`(その行は無かった物として扱う)。 */
export function decodeTombstone(key: string, v: string | null | undefined): (Tombstone & { deletedAt: string }) | null {
  if (!v) return null;
  try {
    const o = JSON.parse(v) as unknown;
    if (typeof o !== 'object' || o === null) return null;
    const r = o as Record<string, unknown>;
    if (typeof r.h !== 'string' || !r.h || !isDeviceId(r.d) || typeof r.s !== 'number' || !Number.isInteger(r.s) || r.s < 0) return null;
    return { key, lastHash: r.h, device: r.d, seq: r.s, deletedAt: typeof r.t === 'string' ? r.t : '' };
  } catch {
    return null;
  }
}

export function encodeBaseline(b: Baseline): string {
  return JSON.stringify(b);
}

/** 前回の合意の読み込み。壊れていれば空(= 一度も同期していない扱い。⚠ 消した事実は墓標が補う)。 */
export function decodeBaseline(v: string | null | undefined): Baseline {
  if (!v) return {};
  try {
    const o = JSON.parse(v) as unknown;
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return {};
    const out: Record<string, string> = {};
    for (const [k, h] of Object.entries(o as Record<string, unknown>)) if (typeof h === 'string' && h) out[k] = h;
    return out;
  } catch {
    return {};
  }
}

/**
 * 墓標を足す(消したとき)。同じキーがあれば連番の大きい方を残す。
 * ⚠ 現在あるキー(消したあと戻した)は呼び手が先に `dropRevived` で外す。
 */
export function addTombstone(existing: readonly Tombstone[], t: Tombstone): Tombstone[] {
  const rest = existing.filter((e) => e.key !== t.key);
  const prev = existing.find((e) => e.key === t.key);
  rest.push(prev && prev.seq > t.seq ? prev : t);
  return rest;
}

/** 戻ったキー(いま在る)の墓標を外す。ゴミ箱から戻したノートが次の同期で消されないように。 */
export function dropRevived(tombs: readonly Tombstone[], presentKeys: ReadonlySet<string>): Tombstone[] {
  return tombs.filter((t) => !presentKeys.has(t.key));
}

/**
 * 古い墓標を捨てる。⚠ **ゴミ箱を空にしても呼ばない**(それは墓標の寿命と無関係)。期限(日)と件数でだけ捨てる。
 * 期限は `deletedAt`(表示用の ISO)があるものだけ見る ── 無いものは件数の上限でだけ捨てる(連番の小さい順)。
 */
export function pruneTombstones(tombs: readonly (Tombstone & { deletedAt?: string })[], nowMs: number): Tombstone[] {
  const limit = nowMs - TOMBSTONE_KEEP_DAYS * 86_400_000;
  const alive = tombs.filter((t) => {
    const ms = t.deletedAt ? Date.parse(t.deletedAt) : NaN;
    return Number.isNaN(ms) || ms >= limit;
  });
  const sorted = [...alive].sort((a, b) => b.seq - a.seq);
  return sorted.slice(0, TOMBSTONE_MAX);
}
