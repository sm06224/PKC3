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
import { webE2ECrypto } from './encrypted-box';
import { SyncE2E } from './sync-e2e';

/**
 * 📌 **保管先を選べるか**(user 裁定 2026-11-22)── `file://` では選べない(「HTTPS で開いたときだけ使えます」)。
 * ⚠ 安全な文脈(`isSecureContext`)でないと WebCrypto も使えない。手元の `http://localhost` は安全な文脈なので選べる(開発・smoke)。
 */
export function remoteUnavailableReason(loc: { protocol: string }, secure: boolean): string | null {
  if (loc.protocol === 'file:' || !secure) return SYNC_REMOTE_HTTPS_ONLY;
  return null;
}

/**
 * 窓の保管先の口(IndexedDB の鍵の保管 + fetch の S3)と、暗号化の口(#2000 段 4b-B)。
 * 🔴 暗号化キーの保管は認証情報と**同じ鍵の保管**(`SyncKeystore`)── 同じ 1 つを共有する。
 */
export function windowSyncRemoteAndE2E(): { remote: SyncRemoteDeps; e2e: SyncE2E | null } {
  let keystore: SyncKeystore | null = null;
  // ⚠ 鍵の保管は使うときに作る(`file://` で開いたとき・使わない人の端末で IndexedDB を開かない)
  const ks = (): SyncKeystore => (keystore ??= new SyncKeystore(idbKeystoreBackend(), globalThis.crypto.subtle, undefined, windowKeystoreLock()));
  const remote = windowRemote(ks);
  const e2e =
    globalThis.crypto?.subtle === undefined
      ? null
      : new SyncE2E({
          crypto: webE2ECrypto(),
          keys: {
            load: async (cid) => {
              const v = await ks().openDataKey(cid);
              return v === null ? null : { keyId: v.keyId, key: v.key };
            },
            save: (cid, v) => ks().saveDataKey(cid, v),
            remove: (cid) => ks().removeDataKey(cid),
          },
        });
  return { remote, e2e };
}

/** 窓の保管先の口(後方互換: 暗号化の口は `windowSyncRemoteAndE2E`)。 */
export function windowSyncRemote(): SyncRemoteDeps {
  return windowSyncRemoteAndE2E().remote;
}

function windowRemote(ks: () => SyncKeystore): SyncRemoteDeps {
  return {
    unavailable: () => remoteUnavailableReason(globalThis.location ?? { protocol: 'file:' }, globalThis.isSecureContext === true),
    open: (cid) => ks().open(cid),
    save: (cid, config, secret) => ks().save(cid, config, secret),
    remove: (cid) => ks().remove(cid),
    box: (config, secret) => new S3Box({ config, secret, crypto: webSigCrypto() }),
  };
}
