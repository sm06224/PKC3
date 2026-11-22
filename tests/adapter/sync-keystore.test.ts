/** @vitest-environment node */
/**
 * 🔴 **同期の保管先の鍵(資格情報)の保管**(#2000 段 4a-2。user 裁定 2026-11-22)。
 *
 * 守る主張:
 * 1. 秘密(アクセスキー ID・シークレット)は AES-GCM で暗号化して置き、置き場の中身に平文の字が 1 バイトも無い
 * 2. 暗号の鍵は取り出せない(`extractable: false`)
 * 3. 開けない(鍵が無い・改ざん)ときは `null` で返し、理由の字に秘密を混ぜない
 * 4. 「接続を外す」で接続情報と秘密が消え、全部の接続が無くなったら暗号の鍵も消える(片道にしない)
 * 5. 🔴 **user の必須ガード: バックアップ(full / part / notes)・差分 zip・設定ファイル・メッセージの集積地のどれにも混ざらない**
 *    ── 鍵の置き場(IndexedDB の `pkc3-sync-keys`)を読む口は `sync-keystore.ts` だけで、書き出しの経路はどれもこの口を
 *    import しない / localStorage(設定ファイルが運ぶ置き場)にも sessionStorage にも書かない
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SyncKeystore, SYNC_KEYS_DB, type KeystoreBackend, type S3BoxConfig } from '../../src/adapter/platform/sync-keystore';

const CANARY_ID = 'AKIA-CANARY-ID-7Q3';
const CANARY_SECRET = 'canary/SECRET+value=Zx81';
const CONFIG: S3BoxConfig = { kind: 's3', endpoint: 'https://s3.example.test', bucket: 'notes', region: 'auto', prefix: 'pkc3/' };

/** 作り物の置き場(中身を覗ける)。 */
function memBackend(): KeystoreBackend & { dump(): unknown[] } {
  let key: CryptoKey | null = null;
  const boxes = new Map<string, unknown>();
  return {
    getKey: async () => key,
    putKey: async (k) => void (key = k),
    deleteKey: async () => void (key = null),
    getBox: async (cid) => (boxes.get(cid) as never) ?? null,
    putBox: async (cid, v) => void boxes.set(cid, structuredClone(v)),
    deleteBox: async (cid) => void boxes.delete(cid),
    countBoxes: async () => boxes.size,
    dump: () => [key, ...boxes.values()],
  };
}

/** 置き場の中身を、字として探せる形に崩す(バイト列は latin1 の字に)。 */
function flatten(v: unknown): string {
  if (v instanceof ArrayBuffer) return Buffer.from(v).toString('latin1');
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('latin1');
  if (typeof v === 'object' && v !== null) return Object.values(v).map(flatten).join('|');
  return String(v);
}

describe('SyncKeystore', () => {
  it('🔴 置いて開ける / 接続情報は秘密を開かずに読める', async () => {
    const ks = new SyncKeystore(memBackend());
    await ks.save('c1', CONFIG, { accessKeyId: CANARY_ID, secretAccessKey: CANARY_SECRET });
    expect(await ks.config('c1')).toEqual(CONFIG);
    expect(await ks.open('c1')).toEqual({ config: CONFIG, secret: { accessKeyId: CANARY_ID, secretAccessKey: CANARY_SECRET } });
  });

  it('🔴 置き場の中身に、秘密の平文が 1 バイトも無い(暗号化されている)', async () => {
    const be = memBackend();
    await new SyncKeystore(be).save('c1', CONFIG, { accessKeyId: CANARY_ID, secretAccessKey: CANARY_SECRET });
    const flat = be.dump().map(flatten).join('||');
    expect(flat, '空振り防止: 接続情報は平文で在る').toContain('s3.example.test');
    for (const c of [CANARY_ID, CANARY_SECRET, 'CANARY', 'SECRET']) expect(flat, `平文の ${c} が置き場に在る`).not.toContain(c);
  });

  it('🔴 暗号の鍵は取り出せない', async () => {
    const be = memBackend();
    await new SyncKeystore(be).save('c1', CONFIG, { accessKeyId: 'a', secretAccessKey: 'b' });
    const k = (await be.getKey())!;
    expect(k.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey('raw', k)).rejects.toThrow();
  });

  it('🔴 開けないとき(改ざん・鍵が無い)は null で返し、投げない', async () => {
    const be = memBackend();
    const ks = new SyncKeystore(be);
    await ks.save('c1', CONFIG, { accessKeyId: CANARY_ID, secretAccessKey: CANARY_SECRET });
    const saved = (await be.getBox('c1')) as unknown as { config: S3BoxConfig; sealed: { iv: Uint8Array; data: ArrayBuffer } };
    const bad = new Uint8Array(saved.sealed.data.slice(0));
    bad[0] = bad[0]! ^ 0xff;
    await be.putBox('c1', { config: saved.config, sealed: { iv: saved.sealed.iv, data: bad.buffer } } as never);
    expect(await ks.open('c1'), '改ざんされた秘密を開いた').toBeNull();
    await be.deleteKey();
    expect(await ks.open('c1'), '鍵が無いのに開いた').toBeNull();
  });

  it('🔴 接続を外すと消え、全部の接続が無くなったら暗号の鍵も消える(他の接続があれば鍵は残る)', async () => {
    const be = memBackend();
    const ks = new SyncKeystore(be);
    await ks.save('c1', CONFIG, { accessKeyId: 'a', secretAccessKey: 'b' });
    await ks.save('c2', CONFIG, { accessKeyId: 'c', secretAccessKey: 'd' });
    await ks.remove('c1');
    expect(await ks.open('c1')).toBeNull();
    expect(await be.getKey(), '他の接続があるのに鍵を消した').not.toBeNull();
    expect((await ks.open('c2'))?.secret.accessKeyId).toBe('c');
    await ks.remove('c2');
    expect(await be.getKey(), '全部外したのに鍵が残った').toBeNull();
  });

  it('🔴 書けなかったときの理由の字に秘密を混ぜない', async () => {
    const be = memBackend();
    be.putBox = async () => {
      throw new Error('認証情報の置き場に書けません');
    };
    const err = await new SyncKeystore(be).save('c1', CONFIG, { accessKeyId: CANARY_ID, secretAccessKey: CANARY_SECRET }).catch((e: unknown) => e);
    expect(String(err)).not.toContain(CANARY_ID);
    expect(String(err)).not.toContain(CANARY_SECRET);
  });
});

describe('🔴 鍵が書き出しの経路に混ざらない(user の必須ガード)', () => {
  /** src の .ts を全部(コメントを含む原文)。 */
  function sources(dir = 'src'): { path: string; text: string }[] {
    const out: { path: string; text: string }[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...sources(p));
      else if (p.endsWith('.ts')) out.push({ path: p, text: readFileSync(p, 'utf8') });
    }
    return out;
  }
  const all = sources();

  it('🔴 鍵の置き場の名前(`pkc3-sync-keys`)を書いている file は sync-keystore.ts だけ', () => {
    const hits = all.filter((f) => f.text.includes(SYNC_KEYS_DB)).map((f) => f.path);
    expect(hits).toEqual([join('src', 'adapter', 'platform', 'sync-keystore.ts')]);
  });

  /**
   * 🔑 鍵の口を import してよい file の一覧(理由つき)。⚠ 書き出し(バックアップ・差分 zip・設定ファイル・メッセージ)の file は
   *   ここに入れない ── 入れたくなったら、それは鍵を書き出しへ運ぶ道を作ろうとしている。
   */
  const ALLOWED_IMPORTERS: Record<string, string> = {};

  it('🔴 鍵の口を import している file は、許した物だけ(書き出しの経路は 1 つも無い)', () => {
    const importers = all
      .filter((f) => /from\s+['"][^'"]*sync-keystore['"]/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !p.endsWith('sync-keystore.ts'));
    expect(importers.filter((p) => ALLOWED_IMPORTERS[p] === undefined), '許していない file が鍵の口を読んでいる').toEqual([]);
    // 書き出しの経路の file が許した一覧に紛れていない
    for (const p of Object.keys(ALLOWED_IMPORTERS))
      expect(p, `書き出しの経路が鍵の口を読む: ${p}`).not.toMatch(/backup|export|diff-file|sync-diff|settings-file|message|notice|portable/);
  });

  it('🔴 鍵を置いても、localStorage(設定ファイルが運ぶ置き場)にも sessionStorage にも 1 字も書かない', async () => {
    const writes: string[] = [];
    const fake = (name: string): Storage =>
      ({
        setItem: (k: string, v: string) => void writes.push(`${name}:${k}=${v}`),
        getItem: () => null,
        removeItem: () => undefined,
        clear: () => undefined,
        key: () => null,
        length: 0,
      }) as Storage;
    const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
    const before = { l: g.localStorage, s: g.sessionStorage };
    g.localStorage = fake('local');
    g.sessionStorage = fake('session');
    try {
      const ks = new SyncKeystore(memBackend());
      await ks.save('c1', CONFIG, { accessKeyId: CANARY_ID, secretAccessKey: CANARY_SECRET });
      await ks.open('c1');
      await ks.remove('c1');
    } finally {
      g.localStorage = before.l;
      g.sessionStorage = before.s;
    }
    expect(writes).toEqual([]);
  });
});
