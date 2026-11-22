/**
 * 🔴 **S3 互換の保管先の口を組む所**(#2000 段 4a-4)── 鍵の保管(`sync-keystore.ts`)と保管先(`S3Box`)をつないで、
 * 同期の実行部(`SyncFolder`)へ渡す 1 つの口(`SyncRemoteDeps`)にする。
 * ⚠ 鍵の保管を読む file はここと `sync-folder.ts` / `s3-box.ts` だけ(`tests/adapter/sync-keystore.test.ts` が import を数える)。
 *   `main.ts` はここだけを読む(書き出し・バックアップの経路と同じ file に鍵の口を置かない)。
 */
import { S3Box, webSigCrypto } from './s3-box';
import type { SyncRemoteDeps } from './sync-folder';
import { SYNC_REMOTE_HTTPS_ONLY } from './sync-folder';
import { idbKeystoreBackend, SyncKeystore, windowKeystoreLock } from './sync-keystore';

/**
 * 📌 **保管先を選べるか**(user 裁定 2026-11-22)── `file://` では選べない(「HTTPS で開いたときだけ使えます」)。
 * ⚠ 安全な文脈(`isSecureContext`)でないと WebCrypto も使えない。手元の `http://localhost` は安全な文脈なので選べる(開発・smoke)。
 */
export function remoteUnavailableReason(loc: { protocol: string }, secure: boolean): string | null {
  if (loc.protocol === 'file:' || !secure) return SYNC_REMOTE_HTTPS_ONLY;
  return null;
}

/** 窓の保管先の口(IndexedDB の鍵の保管 + fetch の S3)。 */
export function windowSyncRemote(): SyncRemoteDeps {
  let keystore: SyncKeystore | null = null;
  // ⚠ 鍵の保管は使うときに作る(`file://` で開いたとき・使わない人の端末で IndexedDB を開かない)
  const ks = (): SyncKeystore => (keystore ??= new SyncKeystore(idbKeystoreBackend(), globalThis.crypto.subtle, undefined, windowKeystoreLock()));
  return {
    unavailable: () => remoteUnavailableReason(globalThis.location ?? { protocol: 'file:' }, globalThis.isSecureContext === true),
    open: (cid) => ks().open(cid),
    save: (cid, config, secret) => ks().save(cid, config, secret),
    remove: (cid) => ks().remove(cid),
    box: (config, secret) => new S3Box({ config, secret, crypto: webSigCrypto() }),
  };
}
