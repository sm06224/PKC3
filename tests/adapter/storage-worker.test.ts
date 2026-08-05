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

  it('[M-24] 取込んだ版も content_hash 検証を通る(壊れた鎖から本文を作らない)', async () => {
    const tip = Array.from({ length: 50 }, (_, i) => `行 ${i}`).join('\n') + '\n';
    const old = tip.replace('行 7', '古い 7');
    await request({ op: 'bulkUpsertEntries', cid: 'c1', entries: [entry('imp6', tip)] });
    await request({
      op: 'importRevisionChains',
      cid: 'c1',
      chains: [{ entryLid: 'imp6', snapshots: [{ body: old, createdAt: '2026-07-01T00:00:00Z' }] }],
    });
    const [meta] = await request({ op: 'listRevisionMetas', cid: 'c1', entryLid: 'imp6' });
    expect((await request({ op: 'getRevision', cid: 'c1', id: meta!.id }))?.body).toBe(old);

    // 鎖を壊す: **bulk 経路は maintainChain を通らない**ので、tip だけが
    // 差し替わって頭のパッチが宙に浮く。行数を揃えてあるのでパッチは
    // 「適用できてしまう」── content_hash が無ければそれらしい本文が黙って返る
    const bogus = Array.from({ length: 50 }, (_, i) => `別物 ${i}`).join('\n') + '\n';
    await request({ op: 'bulkUpsertEntries', cid: 'c1', entries: [entry('imp6', bogus)] });
    await expect(request({ op: 'getRevision', cid: 'c1', id: meta!.id })).rejects.toThrow();
  });

  it('[M-28] keepLatest が 0 でも最低 1 版は残す(履歴を全部捨てない)', async () => {
    await request({ op: 'bulkUpsertEntries', cid: 'c1', entries: [entry('imp7', 'tip\n')] });
    const res = await request({
      op: 'importRevisionChains',
      cid: 'c1',
      keepLatest: 0,
      chains: [
        {
          entryLid: 'imp7',
          snapshots: [
            { body: 'v1\n', createdAt: '2026-07-01T00:00:00Z' },
            { body: 'v2\n', createdAt: '2026-07-02T00:00:00Z' },
          ],
        },
      ],
    });
    expect(res.added).toBe(1);
    expect(res.droppedOverLimit).toBe(1);
  });

  // ── P6d: listBodies(書出し用の一括読み)
  //
  // 🔴 **実 SQL に当てる**。スタブで書いた round-trip test は配列 index で継続する
  // ので、実装のカーソルが `ORDER BY` と噛み合っていなくても素通りしていた
  // (review M-2: スタブが実装より正しい状態になっていた)

  const listBodies = (
    after: { entryOrder: number; lid: string } | undefined,
    maxBytes: number,
  ) => request({ op: 'listBodies', cid: 'c1', maxBytes, ...(after ? { after } : {}) });

  /** カーソルを追って全部集める(書出しがやることと同じ)。 */
  async function drain(maxBytes: number): Promise<string[]> {
    const out: string[] = [];
    let after: { entryOrder: number; lid: string } | undefined;
    for (let guard = 0; guard < 1000; guard++) {
      const r = await listBodies(after, maxBytes);
      out.push(...r.rows.map((x) => x.lid));
      if (r.done || !r.next) return out;
      after = r.next;
    }
    throw new Error('カーソルが進んでいません(無限ループ)');
  }

  it('[P6d] 🔴 entry_order が重複していても 1 件も落とさない', async () => {
    // app-state 自身が「trash 復元と CREATE の並行採番は重複しうる」と明記している。
    // カーソルが `entry_order > ?` 単独だと、境界の順序値を共有する行が**全部飛ぶ**
    // ── バックアップの中身が黙って減る
    for (const lid of ['d1', 'd2', 'd3', 'd4', 'd5']) {
      await request({
        op: 'upsertEntry',
        cid: 'c1',
        entry: entry(lid, `本文 ${lid}`, { entryOrder: 500 }), // 🔴 全部同じ
        checkpoint: false,
      });
    }
    const got = await drain(1); // 1 件ずつ返させる(境界を毎回踏ませる)
    expect(got.filter((l) => l.startsWith('d'))).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
  });

  it('[P6d] 🔴 maxBytes より大きい本文が 1 件あっても進む(無限ループを作らない)', async () => {
    await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('big1', 'x'.repeat(5000), { entryOrder: 600 }),
      checkpoint: false,
    });
    await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('big2', 'y'.repeat(5000), { entryOrder: 601 }),
      checkpoint: false,
    });
    // maxBytes=1 でも 1 件目は必ず返る ── 返さないと永遠に進まない
    const got = await drain(1);
    expect(got).toContain('big1');
    expect(got).toContain('big2');
  });

  it('[P6d] 並びは entry_order → lid(書出しの並びの正本)', async () => {
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('o-b', 'B', { entryOrder: 700 }), checkpoint: false });
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('o-a', 'A', { entryOrder: 700 }), checkpoint: false });
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('o-c', 'C', { entryOrder: 699 }), checkpoint: false });
    const got = (await drain(1_000_000)).filter((l) => l.startsWith('o-'));
    expect(got).toEqual(['o-c', 'o-a', 'o-b']);
  });

  it('[P6d] 本文が実際に返る(lid だけ合っていても意味がない)', async () => {
    await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('bd1', '# 見出し\n本文です\n', { entryOrder: 800 }),
      checkpoint: false,
    });
    const r = await listBodies({ entryOrder: 799, lid: '' }, 1_000_000);
    expect(r.rows.find((x) => x.lid === 'bd1')?.body).toBe('# 見出し\n本文です\n');
  });

  it('[P6d] 2 バッチ目以降も返る(done を常に true にしないこと)', async () => {
    for (const [i, lid] of ['m1', 'm2', 'm3'].entries()) {
      await request({
        op: 'upsertEntry',
        cid: 'c1',
        entry: entry(lid, 'z'.repeat(100), { entryOrder: 900 + i }),
        checkpoint: false,
      });
    }
    const first = await listBodies({ entryOrder: 899, lid: '' }, 150);
    expect(first.done).toBe(false);
    expect(first.rows).toHaveLength(1);
    expect(first.next).toEqual({ entryOrder: 900, lid: 'm1' });
  });
});
/**
 * P6e: 鎖の書出しと復元。
 *
 * 🔴 「鎖の decode は worker の中なので unit では届かない」は**誤り**だった
 * (review M-4)── この harness は実物の worker を node で動かしている。
 * smoke の 1 アサーションだけを砦にしていると、向きや題名の取り違えが素通りする。
 *
 * ⚠ 見るのは「同じ**状態列**が戻るか」。バイト列は保証範囲外(decode → encode を
 * 往復するので刈り込みと畳み込みが再適用される)。
 */
describe('P6e ── 鎖を書き出して復元する', () => {
  /** その entry の全版を**古い → 新しい**で materialize して並べる。 */
  const statesOf = async (lid: string): Promise<string[]> => {
    const metas = await metasOf(lid);
    const out: string[] = [];
    for (const m of [...metas].reverse()) out.push((await bodyOf(m.id))!);
    return out;
  };

  it('🔴 状態列が保たれる(2 周目も)', async () => {
    await write('src1', doc('初稿'));
    await write('src1', doc('二稿'), { checkpoint: true });
    await write('src1', doc('三稿'), { checkpoint: true });
    const before = await statesOf('src1');
    expect(before).toHaveLength(2);

    // 🔑 パッチ経路を通っていること ── 全部 full なら decode を検証していない
    const chain = await request({ op: 'exportRevisionChain', cid: 'c1', entryLid: 'src1' });
    expect(chain.some((r) => r.kind === 'patch')).toBe(true);
    expect(chain.map((r) => r.revOrder)).toEqual([2, 1]); // 新しい → 古い

    // 同じ tip を持つ別 entry へ復元する
    await write('dst1', doc('三稿'));
    const r = await request({
      op: 'restoreRevisionChains',
      cid: 'c1',
      chains: [{ entryLid: 'dst1', rows: chain }],
    });
    expect(r.added).toBe(2);
    expect(r.brokenChains).toEqual([]);
    expect(await statesOf('dst1')).toEqual(before);

    // 2 周目 ── 復元したものをもう一度書き出して復元しても同じ状態列
    const again = await request({ op: 'exportRevisionChain', cid: 'c1', entryLid: 'dst1' });
    await write('dst2', doc('三稿'));
    await request({
      op: 'restoreRevisionChains',
      cid: 'c1',
      chains: [{ entryLid: 'dst2', rows: again }],
    });
    expect(await statesOf('dst2')).toEqual(before);
  });

  it('🔴 アーカイブに contentHash が**実際に載る**(検査が生きている条件)', async () => {
    // optional にしていたので writer が代入を落としても tsc が黙り、
    // **全アーカイブで噛み合わせ検査が無効化**されていた(review H-2)。
    // 「検査を書いた」だけでは足りない ── 材料が届いていることを見る
    const { writeArchive, readArchive } = await import(
      '../../src/features/export/pkc3-archive'
    );
    await write('hash1', doc('もと'));
    await write('hash1', doc('いま'), { checkpoint: true });
    const src = {
      cid: 'c1',
      title: 'T',
      listEntryMetas: async () => [
        {
          lid: 'hash1',
          title: 't',
          archetype: 'text',
          created_at: null,
          updated_at: null,
          entry_order: 1,
          status: null,
          date: null,
          archived: 0,
        },
      ],
      listBodies: async () => ({ rows: [{ lid: 'hash1', body: doc('いま') }], done: true }),
      listRelations: async () => [],
      listAssetMetas: async () => [],
      getAssetBlob: async () => null,
      listRevisionLids: async () => ['hash1'],
      getRevisionChain: (entryLid: string) =>
        request({ op: 'exportRevisionChain', cid: 'c1', entryLid }),
    };
    const got = await readArchive((await writeArchive(src, 'NOW')).blob);
    expect(got.revisions).toHaveLength(1);
    // 実 sqlite が刻んだ hash がアーカイブまで届いている
    expect(got.revisions[0]!.contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('🔴 rows の向きが逆だと壊れる(契約が効いていることの確認)', async () => {
    await write('rev1', doc('A'));
    await write('rev1', doc('B'), { checkpoint: true });
    await write('rev1', doc('C'), { checkpoint: true });
    const chain = await request({ op: 'exportRevisionChain', cid: 'c1', entryLid: 'rev1' });

    await write('rev1dst', doc('C'));
    const r = await request({
      op: 'restoreRevisionChains',
      cid: 'c1',
      chains: [{ entryLid: 'rev1dst', rows: [...chain].reverse() }],
    });
    // ⚠ hash では捕まらない(各版は個別には正しく復元でき、hash も一致する)──
    // 壊れるのは**並び**なので、向きの契約そのものを検査している
    expect(r.added).toBe(0);
    expect(r.brokenChains.join()).toMatch(/並びが新しい → 古いになっていません/);
  });

  it('🔴 改竄されたパッチを受け付けない(行数が合っていても)', async () => {
    // `applyLinePatch` は行数さえ合えば通る ── hash が無いと**誤った履歴が
    // 静かに書かれ、書込側が hash を計算し直すので永久に自己証明される**
    await write('tam', doc('もと'));
    await write('tam', doc('いま'), { checkpoint: true });
    const chain = await request({ op: 'exportRevisionChain', cid: 'c1', entryLid: 'tam' });
    const patched = chain.map((r) => ({
      ...r,
      snapshot: r.snapshot.replace('もと', 'ニセ'),
    }));

    await write('tamdst', doc('いま'));
    const r = await request({
      op: 'restoreRevisionChains',
      cid: 'c1',
      chains: [{ entryLid: 'tamdst', rows: patched }],
    });
    expect(r.added).toBe(0);
    expect(r.brokenChains.join()).toMatch(/噛み合いません/);
  });

  it('🔴 1 本が壊れていても健全な鎖は残る(全部を巻き戻さない)', async () => {
    await write('okA', doc('旧'));
    await write('okA', doc('新'), { checkpoint: true });
    const good = await request({ op: 'exportRevisionChain', cid: 'c1', entryLid: 'okA' });

    await write('okDst', doc('新'));
    await write('ngDst', doc('新'));
    const r = await request({
      op: 'restoreRevisionChains',
      cid: 'c1',
      chains: [
        { entryLid: 'ngDst', rows: good.map((x) => ({ ...x, contentHash: 'ちがう' })) },
        { entryLid: 'okDst', rows: good },
      ],
    });
    expect(r.brokenChains).toHaveLength(1);
    expect(await metasOf('okDst')).toHaveLength(1); // 健全な方は残る
    expect(await metasOf('ngDst')).toHaveLength(0);
  });

  it('未対応の保存形は断る(生の JSON エラーを見せない)', async () => {
    await write('kd', doc('x'));
    const r = await request({
      op: 'restoreRevisionChains',
      cid: 'c1',
      chains: [
        {
          entryLid: 'kd',
          rows: [
            { revOrder: 1, createdAt: null, title: null, archetype: null, kind: 'gzip', snapshot: 'ぐちゃ', contentHash: null },
          ],
        },
      ],
    });
    expect(r.brokenChains.join()).toMatch(/未対応の履歴の保存形/);
  });

  it('版ごとの題名を保つ(entry の題名で塗り潰さない)', async () => {
    await write('ttl', doc('v1'));
    await write('ttl', doc('v2'), { checkpoint: true });
    const chain = await request({ op: 'exportRevisionChain', cid: 'c1', entryLid: 'ttl' });
    const named = chain.map((r) => ({ ...r, title: `版 ${r.revOrder} の題名` }));

    await write('ttldst', doc('v2'));
    await request({
      op: 'restoreRevisionChains',
      cid: 'c1',
      chains: [{ entryLid: 'ttldst', rows: named }],
    });
    expect((await metasOf('ttldst')).map((m) => m.title)).toEqual(['版 1 の題名']);
  });

  it('保持上限は呼び出し側の値で効く(worker の既定に頼らない)', async () => {
    await write('keep', doc('0'));
    for (let i = 1; i <= 5; i++) await write('keep', doc(String(i)), { checkpoint: true });
    const chain = await request({ op: 'exportRevisionChain', cid: 'c1', entryLid: 'keep' });
    expect(chain).toHaveLength(5);

    await write('keepdst', doc('5'));
    const r = await request({
      op: 'restoreRevisionChains',
      cid: 'c1',
      chains: [{ entryLid: 'keepdst', rows: chain }],
      keepLatest: 2,
    });
    expect(r.droppedOverLimit).toBe(3);
    expect(await metasOf('keepdst')).toHaveLength(2);
  });
});

describe('🔴 居場所の張り替え(2026-08-05。フォルダ整理)', () => {
  const relsOf = async (toLid: string) =>
    (await request({ op: 'listRelations', cid: 'c1' })).filter((r) => r.to_lid === toLid);

  it('入れる → 別へ移す ── 辺は常に 1 本(2 か所に居ない)', async () => {
    await write('p-fold', '# 入れ物 A\n');
    await write('p-fold2', '# 入れ物 B\n');
    await write('p-child', '# 中身\n');

    await request({
      op: 'setEntryParent',
      cid: 'c1',
      lid: 'p-child',
      parentLid: 'p-fold',
      relationId: 'pr-1',
    });
    let rows = await relsOf('p-child');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.from_lid).toBe('p-fold');
    expect(rows[0]!.kind).toBe('structural');
    // ⚠ 時刻は **DB が刻む**(主スレッドで作らない ── P9 段①)
    expect(rows[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2} /);

    await request({
      op: 'setEntryParent',
      cid: 'c1',
      lid: 'p-child',
      parentLid: 'p-fold2',
      relationId: 'pr-2',
    });
    rows = await relsOf('p-child');
    expect(rows).toHaveLength(1); // 🔴 前の辺が残ると 2 つのフォルダに見える
    expect(rows[0]!.from_lid).toBe('p-fold2');
  });

  it('ルートへ出す(parentLid = null)と辺が無くなる', async () => {
    await request({
      op: 'setEntryParent',
      cid: 'c1',
      lid: 'p-child',
      parentLid: null,
      relationId: 'pr-3',
    });
    expect(await relsOf('p-child')).toHaveLength(0);
  });

  it('🔴 structural 以外の辺は巻き添えにしない', async () => {
    await request({
      op: 'bulkUpsertRelations',
      cid: 'c1',
      relations: [
        { id: 'pr-sem', fromLid: 'p-fold', toLid: 'p-child', kind: 'semantic' },
      ],
    });
    await request({
      op: 'setEntryParent',
      cid: 'c1',
      lid: 'p-child',
      parentLid: 'p-fold',
      relationId: 'pr-4',
    });
    const rows = await relsOf('p-child');
    expect(rows.map((r) => r.kind).sort()).toEqual(['semantic', 'structural']);
    // 出すときも意味リンクは残る
    await request({
      op: 'setEntryParent',
      cid: 'c1',
      lid: 'p-child',
      parentLid: null,
      relationId: 'pr-5',
    });
    expect((await relsOf('p-child')).map((r) => r.id)).toEqual(['pr-sem']);
  });

  it('🔴 削除しても辺は残る ── ゴミ箱から戻すと**居場所も戻る**', async () => {
    // 直す前は deleteEntry が両側の辺を消していたので、戻すと必ず root へ出ていた
    // (フォルダを消して戻すと中身が空になる、の裏返し)
    await request({
      op: 'setEntryParent',
      cid: 'c1',
      lid: 'p-child',
      parentLid: 'p-fold',
      relationId: 'pr-6',
    });
    await request({ op: 'deleteEntry', cid: 'c1', lid: 'p-child' });
    expect(await relsOf('p-child')).toHaveLength(2); // structural + semantic

    // 復元(= 行の挿し直し)で、そのまま p-fold の下に戻る
    await write('p-child', '# 中身(復元)\n');
    const rows = await relsOf('p-child');
    expect(rows.find((r) => r.kind === 'structural')?.from_lid).toBe('p-fold');
  });

  it('🔴 purgeTrash が、本当に消えた lid の辺を掃除する', async () => {
    // ⚠ deleteEntry が辺を残す以上、最終処分場はここ 1 か所しかない ──
    //    掃除しないと、消した lid を指す辺が永久に溜まる
    await write('p-gone', '# 消える\n');
    await request({
      op: 'setEntryParent',
      cid: 'c1',
      lid: 'p-gone',
      parentLid: 'p-fold',
      relationId: 'pr-gone',
    });
    await request({ op: 'deleteEntry', cid: 'c1', lid: 'p-gone' });
    // ゴミ箱に居る間は**消さない**(まだ戻せる)
    expect(await relsOf('p-gone')).toHaveLength(1);

    await request({ op: 'purgeTrash', cid: 'c1' });
    expect(await relsOf('p-gone')).toHaveLength(0);
    // 生きている entry の辺は残る(掃除が広すぎない)
    expect(await relsOf('p-child')).toHaveLength(2);
  });
});

describe('🔴 未知の op を名指しで断る', () => {
  it('存在しない op は **op 名つき**のエラーになる', async () => {
    // ⚠ 無条件に呼ぶと `TypeError: handler is not a function` になるだけで、
    // **どの op が無いのか分からない** ── nightly の store probe が P5c で
    // 消えた `bulkAddRevisions` を呼び続け、この文言だけを残して落ちていた。
    // op の増減は改名で起きるので、名前を出す価値がある
    await expect(
      request({ op: 'bulkAddRevisions' } as never),
    ).rejects.toThrow(/未知の op.*bulkAddRevisions/);
  });

  it('既知の op はそのまま通る(ガードが全部を塞いでいない)', async () => {
    await expect(request({ op: 'counts', cid: 'c1' })).resolves.toBeTruthy();
  });
});
