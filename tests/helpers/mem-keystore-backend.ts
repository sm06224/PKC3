/** 作り物の鍵の置き場(メモリ。中身を覗ける)。`sync-keystore` / 同期の test が使う。 */
import type { KeystoreBackend, SavedDataKey } from '../../src/adapter/platform/sync-keystore';

export function memKeystoreBackend(): KeystoreBackend & { dump(): unknown[] } {
  let key: CryptoKey | null = null;
  const boxes = new Map<string, unknown>();
  const dataKeys = new Map<string, SavedDataKey>();
  return {
    getKey: async () => key,
    putKey: async (k) => void (key = k),
    deleteKey: async () => void (key = null),
    getBox: async (cid) => (boxes.get(cid) as never) ?? null,
    putBox: async (cid, v) => void boxes.set(cid, structuredClone(v)),
    deleteBox: async (cid) => void boxes.delete(cid),
    countBoxes: async () => boxes.size,
    getDataKey: async (cid) => dataKeys.get(cid) ?? null,
    putDataKey: async (cid, v) => void dataKeys.set(cid, v),
    deleteDataKey: async (cid) => void dataKeys.delete(cid),
    dump: () => [key, ...boxes.values(), ...[...dataKeys.values()].map((d) => d.keyId)],
  };
}
