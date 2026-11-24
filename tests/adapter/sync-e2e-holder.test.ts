import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SyncE2E, type E2EKeyStore } from '../../src/adapter/platform/sync-e2e';

const crypto = { subtle: webcrypto.subtle as SubtleCrypto, random: (n: number) => webcrypto.getRandomValues(new Uint8Array(n)) };
async function dataKey(): Promise<CryptoKey> {
  return (await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])) as CryptoKey;
}
function mem(): E2EKeyStore & { map: Map<string, { keyId: string; key: CryptoKey }> } {
  const map = new Map<string, { keyId: string; key: CryptoKey }>();
  return { map, load: async (c) => map.get(c) ?? null, save: async (c, v) => void map.set(c, v), remove: async (c) => void map.delete(c) };
}

describe('SyncE2E(開いた暗号化キーの持ち主 = 段 4b-B)', () => {
  it('A(置く): 保管にも入り、作り直した持ち主(= 開き直し)でも自動で開く / B(置かない): メモリだけ・開き直すと無い', async () => {
    const ks = mem();
    const a = new SyncE2E({ crypto, keys: ks });
    expect(await a.key('c')).toBeNull();
    const k = { dataKey: await dataKey(), keyId: 'kid' };
    await a.hold('c', k, true);
    expect(a.state('c')).toEqual({ open: true, stored: true });
    expect(ks.map.has('c')).toBe(true);
    const reopened = new SyncE2E({ crypto, keys: ks });
    expect((await reopened.key('c'))?.keyId, '保管から自動で開く').toBe('kid');
    expect(await reopened.refresh('c')).toEqual({ open: true, stored: true });

    await a.setRemember('c', false);
    expect(ks.map.has('c'), '保管を消した').toBe(false);
    expect((await a.key('c'))?.keyId, 'このセッションでは開いたまま').toBe('kid');
    expect(a.state('c')).toEqual({ open: true, stored: false });
    expect(await new SyncE2E({ crypto, keys: ks }).key('c'), '開き直すと無い').toBeNull();
    expect(await a.setRemember('zzz', true), '開いていない接続は切り替えられない').toBe(false);
    await a.setRemember('c', true);
    expect(ks.map.get('c')?.keyId).toBe('kid');
  });

  it('forget: メモリも保管も消す', async () => {
    const ks = mem();
    const a = new SyncE2E({ crypto, keys: ks });
    await a.hold('c', { dataKey: await dataKey(), keyId: 'k' }, true);
    await a.forget('c');
    expect(await a.key('c')).toBeNull();
    expect(ks.map.size).toBe(0);
    expect(a.state('c')).toEqual({ open: false, stored: false });
  });
});
