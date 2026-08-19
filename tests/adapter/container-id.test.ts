/**
 * コンテナ id の採番(#260)。
 *
 * 🔴 直す前は `main.ts` が `'default'` という**全インストール共通の定数**を
 * 渡していた。`pkc://<cid>/entry/<lid>` の「自分のコンテナか」は**文字列の
 * 等値**で決まる(`features/link/permalink.ts`)ので、**他人の PKC3 が書いた
 * 参照**が「自分のもの」と判定されていた。
 *
 * 🔑 守る主張は 3 つ:
 * 1. **新しい端末は自分だけの id を持つ**(`'default'` を名乗らない)
 * 2. **既に在るものは採番し直さない** ── cid は全テーブルの区画鍵
 *    (`WHERE cid = ?`)なので、振り直すと**既存データがまるごと見えなくなる**
 * 3. **綴りが 2 つの外部制約を満たす** ── permalink の token 規則と、
 *    asset の key 空間(`':'` 禁止)
 *
 * ⚠ **DB の状態ごとに worker を建て直す**(`init` は冪等なので、1 つの
 *   instance では「まっさらな DB」と「既に在る DB」を両方は試せない)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';
import {
  formatPortablePkcReference,
  parsePortablePkcReference,
} from '../../src/features/link/permalink';

type Op = StorageRequest['op'];
type Request = <O extends Op>(req: Extract<StorageRequest, { op: O }>) => Promise<ResultMap[O]>;

let dbSeq = 0;

/** まっさらな :memory: DB を持つ worker を 1 本建てる(node に OPFS は無い)。 */
async function freshWorker(): Promise<Request> {
  const pending = new Map<number, (resp: StorageResponse) => void>();
  let seq = 0;
  const workerSelf: {
    onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
  } = { onmessage: null };
  const g = globalThis as unknown as Record<string, unknown>;
  g['self'] = workerSelf;
  g['postMessage'] = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  const request: Request = (req) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (resp) =>
        resp.ok ? resolve(resp.result as never) : reject(new Error(resp.error)),
      );
      workerSelf.onmessage!({ data: { id, req } });
    });
  // ⚠ module registry を捨ててから import する ── 捨てないと前の test の
  //   worker(= 前の DB)がそのまま返ってきて、「まっさら」の前提が崩れる
  vi.resetModules();
  await import('../../src/adapter/platform/storage/storage-worker');
  const init = await request({ op: 'init', dbName: `unit-cid-${++dbSeq}` });
  expect(init.vfs, 'node に OPFS は無い ── memory fallback が前提').toBe('memory');
  return request;
}

let request: Request;
beforeEach(async () => {
  request = await freshWorker();
}, 30_000);

describe('コンテナ id の採番(#260)', () => {
  it('🔴 まっさらな端末は、自分だけの id を採番する', async () => {
    const first = await request({ op: 'resolveContainer', title: 'PKC3' });
    expect(first.created, '既に在るものを返した(まっさらの前提が崩れている)').toBe(true);
    expect(first.cid, '全インストール共通の既定値を名乗っている').not.toBe('default');
    expect(first.cid).toMatch(/^c-[0-9a-f]{32}$/);
  });

  it('🔴 2 回目は採番し直さない(同じ id が返る)', async () => {
    const first = await request({ op: 'resolveContainer', title: 'PKC3' });
    const second = await request({ op: 'resolveContainer', title: 'PKC3' });
    expect(second.cid, '起動のたびに別の器を開いている').toBe(first.cid);
    expect(second.created, '既に在るのに作ったと言っている').toBe(false);
  });

  /**
   * 🔴 **移行は「既存はそのまま」**(#260 の推薦)。振り直すと、区画鍵が変わって
   * 既存の entry / relation / revision / asset が**まるごと見えなくなる**。
   */
  it('🔴 既に `default` で使っている端末は、そのまま `default` を返す', async () => {
    await request({ op: 'openContainer', cid: 'default', title: 'PKC3' });
    await request({
      op: 'upsertEntry',
      cid: 'default',
      entry: {
        lid: 'e1',
        title: '前からあるノート',
        archetype: 'text',
        body: '本文',
        entryOrder: 1,
        status: null,
        date: null,
        archived: false,
      },
      checkpoint: false,
    });

    const resolved = await request({ op: 'resolveContainer', title: 'PKC3' });
    expect(resolved.cid, '既存の器を捨てて採番し直した').toBe('default');
    expect(resolved.created).toBe(false);
    // ⚠ 観測点は「id が同じ」ではなく **中身が見えること**(区画鍵なので)
    const metas = await request({ op: 'listEntryMetas', cid: resolved.cid });
    expect(metas.map((m) => m.lid), '既存のノートが見えなくなっている').toEqual(['e1']);
  });

  /**
   * ⚠ 綴りの制約は**別の file が持っている** ── ここで正規表現を書き写すと、
   * 向こうが変わったときに気づけない。**本物の formatter に通す**。
   */
  it('🔴 採番した id は permalink の綴りに収まる', async () => {
    const { cid } = await request({ op: 'resolveContainer', title: 'PKC3' });
    const ref = formatPortablePkcReference({ kind: 'entry', containerId: cid, targetId: 'e1' });
    expect(ref, 'permalink の token 規則に収まらない id を採番した').not.toBeNull();
    expect(parsePortablePkcReference(ref!)?.containerId, '往復で崩れる').toBe(cid);
    // ⚠ `asset-blob-store.ts` の `assertCid` ── `':'` は key 空間を混ぜるので禁止
    expect(cid).not.toContain(':');
  });

  /**
   * 🔴 **他人の `pkc://default/...` を「自分のもの」と読まない**(#260 の実害)。
   * ⚠ 判定そのものは `permalink.ts` に在る ── ここは「採番した id を渡すと
   *   食い違う」ことを、**本物の判定関数**で確かめる。
   */
  it('🔴 他人の PKC3 が書いた `default` の参照と食い違う', async () => {
    const { cid } = await request({ op: 'resolveContainer', title: 'PKC3' });
    const foreign = parsePortablePkcReference('pkc://default/entry/e1');
    expect(foreign, '前提が崩れている(参照が読めていない)').not.toBeNull();
    expect(foreign!.containerId === cid, '他人の参照を自分のものと判定した').toBe(false);
  });
});
