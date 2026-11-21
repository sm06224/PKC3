/** @vitest-environment node */
/**
 * 🔴 端末間の同期(#2000 段 2)── 着地前レビューの指摘(system 領域・つながりの種類・取り消し・計画と反映の間の編集・
 * 削除の記録の速さ・worker の指紋・確認の文言)を、実物の worker(2 台)で通す。
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { exportSyncDiff, importSyncDiff, CONFLICT_HOWTO, UNDO_LIMIT_LINE } from '../../src/adapter/ui/actions/sync-diff';
import { readDiffZip, writeDiffZip, DIFF_FORMAT, type DiffNote, type DiffRelation } from '../../src/features/sync/diff-file';
import { relationKey, type Tombstone } from '../../src/features/sync/change-set';
import { entryFp, relationFp } from '../../src/features/sync/sync-fp';
import { spawnDevice, type SyncDevice } from '../helpers/sync-device';

const devices: SyncDevice[] = [];
async function dev(name: string, on = true, cid?: string): Promise<SyncDevice> {
  const d = await spawnDevice(name, cid);
  devices.push(d);
  await d.setEnabled(on);
  return d;
}
afterEach(async () => {
  for (const d of devices.splice(0)) await d.close().catch(() => undefined);
});
const live = async (d: SyncDevice) => (await d.request({ op: 'listEntryMetas', cid: d.cid })).map((m) => m.lid).sort();
const body = async (d: SyncDevice, lid: string) => (await d.request({ op: 'getBodies', cid: d.cid, lids: [lid] }))[0]?.body ?? null;
const snap = (d: SyncDevice) => d.request({ op: 'syncSnapshot', cid: d.cid });
const lastReport = (d: SyncDevice): string => (d.reports[d.reports.length - 1] ?? []).join('\n');
async function send(from: SyncDevice, to: SyncDevice, opts: { all?: boolean } = {}): Promise<void> {
  from.lastDiff = null;
  await exportSyncDiff(from.deps(), opts);
  expect(from.failures).toEqual([]);
  await importSyncDiff(to.deps(), from.lastDiff!.blob, from.lastDiff!.name);
  expect(to.failures).toEqual([]);
}
const structural = async (d: SyncDevice) =>
  (await d.request({ op: 'listRelations', cid: d.cid })).filter((r) => r.kind === 'structural').map((r) => `${r.from_lid}>${r.to_lid}`).sort();

const PEER = 'abcdef0123456789';
const note = (lid: string, title: string, bodyText: string, parentLid: string | null = null, archetype = 'text'): DiffNote => ({ lid, title, archetype, parentLid, body: bodyText });

/** 細工した差分ファイル(他の端末が作った入力)。 */
async function forge(o: { notes?: DiffNote[]; relations?: DiffRelation[]; tombstones?: Tombstone[]; device?: string; cid?: string; seq?: number }): Promise<Blob> {
  const notes = o.notes ?? [];
  const relations = o.relations ?? [];
  const fingerprints = [
    ...notes.map((n) => {
      const f = entryFp({ title: n.title, archetype: n.archetype, parentLid: n.parentLid, body: n.body });
      return { key: n.lid, c: f.content, p: f.place as string };
    }),
    ...relations.map((r) => ({ key: relationKey(r), c: relationFp().content })),
  ];
  async function* it(): AsyncGenerator<DiffNote> {
    for (const n of notes) yield n;
  }
  const out = await writeDiffZip({
    manifest: { exported_at: '2026-11-21T09:30:00.000Z', device: o.device ?? PEER, seq: o.seq ?? 1, cid: o.cid ?? 'c-forge', title: '細工', complete: true },
    notes: it(),
    relations,
    tombstones: o.tombstones ?? [],
    fingerprints,
    peerBase: [],
    labels: [],
    pins: [],
    assets: () => [],
    getAssetBlob: async () => null,
  });
  return out.blob;
}

describe('🔴1 system 領域の lid(読む側と書く側の二重の門)', () => {
  it('readDiffZip は system の lid を、ノート・つながり・削除の記録・指紋から除き、数を返す', async () => {
    const blob = await forge({
      notes: [note('ok1', '普通', '本文'), note('sys-messages', '乗っ取り', '細工'), note('sys-jobs', '乗っ取り2', '細工2')],
      relations: [
        { from: 'ok1', to: 'sys-messages', kind: 'semantic' },
        { from: 'ok1', to: 'ok1', kind: 'semantic' },
      ],
      tombstones: [{ key: 'sys-jobs', lastFp: { content: 'c1', place: 'p1' }, device: PEER, seq: 1 }],
    });
    const d = await readDiffZip(blob);
    expect(d.container.notes.map((n) => n.lid)).toEqual(['ok1']);
    expect(d.container.fingerprints.map((f) => f.key).filter((k) => k.includes('sys-'))).toEqual([]);
    expect(d.container.tombstones).toEqual([]);
    expect(d.container.relations.map((r) => r.to)).toEqual(['ok1']);
    // 数: ノート 2 + つながり 1 + 削除の記録 1(指紋は写しなので数えない)
    expect(d.dropped.reserved).toBe(4);
  });

  it('取り込むと system のノートは変わらず、結果に「システム領域」の件数が出る(対照: 普通のノートは入る)', async () => {
    const a = await dev('A');
    await a.request({ op: 'appendMessage', cid: a.cid, lid: 'sys-messages', title: 'メッセージ', section: '元のメッセージ', cap: 100 });
    const bodyBefore = await body(a, 'sys-messages');
    expect(bodyBefore).toContain('元のメッセージ');
    const blob = await forge({ notes: [note('ok1', '普通', '本文'), note('sys-messages', '乗っ取り', '細工された本文')] });
    const r = await importSyncDiff(a.deps(), blob, 'forged.pkc3-diff.zip');
    expect(r.ok).toBe(true);
    expect(await body(a, 'sys-messages')).toBe(bodyBefore);
    expect(await live(a)).toEqual(['ok1']); // user の一覧に system のノートは混ざらない・普通のノートは入る
    expect(lastReport(a)).toContain('システム領域');
  });

  it('worker の applySync は、対象に system 領域の行(名前が普通でも realm が system)があれば tx ごと断る', async () => {
    const a = await dev('A');
    await a.put('x1', '普通の名前', '元の本文');
    await a.put('y1', '別のノート', '別の本文');
    a.execSql("UPDATE entries SET realm = 'system' WHERE lid = 'x1'");
    const input = (over: Record<string, unknown>) => ({
      peer: PEER,
      peerCid: 'c-forge',
      peerSeq: 1,
      upserts: [] as Array<Record<string, unknown>>,
      trash: [] as string[],
      relationAdds: [] as Array<{ from: string; to: string; kind: string }>,
      relationRemoves: [] as Array<{ from: string; to: string; kind: string }>,
      baseline: {},
      nowIso: '2026-11-21T00:00:00.000Z',
      ...over,
    });
    const run = (over: Record<string, unknown>) => a.request({ op: 'syncApply', cid: a.cid, input: input(over) as never });
    // 同じ tx で書き換えられるはずの y1 も残る(全体が巻き戻る)ことを見る
    await expect(run({ upserts: [{ lid: 'y1', content: { title: '書き換え', archetype: 'text', body: '書き換えられた' } }, { lid: 'x1', content: { title: '乗っ取り', archetype: 'text', body: '細工' } }] })).rejects.toThrow('システム領域');
    await expect(run({ trash: ['x1'] })).rejects.toThrow('システム領域');
    await expect(run({ relationAdds: [{ from: 'y1', to: 'x1', kind: 'semantic' }] })).rejects.toThrow('システム領域');
    await expect(run({ upserts: [{ lid: 'sys-jobs', content: { title: 't', archetype: 'text', body: 'b' } }] })).rejects.toThrow('システム領域');
    expect(await body(a, 'y1')).toBe('別の本文');
    expect(await body(a, 'x1')).toBe('元の本文');
    // 対照: system でない lid だけなら通る
    const ok = await run({ upserts: [{ lid: 'y1', content: { title: '書き換え', archetype: 'text', body: '書き換えられた' } }] });
    expect(ok.written).toBe(1);
    expect(await body(a, 'y1')).toBe('書き換えられた');
  });
});

describe('🔴2 つながりの種類(structural・知らない種類)', () => {
  it('readDiffZip は structural と知らない種類のつながり(と指紋)を除き、数を返す', async () => {
    const blob = await forge({
      notes: [note('a', 'a', 'a'), note('b', 'b', 'b')],
      relations: [
        { from: 'a', to: 'b', kind: 'structural' },
        { from: 'a', to: 'b', kind: 'bogus-kind' },
        { from: 'a', to: 'b', kind: 'semantic' },
      ],
    });
    const d = await readDiffZip(blob);
    expect(d.container.relations.map((r) => r.kind)).toEqual(['semantic']);
    expect(d.container.fingerprints.map((f) => f.key).filter((k) => k.startsWith('rel:'))).toEqual(['rel:a|b|semantic']);
    expect(d.dropped.relations).toBe(2);
  });

  it('A↔B の輪を作る細工(structural の辺 2 本 + 互いを親にする)を取り込んでも、親子は輪にならない・つながりも足されない', async () => {
    const a = await dev('A');
    const blob = await forge({
      notes: [note('fa', 'フォルダ A', '', 'fb', 'folder'), note('fb', 'フォルダ B', '', 'fa', 'folder')],
      relations: [
        { from: 'fa', to: 'fb', kind: 'structural' },
        { from: 'fb', to: 'fa', kind: 'structural' },
      ],
    });
    const r = await importSyncDiff(a.deps(), blob, 'cycle.pkc3-diff.zip');
    expect(r.ok).toBe(true);
    const edges = await structural(a);
    // 親子の道(輪の門つき)だけが張る: 2 本とも張ることは無い(輪になる)
    expect(edges.length).toBeLessThanOrEqual(1);
    expect(edges.includes('fa>fb') && edges.includes('fb>fa')).toBe(false);
    expect(lastReport(a)).toContain('取り込めない種類のつながりが 2 本');
  });

  it('worker の applySync は relationAdds の structural・知らない種類を、直接渡されても足さない', async () => {
    const a = await dev('A');
    await a.put('p', 'p', 'p');
    await a.put('q', 'q', 'q');
    const res = await a.request({
      op: 'syncApply',
      cid: a.cid,
      input: {
        peer: PEER, peerCid: 'c-forge', peerSeq: 1, upserts: [], trash: [],
        relationAdds: [{ from: 'p', to: 'q', kind: 'structural' }, { from: 'p', to: 'q', kind: 'bogus' }, { from: 'p', to: 'q', kind: 'semantic' }],
        relationRemoves: [], baseline: {}, nowIso: '2026-11-21T00:00:00.000Z',
      },
    });
    expect(res.relationsAdded).toBe(1);
    expect(await structural(a)).toEqual([]);
    expect((await a.request({ op: 'listRelations', cid: a.cid })).map((r) => r.kind)).toEqual(['semantic']);
  });
});

describe('⚠4 取り消しは取り込み後の編集(題名・移動・種別)も触らない / ⚠5 連番は戻さない / ⚠8 控えに本文を持たない', () => {
  async function setup() {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('f1', 'フォルダ', '', { archetype: 'folder' });
    for (const [lid, t] of [['n1', '題名編集される'], ['n2', '移動される'], ['n3', '対照(そのまま)']] as const) await a.put(lid, t, `${lid} の初稿`);
    await send(a, b);
    await send(b, a);
    for (const lid of ['n1', 'n2', 'n3']) await b.put(lid, lid === 'n1' ? '題名編集される' : lid === 'n2' ? '移動される' : '対照(そのまま)', `${lid} のB版`);
    await send(b, a);
    for (const lid of ['n1', 'n2', 'n3']) expect(await body(a, lid)).toBe(`${lid} のB版`);
    return { a, b };
  }

  it('題名だけ・移動だけの編集は「取り込み後の編集」として触らず、そのままの物だけ戻す(対照)', async () => {
    const { a } = await setup();
    await a.request({ op: 'renameEntry', cid: a.cid, lid: 'n1', title: '題名だけ変えた' });
    await a.request({ op: 'setEntryParent', cid: a.cid, lid: 'n2', parentLid: 'f1', relationId: 'mv-n2' });
    const r = await a.undo!.run();
    expect(r).toEqual({ restored: 1, skipped: 2 });
    expect(await body(a, 'n3')).toBe('n3 の初稿'); // 対照: 触っていない物は戻る
    expect(await body(a, 'n1')).toBe('n1 のB版'); // 題名だけ編集 → 触らない
    expect(await body(a, 'n2')).toBe('n2 のB版'); // 移動だけ → 触らない
    expect((await a.request({ op: 'listEntryMetas', cid: a.cid })).find((m) => m.lid === 'n1')?.title).toBe('題名だけ変えた');
    expect(await structural(a)).toContain('f1>n2');
  });

  it('取り消しの控えは本文を持たない(履歴の版の id から戻す)・戻した本文は正しい', async () => {
    const { a } = await setup();
    const token = JSON.stringify(a.undoToken);
    expect(token).not.toContain('の初稿');
    expect(token).not.toContain('のB版');
    expect(token).toContain('"kind":"rev"');
    const r = await a.undo!.run();
    expect(r.restored).toBe(3);
    expect(await body(a, 'n1')).toBe('n1 の初稿');
  });

  it('取り消しは連番を巻き戻さない(out:<連番> の再利用を防ぐ)', async () => {
    const { a } = await setup();
    const seqBefore = (await snap(a)).seq;
    // 取り込み後に自分が書き出す(連番が進む)
    await exportSyncDiff(a.deps());
    const seqAfterExport = (await snap(a)).seq;
    expect(seqAfterExport).toBeGreaterThan(seqBefore);
    const outsBefore = Object.keys((await snap(a)).outs).map(Number).sort();
    await a.undo!.run();
    expect((await snap(a)).seq).toBe(seqAfterExport);
    // 次の書き出しは新しい連番になる(既存の out を上書きしない)
    await exportSyncDiff(a.deps());
    const outsAfter = Object.keys((await snap(a)).outs).map(Number).sort();
    expect(outsAfter.length).toBe(outsBefore.length + 1);
    expect(outsAfter[outsAfter.length - 1]).toBeGreaterThan(outsBefore[outsBefore.length - 1]!);
  });
});

describe('⚠6 計画と反映の間の編集は、黙って上書きせず競合のコピーにする', () => {
  it('snapshot の後・apply の前にこちらが編集 → こちらを残し、相手の版は別ノート(コピー)で足す・結果に出る', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '共有', '初稿');
    await a.put('n2', '共有 2', '初稿2');
    await send(a, b);
    await send(b, a);
    await b.put('n1', '共有', 'B の編集');
    await b.put('n2', '共有 2', 'B の編集2');
    b.lastDiff = null;
    await exportSyncDiff(b.deps());
    const blob = b.lastDiff!.blob;
    let injected = false;
    const deps = a.deps({
      request: (async (req: { op: string }) => {
        if (req.op === 'syncApply' && !injected) {
          injected = true;
          await a.put('n1', '共有', 'A が割り込んだ編集'); // 計画の後・反映の前
        }
        return a.request(req as never);
      }) as never,
    });
    const r = await importSyncDiff(deps, blob, 'b.pkc3-diff.zip');
    expect(r.ok).toBe(true);
    expect(injected).toBe(true);
    expect(await body(a, 'n1')).toBe('A が割り込んだ編集'); // こちらを失わない
    expect(await body(a, 'n2')).toBe('B の編集2'); // 対照: 割り込まれなかった物は普通に取り込む
    const metas = await a.request({ op: 'listEntryMetas', cid: a.cid });
    const copy = metas.find((m) => m.title.includes('同期の競合'));
    expect(copy).toBeDefined();
    expect(await body(a, copy!.lid)).toBe('B の編集'); // 相手の版は別ノートに残る
    expect(lastReport(a)).toContain('取り込む直前にこちらで編集されたノート: 1 件');
    expect(a.conflictButtons).toBeGreaterThan(0);
    expect(a.messages.some((m) => m.text.includes('1 件'))).toBe(true);
  });

  it('ゴミ箱へ移す判定の物も、割り込みの編集があれば移さない', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '消される予定', '初稿');
    await send(a, b);
    await send(b, a);
    await b.del('n1');
    b.lastDiff = null;
    await exportSyncDiff(b.deps());
    let injected = false;
    const deps = a.deps({
      request: (async (req: { op: string }) => {
        if (req.op === 'syncApply' && !injected) {
          injected = true;
          await a.put('n1', '消される予定', 'A の割り込み');
        }
        return a.request(req as never);
      }) as never,
    });
    await importSyncDiff(deps, b.lastDiff!.blob, 'b.pkc3-diff.zip');
    expect(await live(a)).toEqual(['n1']);
    expect(await body(a, 'n1')).toBe('A の割り込み');
    expect((await a.request({ op: 'listTrashHeads', cid: a.cid })).length).toBe(0);
  });
});

describe('⚠7 削除の記録は件数に比例して遅くならない', () => {
  it('3000 件をまとめてゴミ箱へ移して(取り込み)、削除の記録が 3000 件・連番が 1 ずつ進み、十分速く終わる', async () => {
    const a = await dev('A');
    const N = 3000;
    const upserts = Array.from({ length: N }, (_, i) => ({ lid: `m${i}`, content: { title: `ノート ${i}`, archetype: 'text', body: `本文 ${i}` } }));
    const base = { peer: PEER, peerCid: 'c-forge', peerSeq: 1, relationAdds: [], relationRemoves: [], baseline: {}, nowIso: '2026-11-21T00:00:00.000Z' };
    await a.request({ op: 'syncApply', cid: a.cid, input: { ...base, upserts, trash: [] } });
    const seq0 = (await snap(a)).seq;
    const t0 = Date.now();
    const res = await a.request({ op: 'syncApply', cid: a.cid, input: { ...base, upserts: [], trash: upserts.map((u) => u.lid) } });
    const ms = Date.now() - t0;
    expect(res.trashed).toBe(N);
    const s = await snap(a);
    expect(s.tombstones.length).toBe(N);
    expect(new Set(s.tombstones.map((t) => t.seq)).size).toBe(N);
    expect(s.seq).toBe(Math.max(seq0 + N, 1));
    // 1 件ごとに全件を読む形(O(N²))は、この件数で 20 秒を超える(実測)。通常は 1 秒前後なので、遅い環境でも収まる緩い上限
    expect(ms).toBeLessThan(8_000);
  }, 120_000);
});

describe('⚠8 相手の本文の指紋は worker で測る(主スレッドで SHA-256 しない)', () => {
  it('syncMeasureNotes は syncSnapshot と同じ指紋を返す(同じノートなら同じ値)', async () => {
    const a = await dev('A');
    await a.put('n1', '日本語の題名', '本文あ');
    const s = await snap(a);
    const [m] = await a.request({ op: 'syncMeasureNotes', notes: [{ lid: 'n1', title: '日本語の題名', archetype: 'text', parentLid: null, body: '本文あ' }] });
    const local = s.states.find((x) => x.key === 'n1')!;
    expect(m).toEqual({ lid: 'n1', content: local.content, place: local.place });
  });
  it('取り込み経路は syncMeasureNotes を呼ぶ(主スレッドの計画は指紋を測らない)', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '題', '本文');
    a.lastDiff = null;
    await exportSyncDiff(a.deps());
    const ops: string[] = [];
    const deps = b.deps({ request: (async (req: { op: string }) => (ops.push(req.op), b.request(req as never))) as never });
    await importSyncDiff(deps, a.lastDiff!.blob, 'a.pkc3-diff.zip');
    expect(ops).toContain('syncMeasureNotes');
    expect(await live(b)).toEqual(['n1']);
  });
});

describe('D1 / D4 / D5 / 提案: 画面の言葉', () => {
  it('競合: 結果に直し方・一覧ボタンの指示・最後の行に取り消しの限界。メッセージにも直し方', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '共有ノート', '初稿');
    await send(a, b);
    await send(b, a);
    await a.put('n1', '共有ノート', 'A の版');
    await b.put('n1', '共有ノート', 'B の版');
    await send(a, b);
    const rep = b.reports[b.reports.length - 1]!;
    expect(rep).toContain(CONFLICT_HOWTO);
    expect(rep[rep.length - 1]).toBe(UNDO_LIMIT_LINE);
    expect(b.conflictButtons).toBe(1);
    expect(b.messages[0]!.text).toContain('見比べて');
    expect(b.messages[0]!.text).toContain('同期の競合');
    // 対照: 競合の無い取り込みはボタンを出さない
    const c = await dev('C');
    await c.put('z', 'z', 'z');
    await send(c, a);
    expect(a.conflictButtons).toBe(0);
  });

  it('初回の同期の競合の題名は「同期の競合」を含む(一覧の検索 1 語で全部拾える)', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('same', '同じ lid', 'A の内容');
    await b.put('same', '同じ lid', 'B の内容');
    await send(a, b);
    const titles = (await b.request({ op: 'listEntryMetas', cid: b.cid })).map((m) => m.title);
    expect(titles.filter((t) => t.includes('同期の競合')).length).toBe(1);
    expect(titles.some((t) => t.includes('初回の同期'))).toBe(true);
    expect(titles.join('')).not.toContain('突き合わせ');
  });

  it('ワークスペースの対応の確認は質問形・題名が違うときだけ警告・ボタン名・相手の端末(先頭 4 文字)と書き出しの日時', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '題', '本文');
    await send(a, b);
    const idA = (await snap(a)).device!;
    const msg = b.confirms[0]!;
    expect(msg).toContain('相手の端末のワークスペース「ワークスペースA」を、このワークスペース「ワークスペースB」と同じ物として取り込みますか?(次からは確認しません)');
    expect(msg).toContain('題名が違います');
    expect(msg).toContain(`相手の端末(${idA.slice(0, 4)})`);
    expect(msg).toContain('2026-11-21');
    expect(b.confirmOpts[0]).toEqual({ okLabel: '同じ物として取り込む', cancelLabel: 'やめる' });
    expect(lastReport(b)).toContain(`相手の端末(${idA.slice(0, 4)})`);
    expect(lastReport(b)).toContain('書き出し 2026-11-21');
    // 対照: 題名が同じなら警告は出ない
    const c = await dev('C');
    await c.put('n9', '題', '本文');
    c.lastDiff = null;
    await exportSyncDiff(c.deps({ title: () => '共通' }));
    const d = await dev('D');
    await importSyncDiff(d.deps({ title: () => '共通' }), c.lastDiff!.blob, 'c.pkc3-diff.zip');
    expect(d.confirms[0]).not.toContain('題名が違います');
  });

  it('やめるを選ぶと何も取り込まず、対応の記録も作らない', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '題', '本文');
    a.lastDiff = null;
    await exportSyncDiff(a.deps());
    const r = await importSyncDiff(b.deps({ confirmAction: async () => false }), a.lastDiff!.blob, 'a.pkc3-diff.zip');
    expect(r).toEqual({ ok: true, count: 0 });
    expect(await live(b)).toEqual([]);
    expect(Object.keys((await snap(b)).pairs)).toEqual([]);
  });
});

describe('D2 同期の記録を消す', () => {
  it('端末 id・連番・対応・前回の同期の記録・削除の記録を全ワークスペースぶん消し、ノートは消さない(次は初回の同期)', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '題', '本文');
    await a.put('n2', '消す', '消す本文');
    await a.del('n2');
    await send(a, b);
    await send(b, a);
    const sBefore = await snap(b);
    expect(Object.keys(sBefore.pairs).length).toBeGreaterThan(0);
    expect(Object.keys(sBefore.bases).length).toBeGreaterThan(0);
    const r = await b.request({ op: 'syncForget' });
    expect(r.removed).toBeGreaterThan(0);
    const s = await snap(b);
    expect(s.device).toBeNull();
    expect(s.seq).toBe(0);
    expect(s.pairs).toEqual({});
    expect(s.bases).toEqual({});
    expect(s.tombstones).toEqual([]);
    expect(await live(b)).toEqual(['n1']); // ノートは触らない
    // 切のままでも消せる(切にするときに消す)
    await b.setEnabled(false);
    expect((await b.request({ op: 'syncForget' })).removed).toBe(0);
    // 対応が消えているので、次の取り込みは確認からやり直す(片道にしない)
    await b.setEnabled(true);
    await send(a, b);
    expect(b.confirms.length).toBe(2);
  });
});

describe('マニフェスト(形式)', () => {
  it('差分ファイルの形式名は pkc3-diff のまま(取り込み口の判定が見る)', () => {
    expect(DIFF_FORMAT).toBe('pkc3-diff');
  });
});

describe('入 / 切の通知(syncConfigure)の失敗は握りつぶさず、次の操作でやり直す', () => {
  it('ensureConfigured が失敗したら、書き出し・取り込みはその理由を言って止まる(何も書かない)。直ったら続けられる', async () => {
    const a = await dev('A');
    const b = await dev('B');
    await a.put('n1', '題', '本文');
    let broken = true;
    const ensure = async (): Promise<void> => {
      if (broken) throw new Error('worker に届きませんでした');
    };
    await exportSyncDiff(a.deps({ ensureConfigured: ensure }));
    expect(a.failures.join('\n')).toContain('worker に届きませんでした');
    expect(a.lastDiff).toBeNull();
    broken = false;
    a.failures.length = 0;
    await exportSyncDiff(a.deps({ ensureConfigured: ensure }));
    expect(a.failures).toEqual([]);
    expect(a.lastDiff).not.toBeNull();
    // 取り込み側も同じ
    broken = true;
    const r = await importSyncDiff(b.deps({ ensureConfigured: ensure }), a.lastDiff!.blob, 'a.pkc3-diff.zip');
    expect(r.ok).toBe(false);
    expect(await live(b)).toEqual([]);
    broken = false;
    expect((await importSyncDiff(b.deps({ ensureConfigured: ensure }), a.lastDiff!.blob, 'a.pkc3-diff.zip')).ok).toBe(true);
    expect(await live(b)).toEqual(['n1']);
  });
});

describe('⚠8 主スレッド側の計画・配線は本文の指紋を自分で測らない(静的な突合)', () => {
  const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['src/features/sync/sync-plan.ts', 'src/adapter/ui/actions/sync-diff.ts']) {
    it(`${f} は entryFp を呼ばない(worker の syncMeasureNotes を通す)`, () => {
      const src = strip(readFileSync(f, 'utf8'));
      expect(src.length, '読めていない').toBeGreaterThan(1000);
      expect(src).not.toMatch(/\bentryFp\(/);
    });
  }
});
