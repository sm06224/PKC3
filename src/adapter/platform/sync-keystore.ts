/**
 * 🔴 **同期の保管先の鍵(資格情報)の保管**(#2000 段 4a-2。user 裁定 2026-11-22)。
 *
 * ## 何をどこに置くか
 * - 置き場は **IndexedDB の専用の DB(`pkc3-sync-keys`)** だけ。本体の DB(SQLite)・バックアップ(full / part / notes)・差分 zip・
 *   設定ファイル(localStorage の `pkc3.*` を運ぶ)・メッセージの集積地のどれにも入らない(どれもこの DB を読まない ──
 *   `tests/adapter/sync-keystore.test.ts` が import の経路と書き出しの中身で固定する)。
 * - 保管先の接続情報のうち、**秘密(アクセスキー ID・シークレット)だけを AES-GCM で暗号化**して置く。暗号の鍵は
 *   **取り出せない(`extractable: false`)`CryptoKey`** として同じ DB に置く(structured clone で保存できる)。
 * - 秘密でない部分(エンドポイント・バケット・リージョン・接頭辞)は平文で置く(画面に出す物)。
 *
 * ## この保管が守る物・守らない物(設計 doc §2.1 / user 裁定)
 * - 守る: ディスクやバックアップを丸ごと写されたときに、資格情報が平文で出ること。
 * - 守らない: **同じ origin で動く別のページ・XSS** は、この端末の `CryptoKey` で復号を呼べる(`<user>.github.io` は同じ user の他の
 *   repo のページと origin を共有する ── 段 4a-4 の設定画面で注意を出す)。任意のパスフレーズは段 4b(E2E)で足す。
 *
 * ## 片道にしない
 * - 「接続を外す」で鍵と接続情報を消す(`remove`)。暗号の鍵は全部の接続が無くなったら消す。
 */

/** S3 互換の保管先の、秘密でない接続情報(画面に出す物)。 */
export interface S3BoxConfig {
  readonly kind: 's3';
  /** `https://<host>[:port]`(パスは付けない)。⚠ path-style で使う(`<endpoint>/<bucket>/<key>`)。 */
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  /** バケットの中の置き場(`pkc3/` など)。空ならバケットの直下。 */
  readonly prefix: string;
}

/** 秘密(暗号化して置く)。 */
export interface S3BoxSecret {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** 暗号化した秘密(置き場に置く形)。⚠ 平文の字は 1 つも持たない。 */
interface SealedSecret {
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly data: ArrayBuffer;
}

/** 置き場の 1 件(ワークスペースごと)。 */
interface SavedBox {
  readonly config: S3BoxConfig;
  readonly sealed: SealedSecret;
}

/** 置き場の口(IndexedDB の実装と、テストの作り物)。 */
export interface KeystoreBackend {
  getKey(): Promise<CryptoKey | null>;
  putKey(k: CryptoKey): Promise<void>;
  deleteKey(): Promise<void>;
  getBox(cid: string): Promise<SavedBox | null>;
  putBox(cid: string, v: SavedBox): Promise<void>;
  deleteBox(cid: string): Promise<void>;
  countBoxes(): Promise<number>;
}

/** 鍵の保管の DB 名。⚠ この名前は**この file にしか書かない**(書き出しの経路がこの DB を読まないことを、名前の所在で固定する)。 */
export const SYNC_KEYS_DB = 'pkc3-sync-keys';

export class SyncKeystore {
  constructor(
    private readonly backend: KeystoreBackend,
    private readonly subtle: SubtleCrypto = globalThis.crypto.subtle,
    private readonly random: (a: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (a) => globalThis.crypto.getRandomValues(a),
  ) {}

  /** 暗号の鍵(無ければ作る。⚠ 取り出せない鍵 ── 平文の鍵の字はどこにも出ない)。 */
  private async key(): Promise<CryptoKey> {
    const have = await this.backend.getKey();
    if (have !== null) return have;
    const k = await this.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await this.backend.putKey(k);
    return k;
  }

  /** 保管先の接続情報と秘密を置く(上書き)。 */
  async save(cid: string, config: S3BoxConfig, secret: S3BoxSecret): Promise<void> {
    const iv = this.random(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify({ a: secret.accessKeyId, s: secret.secretAccessKey }));
    const data = await this.subtle.encrypt({ name: 'AES-GCM', iv }, await this.key(), plain);
    await this.backend.putBox(cid, { config: { ...config }, sealed: { iv, data } });
  }

  /** 接続情報だけ(秘密を開かない ── 画面に出すとき)。 */
  async config(cid: string): Promise<S3BoxConfig | null> {
    return (await this.backend.getBox(cid))?.config ?? null;
  }

  /**
   * 接続情報と秘密を開く。開けなければ `null`(⚠ 理由の字に秘密を混ぜない ── 呼び手は「鍵を読めません」とだけ言う)。
   */
  async open(cid: string): Promise<{ config: S3BoxConfig; secret: S3BoxSecret } | null> {
    const saved = await this.backend.getBox(cid);
    if (saved === null) return null;
    const k = await this.backend.getKey();
    if (k === null) return null;
    try {
      const plain = await this.subtle.decrypt({ name: 'AES-GCM', iv: saved.sealed.iv }, k, saved.sealed.data);
      const o = JSON.parse(new TextDecoder().decode(plain)) as { a?: unknown; s?: unknown };
      if (typeof o.a !== 'string' || typeof o.s !== 'string') return null;
      return { config: saved.config, secret: { accessKeyId: o.a, secretAccessKey: o.s } };
    } catch {
      return null;
    }
  }

  /** 🔴 接続を外す(片道にしない)── 接続情報と秘密を消す。全部の接続が無くなったら暗号の鍵も消す。 */
  async remove(cid: string): Promise<void> {
    await this.backend.deleteBox(cid);
    if ((await this.backend.countBoxes()) === 0) await this.backend.deleteKey();
  }
}

/**
 * IndexedDB の置き場(`pkc3-sync-keys`)。⚠ 暗号の鍵(`CryptoKey`)は structured clone で保存する(取り出せない鍵のまま)。
 * ⚠ 本体の DB・バックアップ・差分 zip・設定ファイル・メッセージはこの DB を読まない(読む口はここだけ)。
 */
export function idbKeystoreBackend(dbName = SYNC_KEYS_DB): KeystoreBackend {
  const KEYS = 'keys';
  const BOXES = 'boxes';
  const DEVICE_KEY = 'device';
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS);
        if (!db.objectStoreNames.contains(BOXES)) db.createObjectStore(BOXES);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('認証情報の置き場を開けません'));
    });
  const tx = async <T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const r = fn(t.objectStore(store));
        t.oncomplete = () => resolve(r.result);
        t.onerror = () => reject(t.error ?? new Error('認証情報の置き場に書けません'));
        t.onabort = () => reject(t.error ?? new Error('認証情報の置き場への書き込みが中断されました'));
      });
    } finally {
      db.close();
    }
  };
  return {
    getKey: async () => ((await tx(KEYS, 'readonly', (s) => s.get(DEVICE_KEY))) as CryptoKey | undefined) ?? null,
    putKey: async (k) => void (await tx(KEYS, 'readwrite', (s) => s.put(k, DEVICE_KEY))),
    deleteKey: async () => void (await tx(KEYS, 'readwrite', (s) => s.delete(DEVICE_KEY))),
    getBox: async (cid) => ((await tx(BOXES, 'readonly', (s) => s.get(cid))) as SavedBox | undefined) ?? null,
    putBox: async (cid, v) => void (await tx(BOXES, 'readwrite', (s) => s.put(v, cid))),
    deleteBox: async (cid) => void (await tx(BOXES, 'readwrite', (s) => s.delete(cid))),
    countBoxes: async () => await tx(BOXES, 'readonly', (s) => s.count()),
  };
}
