/**
 * 🔴 **保存領域を縮める口(`vacuum`)を、本物の worker で通す**(#999。Gemini 裁定 A)。
 *
 * 見るのは:
 * - **消した後に打つと、空きページが 0 になり file が縮む**(前提: 消した直後は空きが在る ──
 *   空振り防止。在らなければ「縮んだ」が何も言っていない)
 * - 返る形(前後の `storageGauge` と所要。⚠ 期待値は**実物の worker から読む**)
 * - **縮めても中身は変わらない**(残したノートの本文・探した結果)
 * - 🔴 **書込と並走しない**: 直前に投げた書込が終わってから走る
 * - 一覧の仕分け: 壊れの門・空きの門の両方に入っている(断る理由は下で実物に当てる)
 * - 🔴 **自動では打たない**: 自動の係(`optimizeIndexes` / `auto-optimize`)は VACUUM を含まない(原文 pin)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';
import { CORRUPT_BLOCKED_OPS } from '../../src/features/storage/db-corruption';
import { QUOTA_BLOCKED_OPS } from '../../src/features/storage/write-quota';
import { codeOnly } from '../helpers/code-only';

type Op = StorageRequest['op'];
const pending = new Map<number, (resp: StorageResponse) => void>();
let seq = 0;
const workerSelf: {
  onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
} = { onmessage: null };

function request<O extends Op>(req: Extract<StorageRequest, { op: O }>): Promise<ResultMap[O]> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (resp) =>
      resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error)),
    );
    workerSelf.onmessage!({ data: { id, req } });
  });
}

async function put(lid: string, body: string): Promise<void> {
  await request({
    op: 'upsertEntry',
    cid: 'c1',
    entry: {
      lid,
      title: `題名 ${lid}`,
      archetype: 'text',
      body,
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
    },
  });
}

/** 決定的な本文(乱数を使わない)。 */
const bodyOf = (i: number, kb: number): string =>
  `# 本文 ${i}\n` + `語${i}-とりあえず試す文章を繰り返す。`.repeat(Math.ceil((kb * 1024) / 30));

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (msg: StorageResponse) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  await request({ op: 'init', dbName: 'unit-vacuum' });
  await request({ op: 'openContainer', cid: 'c1', title: 'unit' });
}, 30_000);

afterAll(async () => {
  await request({ op: 'close' });
});

/** 大きめの本文を 30 件書いて消す(空きページを作る)。残す 1 件は呼び側が置く。 */
async function growAndEmpty(): Promise<void> {
  for (let i = 0; i < 30; i++) await put(`g${i}`, bodyOf(i, 20));
  for (let i = 0; i < 30; i++) await request({ op: 'deleteEntry', cid: 'c1', lid: `g${i}` });
  await request({ op: 'purgeTrash', cid: 'c1' });
}

describe('vacuum(#999)', () => {
  it('🔴 消した後に打つと、空きページが 0 になり file が縮む', async () => {
    await put('keeper', bodyOf(99, 5));
    await growAndEmpty();
    const emptied = await request({ op: 'storageGauge' });
    // ⚠ 空振り防止 ── 空きが在る状態から始めていること(でないと「縮んだ」は何も言わない)
    expect(emptied.freelistCount, '前提: 消したのに空きページが無い').toBeGreaterThan(0);

    const r = await request({ op: 'vacuum' });
    expect(r.before.freelistCount, 'before が消した直後の姿でない').toBe(emptied.freelistCount);
    expect(r.after.freelistCount, '空きが 0 になっていない').toBe(0);
    expect(r.after.fileBytes, 'file が縮んでいない').toBeLessThan(r.before.fileBytes);
    // 🔑 返した after は、いま測り直した値と同じ(嘘の after を返していない)
    const now = await request({ op: 'storageGauge' });
    expect(r.after.pageCount).toBe(now.pageCount);
    expect(r.after.freelistCount).toBe(now.freelistCount);
    // 返る形: 前後とも `storageGauge` と同じ形で、所要は数字
    for (const g of [r.before, r.after]) {
      expect(g.fileBytes).toBe(g.pageCount * g.pageSize);
      expect(g.freeBytes).toBe(g.freelistCount * g.pageSize);
    }
    expect(Number.isFinite(r.elapsedMs)).toBe(true);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('🔴 縮めても中身は変わらない(残したノートの本文・探した結果)', async () => {
    const q = { op: 'searchEntries', cid: 'c1', query: '語99' } as const;
    const before = await request(q);
    expect(before.lids.length, '前提: 当たりが 1 件も無い').toBeGreaterThan(0);
    await growAndEmpty();
    await request({ op: 'vacuum' });
    expect(await request({ op: 'getBody', cid: 'c1', lid: 'keeper' })).toBe(bodyOf(99, 5));
    const after = await request(q);
    expect([...after.lids].sort()).toEqual([...before.lids].sort());
  }, 30_000);

  it('🔴 書込と並走しない: 直前に投げた upsertEntry が終わってから走る', async () => {
    await growAndEmpty();
    // ⚠ await しない ── 同じ瞬間に 2 つ投げ、順番だけで決まる形にする
    const writing = put('late', bodyOf(200, 40));
    const vacuuming = request({ op: 'vacuum' });
    await writing;
    const r = await vacuuming;
    // 書込が先に終わっていれば、縮めた後でも本文は読める(並走して書込が消えていない)
    expect(await request({ op: 'getBody', cid: 'c1', lid: 'late' })).toBe(bodyOf(200, 40));
    expect(r.before.pageCount, '前提: 縮める前の file を測れていない').toBeGreaterThan(0);
  }, 30_000);

  it('🔴 壊れの門にも空きの門にも入っている(押せない理由は features が先に言う)', () => {
    expect(CORRUPT_BLOCKED_OPS).toContain('vacuum');
    expect(QUOTA_BLOCKED_OPS).toContain('vacuum');
  });
});

/**
 * 🔴 **自動では打たない**(#999 / #1218)。⚠ 見るのは**実行する行**(注釈を剥いでから)── 注釈には
 * 「VACUUM は打たない」と書いてあるので、そのまま見ると必ず満たされる(CLAUDE.md §1 の 5 度目)。
 */
describe('縮める(VACUUM)は自動では打たない(原文 pin)', () => {
  const code = (path: string): string => codeOnly(readFileSync(path, 'utf-8'));

  it('🔴 自動の係(adapter / features の auto-optimize)に VACUUM が無い', () => {
    for (const p of [
      'src/adapter/platform/storage/auto-optimize.ts',
      'src/features/storage/auto-optimize.ts',
    ]) {
      const c = code(p);
      // 空振り防止 ── 剥いだ後も本体は残っている
      expect(c.length, `${p} を読めていない`).toBeGreaterThan(500);
      expect(/vacuum/i.test(c), `${p} が VACUUM に触れている`).toBe(false);
    }
  });

  it('🔴 worker の optimizeIndexes の handler に VACUUM が無い(vacuum の handler は別に在る)', () => {
    const c = code('src/adapter/platform/storage/storage-worker.ts');
    const m = /optimizeIndexes:\s*\(\)\s*=>\s*\{([\s\S]*?)\n {2}\},/.exec(c);
    expect(m, 'optimizeIndexes の handler が見つからない(空振り防止)').not.toBeNull();
    expect(/vacuum/i.test(m?.[1] ?? ''), 'optimizeIndexes が VACUUM を打っている').toBe(false);
    // 対照群 ── 縮める口そのものは在る(上の走査が読めている証拠)
    const v = /\n {2}vacuum:\s*\(\)\s*=>\s*\{([\s\S]*?)\n {2}\},/.exec(c);
    expect(v, 'vacuum の handler が見つからない').not.toBeNull();
    expect(v?.[1]).toContain("exec('VACUUM')");
  });

  it('🔴 自動の係を組む所(main.ts)は vacuum を呼ばない / 縮める係を呼ぶのは押し口だけ', () => {
    const main = code('src/main.ts');
    const m = /new AutoOptimizer\(\{([\s\S]*?)\}\);/.exec(main);
    expect(m, '係を組む所が見つからない(空振り防止)').not.toBeNull();
    expect(/vacuum/i.test(m?.[1] ?? '')).toBe(false);
    // `appStorageVacuum.run()` を呼ぶのは binder の `storage-vacuum` の 1 か所だけ
    const hits: string[] = [];
    for (const p of [
      'src/main.ts',
      'src/adapter/ui/actions/binder.ts',
      'src/adapter/ui/render/settings.ts',
    ]) {
      const n = (code(p).match(/appStorageVacuum\.run\(\)/g) ?? []).length;
      if (n > 0) hits.push(`${p}:${n}`);
    }
    expect(hits).toEqual(['src/adapter/ui/actions/binder.ts:1']);
  });
});
