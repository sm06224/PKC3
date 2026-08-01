/**
 * asset key = **中身のハッシュ**(content addressing、user 指示 2026-08-01)。
 *
 * > 「ハッシュとって同一なら差分ができるまでリンク参照する ZFS と同じ発想でいい」
 *
 * 同一 bytes は必ず同じ key に落ちるので、重複は「検出して避ける」ものではなく
 * **構造的に起きない**。帰結:
 * - 台帳を引く必要が無い(key の存在確認だけで済む)── 経路ごとに dedupe の
 *   実装がズレる余地が消える(PKC2 は base64 文字列 hash で経路により不一致だった)
 * - **削除は参照カウント前提**になる ── 複数 entry が同じ key を共有しうる。
 *   PKC3 の GC は body 走査ベース(参照されていないものだけ消す)なので元から正しい
 * - key 採番の衝突ガードが要らない(採番していないので衝突しない)
 *
 * ⚠ **旧 key(`ast-<ts36>-<rand>`)は有効なまま**。key は不透明な文字列であり、
 * 既存データの移行は要らない ── 新しく書くものだけが content key になる。
 *
 * ⚠ **HASH_MAX_BYTES の carve-out**: WebCrypto に streaming digest が無く、
 * `crypto.subtle.digest` は全量を ArrayBuffer で要求する。巨大ファイルで
 * それをやると「生成物を溜めない」規律に反するため、閾値超は**ハッシュを取らず
 * 採番 key へ落とす**(その 1 件だけ dedupe されない)。streaming SHA-256 が
 * 入ればこの carve-out は消える ── Rust/wasm の判定枠に乗る題材(R レーン)。
 */

/** これ以上は content addressing しない(全量を heap に載せないため)。 */
export const HASH_MAX_BYTES = 64 * 1024 * 1024;

/** content key の見た目。`asset:<key>` の token 規則 `[A-Za-z0-9_-]+` に収まる。 */
const PREFIX = 'ast-';

/** 中身に依らない採番(ハッシュを取れないときだけ使う)。 */
export function generateAssetKey(): string {
  return `${PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface AssetIdentity {
  key: string;
  /** null = ハッシュを取っていない(閾値超)。この 1 件は dedupe 対象外。 */
  hash: string | null;
}

/**
 * bytes から key を決める。**同じ bytes なら必ず同じ key**。
 * 閾値超のときだけ採番へ落ちる(その旨は hash === null で観測できる)。
 */
export async function identifyAsset(blob: Blob): Promise<AssetIdentity> {
  if (blob.size > HASH_MAX_BYTES) return { key: generateAssetKey(), hash: null };
  const hash = await sha256Hex(blob);
  return { key: `${PREFIX}${hash}`, hash };
}

/** content key かどうか(採番 key と見分ける ── 診断・test 用)。 */
export function isContentKey(key: string): boolean {
  return key.startsWith(PREFIX) && /^[0-9a-f]{64}$/.test(key.slice(PREFIX.length));
}
