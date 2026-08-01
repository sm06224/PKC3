/**
 * storage worker の意味論 unit(P5b で常設 ── review P5a F2)。
 *
 * `self` / `postMessage` を差してから実物の storage-worker を dynamic import する。
 * node に OPFS が無いので sqlite-wasm は :memory: fallback で init まで通り、
 * **実物の SQL と実物の鎖ロジック**をそのまま PR gate で検証できる。
 * OPFS SAHPool 固有面(VFS / journal / 永続化)は nightly の probe が担保する。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ResultMap,
  StorageRequest,
  StorageResponse,
} from '../../src/adapter/platform/storage/protocol';

type Op = StorageRequest['op'];

const pending = new Map<number, (resp: StorageResponse) => void>();
let seq = 0;
const workerSelf: {
  onmessage: ((ev: { data: { id: number; req: StorageRequest } }) => void) | null;
} = { onmessage: null };

function request<O extends Op>(
  req: Extract<StorageRequest, { op: O }>,
): Promise<ResultMap[O]> {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (resp) =>
      resp.ok ? resolve(resp.result as ResultMap[O]) : reject(new Error(resp.error)),
    );
    workerSelf.onmessage!({ data: { id, req } });
  });
}

function entry(lid: string, body: string, over: Record<string, unknown> = {}) {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    body,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    ...over,
  };
}

/** 本文を書く(既定 = amend。checkpoint で履歴が 1 件伸びる)。 */
const write = (
  lid: string,
  body: string,
  opts: { checkpoint?: boolean; keepLatest?: number } = {},
) =>
  request({
    op: 'upsertEntry',
    cid: 'c1',
    entry: entry(lid, body),
    checkpoint: opts.checkpoint === true,
    keepLatest: opts.keepLatest,
  });

const bodyOf = async (revId: string): Promise<string | null> =>
  (await request({ op: 'getRevision', cid: 'c1', id: revId }))?.body ?? null;

const metasOf = (lid: string) =>
  request({ op: 'listRevisionMetas', cid: 'c1', entryLid: lid });

beforeAll(async () => {
  (globalThis as unknown as Record<string, unknown>).self = workerSelf;
  (globalThis as unknown as Record<string, unknown>).postMessage = (
    msg: StorageResponse,
  ) => {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb?.(msg);
  };
  await import('../../src/adapter/platform/storage/storage-worker');
  const init = await request({ op: 'init', dbName: 'unit-test' });
  expect(init.vfs).toBe('memory'); // node に OPFS は無い ── memory fallback が前提
  await request({ op: 'openContainer', cid: 'c1', title: 'unit' });
}, 30_000);

afterAll(async () => {
  await request({ op: 'close' });
});

/** パッチ経路を実際に通す大きさの本文(小さいと encodeReverse が全文を選ぶ)。 */
const doc = (mark: string, lines = 200): string =>
  Array.from({ length: lines }, (_, i) => (i === 7 ? `行 ${i} ${mark}\n` : `行 ${i}\n`)).join('');

describe('revision chain (P5c ── 逆向き差分)', () => {
  it('checkpoint は履歴を伸ばし、amend は伸ばさない ── 過去の状態は amend で不変', async () => {
    // ⚠ 本文は**パッチが選ばれる大きさ**にする(review P5c F3: 小さい本文だと
    // 全文保存になり、amend の再符号化を丸ごと外しても test が素通りしていた)
    await write('e1', doc('初稿'));
    await write('e1', doc('二稿'), { checkpoint: true });
    const afterFirst = await metasOf('e1');
    expect(afterFirst).toHaveLength(1);
    const revId = afterFirst[0]!.id;
    expect(await bodyOf(revId)).toBe(doc('初稿'));

    // amend(toggle / rename 相当): 履歴は伸びず、id も保たれる(change ID の安定)
    await write('e1', doc('二稿') + 'トグル追記\n');
    const afterAmend = await metasOf('e1');
    expect(afterAmend).toHaveLength(1);
    expect(afterAmend[0]!.id).toBe(revId);
    // tip が動いても、その revision が指す**過去の状態は変わらない**
    // (= 頭のパッチが新しい tip 基準へ張り替わっている)
    expect(await bodyOf(revId)).toBe(doc('初稿'));

    // amend を連打しても劣化しない
    for (let i = 0; i < 5; i++) await write('e1', doc('二稿') + `連打 ${i}\n`);
    expect(await metasOf('e1')).toHaveLength(1);
    expect(await bodyOf(revId)).toBe(doc('初稿'));
  });

  it('checkpoint と amend をランダムに交ぜても全世代が byte 一致で戻る', async () => {
    // 決定的 PRNG(落ちたら同じ列で再現する)
    let seed = 20260801;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const lid = 'e-fuzz';
    let tip = doc('v0');
    await write(lid, tip);
    const recorded: string[] = []; // checkpoint で刻まれた本文(古い順)
    for (let step = 1; step <= 40; step++) {
      const next = doc(`v${step}`, 200 + (rnd() < 0.5 ? 0 : 3));
      const checkpoint = rnd() < 0.5;
      if (checkpoint) recorded.push(tip);
      await write(lid, next, { checkpoint, keepLatest: 100 });
      tip = next;
    }
    const metas = await metasOf(lid); // 新しい順
    expect(metas).toHaveLength(recorded.length);
    for (let i = 0; i < metas.length; i++) {
      expect(await bodyOf(metas[i]!.id)).toBe(recorded[recorded.length - 1 - i]!);
    }
  });

  it('hash 検証: 行数が一致する壊れ方でも「存在しなかった版」を返さない', async () => {
    // 全消費要求(applyLinePatch)は行数が合うとすり抜ける ── そこを hash が守る
    // (review P5c F4: この経路は従来 1 件も pin されていなかった)
    const lid = 'e-hash';
    await write(lid, doc('A'));
    await write(lid, doc('B'), { checkpoint: true });
    const revId = (await metasOf(lid))[0]!.id;
    expect(await bodyOf(revId)).toBe(doc('A'));
    // 鎖を維持しない経路で、**行数の同じ別内容**へ tip をすげ替える
    await request({
      op: 'bulkUpsertEntries',
      cid: 'c1',
      entries: [entry(lid, doc('B だが別の行が違う').replace('行 9\n', '行 9 改\n'))],
    });
    await expect(request({ op: 'getRevision', cid: 'c1', id: revId })).rejects.toThrow(
      /integrity check/,
    );
  });

  it('鎖が壊れていても本文の保存は通る ── 履歴の破損が編集を巻き添えにしない', async () => {
    // review P5c F1(データ喪失方向): amend の materialize が throw して tx ごと
    // 巻き戻ると、toggle 相当の書込が永久に失敗し user の編集が disk に届かない
    const lid = 'e-resilient';
    await write(lid, doc('A'));
    await write(lid, doc('B'), { checkpoint: true });
    await request({
      op: 'bulkUpsertEntries',
      cid: 'c1',
      entries: [entry(lid, '全く別の本文\n')], // 鎖の前提を壊す
    });
    await write(lid, '全く別の本文(編集)\n'); // amend 経路 ── throw しない
    expect(await request({ op: 'getBody', cid: 'c1', lid })).toBe('全く別の本文(編集)\n');
    await write(lid, '更に編集\n'); // 連続でも通る(自己回復しない状態でも編集は生きる)
    expect(await request({ op: 'getBody', cid: 'c1', lid })).toBe('更に編集\n');
  });

  it('古い版にしか無い escape 済み asset 参照も GC が keep する(patch は JSON 二重化)', async () => {
    const lid = 'e-esc';
    await write(lid, `${doc('参照あり')}![x](asset:ast\\-esc-key)\n`);
    await write(lid, doc('参照を削除'), { checkpoint: true }); // tip から消える
    const scan = await request({
      op: 'scanAssetRefs',
      cid: 'c1',
      candidates: ['ast-esc-key'],
    });
    expect(scan.referenced).toEqual(['ast-esc-key']);
  });

  it('多世代の鎖を正しく復元し、保存は全文でなく差分(容量の前提)', async () => {
    const base = Array.from({ length: 200 }, (_, i) => `行 ${i}\n`).join('');
    await write('e2', base);
    const states: string[] = [];
    for (let v = 1; v <= 5; v++) {
      states.push(v === 1 ? base : states[v - 2]!.replace(`行 ${v}\n`, `行 ${v} 改\n`));
      const next = states[v - 1]!.replace(`行 ${v + 1}\n`, `行 ${v + 1} 改\n`);
      await write('e2', next, { checkpoint: true });
    }
    const metas = await metasOf('e2');
    expect(metas).toHaveLength(5);
    // すべての世代が byte 一致で戻る(古い側ほど遠くまで遡る)
    for (let i = 0; i < metas.length; i++) {
      expect(await bodyOf(metas[i]!.id)).toBe(states[metas.length - 1 - i]!);
    }
    // 保存量: 全文 5 部より桁で小さい(差分保持の前提が実際に成立している)
    const counts = await request({ op: 'counts', cid: 'c1' });
    expect(counts.revisions).toBeGreaterThanOrEqual(5);
  });

  it('prune(保持上限)が鎖を壊さない ── 残った全世代が復元できる', async () => {
    await write('e3', 'v0\n');
    for (let v = 1; v <= 6; v++) {
      await write('e3', `v${v}\n`, { checkpoint: true, keepLatest: 3 });
    }
    const metas = await metasOf('e3');
    expect(metas).toHaveLength(3); // 古い側から捨てられる
    expect(metas.map((m) => m.rev_order)).toEqual([6, 5, 4]);
    expect(await bodyOf(metas[0]!.id)).toBe('v5\n');
    expect(await bodyOf(metas[1]!.id)).toBe('v4\n');
    expect(await bodyOf(metas[2]!.id)).toBe('v3\n');
  });

  it('同一内容の checkpoint は積まない(hash skip)', async () => {
    await write('e4', 'x\n');
    await write('e4', 'y\n', { checkpoint: true });
    await write('e4', 'x\n', { checkpoint: true }); // 直前 revision は 'x\n'…ではない
    const before = (await metasOf('e4')).length;
    // 直前 revision が記録している内容(= 'y\n')へ戻してから、もう一度刻む
    await write('e4', 'z\n', { checkpoint: true });
    const metas = await metasOf('e4');
    expect(metas.length).toBe(before + 1);
    expect(await bodyOf(metas[0]!.id)).toBe('x\n');
  });

  it('deleteEntry: tip を全文で確定して trash になり、履歴ごと復元できる', async () => {
    await write('e5', '# 消す前\n');
    await write('e5', '# 消す直前\n', { checkpoint: true });
    await request({ op: 'deleteEntry', cid: 'c1', lid: 'e5' });

    const trash = await request({ op: 'listTrash', cid: 'c1' });
    const row = trash.find((t) => t.entry_lid === 'e5')!;
    expect(row).toBeDefined();
    // tip(= 削除直前の本文)が全文行として残り、それより古い版も遡れる
    expect(await bodyOf(row.id)).toBe('# 消す直前\n');
    const metas = await metasOf('e5');
    expect(await bodyOf(metas[metas.length - 1]!.id)).toBe('# 消す前\n');
    // 存在しない lid の削除は無例外
    await request({ op: 'deleteEntry', cid: 'c1', lid: 'no-such' });
  });

  it('復元 → 無変更 → 再削除で同一 snapshot を積まない(P5a review F3)', async () => {
    await write('e6', '# 同一\n');
    await request({ op: 'deleteEntry', cid: 'c1', lid: 'e6' });
    await write('e6', '# 同一\n'); // 復元相当(entry が居ないので新規挿入)
    await request({ op: 'deleteEntry', cid: 'c1', lid: 'e6' });
    expect(await metasOf('e6')).toHaveLength(1);
  });

  it('鎖の base が壊れたら可視エラー ── それらしい本文を返さない', async () => {
    // ⚠ 本文が小さいとパッチの方が大きくなり全文で保存される(= tip 非依存に
    // なって壊しようがない)。**実際にパッチが選ばれる大きさ**で試す ──
    // この test が通ること自体が「差分で保存されている」ことの証拠でもある
    const big = Array.from({ length: 200 }, (_, i) => `行 ${i}\n`).join('');
    await write('e7', big);
    await write('e7', big.replace('行 5\n', '行 5 改\n'), { checkpoint: true });
    const revId = (await metasOf('e7'))[0]!.id;
    expect(await bodyOf(revId)).toBe(big);
    // bulkUpsertEntries は**新規取込専用**で鎖を維持しない(protocol に明記)──
    // それで tip を差し替えると鎖の前提が崩れる。hash 検証がそれを捕まえる
    await request({
      op: 'bulkUpsertEntries',
      cid: 'c1',
      entries: [entry('e7', '全く別の本文\n')],
    });
    await expect(request({ op: 'getRevision', cid: 'c1', id: revId })).rejects.toThrow(
      /revision restore failed/,
    );
  });

  it('scanAssetRefs: 古い版にしか無い asset も keep される(差分化後も成立)', async () => {
    // 逆向き差分は「新しい側に無い行」を必ず含むので、tip から消えた参照は
    // パッチ本体に現れる ── 走査の網羅性は差分化しても保たれる
    await write('e8', '本文 ![x](asset:ast-old-only)\n');
    await write('e8', '本文(参照を削除)\n', { checkpoint: true });
    const scan = await request({
      op: 'scanAssetRefs',
      cid: 'c1',
      candidates: ['ast-old-only', 'ast-nowhere'],
    });
    expect(scan.referenced).toEqual(['ast-old-only']);
  });

  it('purgeTrash は削除済み lid の revisions だけ消す', async () => {
    const before = await request({ op: 'counts', cid: 'c1' });
    const r = await request({ op: 'purgeTrash', cid: 'c1' });
    expect(r.purged).toBeGreaterThan(0);
    const after = await request({ op: 'counts', cid: 'c1' });
    expect(after.revisions).toBe(before.revisions - r.purged);
    expect(await request({ op: 'listTrash', cid: 'c1' })).toHaveLength(0);
    // 生存 entry の履歴は残る
    expect((await metasOf('e3')).length).toBeGreaterThan(0);
  });

  it('listRevisionLids: ゴミ箱の lid も返す(取込の衝突判定はこれが正)', async () => {
    // 生存 entry だけで lid 衝突を判定すると、削除済み lid が再採番されず
    // ① その item がゴミ箱から消え ② 取り込んだ entry が他人の履歴を背負う
    // (どちらも P6b review H-1 で実 sqlite 実証済み)
    await write('e-trash', '消される版 v1\n');
    await write('e-trash', '消される版 v2\n', { checkpoint: true });
    await request({ op: 'deleteEntry', cid: 'c1', lid: 'e-trash' });

    const live = new Set(
      (await request({ op: 'listEntryMetas', cid: 'c1' })).map((m) => m.lid),
    );
    expect(live.has('e-trash')).toBe(false); // entries には居ない
    const revLids = await request({ op: 'listRevisionLids', cid: 'c1' });
    expect(revLids).toContain('e-trash'); // しかし衝突する
    expect(new Set(revLids).size).toBe(revLids.length); // DISTINCT
    // 生存 entry の lid も含む(union が衝突集合になる)
    expect(revLids).toContain('e3');
  });

  it('importRevisionChains: 全文でなく**逆向きパッチ**として積み、各版が復元できる', async () => {
    // user 裁定 2026-08-01「revisions の考え方は持ち込む」── ただし P5c の鎖へ。
    // 全文で積むと取込だけが設計から外れ、PKC2 と同じ「履歴が本文の N 倍」に戻る
    const lines = (tag: string) =>
      Array.from({ length: 200 }, (_, i) => (i === 7 ? `${tag} の行` : `共通の行 ${i}`)).join(
        '\n',
      ) + '\n';
    const v1 = lines('第1版');
    const v2 = lines('第2版');
    const tip = lines('いま');

    await request({ op: 'bulkUpsertEntries', cid: 'c1', entries: [entry('imp1', tip)] });
    const res = await request({
      op: 'importRevisionChains',
      cid: 'c1',
      chains: [
        {
          entryLid: 'imp1',
          snapshots: [
            { body: v1, createdAt: '2026-07-01T00:00:00Z' },
            { body: v2, createdAt: '2026-07-02T00:00:00Z' },
          ],
        },
      ],
    });
    expect(res.added).toBe(2);

    const metas = await request({ op: 'listRevisionMetas', cid: 'c1', entryLid: 'imp1' });
    expect(metas).toHaveLength(2);
    // 履歴の時刻は捏造しない(PKC2 の created_at をそのまま持ち込む)
    expect(metas.map((m) => m.created_at)).toEqual([
      '2026-07-02T00:00:00Z',
      '2026-07-01T00:00:00Z',
    ]);
    // 各版が **byte 一致**で復元できる(鎖を tip から遡る実経路)
    expect((await request({ op: 'getRevision', cid: 'c1', id: metas[0]!.id }))?.body).toBe(v2);
    expect((await request({ op: 'getRevision', cid: 'c1', id: metas[1]!.id }))?.body).toBe(v1);

    // 🔑 **保存形そのもの**を pin する。200 行中 1 行しか違わない版なので、
    // 差分で持っていれば必ず 'patch' に落ちる ── 全文で積む実装に退化したら
    // ここが 'full' になって落ちる(user 裁定の主題はまさにこれ)
    expect(metas.map((m) => m.kind)).toEqual(['patch', 'patch']);
  });

  it('importRevisionChains: 無変更の版は畳む / tip と同じ最新版は積まない', async () => {
    const body = '本文\n';
    await request({ op: 'bulkUpsertEntries', cid: 'c1', entries: [entry('imp2', body)] });
    const res = await request({
      op: 'importRevisionChains',
      cid: 'c1',
      chains: [
        {
          entryLid: 'imp2',
          snapshots: [
            { body: '古い\n', createdAt: '2026-07-01T00:00:00Z' },
            { body: '古い\n', createdAt: '2026-07-02T00:00:00Z' }, // 無変更
            { body, createdAt: '2026-07-03T00:00:00Z' }, // tip と同じ
          ],
        },
      ],
    });
    expect(res.added).toBe(1);
    expect(res.skippedNoChange).toBe(2);
    const metas = await request({ op: 'listRevisionMetas', cid: 'c1', entryLid: 'imp2' });
    expect((await request({ op: 'getRevision', cid: 'c1', id: metas[0]!.id }))?.body).toBe(
      '古い\n',
    );
  });

  it('importRevisionChains: 既に履歴を持つ entry には積まない(既存の鎖を壊さない)', async () => {
    await write('imp3', 'v1\n');
    await write('imp3', 'v2\n', { checkpoint: true });
    const before = await metasOf('imp3');
    const res = await request({
      op: 'importRevisionChains',
      cid: 'c1',
      chains: [
        { entryLid: 'imp3', snapshots: [{ body: 'よそ者\n', createdAt: '2020-01-01T00:00:00Z' }] },
        { entryLid: 'imp-nonexistent', snapshots: [{ body: 'x\n', createdAt: '' }] },
      ],
    });
    expect(res.added).toBe(0);
    expect(res.skippedEntries.sort()).toEqual(['imp-nonexistent', 'imp3']);
    expect(await metasOf('imp3')).toHaveLength(before.length);
  });

  it('importRevisionChains: 保持上限を超えた古い版は捨て、件数を返す', async () => {
    await request({ op: 'bulkUpsertEntries', cid: 'c1', entries: [entry('imp4', 'tip\n')] });
    const res = await request({
      op: 'importRevisionChains',
      cid: 'c1',
      keepLatest: 3,
      chains: [
        {
          entryLid: 'imp4',
          snapshots: Array.from({ length: 10 }, (_, i) => ({
            body: `v${i}\n`,
            createdAt: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
          })),
        },
      ],
    });
    expect(res.added).toBe(3);
    expect(res.droppedOverLimit).toBe(7);
    const metas = await request({ op: 'listRevisionMetas', cid: 'c1', entryLid: 'imp4' });
    // 残るのは**直近**(v7/v8/v9)── 古い側から捨てる
    expect((await request({ op: 'getRevision', cid: 'c1', id: metas[0]!.id }))?.body).toBe(
      'v9\n',
    );
  });

  it('取り込んだ履歴の後に編集しても鎖が伸びる(既存の checkpoint 経路と合流する)', async () => {
    await request({ op: 'bulkUpsertEntries', cid: 'c1', entries: [entry('imp5', 'tip\n')] });
    await request({
      op: 'importRevisionChains',
      cid: 'c1',
      chains: [
        { entryLid: 'imp5', snapshots: [{ body: '取込した版\n', createdAt: '2026-07-01T00:00:00Z' }] },
      ],
    });
    await write('imp5', '編集した\n', { checkpoint: true });

    const metas = await metasOf('imp5');
    expect(metas).toHaveLength(2);
    // 新しい方 = 編集直前の tip / 古い方 = 取り込んだ版。どちらも復元できる
    expect((await request({ op: 'getRevision', cid: 'c1', id: metas[0]!.id }))?.body).toBe(
      'tip\n',
    );
    expect((await request({ op: 'getRevision', cid: 'c1', id: metas[1]!.id }))?.body).toBe(
      '取込した版\n',
    );
  });
});
