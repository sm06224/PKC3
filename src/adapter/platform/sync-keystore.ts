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

/** タブをまたいで 1 つずつ動かす口(`navigator.locks`。無ければ `null` ── このタブの中だけ直列にする)。 */
export type KeystoreLock = <T>(fn: () => Promise<T>) => Promise<T>;

/** 窓の `navigator.locks` から作る(無ければ `null`)。 */
export function windowKeystoreLock(nav: object = globalThis.navigator ?? {}): KeystoreLock | null {
  const locks = (nav as { locks?: { request?: unknown } }).locks;
  if (typeof locks?.request !== 'function') return null;
  const request = locks.request as (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
  return <T>(fn: () => Promise<T>): Promise<T> => request.call(locks, SYNC_KEYS_DB, fn) as Promise<T>;
}

/**
 * 🔴 **接続先の設定を確かめる**(着地前レビュー ⚠4)── 平文で置く物に認証情報を紛れ込ませない。
 * - エンドポイントは `https://<host>[:port]` だけ(利用者名・パスワード・クエリ・断片・パスを持たない)。
 *   ⚠ `http://` は手元の確かめ(`localhost` / `127.0.0.1`)だけ許す(作り物の S3 サーバの smoke と、手元の MinIO)。
 * - 接頭辞に `?` `#` を入れない。
 * @returns 断る理由(通れば `null`)。⚠ 理由の字にエンドポイントの字そのものは入れない(認証情報が紛れていても出さない)
 */
export function s3ConfigProblem(c: S3BoxConfig): string | null {
  let u: URL;
  try {
    u = new URL(c.endpoint);
  } catch {
    return 'エンドポイントの形が読めません(https://ホスト名 の形で入れてください)';
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return 'エンドポイントは https:// で始めてください';
  if (u.username !== '' || u.password !== '') return 'エンドポイントに利用者名やパスワードを入れないでください(アクセスキーの欄に入れます)';
  if (u.search !== '' || u.hash !== '' || (u.pathname !== '/' && u.pathname !== '')) return 'エンドポイントはホスト名までにしてください(パスや ? # を付けない)';
  if (c.bucket.trim() === '' || /[/?#]/.test(c.bucket)) return 'バケット名を入れてください(/ ? # は使えません)';
  if (/[?#]/.test(c.prefix)) return '置き場の接頭辞に ? や # は使えません';
  return null;
}

/** 暗号文を、どのワークスペースのどの接続先の物かに結び付ける字(AES-GCM の追加の認証データ)。 */
function aadOf(cid: string, c: S3BoxConfig): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(['pkc3-sync-box', cid, c.kind, c.endpoint, c.bucket, c.region, c.prefix]));
}

export class SyncKeystore {
  /** このタブの中の直列(`lock` が無い環境でも、保存・外す・鍵を作るが重ならない)。 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly backend: KeystoreBackend,
    private readonly subtle: SubtleCrypto = globalThis.crypto.subtle,
    private readonly random: (a: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (a) => globalThis.crypto.getRandomValues(a),
    private readonly lock: KeystoreLock | null = null,
  ) {}

  /**
   * 🔴 **書く操作は 1 つずつ**(着地前レビュー 🔴2)── 保存と外すが重なると、外した側が鍵を消した直後に保存側が古い鍵で
   *   書いて開けない秘密が残る / 2 つの保存が同時に鍵を作ると後勝ちで先の秘密が開けなくなる。タブの中は約束の鎖、
   *   タブをまたぐのは `navigator.locks`(在れば)で並べる。
   */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = (): Promise<T> => (this.lock === null ? fn() : this.lock(fn));
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** 暗号の鍵(無ければ作る。⚠ 取り出せない鍵 ── 平文の鍵の字はどこにも出ない)。⚠ `serial` の中からだけ呼ぶ。 */
  private async key(): Promise<CryptoKey> {
    const have = await this.backend.getKey();
    if (have !== null) return have;
    const k = await this.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await this.backend.putKey(k);
    return k;
  }

  /**
   * 保管先の接続情報と秘密を置く(上書き)。
   * ⚠ 鍵が消えていて(ブラウザが退避した等)他の接続が残っていると、その接続の秘密は開けなくなる(`open` が `null` ──
   *   画面は「接続し直してください」と言う)。黙って別の鍵で開けたことにはしない。
   * @throws 接続先の設定が通らない(`s3ConfigProblem`)
   */
  save(cid: string, config: S3BoxConfig, secret: S3BoxSecret): Promise<void> {
    const problem = s3ConfigProblem(config);
    if (problem !== null) return Promise.reject(new Error(problem));
    return this.serial(async () => {
      const iv = this.random(new Uint8Array(12));
      const plain = new TextEncoder().encode(JSON.stringify({ a: secret.accessKeyId, s: secret.secretAccessKey }));
      const data = await this.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadOf(cid, config) }, await this.key(), plain);
      await this.backend.putBox(cid, { config: { ...config }, sealed: { iv, data } });
    });
  }

  /** 接続情報だけ(秘密を開かない ── 画面に出すとき)。 */
  async config(cid: string): Promise<S3BoxConfig | null> {
    return (await this.backend.getBox(cid))?.config ?? null;
  }

  /**
   * 接続情報と秘密を開く。開けなければ `null`(⚠ 理由の字に秘密を混ぜない ── 呼び手は「認証情報を読めません」とだけ言う)。
   * 🔴 暗号文は、置いたワークスペース(`cid`)と接続先の設定に結び付いている(追加の認証データ)── 別のワークスペースの
   *   暗号文を差し込まれても、接続先だけ書き換えられても開かない(秘密を別の宛先へ送らない)。
   */
  async open(cid: string): Promise<{ config: S3BoxConfig; secret: S3BoxSecret } | null> {
    const saved = await this.backend.getBox(cid);
    if (saved === null) return null;
    const k = await this.backend.getKey();
    if (k === null) return null;
    try {
      const plain = await this.subtle.decrypt(
        { name: 'AES-GCM', iv: saved.sealed.iv, additionalData: aadOf(cid, saved.config) },
        k,
        saved.sealed.data,
      );
      const o = JSON.parse(new TextDecoder().decode(plain)) as { a?: unknown; s?: unknown };
      if (typeof o.a !== 'string' || typeof o.s !== 'string') return null;
      return { config: saved.config, secret: { accessKeyId: o.a, secretAccessKey: o.s } };
    } catch {
      return null;
    }
  }

  /** 🔴 接続を外す(片道にしない)── 接続情報と秘密を消す。全部の接続が無くなったら暗号の鍵も消す。 */
  remove(cid: string): Promise<void> {
    return this.serial(async () => {
      await this.backend.deleteBox(cid);
      if ((await this.backend.countBoxes()) === 0) await this.backend.deleteKey();
    });
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
        // 鍵の書き込みは書き終えるまで戻らない(直後に落ちて鍵だけ失うと、置いた秘密が全部開けなくなる)
        const t = store === KEYS && mode === 'readwrite' ? db.transaction(store, mode, { durability: 'strict' }) : db.transaction(store, mode);
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
