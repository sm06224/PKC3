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
import { s3ConfigProblem, SyncKeystore, SYNC_KEYS_DB, type KeystoreBackend, type S3BoxConfig } from '../../src/adapter/platform/sync-keystore';

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

describe('🔴 着地前レビュー 🔴1: 暗号文は置いたワークスペースと接続先に結び付く(追加の認証データ)', () => {
  it('🔴 別のワークスペースの暗号文を差し込まれても開かない', async () => {
    const be = memBackend();
    const ks = new SyncKeystore(be);
    await ks.save('c1', CONFIG, { accessKeyId: CANARY_ID, secretAccessKey: CANARY_SECRET });
    await be.putBox('c2', (await be.getBox('c1'))!);
    expect(await ks.open('c2'), '差し込んだ暗号文で c2 の秘密として開いた').toBeNull();
    expect((await ks.open('c1'))?.secret.accessKeyId, '対照群: 元のワークスペースでは開く').toBe(CANARY_ID);
  });
  it('🔴 接続先(エンドポイント)だけ書き換えられたら開かない(秘密を別の宛先へ送らない)', async () => {
    const be = memBackend();
    const ks = new SyncKeystore(be);
    await ks.save('c1', CONFIG, { accessKeyId: CANARY_ID, secretAccessKey: CANARY_SECRET });
    const saved = (await be.getBox('c1')) as unknown as { config: S3BoxConfig; sealed: unknown };
    await be.putBox('c1', { config: { ...saved.config, endpoint: 'https://evil.example.test' }, sealed: saved.sealed } as never);
    expect(await ks.open('c1')).toBeNull();
  });
  it('IV は保存のたびに違う', async () => {
    const be = memBackend();
    const ks = new SyncKeystore(be);
    await ks.save('c1', CONFIG, { accessKeyId: 'a', secretAccessKey: 'b' });
    const iv1 = Buffer.from(((await be.getBox('c1')) as unknown as { sealed: { iv: Uint8Array } }).sealed.iv).toString('hex');
    await ks.save('c1', CONFIG, { accessKeyId: 'a', secretAccessKey: 'b' });
    const iv2 = Buffer.from(((await be.getBox('c1')) as unknown as { sealed: { iv: Uint8Array } }).sealed.iv).toString('hex');
    expect(iv1).not.toBe(iv2);
  });
});

describe('🔴 着地前レビュー 🔴2: 書く操作は 1 つずつ(鍵の作り合い・保存と外すの重なり)', () => {
  /** 読み書きの間に間を入れる置き場(重なりを起こしやすくする)。 */
  function slowBackend(): ReturnType<typeof memBackend> {
    const be = memBackend();
    const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
    return {
      ...be,
      getKey: async () => {
        const k = await be.getKey();
        await wait();
        return k;
      },
      putBox: async (cid, v) => {
        await wait();
        await be.putBox(cid, v);
      },
      countBoxes: async () => {
        await wait();
        return be.countBoxes();
      },
    };
  }
  it('🔴 鍵が無いところへ 2 つ同時に保存しても、両方とも開ける(鍵を 2 本作って後勝ちにしない)', async () => {
    const ks = new SyncKeystore(slowBackend());
    await Promise.all([
      ks.save('c1', CONFIG, { accessKeyId: 'one', secretAccessKey: 's1' }),
      ks.save('c2', CONFIG, { accessKeyId: 'two', secretAccessKey: 's2' }),
    ]);
    expect((await ks.open('c1'))?.secret.accessKeyId).toBe('one');
    expect((await ks.open('c2'))?.secret.accessKeyId).toBe('two');
  });
  it('🔴 外すと保存が重なっても、保存した秘密は開ける(外した側が鍵を消して古い鍵の暗号文を残さない)', async () => {
    const ks = new SyncKeystore(slowBackend());
    await ks.save('c1', CONFIG, { accessKeyId: 'one', secretAccessKey: 's1' });
    await Promise.all([ks.remove('c1'), ks.save('c2', CONFIG, { accessKeyId: 'two', secretAccessKey: 's2' })]);
    expect((await ks.open('c2'))?.secret.accessKeyId).toBe('two');
  });
  it('タブをまたぐ口(navigator.locks)を渡せば、書く操作はその中で動く', async () => {
    const inside: string[] = [];
    let depth = 0;
    const lock = async <T,>(fn: () => Promise<T>): Promise<T> => {
      depth += 1;
      try {
        return await fn();
      } finally {
        depth -= 1;
      }
    };
    const be = memBackend();
    const putBox = be.putBox;
    be.putBox = async (cid, v) => {
      inside.push(depth > 0 ? 'locked' : 'free');
      await putBox(cid, v);
    };
    await new SyncKeystore(be, undefined, undefined, lock).save('c1', CONFIG, { accessKeyId: 'a', secretAccessKey: 'b' });
    expect(inside).toEqual(['locked']);
  });
});

describe('着地前レビュー ⚠4: 平文で置く接続先に認証情報を紛れ込ませない', () => {
  it('🔴 利用者名・パスワード・クエリ・断片・パス入りのエンドポイント、http(手元以外)は断る(理由にエンドポイントの字を出さない)', async () => {
    const bad = [
      'https://AKIAX:SECRETX@s3.example.test',
      'https://s3.example.test/?X-Amz-Signature=SECRETX',
      'https://s3.example.test/#SECRETX',
      'https://s3.example.test/bucket',
      'http://s3.example.test',
    ];
    for (const endpoint of bad) {
      const why = s3ConfigProblem({ ...CONFIG, endpoint });
      expect(why, endpoint).not.toBeNull();
      expect(why!).not.toContain('SECRETX');
      await expect(new SyncKeystore(memBackend()).save('c1', { ...CONFIG, endpoint }, { accessKeyId: 'a', secretAccessKey: 'b' })).rejects.toThrow();
    }
    expect(s3ConfigProblem({ ...CONFIG, endpoint: 'http://localhost:9000' }), '手元の確かめは通す').toBeNull();
    expect(s3ConfigProblem(CONFIG)).toBeNull();
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
  const ALLOWED_IMPORTERS: Record<string, string> = {
    // 段 4a-3: S3 の保管先は接続情報と秘密の**型**だけを読む(秘密は呼び手が `open` で開いて渡す)。書き出しの経路ではない
    [join('src', 'adapter', 'platform', 's3-box.ts')]: 'S3 の保管先(型だけ)',
    // 段 4a-4: 同期の実行部は接続先の型と確かめ(`normalizeS3Config` / `s3ConfigProblem`)だけ。開いた秘密は口(box)へ渡すだけで記録に置かない
    [join('src', 'adapter', 'platform', 'sync-folder.ts')]: '同期の実行部(型と確かめだけ)',
    // 段 4a-4: 鍵の保管と S3 の保管先をつなぐ 1 か所(main.ts はここだけを読む)
    [join('src', 'adapter', 'platform', 'sync-remote.ts')]: '保管先の口を組む所',
  };

  it('🔴 鍵の口を import している file は、許した物だけ(書き出しの経路は 1 つも無い)', () => {
    // ⚠ import の書き方を問わない(`from` / 動的 `import()` / 副作用の `import '…'` / 拡張子つき)── 字としての参照を全部数える
    const importers = all
      .filter((f) => /['"][^'"]*sync-keystore(?:\.ts)?['"]/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !p.endsWith('sync-keystore.ts'));
    expect(importers.filter((p) => ALLOWED_IMPORTERS[p] === undefined), '許していない file が鍵の口を読んでいる').toEqual([]);
    // 書き出しの経路の file が許した一覧に紛れていない
    for (const p of Object.keys(ALLOWED_IMPORTERS))
      expect(p, `書き出しの経路が鍵の口を読む: ${p}`).not.toMatch(/backup|export|diff-file|sync-diff|settings-file|message|notice|portable/);
  });

  it('🔴 src のどこも IndexedDB の DB を全部並べない(`indexedDB.databases()` で鍵の置き場を拾う道を作らない)', () => {
    expect(all.filter((f) => /indexedDB\s*\.\s*databases\s*\(/.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it('🔴 鍵の口の file(IndexedDB の置き場も含む)は localStorage / sessionStorage に触らない', () => {
    const me = all.find((f) => f.path.endsWith(join('platform', 'sync-keystore.ts')))!;
    expect(me.text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toMatch(/localStorage|sessionStorage/);
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
