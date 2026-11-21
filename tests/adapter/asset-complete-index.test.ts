import { describe, expect, it } from 'vitest';
import { createAssetIndex } from '../../src/adapter/ui/actions/asset-complete-index';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const fm = (name: string, key: string, mime = 'image/png', size = 10): string =>
  `---\nattachment.name: ${name}\nattachment.mime: ${mime}\nattachment.size: ${String(size)}\nattachment.asset_key: ${key}\n---\n`;

function meta(lid: string, updatedAt: string, archetype = 'attachment'): EntryMeta {
  return { lid, title: lid, archetype, createdAt: null, updatedAt, entryOrder: 0, status: null, date: null, archived: false, bodyChars: null };
}

/** 本文の置き場(読んだ lid の記録つき)。 */
function store(initial: Record<string, string>) {
  const bodies = new Map(Object.entries(initial));
  const reads: string[][] = [];
  const read = (lids: readonly string[]): Promise<ReadonlyMap<string, string>> => {
    reads.push([...lids]);
    return Promise.resolve(new Map(lids.filter((l) => bodies.has(l)).map((l) => [l, bodies.get(l)!] as const)));
  };
  return { bodies, reads, read };
}

describe('添付の一覧(#2001 段 4)── updatedAt で控えを失効させる', () => {
  it('追加・改名・削除が一覧に反映され、変わっていない添付は読み直さない', async () => {
    const idx = createAssetIndex();
    const st = store({ a: fm('a.png', 'ka'), b: fm('b.pdf', 'kb', 'application/pdf') });
    let metas = new Map([['a', meta('a', 'u1')], ['b', meta('b', 'u1')]]);
    let order = ['a', 'b'];
    expect((await idx.rows(metas, order, st.read)).map((r) => r.name)).toEqual(['a.png', 'b.pdf']);
    expect(st.reads).toEqual([['a', 'b']]);
    // 同じ状態でもう一度 → 読まない
    await idx.rows(metas, order, st.read);
    expect(st.reads.length, '控えがあるのに読み直した').toBe(1);
    // 改名(本文が変わり updatedAt が動く)→ その 1 件だけ読み直し、新しい名前になる
    st.bodies.set('a', fm('renamed.png', 'ka'));
    metas = new Map([['a', meta('a', 'u2')], ['b', meta('b', 'u1')]]);
    expect((await idx.rows(metas, order, st.read)).map((r) => r.name), '改名が一覧に出ない').toEqual(['renamed.png', 'b.pdf']);
    expect(st.reads.at(-1), '無関係な添付まで読み直した').toEqual(['a']);
    // 別のノート(添付でない)が変わっても、添付は読み直さない
    metas = new Map([...metas, ['t', meta('t', 'u9', 'text')]]);
    order = ['a', 'b', 't'];
    const n = st.reads.length;
    await idx.rows(metas, order, st.read);
    expect(st.reads.length, '添付でないノートの追加で読み直した').toBe(n);
    // 追加
    st.bodies.set('c', fm('c.txt', 'kc', 'text/plain'));
    metas = new Map([...metas, ['c', meta('c', 'u1')]]);
    order = ['a', 'b', 't', 'c'];
    expect((await idx.rows(metas, order, st.read)).map((r) => r.name)).toEqual(['renamed.png', 'b.pdf', 'c.txt']);
    expect(st.reads.at(-1)).toEqual(['c']);
    // 削除(order から消える)→ 一覧から消え、同じ lid が戻ったら読み直す(古い控えを使わない)
    order = ['a', 't', 'c'];
    metas = new Map([...metas].filter(([l]) => l !== 'b'));
    expect((await idx.rows(metas, order, st.read)).map((r) => r.name)).toEqual(['renamed.png', 'c.txt']);
    metas = new Map([...metas, ['b', meta('b', 'u1')]]);
    order = ['a', 'b', 't', 'c'];
    const m = st.reads.length;
    await idx.rows(metas, order, st.read);
    expect(st.reads.length, '消えた添付の控えが残っている').toBe(m + 1);
    expect(st.reads.at(-1)).toEqual(['b']);
  });

  it('同じ updatedAt のまま本文だけが違っても読み直さない(失効の鍵は updatedAt)── 逆に updatedAt が動けば必ず読む', async () => {
    const idx = createAssetIndex();
    const st = store({ a: fm('old.png', 'ka') });
    const order = ['a'];
    await idx.rows(new Map([['a', meta('a', 'u1')]]), order, st.read);
    st.bodies.set('a', fm('new.png', 'ka'));
    expect((await idx.rows(new Map([['a', meta('a', 'u1')]]), order, st.read))[0]?.name).toBe('old.png');
    expect((await idx.rows(new Map([['a', meta('a', 'u2')]]), order, st.read))[0]?.name).toBe('new.png');
  });

  it('🔴 読んでいる最中の添付は、続けて呼ばれても二重に読まない(1 つの読みを共有)', async () => {
    const idx = createAssetIndex();
    let release: (m: ReadonlyMap<string, string>) => void = () => undefined;
    let calls = 0;
    const slow = (): Promise<ReadonlyMap<string, string>> => {
      calls += 1;
      return new Promise((r) => {
        release = r;
      });
    };
    const metas = new Map([['a', meta('a', 'u1')]]);
    const order = ['a'];
    const p1 = idx.rows(metas, order, slow);
    const p2 = idx.rows(metas, order, slow);
    release(new Map([['a', fm('a.png', 'ka')]]));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(calls, '打鍵ごとに同じ添付を読み直している').toBe(1);
    expect(r1.map((r) => r.name)).toEqual(['a.png']);
    expect(r2.map((r) => r.name)).toEqual(['a.png']);
  });

  it('読みが失敗したら呼び手へ失敗を返し、控えず、次の呼びで読み直す', async () => {
    const idx = createAssetIndex();
    const metas = new Map([['a', meta('a', 'u1')]]);
    const order = ['a'];
    await expect(idx.rows(metas, order, () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    const st = store({ a: fm('a.png', 'ka') });
    expect((await idx.rows(metas, order, st.read)).map((r) => r.name)).toEqual(['a.png']);
    expect(st.reads).toEqual([['a']]);
  });

  it('key が無い添付は候補に出さない', async () => {
    const idx = createAssetIndex();
    const st = store({ a: '---\nattachment.name: x.png\n---\n' });
    expect(await idx.rows(new Map([['a', meta('a', 'u1')]]), ['a'], st.read)).toEqual([]);
  });
});
