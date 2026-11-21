/**
 * 🔴 **端末間の同期(#2000)段 1 ── 端末 id・連番・墓標・前回の合意の置き場と純関数**。
 *
 * ## 裁定: スキーマを変えない(`DB_SCHEMA_VERSION` を上げない)
 *
 * 足りない物は 4 つ ── 端末 id / 端末ごとの連番 / 墓標(画面では「削除の記録」)/ 相手ごとの前回の合意(画面では「同期の記録」)。
 * どれも **`settings` 表の行**で持てる。理由:
 *
 * - 版を上げると旧ビルドが同じ DB を開けなくなる(`schema.ts` 冒頭の #286 の教訓)。足すだけの行なら旧ビルドは知らずに動く。
 * - 同期が OFF の間は**行を 1 本も書かない**(既定の端末のデータは今と同一)。
 * - 端末 id がバックアップや人に渡す HTML で別の端末へ複製されないこと(`.pkc3-*.zip` は設定の表を読まない /
 *   可搬 HTML の DB 画像は `withMessagesRemoved` が `__sync__` の行を除く)は test で固定する。
 *   ⚠ OPFS の DB ファイルそのものを複製した場合だけ id が重なる → 重複の見分け方は設計 doc §12.1。
 *
 * ## 置き場: 端末の物は `__sync__`、ワークスペースごとの物は `__sync__:<cid>`
 *
 * - `SYNC_SCOPE`(端末ごとに 1 組): 端末 id・連番。
 * - `syncScope(cid)`(ワークスペースごと。`tag-color:<cid>` などと同じ作法): 墓標・前回の合意・相手のワークスペースとの対応。
 *   ワークスペースを削除したときは `deleteContainerRows` がこの区画も消す。
 * - ⚠ cid は端末ごとに乱数で作る(`mintContainerId`)ので、**端末をまたいで cid は一致しない**(バックアップの `cid` は
 *   本文中のリンクを写す用途だけ)。対応づけの規則は設計 doc §12.1。
 *
 * ## 裁定: 時計(updated_at)ではなく「内容の指紋 + 端末 id + 端末ごとの連番」
 *
 * - 変更の有無・競合の判定は指紋の三者比較だけ(`change-set.ts`)。時計は見ない → 時計ずれ・巻き戻しで結果が変わらない。
 * - 連番は端末ごとに単調増加(時計が戻っても進む)。端末ごとの順序づけ(「連番 N より後」)に使い、
 *   相手の連番を見たら `max` に追い付く(`advanceSeq`)。⚠ **端末をまたいだ連番の大小は比べない**(別の端末の連番は無関係)。
 * - 時計(`deletedAt`)を使うのは**古い墓標の整理だけ**。判定には使わない。
 *
 * ## 墓標: ゴミ箱の版だけでは足りない
 *
 * 消すと履歴にゴミ箱の版が残るが、**ゴミ箱を空にするとその版も消える** ── 版だけを墓標にすると、
 * 空にした後に他の端末の古いコピーが「新しいノート」として復活する。だから消した事実は**別に**
 * 墓標として持ち、ゴミ箱を空にしても消さない(`pruneTombstones` は期限・件数でだけ消す)。
 * 書く側(削除の経路)は段 2 で、同期が ON のときだけ書く。
 * こちらの墓標は `decideMerge` の `localTombstones` として三者比較に入る(合意が無い物の基準になる)。
 *
 * ⚠ pure module。乱数・保存は呼び手が持つ。
 */
import type { Baseline, Fp, Tombstone } from './change-set';

/** `settings` 表の scope(端末ごとの物)。`__fts__` と同じ作法(アプリ自身の行)。 */
export const SYNC_SCOPE = '__sync__';

/** ワークスペースごとの `settings` の scope(墓標・前回の合意・対応)。 */
export function syncScope(cid: string): string {
  return `${SYNC_SCOPE}:${cid}`;
}
export const SYNC_KEY_DEVICE = 'device';
export const SYNC_KEY_SEQ = 'seq';
/** 墓標の行: `tomb:<key>`。値は `encodeTombstone`。 */
export const SYNC_KEY_TOMB_PREFIX = 'tomb:';
/** 前回の合意の行(`syncScope(cid)` の中): `base:<相手の端末 id>`。値は `encodeBaseline`。 */
export const SYNC_KEY_BASE_PREFIX = 'base:';
/** 相手のワークスペースとの対応の行(`syncScope(cid)` の中): `pair:<相手の端末 id>`、値 = 相手の cid。設計 doc §12.1。 */
export const SYNC_KEY_PAIR_PREFIX = 'pair:';

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

function encodeFp(fp: Fp): { c: string; p?: string } {
  return fp.place === undefined ? { c: fp.content } : { c: fp.content, p: fp.place };
}

function decodeFp(v: unknown): Fp | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.c !== 'string' || !r.c) return null;
  if (r.p === undefined) return { content: r.c };
  // 空の place は正当な値(`seedBaseline` も空の place は捨てない)。行ごと捨てない。空にできないのは content だけ
  if (typeof r.p !== 'string') return null;
  return { content: r.c, place: r.p };
}

export function encodeTombstone(t: Tombstone): string {
  return JSON.stringify({ f: encodeFp(t.lastFp), d: t.device, s: t.seq, t: t.deletedAt ?? '' });
}

/** 墓標の行の読み込み。形が違えば `null`(その行は無かった物として扱う)。日時が読めなければ `deletedAt` は付かない(日時不明)。 */
export function decodeTombstone(key: string, v: string | null | undefined): Tombstone | null {
  if (!v) return null;
  try {
    const o = JSON.parse(v) as unknown;
    if (typeof o !== 'object' || o === null) return null;
    const r = o as Record<string, unknown>;
    const fp = decodeFp(r.f);
    if (!fp || !isDeviceId(r.d) || typeof r.s !== 'number' || !Number.isInteger(r.s) || r.s < 0) return null;
    const base = { key, lastFp: fp, device: r.d, seq: r.s };
    return typeof r.t === 'string' && !Number.isNaN(Date.parse(r.t)) ? { ...base, deletedAt: r.t } : base;
  } catch {
    return null;
  }
}

export function encodeBaseline(b: Baseline): string {
  const o = Object.create(null) as Record<string, { c: string; p?: string }>;
  for (const [k, fp] of Object.entries(b)) o[k] = encodeFp(fp);
  return JSON.stringify(o);
}

/** 前回の合意の読み込み。壊れていれば空(= 一度も同期していない扱い。⚠ 消した事実は墓標が補う)。 */
export function decodeBaseline(v: string | null | undefined): Baseline {
  if (!v) return {};
  try {
    const o = JSON.parse(v) as unknown;
    if (typeof o !== 'object' || o === null || Array.isArray(o)) return {};
    const out = Object.create(null) as Record<string, Fp>;
    for (const [k, raw] of Object.entries(o as Record<string, unknown>)) {
      const fp = decodeFp(raw);
      if (fp) out[k] = fp;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 墓標を足す(消したとき)。同じキーがあれば、**同じ端末の記録は連番の大きい方**を残す。
 * 別の端末の記録どうしは連番を比べない(端末ごとの連番は無関係)ので、**あとから足した方**を残す。
 * ⚠ 時計も使わない。現在あるキー(消したあと戻した)は呼び手が先に `dropRevived` で外す。
 */
export function addTombstone(existing: readonly Tombstone[], t: Tombstone): Tombstone[] {
  const rest = existing.filter((e) => e.key !== t.key);
  const prev = existing.find((e) => e.key === t.key);
  rest.push(prev && prev.device === t.device && prev.seq > t.seq ? prev : t);
  return rest;
}

/** 戻ったキー(いま在る)の墓標を外す。ゴミ箱から戻したノートが次の同期で消されないように。 */
export function dropRevived(tombs: readonly Tombstone[], presentKeys: ReadonlySet<string>): Tombstone[] {
  return tombs.filter((t) => !presentKeys.has(t.key));
}

const DAY_MS = 86_400_000;

/**
 * 古い墓標を捨てる。⚠ **ゴミ箱を空にしても呼ばない**(それは墓標の寿命と無関係)。期限(日)と件数でだけ捨てる。
 *
 * ⚠ **時計(`deletedAt`)を使うのはこの整理だけ**。同期の判定には使わない(時計ずれで取りこぼす / 上書きするため。
 *   ここでずれても、せいぜい墓標が早く / 遅く消えるだけで、内容は失われない ── 早く消えた場合は
 *   `docs` §12.1 の「全件の突き合わせ」へ戻る)。
 * - 期限: `deletedAt` が 180 日より前の物を捨てる(ちょうど 180 日は残す)。
 * - 件数: 上限を超えたら **`deletedAt` の古い順**に捨てる(端末をまたいだ連番は比べない)。
 * - `deletedAt` が無い / 読めない物: 古さが分からないので期限では捨てず、件数の整理では**いちばん古い扱い**(先に捨てる)。
 *   同じ古さのときはキーの昇順で決める(決定的)。
 */
export function pruneTombstones(tombs: readonly Tombstone[], nowMs: number): Tombstone[] {
  const limit = nowMs - TOMBSTONE_KEEP_DAYS * DAY_MS;
  const ms = (t: Tombstone): number => {
    const v = t.deletedAt ? Date.parse(t.deletedAt) : NaN;
    return Number.isNaN(v) ? -Infinity : v;
  };
  const alive = tombs.filter((t) => {
    const v = ms(t);
    return v === -Infinity || v >= limit;
  });
  const sorted = [...alive].sort((a, b) => {
    const d = ms(b) - ms(a);
    // -Infinity どうしの差は NaN になるので、先に等しさを見る
    if (ms(a) === ms(b)) return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    return d;
  });
  return sorted.slice(0, TOMBSTONE_MAX);
}
