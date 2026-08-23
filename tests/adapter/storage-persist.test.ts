/**
 * 🔴 **ノート本体が evictable のままだった**(#347、2026-08-23)。
 *
 * ⚠ 直す前、`navigator.storage.persist()` の呼び出しは
 * `office-pack-install.ts` の **1 か所だけ**だった ── Office を入れていない user の
 * ノートは、**一度も永続化を頼んでいなかった**。origin の quota は OPFS
 * (= SQLite 本体)と共用なので、空き容量が減ると**黙って消える**。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PersistOnce,
  requestPersist,
  type PersistCapableStorage,
} from '../../src/adapter/platform/storage-persist';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('requestPersist(#347)', () => {
  it('🔴 まだ消える側なら、頼む', async () => {
    const persist = vi.fn(async () => true);
    const store: PersistCapableStorage = { persisted: async () => false, persist };
    expect(await requestPersist(store)).toBe('persisted');
    expect(persist, '頼んでいない').toHaveBeenCalledTimes(1);
  });

  it('🔴 既に消えない側なら、頼まない(user に尋ねさせない)', async () => {
    const persist = vi.fn(async () => true);
    const store: PersistCapableStorage = { persisted: async () => true, persist };
    expect(await requestPersist(store)).toBe('persisted');
    expect(persist, '既に守られているのに尋ねた').not.toHaveBeenCalled();
  });

  it('🔴 断られたら denied(黙って persisted と言わない)', async () => {
    expect(await requestPersist({ persisted: async () => false, persist: async () => false })).toBe(
      'denied',
    );
  });

  /** ⚠ Safari は `persist` を持たない ── **落ちない**こと自体が主張である。 */
  it('⚠ 口の無いブラウザは unsupported(落ちない)', async () => {
    expect(await requestPersist(undefined)).toBe('unsupported');
    expect(await requestPersist({})).toBe('unsupported');
  });

  /**
   * 🔴 **「断られた」と「聞けなかった」を混ぜない。** 例外を `denied` と
   * 読むと、次に読む人が「user が断った」と誤解する。
   */
  it('🔴 例外は unknown(denied と言わない)', async () => {
    expect(
      await requestPersist({
        persisted: async () => false,
        persist: async () => {
          throw new Error('SecurityError');
        },
      }),
    ).toBe('unknown');
  });
});

describe('PersistOnce(#347)', () => {
  it('🔴 何度呼ばれても 1 度しか頼まない(保存のたびに尋ねない)', async () => {
    const persist = vi.fn(async () => true);
    const once = new PersistOnce({ persisted: async () => false, persist });
    await Promise.all([once.ensure(), once.ensure(), once.ensure()]);
    await once.ensure();
    expect(persist, '保存のたびに尋ねている').toHaveBeenCalledTimes(1);
    expect(once.current).toBe('persisted');
  });

  it('🔴 断られても聞き直さない(毎回の保存で尋ねることになる)', async () => {
    const persist = vi.fn(async () => false);
    const once = new PersistOnce({ persisted: async () => false, persist });
    expect(await once.ensure()).toBe('denied');
    expect(await once.ensure()).toBe('denied');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('⚠ 頼む前は unknown(「守られている」と名乗らない)', () => {
    expect(new PersistOnce({ persisted: async () => true, persist: async () => true }).current).toBe(
      'unknown',
    );
  });

  /** ⚠ 飛んでいる間に呼ばれても二重に頼まない(同じ約束を返す)。 */
  it('⚠ 飛んでいる間の呼び出しは同じ約束を返す', async () => {
    let release: (v: boolean) => void = () => {};
    const persist = vi.fn(() => new Promise<boolean>((r) => (release = r)));
    const once = new PersistOnce({ persisted: async () => false, persist });
    const a = once.ensure();
    await flush();
    const b = once.ensure();
    release(true);
    expect(await a).toBe('persisted');
    expect(await b).toBe('persisted');
    expect(persist, '飛んでいる間に二重に頼んだ').toHaveBeenCalledTimes(1);
  });
});
