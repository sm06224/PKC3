/**
 * 添付取込(P4a): **File → Blob 直 put**。
 *
 * PKC2 からの総合的見直し(調査 2026-07-31):
 * - base64 経路(FileReader → container.assets[key] = base64)を書き込み側から
 *   廃止 ── PKC2 の +293MB 常駐と「250MB 上限(根拠が base64 ヒープ)」を持ち込まない。
 *   上限は quota preflight(storage.estimate)に置き換える
 * - asset key 規則は `ast-<ts36>-<rand>` の **1 本**(PKC2 は 3 規則混在。
 *   旧規則は P6 import 側で受理する)
 * - dedupe は **bytes の SHA-256 + size** 一致で既存 key を再利用に統一
 *   (PKC2 は base64 文字列 hash で、経路により「toast のみ / 再利用」が不一致だった)
 * - hash/size メタは put と同時に書く(後付け reconcile 走査を構造的に不要にする
 *   ── PKC2 は走査が 500MB データで boot OOM を誘発した)
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { attachmentBody } from '@features/flavor/attachment-flavor';
import { generateLid } from './binder';

export interface AttachDeps {
  putBlob(assetKey: string, blob: Blob): Promise<void>;
  putMeta(meta: {
    key: string;
    mime: string;
    size: number;
    hash: string | null;
  }): Promise<void>;
  listMetas(): Promise<
    Array<{ key: string; size: number | null; hash: string | null }>
  >;
  /** quota preflight(無い環境では省略可)。 */
  estimate?(): Promise<{ usage?: number; quota?: number }>;
}

/** SHA-256 は stream 化できないため、これ以上のファイルは hash なし(dedupe 対象外)。 */
const HASH_MAX_BYTES = 64 * 1024 * 1024;

/** file.type が空のときの拡張子 fallback(PKC2 は無くて後段の補正 hack を生んだ)。 */
const EXT_MIME: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

export function resolveMime(name: string, declared: string): string {
  if (declared) return declared;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

function generateAssetKey(): string {
  return `ast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 取込本体。file ごとに独立に成否を扱う(1 個の失敗が batch を殺さない)。 */
export async function attachFiles(
  dispatcher: Dispatcher,
  deps: AttachDeps,
  files: readonly File[],
): Promise<void> {
  if (files.length === 0) return;

  // dedupe 台帳は batch 先頭で 1 回だけ引く(batch 内の重複は逐次 put が防ぐ)。
  // 台帳が引けなくても取込自体は続行(dedupe を諦めるだけ)
  const known: Array<{ key: string; size: number | null; hash: string | null }> =
    await deps.listMetas().catch(() => []);

  for (const file of files) {
    try {
      // quota preflight ── 足りないときは黙って壊れる前に可視で止める
      if (deps.estimate) {
        const est = await deps.estimate();
        if (
          est.quota !== undefined &&
          est.usage !== undefined &&
          est.quota - est.usage < file.size * 1.2
        ) {
          dispatcher.dispatch({
            type: 'OP_FAILED',
            error: `添付を保存する空き容量が不足しています: ${file.name}`,
          });
          continue;
        }
      }

      const mime = resolveMime(file.name, file.type);
      const hash = file.size <= HASH_MAX_BYTES ? await sha256Hex(file) : null;

      // bytes 同一(hash + size 一致)なら既存 asset を参照(put しない)
      let assetKey = hash
        ? (known.find((m) => m.hash === hash && m.size === file.size)?.key ?? null)
        : null;
      if (!assetKey) {
        assetKey = generateAssetKey();
        await deps.putBlob(assetKey, file);
        await deps.putMeta({ key: assetKey, mime, size: file.size, hash });
        known.push({ key: assetKey, size: file.size, hash });
      }

      dispatcher.dispatch({
        type: 'CREATE_ENTRY',
        archetype: 'attachment',
        lid: generateLid(),
        title: file.name,
        body: attachmentBody({ name: file.name, mime, size: file.size, assetKey, hash }),
        edit: false, // 添付は editor に入らない(PKC2 の silent attach と同じ)
      });
    } catch (e) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: `添付の取込に失敗しました(${file.name}): ${String(e)}`,
      });
    }
  }
}
