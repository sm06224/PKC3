/**
 * 🔴 端末間の同期(#2000 段 2)── 取り込みの計画(`planSyncImport`)・書き出しの決め(`planExport`)・差分ファイルの読み書き。
 * 実物の DB を通す往復は `tests/adapter/sync-diff-roundtrip.test.ts`。ここは判定の枝を 1 つずつ見る。
 */
import { describe, expect, it } from 'vitest';
import { relationKey, type KeyedState } from '../../../src/features/sync/change-set';
import { entryFp, labelFp, pinFp, placeFp, relationFp } from '../../../src/features/sync/sync-fp';
import { DIFF_FORMAT, readDiffZip, writeDiffZip, type DiffNote } from '../../../src/features/sync/diff-file';
import { fingerprintDigest, isStaleBase, planExport, planFolderExport } from '../../../src/features/sync/sync-export';
import { conflictCopyTitle, effectiveBaseline, planSyncImport, type PlanInput } from '../../../src/features/sync/sync-plan';
import { TOMBSTONE_MAX } from '../../../src/features/sync/sync-state';

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
      container: { notes: bodies, relations: [], tombstones: [], fingerprints: fpList(all.map(st)), peerBase: [], assets: [] },
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

describe('planSyncImport: 色ラベル・ピン留め(ノートの生き死にとの組み合わせ)', () => {
  it('相手がゴミ箱へ入れ、こちらが編集して残したノート: 印を外さず、前回の合意を記録に持ち越す', () => {
    const base = note('a', '日本語の題名', '初稿');
    const edited = note('a', '日本語の題名', 'こちらの編集');
    const lab = { key: 'lab:a', ...labelFp(3) };
    const pin = { key: 'pin:a', ...pinFp() };
    const baseline = { a: { content: st(base).content, place: st(base).place }, 'lab:a': { content: lab.content }, 'pin:a': { content: pin.content } };
    const i = input({ localStates: [st(edited), lab, pin], baseline });
    const remote = { ...i.remote, container: { ...i.remote.container, labels: [], pins: [] } };
    const p = planSyncImport({ ...i, remote });
    expect(p.upserts.map((u) => u.lid), '対照群: ノートはこちらの編集で残る(ゴミ箱へ行かない)').not.toContain('a');
    expect(p.labelSets, '色を外さない').toEqual([]);
    expect(p.pinSets, 'ピンを外さない').toEqual([]);
    expect(p.baseline['lab:a'], '色の合意を持ち越す').toEqual({ content: lab.content });
    expect(p.baseline['pin:a'], 'ピンの合意を持ち越す').toEqual({ content: pin.content });
  });

  it('対照群: 相手にノートが居て印だけ外した → こちらの印も外す', () => {
    const base = note('a', '日本語の題名', '初稿');
    const lab = { key: 'lab:a', ...labelFp(3) };
    const baseline = { a: { content: st(base).content, place: st(base).place }, 'lab:a': { content: lab.content } };
    const i = input({ remoteNotes: [base], localStates: [st(base), lab], baseline });
    const remote = { ...i.remote, container: { ...i.remote.container, labels: [], pins: [] } };
    const p = planSyncImport({ ...i, remote });
    expect(p.labelSets).toEqual([{ lid: 'a', color: null }]);
  });

  it('対照群: 変わっていないノートが目録(指紋)にだけ居て本体が無い形でも、印だけ外したなら外す', () => {
    const base = note('a', '日本語の題名', '初稿');
    const lab = { key: 'lab:a', ...labelFp(3) };
    const baseline = { a: { content: st(base).content, place: st(base).place }, 'lab:a': { content: lab.content } };
    const i = input({ remoteNotes: [], remoteFps: [base], localStates: [st(base), lab], baseline });
    const remote = { ...i.remote, container: { ...i.remote.container, labels: [], pins: [] } };
    expect(remote.container.notes, '対照群: 本体は運ばれていない').toEqual([]);
    const p = planSyncImport({ ...i, remote });
    expect(p.labelSets).toEqual([{ lid: 'a', color: null }]);
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

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 選択同期(#2066 段 5-A)── 送信の隔離 / 選択を外すのは削除ではない / バージョン / 受け手の保護
// ─────────────────────────────────────────────────────────────────────────────

describe('選択同期: 書き出しの隔離(planExport / planFolderExport)', () => {
  const NOW = Date.parse('2026-11-21T00:00:00Z');
  const a = st(note('a', '共有', 'A'));
  const b = st(note('b', '共有2', 'B'));
  const p = st(note('p', '私的なメモ', 'P'));
  const q = st(note('q', '前に共有していた', 'Q'));
  const relAB = { key: relationKey({ from: 'a', to: 'b', kind: 'semantic' }), ...relationFp() };
  const relAP = { key: relationKey({ from: 'a', to: 'p', kind: 'semantic' }), ...relationFp() };
  const labA = { key: 'lab:a', ...labelFp(2) };
  const labP = { key: 'lab:p', ...labelFp(3) };
  const pinP = { key: 'pin:p', ...pinFp() };
  const states = [a, b, p, q, relAB, relAP, labA, labP, pinP];
  const all = new Set(states.map((s) => s.key));
  const S = new Set(['a', 'b']);
  const fpOf = (s: KeyedState) => ({ content: s.content, ...(s.place === undefined ? {} : { place: s.place }) });
  // 相手との記録: 前は全部を同期していた(q・p も相手に在る)。gone は本当に消した
  const peerBase = { a: fpOf(a), p: fpOf(p), q: fpOf(q), gone: { content: 'g', place: 'x' }, [relAP.key]: fpOf(relAP) };
  const tombPrivate = { key: 'never-shared', lastFp: { content: 'secret', place: 'x' }, device: DEV, seq: 3 };
  const tombShared = { key: 'gone2', lastFp: { content: 'g2', place: 'x' }, device: DEV, seq: 4 };
  const sel = { selectedLids: S, allLiveKeys: all };

  it('🔴 不変条件 1: 指紋・ノート・削除の記録は選択の中だけ(選択の外のノート・つながり・印・私的な削除の記録は 1 件も出ない)', () => {
    const plan = planExport({ device: DEV, seq: 9, states, tombstones: [tombPrivate, tombShared], nowMs: NOW, all: true, peer: null, selective: sel });
    expect(plan.scope).toBe('selective');
    expect(plan.fingerprints.map((f) => f.key)).toEqual(['a', 'b', 'lab:a', relAB.key]);
    expect(plan.noteLids).toEqual(['a', 'b']);
    // 相手が無い全件: 削除の記録は、相手との記録にも選択にも関わらない物を運ばない
    expect(plan.tombstones).toEqual([]);
    // 対照(空振りでない): 選択同期でなければ全部出る
    const ctl = planExport({ device: DEV, seq: 9, states, tombstones: [tombPrivate, tombShared], nowMs: NOW, all: true, peer: null });
    expect(ctl.scope).toBe('all');
    expect(ctl.fingerprints.map((f) => f.key)).toContain('p');
    expect(ctl.tombstones.map((t) => t.key).sort()).toEqual(['gone2', 'never-shared']);
  });

  it('🔴 不変条件 2: 前回同期したノートを選択から外しても削除の記録は 0 件。本当に消した物だけが運ばれる', () => {
    const peer = { baseline: peerBase, at: '2026-11-20T00:00:00Z' };
    const plan = planExport({ device: DEV, seq: 9, states, tombstones: [tombPrivate, tombShared], nowMs: NOW, all: false, peer, selective: sel });
    expect(plan.complete).toBe(false);
    const keys = plan.tombstones.map((t) => t.key).sort();
    expect(keys, '選択から外しただけ(p・q はこちらで生きている)の物が削除の記録になった').not.toContain('p');
    expect(keys).not.toContain('q');
    expect(keys).not.toContain(relAP.key);
    expect(keys, '私的なノートの削除の記録が漏れた').not.toContain('never-shared');
    expect(keys, '相手も持っていた物を本当に消した記録は運ぶ').toEqual(['gone']);
    expect(plan.noteLids).toEqual(['b']); // a は記録と同じ・b は追加
    // 外したノートを本当に消したら(生きていない)、そのときは削除の記録が運ばれる
    const after = planExport({
      device: DEV,
      seq: 10,
      states: states.filter((s) => s.key !== 'q'),
      tombstones: [],
      nowMs: NOW,
      all: false,
      peer,
      selective: { selectedLids: S, allLiveKeys: new Set([...all].filter((k) => k !== 'q')) },
    });
    expect(after.tombstones.map((t) => t.key).sort()).toEqual(['gone', 'q']);
    // 直接指定していた物(sharedKeys)の削除の記録は、相手との記録が無くても運ぶ
    const shared = planExport({ device: DEV, seq: 9, states, tombstones: [tombPrivate], nowMs: NOW, all: true, peer: null, selective: { ...sel, sharedKeys: new Set(['never-shared']) } });
    expect(shared.tombstones.map((t) => t.key)).toEqual(['never-shared']);
  });

  it('🔴 相手との記録が無くても、選択のフォルダの中で本当に消したノートの削除の記録は運ぶ(外のフォルダで消した物は運ばない)', () => {
    const inF = { key: 'deleted-in-F', lastFp: { content: 'c1', place: placeFp('F') }, device: DEV, seq: 5 };
    const inOther = { key: 'deleted-in-G', lastFp: { content: 'c2', place: placeFp('G') }, device: DEV, seq: 6 };
    const atRoot = { key: 'deleted-at-root', lastFp: { content: 'c3', place: placeFp(null) }, device: DEV, seq: 7 };
    const plan = planExport({
      device: DEV,
      seq: 9,
      states,
      tombstones: [inF, inOther, atRoot],
      nowMs: NOW,
      all: true,
      peer: null,
      selective: { ...sel, scopeParents: new Set(['F', 'a']) },
    });
    expect(plan.tombstones.map((t) => t.key)).toEqual(['deleted-in-F']);
    // 対照: 起点の集合が無ければ運ばない(この経路が効いている)
    expect(planExport({ device: DEV, seq: 9, states, tombstones: [inF], nowMs: NOW, all: true, peer: null, selective: sel }).tombstones).toEqual([]);
  });

  it('同期フォルダ: 隔離・外しただけは削除でない・選択を変えたら書き直しの要約が変わる', () => {
    const base = {
      device: DEV,
      seq: 9,
      states,
      tombstones: [tombPrivate],
      bases: { fedcba9876543210: { baseline: peerBase, at: '2026-11-20T00:00:00Z' } },
      others: ['fedcba9876543210'],
      wantedBy: [],
      ownFilePresent: true,
      nowMs: NOW,
    };
    const f = planFolderExport({ ...base, selective: sel });
    expect(f.scope).toBe('selective');
    expect(f.fingerprints.map((x) => x.key)).toEqual(['a', 'b', 'lab:a', relAB.key]);
    expect(f.tombstones.map((t) => t.key)).toEqual(['gone']);
    expect(f.noteLids).toEqual(['b']);
    // 指紋が同じでも、選択の集合が変われば書き直す(ghost = 生きていない lid を選択に足しただけ)
    const g = planFolderExport({ ...base, selective: { selectedLids: new Set([...S, 'ghost']), allLiveKeys: all } });
    expect(g.fingerprints).toEqual(f.fingerprints);
    expect(g.writeKey).not.toBe(f.writeKey);
    // 全部のとき・選択同期のときで要約は別
    const allPlan = planFolderExport(base);
    expect(allPlan.scope).toBe('all');
    expect(allPlan.writeKey).not.toBe(f.writeKey);
    expect(allPlan.tombstones.map((t) => t.key).sort()).toEqual(['gone', 'never-shared']);
  });
});

describe('選択同期: 差分ファイルのバージョン(不変条件 3)', () => {
  const n = note('a', '日本語', '本文');
  async function zipOf(scope?: 'all' | 'selective'): Promise<Blob> {
    const out = await writeDiffZip({
      manifest: { exported_at: '2026-11-21T00:00:00Z', device: DEV, seq: 3, cid: 'c-x', title: 'T', complete: true, ...(scope === undefined ? {} : { scope }) },
      notes: (async function* () {
        yield n;
      })(),
      relations: [],
      tombstones: [],
      fingerprints: fpList([st(n)]),
      peerBase: [],
      labels: [],
      pins: [],
      assets: () => [],
      getAssetBlob: async () => null,
    });
    return out.blob;
  }
  async function rawManifest(zip: Blob): Promise<Record<string, unknown>> {
    const { readZipDirectory, readZipText, unwrapSingleTopDir } = await import('../../../src/features/import/zip-reader');
    const dir = unwrapSingleTopDir(await readZipDirectory(zip)).entries;
    return JSON.parse(await readZipText(zip, dir.find((e) => e.name === 'manifest.json')!)) as Record<string, unknown>;
  }
  /** manifest だけを差し替えた zip(読む側の門を見る)。 */
  async function craft(manifest: Record<string, unknown>): Promise<Blob> {
    const { ZipWriter } = await import('../../../src/features/export/zip-writer');
    const w = new ZipWriter();
    await w.add('manifest.json', [JSON.stringify(manifest)]);
    await w.add('container.json', [JSON.stringify({ notes: [], relations: [], tombstones: [], fingerprints: [], peerBase: [], assets: [], labels: [], pins: [] })]);
    return w.finish();
  }
  const head = { format: DIFF_FORMAT, exported_at: '', device: DEV, seq: 1, cid: 'c', title: 't', complete: true };

  it("🔴 'selective' はバージョン 3 + scope / 'all'・省略はバージョン 2 で scope を書かない(v3.9.0 が読める形のまま)", async () => {
    const s = await rawManifest(await zipOf('selective'));
    expect(s.version).toBe(3);
    expect(s.scope).toBe('selective');
    for (const z of [await zipOf('all'), await zipOf()]) {
      const m = await rawManifest(z);
      expect(m.version).toBe(2);
      expect('scope' in m, 'all のファイルに scope が書かれた').toBe(false);
    }
    // v3.9.0 が読めたバージョン(1・2)に 3 は無い = 古い PKC3 は選択同期のファイルを断る
    expect([1, 2]).not.toContain(s.version);
    expect((await readDiffZip(await zipOf('selective'))).manifest.scope).toBe('selective');
    expect((await readDiffZip(await zipOf())).manifest.scope).toBe('all');
  });

  it('読む側: バージョン 3 の scope は all / selective だけ(無い・違う値は断る)。2 以下は scope を書いてあっても全件', async () => {
    await expect(readDiffZip(await craft({ ...head, version: 3, scope: 'partial' }))).rejects.toThrow('運ぶ範囲');
    await expect(readDiffZip(await craft({ ...head, version: 3 }))).rejects.toThrow('運ぶ範囲');
    expect((await readDiffZip(await craft({ ...head, version: 3, scope: 'all' }))).manifest.scope).toBe('all');
    expect((await readDiffZip(await craft({ ...head, version: 2, scope: 'selective' }))).manifest.scope).toBe('all');
    await expect(readDiffZip(await craft({ ...head, version: 4, scope: 'selective' }))).rejects.toThrow('バージョン');
  });
});

describe('選択同期: 受け手(planSyncImport)', () => {
  const a0 = note('a', 'A', '初稿');
  const p0 = note('p', 'P', '初稿');
  const fpOf = (n: DiffNote) => ({ content: st(n).content, place: st(n).place });
  const rel = (from: string, to: string) => relationKey({ from, to, kind: 'semantic' });
  const remoteSel = (inp: PlanInput, scope: 'all' | 'selective' = 'selective'): PlanInput => ({ ...inp, remote: { ...inp.remote, manifest: { ...inp.remote.manifest, version: scope === 'selective' ? 3 : 2, scope } } });

  it('🔴 不変条件 3: 相手が選択同期なら、相手の一覧に無いノートを消えたと見なさない(対照: 全部のファイルではゴミ箱へ)', () => {
    const inp = input({ remoteNotes: [a0], localStates: [st(a0), st(p0)], baseline: { a: fpOf(a0), p: fpOf(p0) } });
    const sel = planSyncImport(remoteSel(inp));
    expect(sel.trash).toEqual([]);
    expect(sel.baseline.p, '記録から p を落とした').toEqual(fpOf(p0));
    const ctl = planSyncImport(remoteSel(inp, 'all'));
    expect(ctl.trash).toEqual(['p']);
  });

  it('相手が選択同期でも、削除の記録で届いた物はゴミ箱へ・両端が載っているつながりの消失は外す(片端が載っていなければ触らない)', () => {
    const base = { a: fpOf(a0), p: fpOf(p0), b: fpOf(note('b', 'B', 'b')), [rel('a', 'b')]: relationFp(), [rel('a', 'p')]: relationFp() };
    const inp = remoteSel(
      input({
        remoteNotes: [a0, note('b', 'B', 'b')],
        localStates: [st(a0), st(p0), st(note('b', 'B', 'b')), { key: rel('a', 'b'), ...relationFp() }, { key: rel('a', 'p'), ...relationFp() }],
        localRelations: [
          { from: 'a', to: 'b', kind: 'semantic' },
          { from: 'a', to: 'p', kind: 'semantic' },
        ],
        baseline: base,
      }),
    );
    inp.remote.container.tombstones.push({ key: 'p', lastFp: fpOf(p0), device: DEV, seq: 5 });
    const plan = planSyncImport(inp);
    expect(plan.trash).toEqual(['p']);
    expect(plan.relationRemoves).toEqual([{ from: 'a', to: 'b', kind: 'semantic' }]);
  });

  it('相手が選択同期で、両端が載っているつながりが残っていれば何もしない(外した判定の空振りの対照)', () => {
    const b0 = note('b', 'B', 'b');
    const inp = remoteSel(
      input({
        remoteNotes: [a0, b0],
        localStates: [st(a0), st(b0), { key: rel('a', 'b'), ...relationFp() }],
        localRelations: [{ from: 'a', to: 'b', kind: 'semantic' }],
        baseline: { a: fpOf(a0), b: fpOf(b0), [rel('a', 'b')]: relationFp() },
      }),
    );
    inp.remote.container.relations.push({ from: 'a', to: 'b', kind: 'semantic' });
    expect(planSyncImport(inp).relationRemoves).toEqual([]);
  });

  it('🔴 不変条件 4 ①: こちらが選択同期なら、こちらの選択の外のノートへの相手の変更・削除・印・つながりは反映しない(原本と記録を守る)', () => {
    const remoteA = note('a', 'A', '相手の編集');
    const remoteP = note('p', 'P', '相手が私的なメモを書き換えた');
    const base = { a: fpOf(a0), p: fpOf(p0) };
    const inp = input({
      remoteNotes: [remoteA, remoteP],
      localStates: [st(a0), st(p0)],
      baseline: base,
      localSelective: { selectedLids: new Set(['a']), directAndDescendantLids: new Set(['a']) },
    });
    inp.remote.container.labels = [{ lid: 'p', color: 3 }];
    inp.remote.container.pins = ['p'];
    inp.remote.container.relations.push({ from: 'a', to: 'p', kind: 'semantic' });
    inp.remote.container.fingerprints.push({ key: rel('a', 'p'), c: relationFp().content });
    const plan = planSyncImport(inp);
    expect(plan.upserts.map((u) => u.lid)).toEqual(['a']);
    expect(plan.labelSets).toEqual([]);
    expect(plan.pinSets).toEqual([]);
    expect(plan.relationAdds).toEqual([]);
    expect(plan.summary.skippedUnselected).toBe(4); // p の本文・色ラベル・ピン留め・p へのつながり
    expect(plan.baseline.p, 'p の記録が書き換わった').toEqual(base.p);
    // 対照: 選択同期でなければ全部反映する
    const ctl = planSyncImport({ ...inp, localSelective: undefined });
    expect(ctl.upserts.map((u) => u.lid).sort()).toEqual(['a', 'p']);
    expect(ctl.summary.skippedUnselected).toBe(0);
    // 削除: 相手が p を消しても、こちらの選択の外ならゴミ箱へ移さない
    const del = input({ remoteNotes: [a0], localStates: [st(a0), st(p0)], baseline: base, localSelective: { selectedLids: new Set(['a']), directAndDescendantLids: new Set(['a']) } });
    del.remote.container.tombstones.push({ key: 'p', lastFp: base.p, device: DEV, seq: 2 });
    const d = planSyncImport(del);
    expect(d.trash).toEqual([]);
    expect(d.summary.skippedUnselected).toBe(1);
    expect(planSyncImport({ ...del, localSelective: undefined }).trash).toEqual(['p']);
  });

  it('🔴 不変条件 4 ②: 新しく入るノートを直接指定に足す(親がこちらの対象の下・今回入る新しいフォルダの下なら足さない)', () => {
    const F = { lid: 'F', title: 'F', archetype: 'folder', body: '', parentLid: null };
    const G = { lid: 'G', title: 'G', archetype: 'folder', body: '', parentLid: 'outsideFolder' };
    const inp = input({
      remoteNotes: [note('n1', 'ルート直下', 'x'), note('n2', '対象のフォルダの下', 'x', 'F'), G, note('g1', '新しいフォルダの下', 'x', 'G')],
      localStates: [st(F as DiffNote), { key: 'outsideFolder', ...entryFp({ title: 'O', archetype: 'folder', parentLid: null, body: '' }) }],
      localSelective: { selectedLids: new Set(['F']), directAndDescendantLids: new Set(['F']) },
    });
    const plan = planSyncImport(inp);
    expect(plan.upserts.filter((u) => !u.existed).map((u) => u.lid).sort()).toEqual(['G', 'g1', 'n1', 'n2']);
    expect(plan.selectiveSelectAdds).toEqual(['G', 'n1']);
    // 対照: こちらが全部のときは足さない
    expect(planSyncImport({ ...inp, localSelective: undefined }).selectiveSelectAdds).toEqual([]);
  });
});
