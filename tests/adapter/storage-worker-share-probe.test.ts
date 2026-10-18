/** @vitest-environment node */
/**
 * 🔴 **この添付を差し替えると、ほかに何が新しい版になるか**(#1163 依頼 211・293)── worker の読み口 `assetShareProbe`。
 *
 * 守る主張:
 * 1. 同じファイルを指す、ほかの添付のノートを数える(自分は数えない)
 * 2. その鍵を指すリンクを持つ、ほかのノートの数と、リンクの数を数える
 * 3. 数える規則は書き換える側(`rewriteAssetRefs`)と同じ ── 見せる数と、実際に変わる数が一致する(`replaceAssetRefs` の結果と突き合わせる)
 * 4. 読むだけ(本文を 1 バイトも変えない)/ 添付でないノートと実体の分からないノートは `null`
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ResultMap, StorageRequest, StorageResponse } from '../../src/adapter/platform/storage/protocol';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { attachmentBody } from '../../src/features/flavor/attachment-flavor';

type Op = StorageRequest['op'];
const pending = new Map<number, (resp: StorageResponse) => void>();
let seq = 0;
const workerSelf: {
  onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
} = { onmessage: null };

function request<O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (resp) => (resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error))));
    workerSelf.onmessage!({ data: { id, req } });
  });
}

const CID = 'c-share-probe';

const put = (lid: string, body: string, over: Partial<EntryUpsert> = {}) =>
  request({
    op: 'upsertEntry',
    cid: CID,
    entry: {
      lid,
      title: `t-${lid}`,
      archetype: 'text',
      body,
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
      ...over,
    },
    checkpoint: false,
  });

const att = (name: string, key: string): string =>
  attachmentBody({ name, mime: 'application/pdf', size: 3, assetKey: key });

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  await request({ op: 'init', dbName: 'unit-test-share-probe' });
  await request({ op: 'openContainer', cid: CID, title: 'share-probe' });
  // 控えと作業用: 同じファイル(ast-same)を指す添付が 2 つ
  await put('keep', att('契約書(控え).pdf', 'ast-same'), { archetype: 'attachment', entryOrder: 1 });
  await put('work', att('契約書(作業用).pdf', 'ast-same'), { archetype: 'attachment', entryOrder: 2 });
  // 別のファイルを指す添付(数えない)
  await put('other', att('別.pdf', 'ast-other'), { archetype: 'attachment', entryOrder: 3 });
  // その鍵を指すリンクを持つノート: 2 か所と 1 か所 / 別の鍵だけのノート(数えない)
  await put('n1', '[契約書](asset:ast-same) と ![図](asset:ast-same)\n', { entryOrder: 4 });
  await put('n2', '[もう一度](asset:ast-same)\n', { entryOrder: 5 });
  await put('n3', '[別](asset:ast-other)\n', { entryOrder: 6 });
  // 孤立した添付(ほかに同じファイルを指す添付もリンクも無い)
  await put('solo', att('単独.pdf', 'ast-solo'), { archetype: 'attachment', entryOrder: 7 });
}, 30_000);

describe('assetShareProbe(worker の読み口)', () => {
  it('🔴 同じファイルを指すほかの添付と、その鍵を指すリンクを数える(自分は数えない)', async () => {
    const r = await request({ op: 'assetShareProbe', cid: CID, targetLid: 'work' });
    expect(r).toEqual({ sharers: 1, linkNotes: 2, links: 3 });
  });

  it('対照: 控えから数えても同じ(相手が入れ替わるだけ)/ 単独の添付は 0', async () => {
    expect(await request({ op: 'assetShareProbe', cid: CID, targetLid: 'keep' })).toEqual({ sharers: 1, linkNotes: 2, links: 3 });
    expect(await request({ op: 'assetShareProbe', cid: CID, targetLid: 'solo' })).toEqual({ sharers: 0, linkNotes: 0, links: 0 });
  });

  it('🔴 添付でないノート / 無いノートは null(数えられない)', async () => {
    expect(await request({ op: 'assetShareProbe', cid: CID, targetLid: 'n1' })).toBeNull();
    expect(await request({ op: 'assetShareProbe', cid: CID, targetLid: 'nope' })).toBeNull();
  });

  it('🔴 読むだけ ── 本文は 1 バイトも変わらない', async () => {
    const before = await request({ op: 'getBody', cid: CID, lid: 'n1' });
    await request({ op: 'assetShareProbe', cid: CID, targetLid: 'work' });
    expect(await request({ op: 'getBody', cid: CID, lid: 'n1' })).toBe(before);
  });

  it('🔴 見せた数と、実際に新しい版へ変わる数が一致する(差し替えは最後に回す)', async () => {
    const probe = (await request({ op: 'assetShareProbe', cid: CID, targetLid: 'work' }))!;
    const done = await request({
      op: 'replaceAssetRefs',
      cid: CID,
      targetLid: 'work',
      newKey: 'ast-new',
      newHash: null,
      newBytes: 4,
      newName: '契約書(作業用).pdf',
      newMime: 'application/pdf',
      savedAt: '2026-10-17T00:00:00.000Z',
    });
    // 書き換わったノート = 本人 + リンクを持つノート(ほかの添付のノート自身は frontmatter の鍵なので、本文のリンクの数には入らない)
    const rewritten = done.wrote.map((w) => w.lid).filter((l) => l !== 'work').sort();
    expect(rewritten).toEqual(['n1', 'n2']);
    expect(rewritten.length).toBe(probe.linkNotes);
    // ほかの添付のノート(控え)は古い版のまま ── 見せた「sharers」は、リンクの数には足さない
    expect(await request({ op: 'getBody', cid: CID, lid: 'keep' })).toContain('ast-same');
  });
});
