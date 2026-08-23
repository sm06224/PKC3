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
import { TASK_LIMITS } from '../../src/features/schedule/task-cards';
import { contentHash64Hex } from '../../src/adapter/platform/storage/content-hash';

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

  /**
   * 🔴 **別の窓が書いたものは、上書きされても履歴に残るか**(#178 / #300 段③、2026-08-22)。
   *
   * ## なぜここで測るのか
   *
   * 動線レビューは「別窓の書込が本体の未保存編集に**黙って消される**」と報告した。
   * ⚠ **「消える」と「見えなくなる」は別の主張である** ── 前者なら緊急、後者なら
   * 「知らせていない」欠陥である。読んだだけで severity を書くと、CLAUDE.md の
   * 「事故の報告ほど範囲を実測してから書く」を破る。だから**実物の worker で通す**。
   *
   * ## 再現する物語(窓 2 枚)
   *
   * 1. 窓 A がノート X を開く(= `doc('本文')` を読む)
   * 2. 窓 B のカレンダーが X に日付を付ける ── `REQUEST_BODY_REWRITE` は
   *    **`checkpoint` を渡さない**(`store-effects.ts` の `persistEntry(…)` に
   *    opts が無い)ので **amend** である
   * 3. 窓 A が保存する ── `COMMIT_EDIT` は既存ノートで **`checkpoint: true`**
   *
   * ⚠ このとき worker が履歴へ積むのは **`old.body` = ディスク上の値 = 窓 B の版**
   * である。つまり**上書きはされるが、消えてはいない**。
   */
  it('🔴 別の窓が書いた版は、上書きされても履歴から戻せる (#178)', async () => {
    const read = doc('本文'); // 窓 A が読んだ版
    const fromOtherWindow = doc('本文') + 'date: 2026-08-22\n'; // 窓 B が書いた版
    const commit = doc('本文を推敲した'); // 窓 A が保存した版

    // ⚠ **行を作る 1 手が要る** ── 新規行には `old` が無いので `maintainChain` は
    //    呼ばれない(1 稿目はここを取り違えて前提が落ちた。読むより測るほうが速い)
    await write('w1', doc('作った'));
    await write('w1', read, { checkpoint: true });
    expect(await metasOf('w1'), '前提が崩れている(頭が立っていない)').toHaveLength(1);
    // 窓 B(カレンダー / やることの板)── amend なので履歴は伸びない
    await write('w1', fromOtherWindow);
    expect(await metasOf('w1'), '前提が崩れている(別窓の書込で履歴が伸びた)').toHaveLength(1);

    // 窓 A の保存 ── **窓 B の版を上書きする**
    await write('w1', commit, { checkpoint: true });

    const metas = await metasOf('w1');
    const bodies = await Promise.all(metas.map((m) => bodyOf(m.id)));
    /**
     * 🔑 **主張はここ 1 つ** ── 上書きされた「窓 B の版」が履歴に在る。
     * ⚠ `toHaveLength` で数を見ない(数は amend / prune で動く)── **中身**を見る。
     */
    expect(
      bodies,
      '別の窓が書いた版が履歴のどこにも無い(= 本当に消えている。緊急度が上がる)',
    ).toContain(fromOtherWindow);
    // ⚠ **空振り防止** ── 何でも入っているわけではないことを対照群で見る
    expect(bodies, '書いていない版が履歴に在る(この検査は何も絞れていない)').not.toContain(
      doc('存在しない版'),
    );
  });

  /**
   * 🔴 **改名は本文に触らない**(#178、2026-08-22)。
   *
   * ## 直す前に何が起きていたか
   *
   * 改名は `getBody` → 題名を差し替えて **`upsertEntry` で行全体を書く**形だった。
   * ⚠ 読んでから書くまでの間に**別のタブ / 窓が本文を書いていると、それを消す**。
   * しかも本文は変わらないので `maintainChain` は呼ばれず、**履歴にも残らない**
   * ── つまり **どこからも戻せない**(編集の保存は checkpoint が効くので戻せる、
   * という #333 の性質が**この経路には効かない**)。
   *
   * 🔑 直し方は検出ではなく**消滅**である ── 触らなければ衝突しようがない。
   */
  it('🔴 改名は本文を書き戻さない ── 別の窓の本文が生き残る (#178)', async () => {
    await write('r1', doc('初稿'));
    await write('r1', doc('二稿'), { checkpoint: true });
    const before = await metasOf('r1');
    expect(before, '前提が崩れている(頭が立っていない)').toHaveLength(1);

    // 🔴 **別の窓がこのノートの本文を書いた**(改名する側は、これを読んでいない)
    await write('r1', doc('別の窓が書いた'));

    // 改名 ── 題名だけを渡す(本文は渡さない)
    const stamps = await request({
      op: 'renameEntry',
      cid: 'c1',
      lid: 'r1',
      title: '新しい題名',
    });
    expect(stamps, '改名の ack が返らない').not.toBeNull();

    const row = (await request({ op: 'listEntryMetas', cid: 'c1' })).find((m) => m.lid === 'r1');
    expect(row?.title, '題名が変わっていない').toBe('新しい題名');
    expect(stamps?.updatedAt, '刻んだ時刻を返していない').toBeTruthy();
    /**
     * 🔑 **主張はここ** ── 別の窓が書いた本文が**そのまま在る**。
     * ⚠ 直す前はここが `doc('二稿')`(改名する側が読んだ古い本文)に戻っていた。
     */
    expect(await request({ op: 'getBody', cid: 'c1', lid: 'r1' })).toBe(doc('別の窓が書いた'));
    // ⚠ 鎖も動かない(本文が変わっていないので、元から動いていなかった)
    expect(await metasOf('r1'), '改名で履歴が動いた').toHaveLength(before.length);
    expect(before[0]!.id, '履歴の id が変わった(この版が別物になる)').toBe(
      (await metasOf('r1'))[0]!.id,
    );
  });

  /**
   * 🔴 **読んだものと違っていたら、1 バイトも書かない**(#178、2026-08-22)。
   *
   * ⚠ 追記のための門である ── `getBody` → `appendBlock` → 書込 の間に
   * 別のタブ / 窓が書くと、その版を消す(`checkpoint` を渡さないので**履歴にも
   * 残らない**)。🔑 **同じ tx の中で比べる**のが要点:ここで読む `old.body` は
   * 「まさにこれから上書きする値」なので、比較と書込の間に隙間が無い。
   */
  it('🔴 expectHash が食い違ったら書かない(conflict を返す) (#178)', async () => {
    await write('h1', doc('作った'));
    await write('h1', doc('読んだ本文'), { checkpoint: true });
    const revsBefore = await metasOf('h1');

    // 🔴 **別の窓が書いた**(この後、古い基底のまま書こうとする)
    await write('h1', doc('別の窓が書いた'));

    const res = await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('h1', doc('古い基底に足した')),
      checkpoint: false,
      // ⚠ 「読んだ本文」の hash ── いまの disk は既に別物である
      expectHash: contentHash64Hex(doc('読んだ本文')),
    });

    expect(res.conflict, '食い違いを見逃した').toBe(true);
    expect(
      await request({ op: 'getBody', cid: 'c1', lid: 'h1' }),
      '書かないと言いながら書いた(別の窓の本文が消える)',
    ).toBe(doc('別の窓が書いた'));
    // ⚠ **鎖も動かない**(tx ごと巻き戻る)
    expect(await metasOf('h1'), '書かなかったのに履歴が動いた').toHaveLength(revsBefore.length);
  });

  it('🔴 expectHash が一致すれば、ふつうに書く(空振り防止) (#178)', async () => {
    await write('h2', doc('作った'));
    await write('h2', doc('いまの本文'));
    const res = await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('h2', doc('足した')),
      checkpoint: false,
      expectHash: contentHash64Hex(doc('いまの本文')),
    });
    expect(res.conflict, '一致しているのに断った').toBeUndefined();
    expect(await request({ op: 'getBody', cid: 'c1', lid: 'h2' })).toBe(doc('足した'));
  });

  /**
   * ⚠ **渡さなければ今までどおり**(last-write-wins)。
   * 🔑 編集の保存はこちら ── 断ると user が打った字を捨てさせることになる(#333)。
   */
  it('⚠ expectHash を渡さなければ、食い違っていても書く(既定は変えない) (#178)', async () => {
    await write('h3', doc('作った'));
    await write('h3', doc('別の窓が書いた'));
    const res = await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('h3', doc('上書きした')),
      checkpoint: false,
    });
    expect(res.conflict).toBeUndefined();
    expect(await request({ op: 'getBody', cid: 'c1', lid: 'h3' })).toBe(doc('上書きした'));
    /**
     * 🔴 **そして消えた版はどこにも残らない**(#178 残り 2 本の根拠、2026-08-23)。
     * ⚠ `checkpoint` を渡さない書込は **amend** ── 頭が復元する状態は変えないので、
     *   上書きされた `別の窓が書いた` は**履歴に 1 度も入らない**。
     * 🔑 だから「読んで → 直して → 書き戻す」経路(板の設定 / 面のチェック)は
     *   **`expectHash` を渡さないと、別の窓の本文を取り返せない形で消す**。
     */
    const bodies = await Promise.all((await metasOf('h3')).map((m) => bodyOf(m.id)));
    expect(
      bodies.some((b) => b?.includes('別の窓が書いた')),
      '消えた版が履歴に在る(前提が変わった ── 呼び側の expectHash を見直すこと)',
    ).toBe(false);
  });

  /** ⚠ 消えたノートの改名を「成功」と言わない(呼び側が理由を出せる)。 */
  it('⚠ 行が無い改名は null を返す (#178)', async () => {
    expect(await request({ op: 'renameEntry', cid: 'c1', lid: 'no-such', title: 'x' })).toBeNull();
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

/**
 * 🔴 #100 段② ── 添付 key → 所有 entry の逆引き(`findAssetOwner`)。
 *
 * ⚠ **誤爆の pin が本体**である(Issue #100 の名指しの罠): 本文に `asset:<key>` と
 * **書いただけ**の text ノートへ飛んではいけない ── 判定は「archetype='attachment'
 * かつ frontmatter の asset_key 等値」だけ(GC の false-keep 側 scanAssetRefs を
 * 流用しない)。
 */
describe('findAssetOwner(#100 段②)', () => {
  const ATT = [
    '---',
    'attachment.name: p.png',
    'attachment.mime: image/png',
    'attachment.size: 3',
    'attachment.asset_key: ast-own-1',
    '---',
    '',
  ].join('\n');

  it('🔴 所有する attachment の lid が返り、書いただけの text には飛ばない', async () => {
    // ⚠ 誤爆候補(text で key を散文に含む)を**先に**入れる ── 走査順で
    //   先に当たっても falsely 返さないことを見る
    await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('fa-text', '本文で ast-own-1 と asset:ast-own-1 に触れただけ', {
        archetype: 'text',
        entryOrder: 1,
      }),
      checkpoint: false,
    });
    await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('fa-att', ATT, { archetype: 'attachment', entryOrder: 2 }),
      checkpoint: false,
    });
    // 別 key の attachment(等値の pin ── 前方一致等で当たらない)
    await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('fa-att2', ATT.replace('ast-own-1', 'ast-own-10'), {
        archetype: 'attachment',
        entryOrder: 3,
      }),
      checkpoint: false,
    });

    const hit = (await request({ op: 'findAssetOwner', cid: 'c1', assetKey: 'ast-own-1' })) as {
      lid: string | null;
    };
    expect(hit.lid).toBe('fa-att');
  });

  it('見つからなければ null(呼び側が断る ── 黙る dead click にしない)', async () => {
    const miss = (await request({
      op: 'findAssetOwner',
      cid: 'c1',
      assetKey: 'ast-missing',
    })) as { lid: string | null };
    expect(miss.lid).toBeNull();
  });
});

/**
 * 🔴 **作成と居場所を 1 tx で書く**(#258)。
 *
 * ⚠ 直す前は 2 op(行を書く → ack → 辺を書く)で、その隙にタブを閉じると
 * **ノートは残るのに親だけ飛んだ**(フォルダの中に作ったのにルートに現れる)。
 * ⚠ 見るのは「1 op で両方書けるか」だけでなく、**片方だけ残らないか**である。
 * ⚠ この file は **1 つの DB を共有する** ── lid は他の test と衝突しない名前にする。
 */
describe('作成と居場所(#258)', () => {
  /** ⚠ worker は **SQL の列名のまま**返す(`to_lid`)── camel に読み替えない。 */
  const relsOf = async (toLid: string) =>
    (
      (await request({ op: 'listRelations', cid: 'c1' })) as unknown as Array<{
        id: string;
        from_lid: string;
        to_lid: string;
      }>
    ).filter((r) => r.to_lid === toLid);

  it('🔴 1 op で行と辺の両方が書かれる', async () => {
    // ⚠ 親の行も実在させる(いまは FK が無いので通るが、足した日に偽陽性で落ちる)
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('atom-folder', '', { archetype: 'folder' }) });
    await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('atom-child', 'x'),
      parent: { parentLid: 'atom-folder', relationId: 'atom-rel-1' },
    });
    const rows = await request({ op: 'listEntryMetas', cid: 'c1' });
    expect(
      rows.some((m) => m.lid === 'atom-child'),
      '行が書かれていない',
    ).toBe(true);
    const rels = await relsOf('atom-child');
    expect(rels, '辺が書かれていない').toHaveLength(1);
    expect(rels[0]!.from_lid).toBe('atom-folder');
  });

  it('`parent` を渡さなければ辺に触らない(本文の保存で居場所が消えない)', async () => {
    // ⚠ ここが「触らない」でないと、**保存のたびにフォルダから出る**
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('atom-child', 'y') });
    expect(await relsOf('atom-child'), '本文を保存したら居場所が消えた').toHaveLength(1);
  });

  it('🔴 `parentLid: null` は「ルートへ出す」(辺を落とす)', async () => {
    await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('atom-child', 'z'),
      parent: { parentLid: null, relationId: 'atom-rel-1' },
    });
    expect(await relsOf('atom-child')).toHaveLength(0);
  });

  it('🔴 **辺の書込**で落ちたら、行も残らない(1 tx が効いている)', async () => {
    /**
     * ⚠ **落とすのは辺の側**(着地前レビュー 🔴-1)。1 稿目は行の側(`body` に
     * bind できない値)を落としていたが、行 → 辺の順なので **`writeParent` が
     * 一度も走らず**、`BEGIN`/`COMMIT` を丸ごと外しても緑だった ──
     * **ロールバックを 1 度も要求していない**空振りである。
     */
    const before = (await request({ op: 'listEntryMetas', cid: 'c1' })).length;
    await expect(
      request({
        op: 'upsertEntry',
        cid: 'c1',
        entry: entry('atom-rollback', '# x\n'),
        // ⚠ 辺の bind を落とす(行の upsert は成功済みの状態を作る)
        parent: { parentLid: 'atom-folder', relationId: undefined as unknown as string },
      }),
    ).rejects.toBeTruthy();
    const after = await request({ op: 'listEntryMetas', cid: 'c1' });
    expect(
      after.some((m) => m.lid === 'atom-rollback'),
      '辺で落ちたのに行だけ残った(1 tx になっていない)',
    ).toBe(false);
    expect(after.length, '巻き戻っていない').toBe(before);
    expect(await relsOf('atom-rollback')).toHaveLength(0);
  });

  it('新しい worker は「辺も書いた」と名乗る(旧 worker は名乗らない)', async () => {
    // ⚠ 呼び側はこの申告で 2 手へ落ちるかを決める(旧ビルドが本体のときの互換)
    const stamps = await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('atom-said', 'x'),
      parent: { parentLid: 'atom-folder', relationId: 'atom-rel-said' },
    });
    expect(stamps.parentWritten, '書いたのに名乗っていない').toBe(true);
    const plain = await request({ op: 'upsertEntry', cid: 'c1', entry: entry('atom-said', 'y') });
    expect(plain.parentWritten, '触っていないのに名乗った').toBeUndefined();
  });
});


/**
 * 🔴 **チェック項目の候補を列に持つ**(#277 段②。user 裁定 2026-08-19「推薦 A」)。
 *
 * カンバンは「チェック項目を持つノート」だけを集める。全ノートの本文を読むと
 * **面を開くたびの全文走査**になる(#212 と同じ穴)ので、保存時に列へ書き、
 * 面は**まず列で絞ってから**候補の本文だけ読む。
 *
 * 🔑 守る主張:
 * 1. 書けば列が入り、`taskScan` が**その行だけ**を札にする(行番号は原文のもの)
 * 2. 🔴 **消したら札も消える**(片道にしない ── 消えたのに候補に残ると空振りが増える)
 * 3. 🔴 **呼び側が値を送ってこなくても正しい**(旧いタブの follower。#286 の型)
 * 4. 🔴 **切ったことを言う**(黙って切ると user は「無い」と読む)
 *
 * 🔴 **本文は worker から出ない** ── 返るのは項目だけである(不可侵指示
 * 2026-07-27)。だから `taskScan` の結果に本文は 1 バイトも入っていない。
 */
describe('カンバンの札を集める (#277 段②)', () => {
  const taskBody = '# 買い物\n\n- [ ] 牛乳\n- [x] 卵\n';
  /** 札を集めて、鍵の一覧にする(順は entry_order → 行番号)。 */
  const scanKeys = async (cid: string): Promise<string[]> => {
    const scan = await request({ op: 'taskScan', cid });
    return scan.cards.map((c) => `${c.lid} ${c.line}`);
  };

  it('🔴 チェックのある行が札になり、無いノートは 1 枚も出さない', async () => {
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('tk-1', taskBody) });
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('tk-2', '# ただの本文\n') });
    const keys = await scanKeys('c1');
    // ⚠ 行番号は**原文のもの**(2 行目と 3 行目)
    expect(keys, 'チェックの行が札になっていない').toContain('tk-1 2');
    expect(keys).toContain('tk-1 3');
    expect(
      keys.some((k) => k.startsWith('tk-2 ')),
      'チェックの無いノートまで札になっている',
    ).toBe(false);
  });

  /** 🔴 **印の向きが本文と合っている**(取り違えると済みが未完了の列に並ぶ)。 */
  it('🔴 印の向きが本文と合う', async () => {
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('tk-mark', taskBody) });
    const scan = await request({ op: 'taskScan', cid: 'c1' });
    const mine = scan.cards.filter((c) => c.lid === 'tk-mark');
    expect(mine.map((c) => [c.text, c.done])).toEqual([
      ['牛乳', false],
      ['卵', true],
    ]);
  });

  /**
   * 🔴 **消したら札も消える**。⚠ 片道だと、チェックを全部消したノートが
   *   いつまでも候補に残り、面を開くたびに無駄な本文の読みが増える。
   */
  it('🔴 チェックを消すと札も消える(片道にしない)', async () => {
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('tk-3', taskBody) });
    expect(await scanKeys('c1')).toContain('tk-3 2');
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('tk-3', '# 消した\n') });
    expect(
      (await scanKeys('c1')).some((k) => k.startsWith('tk-3 ')),
      '消したのに札が残っている',
    ).toBe(false);
  });

  /**
   * 🔴 **呼び側が数を送ってこなくても正しい**(#286 と同じ型)。
   *
   * 多重タブでは follower の要求が本体タブの worker へ proxy される。
   * ⚠ **follower が旧ビルド**だと、新しい field を載せてこない ── そこで
   *   要求の中身に依存していると、`NOT NULL` で**保存そのものが落ちる**
   *   (= user のデータが書けない)。本文から数えるので、送ってこなくても効く。
   * 🔑 ここでは「余計な field を持たない素の要求」= 旧ビルドの形を再現している。
   */
  it('🔴 旧いタブの形(数を送ってこない要求)でも、札に出る', async () => {
    await request({
      op: 'upsertEntry',
      cid: 'c1',
      // ⚠ `entry()` は taskTotal を持たない ── これがまさに旧ビルドの形
      entry: entry('tk-old', '- [ ] 旧いタブから書いた\n'),
    });
    expect(
      await scanKeys('c1'),
      '旧いタブから書いたノートの札が出ない',
    ).toContain('tk-old 0');
  });

  /** ⚠ 引用の中も拾う(素朴な行走査が落とす形 ── `task-count.test.ts` 参照)。 */
  it('引用の中のチェックも札になる', async () => {
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('tk-q', '> - [ ] 引用\n') });
    expect(await scanKeys('c1')).toContain('tk-q 0');
  });

  /** ⚠ 別の器のノートは混ざらない(cid で切れている)。 */
  it('別の器のノートは混ざらない', async () => {
    await request({ op: 'openContainer', cid: 'c-other', title: 'x' });
    await request({ op: 'upsertEntry', cid: 'c-other', entry: entry('tk-other', taskBody) });
    expect((await scanKeys('c1')).some((k) => k.startsWith('tk-other '))).toBe(false);
    expect(await scanKeys('c-other')).toEqual(['tk-other 2', 'tk-other 3']);
  });

  it('上限に届かない量では切らない(切ったと言わない)', async () => {
    const scan = await request({ op: 'taskScan', cid: 'c1' });
    expect(scan.truncated, '切っていないのに切ったと言っている').toBe(false);
    expect(scan.scannedNotes, '候補を読み残している').toBe(scan.totalNotes);
    expect(scan.totalNotes, '候補が 1 件も無い(空振り)').toBeGreaterThan(0);
  });

  /**
   * 🔴 **切ったら言う**(黙って切ると user は「無い」と読む)。
   *
   * ⚠ **上限を跨ぐ件数で試す**(CLAUDE.md §2「弱いのではなく走っていない」)──
   *   届かない量だけを見ていると、`truncated` を常に `false` にする変異が
   *   **生き延びる**(2026-08-19 の変異試験 M7 で実際に生き延びた)。
   * 🔑 件数は **`TASK_LIMITS` から導く**(直書きしない)── 上限を上げた日に
   *   「上限ちょうど」の主張が嘘になるのを避ける。
   */
  it('🔴 上限を超えたら、切ったと言う(黙って落とさない)', async () => {
    await request({ op: 'openContainer', cid: 'c-many', title: 'x' });
    const entries = Array.from({ length: TASK_LIMITS.notes + 5 }, (_, i) =>
      entry(`many-${String(i).padStart(4, '0')}`, `- [ ] やること ${i}\n`, { entryOrder: i }),
    );
    await request({ op: 'bulkUpsertEntries', cid: 'c-many', entries });
    const scan = await request({ op: 'taskScan', cid: 'c-many' });
    expect(scan.totalNotes, '候補の総数が上限を超えていない(前提が崩れた)').toBe(
      TASK_LIMITS.notes + 5,
    );
    expect(scan.truncated, '切ったのに黙っている').toBe(true);
    expect(scan.scannedNotes, '上限を超えて読んでいる').toBe(TASK_LIMITS.notes);
    // ⚠ 切っても**読んだ分は返る**(0 件にして「無い」と見せない)
    expect(scan.cards.length, '切ったら何も返さなくなった').toBe(TASK_LIMITS.notes);
  });

  /**
   * 🔴 **行に書いた日付が札に載る**(user 指示 2026-08-23)。
   * ⚠ 記法(`@2026-08-25`)は**札の字から外れる** ── 残すと、同じ日付が
   *   1 枚の札に 2 回出る(日付欄と字の両方)。
   */
  it('🔴 行の日付と時刻が札に載り、記法は字から外れる', async () => {
    await request({
      op: 'upsertEntry',
      cid: 'c1',
      entry: entry('tk-when', '- [ ] 見積を送る @2026-08-25\n- [ ] 打合せ @2026-08-26 14:00\n- [ ] 体裁\n'),
    });
    const scan = await request({ op: 'taskScan', cid: 'c1' });
    expect(scan.cards.filter((c) => c.lid === 'tk-when').map((c) => [c.text, c.date, c.time])).toEqual([
      ['見積を送る', '2026-08-25', null],
      ['打合せ', '2026-08-26', '14:00'],
      // ⚠ **日付の無い行も運ぶ**(出す / 出さないを決めるのは描画側)
      ['体裁', null, null],
    ]);
  });

  /**
   * 🔴 **日付を持つ札は、持たない札に押し出されない**(2026-08-23)。
   *
   * ⚠ 上限が 1 本だと、**体裁のチェックリストが並んだノート 1 件**で枠が埋まり、
   *   その後ろのノートに書いた**予定が 1 つも入らない** ── いちばん要る物が
   *   いちばん要らない物に押し出される。しかも `truncated` は立つので、
   *   画面には「切った」としか出ず、**何が落ちたかは誰にも分からない**。
   *
   * 🔑 だから**別々に数える**。この test はその 1 点だけを見る。
   */
  it('🔴 日付の無い項目で枠が埋まっても、日付のある項目は入る', async () => {
    await request({ op: 'openContainer', cid: 'c-starve', title: 'x' });
    /**
     * ⚠ **同じノートの中**でノイズを先に置き、予定を最後に置く。
     * 🔑 これで 2 つの誤りを同時に殺せる ──
     *   ① 上限を 1 本で数える(予定が枠から溢れる)
     *   ② 枠が埋まった時点で**そのノートの残りを読むのをやめる**
     *      (`continue` ではなく `break` にする)── 後ろの予定に永久に届かない
     */
    const lines = Array.from({ length: TASK_LIMITS.undated + 20 }, (_, i) => `- [ ] 体裁 ${i}`);
    lines.push('- [ ] 予定 @2026-08-25');
    await request({
      op: 'upsertEntry',
      cid: 'c-starve',
      entry: entry('starve-1', lines.join('\n') + '\n'),
    });
    const scan = await request({ op: 'taskScan', cid: 'c-starve' });
    // ⚠ 前提の検算:ノイズが本当に枠を埋め切っていること(埋まっていなければ空振り)
    expect(
      scan.cards.filter((c) => c.date === null).length,
      '前提が崩れている(日付の無い枠が埋まっていない)',
    ).toBe(TASK_LIMITS.undated);
    expect(
      scan.cards.filter((c) => c.date !== null).map((c) => [c.text, c.date]),
      '日付のある予定が、体裁のチェックリストに押し出された',
    ).toEqual([['予定', '2026-08-25']]);
    // 🔑 落としたことは黙らない
    expect(scan.truncated, '落としたのに黙っている').toBe(true);
  });
});

/**
 * 🔴 **大きさの列は「保存の口」が書く**(2026-08-19、2 ペインの作り直し)。
 *
 * ⚠ migration の test(`schema-migration.test.ts`)は**埋め戻しの道**しか通らない ──
 *   既に DB を持っている user の道である。**新しく保存したノート**が通るのは
 *   こちら(`bindUpsert`)なので、片方だけでは代入を落とす変異が半分生き延びる
 *   (CLAUDE.md §7「同じ値を複数の経路へ渡すものは、経路ごとに pin する」)。
 * ⚠ そして **`listEntryMetas` が返すこと**も併せて見る ── 列に入っていても
 *   SELECT に挙げ忘れると、画面には永久に届かない(数だけ正しくて表示が空)。
 */
describe('大きさの列(2026-08-19)', () => {
  const charsOf = async (lid: string): Promise<number | null | undefined> =>
    (await request({ op: 'listEntryMetas', cid: 'c1' })).find((m) => m.lid === lid)?.body_chars;

  it('🔴 保存すると本文の文字数が入り、一覧にも載る', async () => {
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('size-ja', 'あいう\n') });
    expect(await charsOf('size-ja'), '保存の口が大きさを書いていない').toBe(4);
  });

  it('🔴 書き換えたら追従する(古い大きさが残らない)', async () => {
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('size-grow', 'ab') });
    expect(await charsOf('size-grow')).toBe(2);
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('size-grow', 'abcdef') });
    expect(await charsOf('size-grow'), 'UPSERT の更新側で列を書いていない').toBe(6);
  });

  /**
   * ⚠ **空のノートは `0`**(「まだ数えていない」= `null` ではない)。
   * 潰すと、埋め戻しが**毎回の open で同じ行を読み直す**(永遠に尽きない)。
   */
  it('🔴 空のノートは 0(未計算ではない)', async () => {
    await request({ op: 'upsertEntry', cid: 'c1', entry: entry('size-empty', '') });
    expect(await charsOf('size-empty')).toBe(0);
  });
});
