/** @vitest-environment node */
/**
 * 🔴 **bytes は在るが登録行（`assets` 表）が無い添付を、付け直したときに埋める**（#1087）。
 *
 * ⚠ 「ノートの保存データを作り直す」は sqlite を丸ごと捨てるので `assets` 表も消える。
 *   bytes（IndexedDB）は残るため、同じ添付をもう一度付けても **bytes が在ると `putMeta` を
 *   呼ばない**作りで、登録行が戻らず、書き出し・容量の内訳に出ないままだった。
 */
import { describe, expect, it } from 'vitest';
import { storeAsset, type AttachDeps } from '../../src/adapter/ui/actions/attach';

type Meta = { key: string; mime: string; size: number; hash: string | null };

function deps(over: { blobKeys: string[]; metaKeys?: string[] | 'unsupported' }) {
  const putMeta: Meta[] = [];
  const putBlob: string[] = [];
  const d = {
    putBlob: async (key: string) => {
      putBlob.push(key);
    },
    putMeta: async (m: Meta) => {
      putMeta.push(m);
    },
    listStoredBlobKeys: async () => over.blobKeys,
    ...(over.metaKeys === 'unsupported'
      ? {}
      : { listMetaKeys: async () => over.metaKeys ?? [] }),
    gate: async (run: () => Promise<void>) => run(),
  } as unknown as AttachDeps;
  return { d, putMeta, putBlob };
}

const item = (text: string) => {
  const blob = new Blob([text], { type: 'text/plain' });
  return { name: 'a.txt', type: 'text/plain', size: blob.size, blob };
};

describe('🔴 bytes は在るが登録行が無い添付（#1087）', () => {
  it('🔴 登録行が無ければ、bytes を書き直さずに登録行だけ書く', async () => {
    // 1 回目: 何も無い状態で付けて、key を知る
    const first = deps({ blobKeys: [] });
    const stored = await storeAsset(first.d, item('同じ中身'));
    expect(first.putMeta, '前提: 新規は登録行を書く').toHaveLength(1);

    const h = deps({ blobKeys: [stored.assetKey], metaKeys: [] });
    await storeAsset(h.d, item('同じ中身'), new Set([stored.assetKey]));
    expect(h.putBlob, 'bytes を書き直している').toEqual([]);
    expect(h.putMeta.map((m) => m.key), '登録行を埋めていない').toEqual([stored.assetKey]);
    expect(h.putMeta[0]!.size).toBe(item('同じ中身').size);
  });

  it('⚠ 対照群 ── 登録行が在れば触らない（初回の mime を保つ）', async () => {
    const first = deps({ blobKeys: [] });
    const stored = await storeAsset(first.d, item('同じ中身'));
    const h = deps({ blobKeys: [stored.assetKey], metaKeys: [stored.assetKey] });
    await storeAsset(h.d, item('同じ中身'), new Set([stored.assetKey]));
    expect(h.putMeta, '在る登録行を上書きしている').toEqual([]);
    expect(h.putBlob).toEqual([]);
  });

  it('⚠ 登録行の一覧が引けなくても、付け直し自体は通る', async () => {
    const first = deps({ blobKeys: [] });
    const stored = await storeAsset(first.d, item('同じ中身'));
    const h = deps({ blobKeys: [stored.assetKey] });
    h.d.listMetaKeys = async () => {
      throw new Error('読めません');
    };
    await expect(storeAsset(h.d, item('同じ中身'), new Set([stored.assetKey]))).resolves.toBeTruthy();
  });

  it('🔴 アプリの配線が `listMetaKeys` を渡している（渡し忘れると、静かに戻らなくなる）', async () => {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync('src/main.ts', 'utf8');
    const at = main.indexOf('const attachDeps: AttachDeps = {');
    expect(at, 'attachDeps の組み立てを見つけられない').toBeGreaterThan(-1);
    const body = main.slice(at, main.indexOf('};', at));
    expect(body, '配線に listMetaKeys が無い').toContain('listMetaKeys: async');
    expect(body).toContain("op: 'listAssetMetas'");
  });
});
