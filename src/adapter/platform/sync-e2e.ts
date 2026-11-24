/**
 * 🔴 **端末間の同期の暗号化キーの持ち主**(#2000 段 4b-B)── 開いた暗号化キー(データ鍵)を、メモリと(任意で)この端末の保管に置く。
 *
 * - **A(既定)**: 開いたら、取り出せない暗号化キー(`extractable: false` の `CryptoKey`)を端末の保管(`SyncKeystore`)に置く ──
 *   次に開いたときも自動で同期する。
 * - **B(任意・「開くたびにパスフレーズを入れる」)**: 保管しない。メモリにだけ置く ── ページを開き直すたびにパスフレーズを入れるまで、同期は待つ。
 * ⚠ 秘密(パスフレーズ・回復キー・データ鍵の生の bytes)はここを通らない(渡るのは取り出せない `CryptoKey` と `keyId` だけ)。
 * ⚠ 保管の口(`E2EKeyStore`)は注入する ── この file は `SyncKeystore` を import しない(鍵の保管を読む file を増やさない。配線は `sync-remote.ts`)。
 */
import type { E2ECrypto, OpenedKey } from '@features/sync/e2e-crypto';

/** 端末の保管の口(`SyncKeystore` の 3 つの口に当たる)。 */
export interface E2EKeyStore {
  load(cid: string): Promise<{ keyId: string; key: CryptoKey } | null>;
  save(cid: string, v: { keyId: string; key: CryptoKey }): Promise<void>;
  remove(cid: string): Promise<void>;
}

export interface E2EKeyState {
  /** いま使える暗号化キーを持っているか(メモリ or 保管)。 */
  readonly open: boolean;
  /** この端末の保管に置いてあるか(偽 = 開くたびにパスフレーズを入れる)。 */
  readonly stored: boolean;
}

export class SyncE2E {
  readonly crypto: E2ECrypto;
  private readonly mem = new Map<string, OpenedKey>();
  private readonly storedFlag = new Map<string, boolean>();

  constructor(o: { crypto: E2ECrypto; keys: E2EKeyStore }) {
    this.crypto = o.crypto;
    this.keys = o.keys;
  }
  private readonly keys: E2EKeyStore;

  /** 暗号化キー(メモリを先に、無ければ保管から)。無ければ `null`(同期は待つ)。 */
  async key(cid: string, fromStore = true): Promise<OpenedKey | null> {
    const m = this.mem.get(cid);
    if (m !== undefined) return m;
    // 🔴 「開くたびにパスフレーズを入れる」の接続は、保管を読まない(消せなかった古いキーが残っていても、自動で開かない)
    if (!fromStore) return null;
    const s = await this.keys.load(cid);
    this.storedFlag.set(cid, s !== null);
    if (s === null) return null;
    const k: OpenedKey = { dataKey: s.key, keyId: s.keyId };
    this.mem.set(cid, k);
    return k;
  }

  /** 画面の見え方(同期の読み取り)。`refresh` のあとに正しい。 */
  state(cid: string): E2EKeyState {
    return { open: this.mem.has(cid), stored: this.storedFlag.get(cid) === true };
  }

  /** 保管を読んで、`state` を最新にする。 */
  async refresh(cid: string, fromStore = true): Promise<E2EKeyState> {
    await this.key(cid, fromStore).catch(() => null);
    return this.state(cid);
  }

  /** 開いた暗号化キーを置く。`remember` = 保管にも置く(A)/ 偽 = メモリだけ(B。保管に前の物があれば消す)。 */
  async hold(cid: string, key: OpenedKey, remember: boolean): Promise<void> {
    // 🔴 保管の操作を先に(失敗したら投げる = メモリに開かない)。メモリはあとから
    if (remember) {
      await this.keys.save(cid, { keyId: key.keyId, key: key.dataKey });
      this.storedFlag.set(cid, true);
    } else {
      await this.keys.remove(cid);
      this.storedFlag.set(cid, false);
    }
    this.mem.set(cid, key);
  }

  /** 保管の有無だけを切り替える(開いているキーがあるときだけ)。@returns 切り替えたか */
  async setRemember(cid: string, remember: boolean): Promise<boolean> {
    const k = this.mem.get(cid);
    if (k === undefined) return false;
    await this.hold(cid, k, remember);
    return true;
  }

  /** この端末の暗号化キーを忘れる(メモリと保管)。暗号化をオフにしたとき・接続を外すとき。 */
  async forget(cid: string): Promise<void> {
    this.mem.delete(cid);
    this.storedFlag.set(cid, false);
    await this.keys.remove(cid);
  }
}
