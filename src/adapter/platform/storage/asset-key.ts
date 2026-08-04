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

async function hexDigest(data: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256Hex(blob: Blob): Promise<string> {
  return hexDigest(await blob.arrayBuffer());
}

export interface AssetIdentity {
  key: string;
  /** null = ハッシュを取っていない(閾値超)。この 1 件は dedupe 対象外。 */
  hash: string | null;
}

/**
 * **既に手元にある bytes** から key を決める(コピーを作らない)。
 * 取込のように復号済み bytes を持っている経路はこちらを使う ── `identifyAsset`
 * は Blob から `arrayBuffer()` でもう 1 部作ってしまう(review M-5)。
 */
export async function identifyBytes(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<AssetIdentity> {
  if (bytes.byteLength > HASH_MAX_BYTES) return assetKeyFromHash(null);
  return assetKeyFromHash(await hexDigest(bytes));
}

/**
 * **hash から key を決める規則**(P8 段⑮)。
 *
 * 🔴 ここを 1 本にする。ハッシュを取る場所がワーカーへ移ったので、
 * 「hash → key」の規則が**メインとワーカーの 2 か所に生える**ところだった
 * ── 同じ判定が 2 か所に生えたら規則を 1 つに寄せる、という repo の規律。
 * ⚠ `hash === null`(閾値超でハッシュを取っていない)は**採番へ落とす**。
 * その 1 件だけ dedupe されない、という意味も 1 か所に閉じる。
 */
export function assetKeyFromHash(hash: string | null): AssetIdentity {
  return hash === null ? { key: generateAssetKey(), hash: null } : { key: `${PREFIX}${hash}`, hash };
}

/**
 * bytes から key を決める。**同じ bytes なら必ず同じ key**。
 * 閾値超のときだけ採番へ落ちる(その旨は hash === null で観測できる)。
 *
 * ⚠ **閾値以下では blob 全量を JS ヒープに載せる**(WebCrypto に streaming
 * digest が無く `crypto.subtle.digest` が BufferSource を要求するため)。
 * `HASH_MAX_BYTES` は「巨大ファイルではやらない」であると同時に
 * 「**64MB までは常に全量を載せる**」という意味でもある。
 */
export async function identifyAsset(blob: Blob): Promise<AssetIdentity> {
  // ⚠ key の作り方は `assetKeyFromHash` の 1 本(P8 段㉓)── ここで
  //    `${PREFIX}${hash}` を書き直すと、1 本に寄せたはずの規則に 2 つ目の写しができる
  if (blob.size > HASH_MAX_BYTES) return assetKeyFromHash(null);
  return assetKeyFromHash(await sha256Hex(blob));
}

/** content key かどうか(採番 key と見分ける ── 診断・test 用)。 */
export function isContentKey(key: string): boolean {
  return key.startsWith(PREFIX) && /^[0-9a-f]{64}$/.test(key.slice(PREFIX.length));
}
