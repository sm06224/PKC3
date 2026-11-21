/**
 * 🔴 端末間の同期(#2000 段 2)── 取り込みの計画(`planSyncImport`)・書き出しの決め(`planExport`)・差分ファイルの読み書き。
 * 実物の DB を通す往復は `tests/adapter/sync-diff-roundtrip.test.ts`。ここは判定の枝を 1 つずつ見る。
 */
import { describe, expect, it } from 'vitest';
import { relationKey, type KeyedState } from '../../../src/features/sync/change-set';
import { entryFp, placeFp, relationFp } from '../../../src/features/sync/sync-fp';
import { DIFF_FORMAT, readDiffZip, writeDiffZip, type DiffNote } from '../../../src/features/sync/diff-file';
import { fingerprintDigest, isStaleBase, planExport } from '../../../src/features/sync/sync-export';
import { conflictCopyTitle, effectiveBaseline, planSyncImport, type PlanInput } from '../../../src/features/sync/sync-plan';
import { TOMBSTONE_MAX } from '../../../src/features/sync/sync-state';
import { labelFp, labelKey, pinFp, pinKey } from '../../../src/features/sync/sync-marks';

const DEV = '0123456789abcdef';
const note = (lid: string, title: string, body: string, parentLid: string | null = null): DiffNote => ({ lid, title, archetype: 'text', body, parentLid });
const st = (n: DiffNote): KeyedState => ({ key: n.lid, ...entryFp({ title: n.title, archetype: n.archetype, parentLid: n.parentLid, body: n.body }) });
const fpList = (states: KeyedState[]) => states.map((s) => ({ key: s.key, c: s.content, ...(s.place === undefined ? {} : { p: s.place }) }));

function input(over: Partial<PlanInput> & { remoteNotes?: DiffNote[]; remoteFps?: DiffNote[] }): PlanInput {
  const bodies = over.remoteNotes ?? [];
  const all = over.remoteFps ?? bodies;
  let n = 0;
  return {
    remote: {
      manifest: { format: DIFF_FORMAT, version: 1, exported_at: '', device: DEV, seq: 1, cid: 'c-r', title: 'R', complete: true, counts: { notes: 0, relations: 0, deletions: 0, assets: 0, total: 0 } },
      container: { notes: bodies, relations: [], tombstones: [], fingerprints: fpList(all.map(st)), peerBase: [], peerBases: null, assets: [], labels: null, pins: null },
    },
    // 本文の指紋は worker で測った物を渡す設計(主スレッドで測らない)── test では同じ関数で測って渡す
    remoteNoteFps: new Map(bodies.map((x) => [x.lid, entryFp({ title: x.title, archetype: x.archetype, parentLid: x.parentLid, body: x.body })] as const)),
    localStates: [],
    localRelations: [],
    localTitles: new Map(),
    localTombstones: [],
    baseline: {},
    date: '2026-11-21',
    genLid: () => `new-${++n}`,
    ...over,
  };
}

describe('planSyncImport: 判定 → 反映の操作', () => {
  it('相手だけにある物は新しく入る(lid を保つ)・記録は取り込み後の指紋', () => {
    const r = note('a', '日本語の題名', '本文');
    const p = planSyncImport(input({ remoteNotes: [r] }));
    expect(p.upserts).toEqual([
      { lid: 'a', existed: false, content: { title: '日本語の題名', archetype: 'text', body: '本文' }, place: { parentLid: null }, reason: 'take', expect: null, fallback: { lid: 'new-1', title: '日本語の題名(同期の競合 2026-11-21)' } },
    ]);
    expect(p.summary.created).toBe(1);
    expect(p.baseline.a).toEqual(st(r) && { content: st(r).content, place: st(r).place });
  });

  it('相手だけが変えた → 取り込む(updated)/ こちらだけが変えた → 何もしない(keptLocal)・記録は相手の版', () => {
    const base = note('a', 't', '初稿');
    const remoteEdited = note('a', 't', '相手の編集');
    const localEdited = note('a', 't', 'こちらの編集');
    const b = { a: { content: st(base).content, place: st(base).place } };
    const take = planSyncImport(input({ remoteNotes: [remoteEdited], localStates: [st(base)], baseline: b }));
    expect(take.summary.updated).toBe(1);
    expect(take.upserts[0]!.content!.body).toBe('相手の編集');
    const keep = planSyncImport(input({ remoteNotes: [base], localStates: [st(localEdited)], baseline: b }));
    expect(keep.upserts).toEqual([]);
    expect(keep.summary.keptLocal).toBe(1);
    expect(keep.baseline.a!.content).toBe(st(base).content); // 相手がいま持っている版(次の書き出しで差分になる)
  });

  it('相手が消した(削除の記録)→ ゴミ箱へ。こちらが変えていれば競合(こちらを残す)', () => {
    const base = note('a', 't', '初稿');
    const b = { a: { content: st(base).content, place: st(base).place } };
    const del = input({ localStates: [st(base)], baseline: b });
    del.remote.container.tombstones.push({ key: 'a', lastFp: b.a, device: DEV, seq: 2 });
    const p = planSyncImport(del);
    expect(p.trash).toEqual(['a']);
    expect(p.baseline.a).toBeUndefined();
    const edited = input({ localStates: [st(note('a', 't', '編集'))], baseline: b });
    edited.remote.container.tombstones.push({ key: 'a', lastFp: b.a, device: DEV, seq: 2 });
    const c = planSyncImport(edited);
    expect(c.trash).toEqual([]);
    expect(c.conflicts[0]).toMatchObject({ kind: 'edited-here-deleted-there', lid: 'a' });
  });

  it('こちらで消し相手が変えた → 相手の版で戻す(existed: false)', () => {
    const base = note('a', 't', '初稿');
    const p = planSyncImport(input({ remoteNotes: [note('a', 't', '相手の編集')], baseline: { a: { content: st(base).content, place: st(base).place } }, localTitles: new Map() }));
    expect(p.upserts[0]).toMatchObject({ lid: 'a', existed: false, reason: 'restore' });
    // こちらの墓標が前回の合意の代わりになる経路(記録が無いとき)も同じ戻し
    const q = planSyncImport(
      input({ remoteNotes: [note('a', 't', '相手の編集')], localTombstones: [{ key: 'a', lastFp: { content: st(base).content, place: st(base).place }, device: DEV, seq: 1 }] }),
    );
    expect(q.upserts[0]).toMatchObject({ lid: 'a', existed: false, reason: 'restore' });
    expect(q.summary.restored).toBe(1);
  });

  it('両方で同じ欄を変えた → 相手の版を別の lid のコピーにする(題名に印・親は相手の親)・元の記録は相手の版', () => {
    const base = note('a', '題', '初稿');
    const b = { a: { content: st(base).content, place: st(base).place } };
    const remote = note('a', '題', 'R');
    const p = planSyncImport(input({ remoteNotes: [remote], localStates: [st(note('a', '題', 'L'))], localTitles: new Map([['a', '題']]), baseline: b }));
    expect(p.upserts).toHaveLength(1);
    expect(p.upserts[0]).toMatchObject({ lid: 'new-1', existed: false, reason: 'copy', content: { title: conflictCopyTitle('題', false, '2026-11-21'), body: 'R' } });
    expect(p.conflicts).toEqual([{ kind: 'both-edited', lid: 'a', title: '題', copyLid: 'new-1', copyTitle: '題(同期の競合 2026-11-21)' }]);
    expect(p.baseline['new-1']).toBeUndefined(); // コピーはこちらだけの新しい物(次の書き出しで送る)
    expect(p.baseline.a!.content).toBe(st(remote).content);
  });

  it('記録が無く両方にあって違う → 初回の同期(題名の印が違うが「同期の競合」を含む)', () => {
    const p = planSyncImport(input({ remoteNotes: [note('a', '題', 'R')], localStates: [st(note('a', '題', 'L'))] }));
    expect(p.conflicts[0]).toMatchObject({ kind: 'first-sync', copyTitle: '題(初回の同期の競合 2026-11-21)' });
    expect(p.summary.firstSync).toBe(1);
  });

  it('移動(相手)と編集(こちら)は合わさる: 内容はこちら・親は相手(`merge`。本文は要らない)', () => {
    const f = note('f', 'フォルダ', '');
    const base = note('a', 't', '初稿');
    const b = { a: { content: st(base).content, place: st(base).place } };
    const moved = { ...base, parentLid: 'f' };
    const local = note('a', 't', 'こちらの編集');
    const p = planSyncImport(input({ remoteNotes: [f, moved], localStates: [st(f), st(local)], localTitles: new Map([['f', 'フォルダ']]), baseline: { ...b, f: { content: st(f).content, place: st(f).place } } }));
    expect(p.upserts).toEqual([{ lid: 'a', existed: true, reason: 'merge', place: { parentLid: 'f' }, expect: { content: st(local).content, place: st(local).place } }]);
    expect(p.summary.merged).toBe(1);
  });

  it('本文の入っていないノートを取り込む判定になったら取り込めない(needFull)・記録は前のまま', () => {
    const r = note('a', '題名', '本文');
    const p = planSyncImport(input({ remoteNotes: [], remoteFps: [r] }));
    expect(p.upserts).toEqual([]);
    expect(p.needFull).toEqual(['a']); // 題名が分からないので lid で言う
    expect(p.baseline.a).toBeUndefined();
  });

  it('親フォルダが取り込み後に無い子は、ルートへ置く(orphan。記録の欄もルートの値)', () => {
    const r = note('a', '子', '本文', 'gone');
    const p = planSyncImport(input({ remoteNotes: [r] }));
    expect(p.upserts[0]!.place).toEqual({ parentLid: null });
    expect(p.summary.orphans).toBe(1);
    expect(p.baseline.a!.place).toBe(placeFp(null));
  });

  it('つながり: 相手にだけ在る物は足す(両端が生きていれば)・端が無ければ足さず数える・相手で消えた物は外す', () => {
    const a = note('a', 'a', 'a');
    const b = note('b', 'b', 'b');
    const rel = { from: 'a', to: 'b', kind: 'semantic' };
    const add = input({ remoteNotes: [a, b] });
    add.remote.container.relations.push(rel);
    const p = planSyncImport(add);
    expect(p.relationAdds).toEqual([rel]);
    expect(p.baseline[relationKey(rel)]).toEqual(relationFp());
    const dangling = input({ remoteNotes: [a] });
    dangling.remote.container.relations.push(rel);
    const d = planSyncImport(dangling);
    expect(d.relationAdds).toEqual([]);
    expect(d.summary.danglingRelations).toBe(1);
    // 相手で消えた(全件の目録に無い・記録にある)
    const key = relationKey(rel);
    const rm = input({ remoteNotes: [a, b], localStates: [st(a), st(b), { key, ...relationFp() }], localRelations: [rel], baseline: { [key]: relationFp(), a: { content: st(a).content, place: st(a).place }, b: { content: st(b).content, place: st(b).place } } });
    const r = planSyncImport(rm);
    expect(r.relationRemoves).toEqual([rel]);
  });
});

describe('effectiveBaseline: 相手が見たこちらの版(peerBase)', () => {
  it('こちらがまだその版のままのキーだけ、相手が見た版を共通の祖先にする(連鎖して競合のコピーが増えない)', () => {
    const x = note('x', 't', 'X');
    const y = note('y', 't', 'Y');
    const stale = { content: 'old' };
    const out = effectiveBaseline({ x: stale, y: stale }, [{ key: 'x', c: st(x).content, p: st(x).place }, { key: 'y', c: 'other', p: 'p' }], [st(x), st(y)]);
    expect(out.x).toEqual({ content: st(x).content, place: st(x).place });
    expect(out.y).toEqual(stale); // こちらが相手の見た版と違う → 保存してある記録のまま
  });
  it('連鎖しない: 相手が競合で残した版を、こちらが変えていなければ素直に取り込む', () => {
    const mine = note('a', 't', 'A の版');
    const theirs = note('a', 't', 'B の版');
    const i = input({ remoteNotes: [theirs], localStates: [st(mine)], localTitles: new Map([['a', 't']]) });
    i.remote.container.peerBase = fpList([st(mine)]);
    const p = planSyncImport(i);
    expect(p.conflicts).toEqual([]);
    expect(p.summary.updated).toBe(1);
  });
});

describe('planExport', () => {
  const s1 = st(note('a', 't', 'a'));
  const s2 = st(note('b', 't', 'b'));
  const NOW = Date.parse('2026-11-21T00:00:00Z');
  const peer = (at: string | null, base: Record<string, { content: string; place?: string | undefined }> = { a: { content: s1.content, place: s1.place } }) => ({ baseline: base, at });
  it('相手が無い・全件指定・記録が古い・削除の記録が上限 → 全件', () => {
    const base = { device: DEV, seq: 1, states: [s1, s2], tombstones: [], nowMs: NOW };
    expect(planExport({ ...base, peer: null, all: false }).complete).toBe(true);
    expect(planExport({ ...base, peer: peer('2026-11-20T00:00:00Z'), all: true }).complete).toBe(true);
    expect(planExport({ ...base, peer: peer('2025-01-01T00:00:00Z'), all: false }).complete).toBe(true);
    expect(planExport({ ...base, peer: peer(null), all: false }).complete).toBe(true);
    const many = Array.from({ length: TOMBSTONE_MAX }, (_, i) => ({ key: `t${i}`, lastFp: { content: 'c' }, device: DEV, seq: 1 }));
    expect(planExport({ ...base, peer: peer('2026-11-20T00:00:00Z'), all: false, tombstones: many }).complete).toBe(true);
  });
  it('新しい記録のある相手 → 変わった物だけ(a は同じ・b は追加)・記録に在って今は無い物は削除の記録として運ぶ', () => {
    const p = planExport({ device: DEV, seq: 5, states: [s1, s2], tombstones: [], nowMs: NOW, all: false, peer: peer('2026-11-20T00:00:00Z', { a: { content: s1.content, place: s1.place }, gone: { content: 'g', place: 'p' } }) });
    expect(p.complete).toBe(false);
    expect(p.noteLids).toEqual(['b']);
    expect(p.tombstones.map((t) => [t.key, t.device, t.seq])).toEqual([['gone', DEV, 5]]);
    expect(p.fingerprints.map((f) => f.key)).toEqual(['a', 'b']); // 指紋は全件
    expect(p.peerBase.map((f) => f.key).sort()).toEqual(['a', 'gone']);
  });
  it('isStaleBase / fingerprintDigest は入力の順に依らず、1 件違えば別の値', () => {
    expect(isStaleBase('2026-11-20T00:00:00Z', NOW)).toBe(false);
    expect(isStaleBase('2026-01-01T00:00:00Z', NOW)).toBe(true);
    expect(isStaleBase('不明', NOW)).toBe(true);
    const f = fpList([s1, s2]);
    expect(fingerprintDigest(f)).toBe(fingerprintDigest([...f].reverse()));
    expect(fingerprintDigest(f)).not.toBe(fingerprintDigest([f[0]!, { ...f[1]!, c: 'x' }]));
  });
});

describe('差分ファイル(zip)の読み書き', () => {
  async function build(over: Record<string, unknown> = {}): Promise<Blob> {
    const n = note('a', '日本語', '本文');
    const out = await writeDiffZip({
      manifest: { exported_at: '2026-11-21T00:00:00Z', device: DEV, seq: 3, cid: 'c-x', title: 'T', complete: true, ...over },
      notes: (async function* () {
        yield n;
      })(),
      relations: [{ from: 'a', to: 'b', kind: 'semantic' }],
      tombstones: [{ key: 'z', lastFp: { content: 'c', place: '' }, device: DEV, seq: 2, deletedAt: '2026-11-01T00:00:00Z' }],
      fingerprints: fpList([st(n)]),
      peerBase: [],
      labels: [],
      pins: [],
      assets: () => [
        { key: 'ast-1', mime: 'image/png', size: 3, hash: null },
        { key: 'ast-missing', mime: 'image/png', size: 3, hash: null },
      ],
      getAssetBlob: async (k) => (k === 'ast-1' ? new Blob([new Uint8Array([9, 8, 7])]) : null),
    });
    expect(out.missingAssets).toEqual(['ast-missing']);
    return out.blob;
  }
  it('往復: ノート・つながり・削除の記録(空の place を含む)・指紋・添付の実体が戻る', async () => {
    const f = await readDiffZip(await build());
    expect(f.manifest).toMatchObject({ device: DEV, seq: 3, cid: 'c-x', title: 'T', complete: true });
    expect(f.container.notes).toEqual([note('a', '日本語', '本文')]);
    expect(f.container.relations).toEqual([{ from: 'a', to: 'b', kind: 'semantic' }]);
    expect(f.container.tombstones[0]).toMatchObject({ key: 'z', lastFp: { content: 'c', place: '' }, deletedAt: '2026-11-01T00:00:00Z' });
    expect(f.container.assets.map((a) => a.key)).toEqual(['ast-1']);
    const src = f.assetSources.get('ast-1')!;
    expect(new Uint8Array(await (await (await import('../../../src/features/import/zip-reader')).readAssetSource(src)).arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
  });
  it('バックアップ(pkc3-archive)や壊れた端末 id は断る', async () => {
    await expect(readDiffZip(await build({ device: 'zz' }))).rejects.toThrow('端末の情報');
    const { writeArchive } = await import('../../../src/features/export/pkc3-archive');
    const arch = await writeArchive(
      {
        cid: 'c',
        title: 't',
        listEntryMetas: async () => [{ lid: 'a', title: 't', archetype: 'text', created_at: null, updated_at: null, entry_order: 1, status: null, date: null, archived: 0 }],
        listBodies: async () => ({ rows: [{ lid: 'a', body: 'b' }], done: true }),
        listRelations: async () => [],
        listAssetMetas: async () => [],
        getAssetBlob: async () => null,
        listRevisionLids: async () => [],
        getRevisionChain: async () => [],
      },
      '2026-11-21T00:00:00Z',
    );
    await expect(readDiffZip(arch.blob)).rejects.toThrow('差分ファイルではありません');
  });
});

describe('planSyncImport: 色ラベル・ピン留め(段 3)', () => {
  const a = note('a', 't', '本文');
  const stFp = (key: string, fp: { content: string; place?: string }): KeyedState => ({ key, ...fp });
  const withMarks = (labels: Array<{ lid: string; color: number }> | null, pins: string[] | null, over: Partial<PlanInput> = {}): PlanInput => {
    const i = input({ remoteNotes: [a], localStates: [st(a)], baseline: { a: { content: st(a).content, place: st(a).place } }, ...over });
    i.remote.container.labels = labels;
    i.remote.container.pins = pins;
    return i;
  };
  it('相手だけの色・ピンは取り込む(記録は相手の指紋)', () => {
    const p = planSyncImport(withMarks([{ lid: 'a', color: 3 }], ['a']));
    expect(p.labelSets).toEqual([{ lid: 'a', color: 3 }]);
    expect(p.pinAdds).toEqual(['a']);
    expect(p.baseline[labelKey('a')]).toEqual(labelFp(3));
    expect(p.baseline[pinKey('a')]).toEqual(pinFp());
    expect(p.summary.labelsSet).toBe(1);
    expect(p.summary.pinsAdded).toBe(1);
  });
  it('相手が外した(記録にあり、相手に無く、こちらは変えていない)→ 外す', () => {
    const base = { a: { content: st(a).content, place: st(a).place }, [labelKey('a')]: labelFp(3), [pinKey('a')]: pinFp() };
    const p = planSyncImport(withMarks([], [], { localStates: [st(a), stFp(labelKey('a'), labelFp(3)), stFp(pinKey('a'), pinFp())], baseline: base }));
    expect(p.labelClears).toEqual(['a']);
    expect(p.pinRemoves).toEqual(['a']);
    expect(p.baseline[labelKey('a')]).toBeUndefined();
  });
  it('こちらだけの色は残す(相手へ送る)/ 相手のファイルが印を運んでいない(null)なら、こちらの印を消さない', () => {
    const base = { a: { content: st(a).content, place: st(a).place }, [labelKey('a')]: labelFp(3) };
    const local = [st(a), stFp(labelKey('a'), labelFp(3))];
    const old = planSyncImport(withMarks(null, null, { localStates: local, baseline: base }));
    expect(old.labelClears).toEqual([]); // 対照: 運んでいれば(上の test)外す
    expect(old.baseline[labelKey('a')]).toEqual(labelFp(3)); // 記録も持ち越す
    const mine = planSyncImport(withMarks([], [], { localStates: local, baseline: {} }));
    expect(mine.labelClears).toEqual([]);
    expect(mine.labelSets).toEqual([]);
  });
  it('両方で違う色: 番号の大きい方(相手が大きければ取り込む / こちらが大きければ残す)', () => {
    const base = { a: { content: st(a).content, place: st(a).place }, [labelKey('a')]: labelFp(1) };
    const local = [st(a), stFp(labelKey('a'), labelFp(2))];
    const takeRemote = planSyncImport(withMarks([{ lid: 'a', color: 5 }], [], { localStates: local, baseline: base, localLabelColors: new Map([['a', 2]]) }));
    expect(takeRemote.labelSets).toEqual([{ lid: 'a', color: 5 }]);
    expect(takeRemote.summary.labelConflicts).toBe(1);
    const keep = planSyncImport(withMarks([{ lid: 'a', color: 4 }], [], { localStates: [st(a), stFp(labelKey('a'), labelFp(7))], baseline: base, localLabelColors: new Map([['a', 7]]) }));
    expect(keep.labelSets).toEqual([]);
    expect(keep.summary.labelConflicts).toBe(1);
  });
  it('宛先のノートが取り込み後に生きていない印は付けない', () => {
    const i = input({ remoteNotes: [], localStates: [] });
    i.remote.container.labels = [{ lid: 'ghost', color: 2 }];
    i.remote.container.pins = ['ghost'];
    i.remote.container.fingerprints = [];
    const q = planSyncImport(i);
    expect(q.labelSets).toEqual([]);
    expect(q.pinAdds).toEqual([]);
    expect(q.baseline[labelKey('ghost')]).toBeUndefined();
  });
});
