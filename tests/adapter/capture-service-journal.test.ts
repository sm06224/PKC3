/** @vitest-environment happy-dom */
/**
 * 🔴 収録の途中保存と段取りのつなぎ(#1985 項目 2)。
 *
 * - 断片が置き場へ届く(最初の断片の待ち合わせは writer 側の test)
 * - 区間が添付になったら、その区間の控えが消える / 取り込めなければ残る
 * - 捨てたら残らない / 書けなくなったら帯に「途中保存できていません」が出て、収録は続く
 * - 250MB の区切り(partBytes)で区間が分かれても、区間ごとに消える
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { createCaptureService } from '../../src/adapter/ui/actions/capture';
import type { CaptureEnd, CaptureHandle, CaptureOptions } from '../../src/adapter/platform/media-capture';
import { MemoryJournalStore } from '../../src/adapter/platform/capture-journal-store';
import { createJournalWriter, type JournalWriter } from '../../src/features/capture/capture-journal-writer';

const meta = (lid: string): EntryMeta => ({
  lid,
  title: 't-' + lid,
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
});

function rig(o: { attachFails?: boolean; failChunk?: boolean; landed?: () => Promise<void>; noRead?: boolean; active?: boolean[] } = {}) {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  d.onEvent((e) => {
    if (e.type !== 'REQUEST_APPEND') return;
    const { lid, gen } = e;
    queueMicrotask(() =>
      d.dispatch({ type: 'ENTRY_APPENDED', lid, gen, body: 'b', status: null, date: null, archived: false, inserted: null }),
    );
  });
  const store = new MemoryJournalStore();
  if (o.failChunk === true) store.failChunk = new Error('quota');
  const lines: Array<string | null> = [];
  const notices: string[] = [];
  const writers: JournalWriter[] = [];
  const attachedSizes: number[] = [];
  let opts!: CaptureOptions;
  let parts = 0;
  let endCb: (r: CaptureEnd) => void = () => undefined;
  let finalBlob: Blob | null = new Blob(['zz']);
  const svc = createCaptureService({
    dispatcher: d,
    attach: async (item) => {
      if (o.attachFails === true) return null;
      attachedSizes.push(item.size);
      const lid = 'att' + item.name;
      d.dispatch({ type: 'CREATE_ENTRY', archetype: 'attachment', lid, title: item.name, body: '#\n', edit: false });
      return { lid, assetKey: 'k' + item.name, mime: item.type, hash: null };
    },
    ...(o.landed === undefined ? {} : { landed: o.landed }),
    onChange: (l) => lines.push(l),
    notify: (t) => notices.push(t),
    notifyOpen: (t) => notices.push(t),
    now: () => new Date(2026, 10, 20, 1, 2, 3),
    tick: () => () => undefined,
    ...(o.active === undefined ? {} : { onActive: (a: boolean) => o.active!.push(a) }),
    // 🔴 控えから読み戻す口(main.ts と同じ: 断片をつなぐ)
    ...(o.noRead === true
      ? {}
      : {
          readJournal: async (rec: string, seg: number) => {
            const cs = await store.readSegment(rec, seg);
            return cs.length === 0 ? null : new Blob(cs.map((c) => c.blob), { type: 'audio/webm' });
          },
        }),
    journal: (m, onState) => {
      const w = createJournalWriter(store, m, { onState: () => onState() });
      writers.push(w);
      return w;
    },
    start: async (kind, _c, op) => {
      opts = op;
      endCb = (r) => op.onEnd?.(r);
      const h: CaptureHandle = {
        kind,
        bytes: () => 0,
        parts: () => parts,
        elapsedMs: () => 5000,
        stop: () => {
          op.onEnd?.('stopped');
          return Promise.resolve(finalBlob);
        },
        discard: () => op.onEnd?.('discarded'),
      };
      return h;
    },
  });
  const chunk = (segment: number, index: number, size = 3): void =>
    opts.onChunk?.({ segment, index, elapsedMs: (index + 1) * 1000, blob: new Blob(['x'.repeat(size)]) });
  return {
    d, svc, store, attachedSizes, lines, notices, writers, chunk,
    cut: (b: Blob) => {
      parts += 1;
      opts.onPart?.(b, parts);
    },
    end: (r: CaptureEnd) => endCb(r),
    setFinal: (b: Blob | null) => {
      finalBlob = b;
    },
    flush: async () => {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 0));
        await Promise.all(writers.map((w) => w.settled()));
      }
    },
  };
}

describe('途中保存と取り込み', () => {
  it('🔴 断片が置き場へ届き、身元に「録り始めたノート」が入る', async () => {
    const r = rig();
    await r.svc.start('audio');
    r.chunk(0, 0);
    r.chunk(0, 1);
    await r.flush();
    expect(r.store.chunks.size).toBe(2);
    expect([...r.store.metas.values()][0]).toMatchObject({ kind: 'audio', startedLid: 'a' });
  });

  it('🔴 止めて添付になったら、控えが消える(身元ごと)', async () => {
    const r = rig();
    await r.svc.start('audio');
    r.chunk(0, 0);
    r.svc.stop();
    await r.flush();
    expect(r.store.chunks.size).toBe(0);
    expect(r.store.metas.size).toBe(0);
  });

  it('🔴 添付にできなかった収録の控えは残る(復元できる)', async () => {
    const r = rig({ attachFails: true });
    await r.svc.start('audio');
    r.chunk(0, 0);
    r.svc.stop();
    await r.flush();
    expect(r.store.chunks.size).toBe(1);
    expect(r.store.metas.size).toBe(1);
  });

  it('🔴 区切り(onPart)で分かれた区間は、区間ごとに消える', async () => {
    const r = rig();
    await r.svc.start('audio');
    r.chunk(0, 0);
    r.chunk(0, 1);
    r.cut(new Blob(['seg0']));
    r.chunk(1, 0);
    await r.flush();
    // 区間 0 は添付になり消え、区間 1(録っている最中)は残る
    expect([...r.store.chunks.values()].map((c) => c.seg)).toEqual([1]);
    expect(r.store.metas.size).toBe(1);
    r.svc.stop();
    await r.flush();
    expect(r.store.chunks.size).toBe(0);
    expect(r.store.metas.size).toBe(0);
  });

  it('🔴 捨てたら控えも残らない', async () => {
    const r = rig();
    await r.svc.start('audio');
    r.chunk(0, 0);
    await r.svc.discard();
    await r.flush();
    expect(r.store.chunks.size).toBe(0);
    expect(r.store.metas.size).toBe(0);
  });

  it('🔴 編集中は預かる間、控えを残し、編集が終わって取り込んだら消える(項目 1 の継ぎ目)', async () => {
    const r = rig();
    await r.svc.start('audio');
    r.chunk(0, 0);
    r.d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '本文' });
    r.d.dispatch({ type: 'START_EDIT' });
    r.svc.stop();
    await r.flush();
    expect(r.d.getState().phase).toBe('editing');
    expect(r.store.chunks.size, '預かっている間は控えが要る').toBe(1);
    r.d.dispatch({ type: 'CANCEL_EDIT' });
    await r.flush();
    expect(r.store.chunks.size).toBe(0);
  });
});

describe('編集中に止めた収録は、控えに書けていればメモリに持たない(#1985 項目 1 の継ぎ目)', () => {
  const startEditing = (r: ReturnType<typeof rig>): void => {
    r.d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: '本文' });
    r.d.dispatch({ type: 'START_EDIT' });
  };

  it('🔴 手放して控えから取り込む: 預かり中は「メモリ上にだけ」に数えず、編集後に添付になる', async () => {
    const active: boolean[] = [];
    const r = rig({ active });
    await r.svc.start('audio');
    expect(active).toEqual([true]);
    r.chunk(0, 0);
    r.chunk(0, 1);
    startEditing(r);
    // 預かるのはメモリの Blob(`finalBlob`)ではなく控え ── 止めた Blob を空にしても控えから入る
    r.setFinal(new Blob(['MEM']));
    r.svc.stop();
    await r.flush();
    expect(active.at(-1), '控えに在るのに「メモリ上にだけ在る」に数えている').toBe(false);
    expect(r.notices.join('\n')).toContain('途中保存に残してある');
    expect(r.store.chunks.size, '預かっている間は控えを消さない').toBe(2);
    r.d.dispatch({ type: 'CANCEL_EDIT' });
    await r.flush();
    const att = [...r.d.getState().entryMetas.values()].filter((m) => m.archetype === 'attachment');
    expect(att.length, '編集が終わっても添付にならない').toBe(1);
    expect(r.store.chunks.size, '着地後に控えが消えていない').toBe(0);
  });

  it('🔴 控えから入れる中身は、控えの断片をつないだもの(メモリの Blob ではない)', async () => {
    const r = rig();
    await r.svc.start('audio');
    r.chunk(0, 0, 4);
    r.chunk(0, 1, 5);
    startEditing(r);
    r.setFinal(new Blob(['X']));
    r.svc.stop();
    await r.flush();
    r.d.dispatch({ type: 'CANCEL_EDIT' });
    await r.flush();
    expect(r.attachedSizes, '控えの 4 + 5 バイトのはず(メモリの 1 バイトではない)').toEqual([9]);
  });

  it('🔴 控えが欠けた収録は、これまでどおりメモリで預かる(数える・一言)', async () => {
    const active: boolean[] = [];
    const r = rig({ failChunk: true, active });
    await r.svc.start('audio');
    r.chunk(0, 0);
    r.chunk(0, 1);
    await r.flush();
    startEditing(r);
    r.svc.stop();
    await r.flush();
    expect(active.at(-1), '欠けた控えなのにメモリの預かりを数えていない').toBe(true);
    expect(r.notices.join('\n')).toContain('途中保存が欠けている');
    r.d.dispatch({ type: 'CANCEL_EDIT' });
    await r.flush();
    const att = [...r.d.getState().entryMetas.values()].filter((m) => m.archetype === 'attachment');
    expect(att.length, 'メモリの預かりが入っていない').toBe(1);
    expect(active.at(-1)).toBe(false);
  });

  it('🔴 読み戻す口が無ければ、メモリで預かる', async () => {
    const active: boolean[] = [];
    const r = rig({ noRead: true, active });
    await r.svc.start('audio');
    r.chunk(0, 0);
    startEditing(r);
    r.svc.stop();
    await r.flush();
    expect(active.at(-1)).toBe(true);
  });

  it('🔴 控えから読み出せなかったら控えを残し、言う(次の起動で復元できる)', async () => {
    const r = rig();
    await r.svc.start('audio');
    r.chunk(0, 0);
    await r.flush();
    startEditing(r);
    r.svc.stop();
    await r.flush();
    r.store.chunks.clear(); // 読み戻す前に控えが消えた
    r.d.dispatch({ type: 'CANCEL_EDIT' });
    await r.flush();
    expect(r.notices.join('\n')).toContain('途中保存から読み出せませんでした');
    expect([...r.d.getState().entryMetas.values()].filter((m) => m.archetype === 'attachment').length).toBe(0);
  });

  it('🔴 着地前に控えを消さない(編集後の取り込みも landed を待つ)', async () => {
    let land!: () => void;
    const gate = new Promise<void>((res) => (land = res));
    const r = rig({ landed: () => gate });
    await r.svc.start('audio');
    r.chunk(0, 0);
    startEditing(r);
    r.svc.stop();
    await r.flush();
    r.d.dispatch({ type: 'CANCEL_EDIT' });
    await r.flush();
    expect([...r.d.getState().entryMetas.values()].filter((m) => m.archetype === 'attachment').length).toBe(1);
    expect(r.store.chunks.size, '着地前に控えが消えた').toBe(1);
    land();
    await r.flush();
    expect(r.store.chunks.size).toBe(0);
  });

  it('🔴 区切り(onPart)の区間も、編集中は控えから預かる', async () => {
    const r = rig();
    await r.svc.start('audio');
    r.chunk(0, 0);
    startEditing(r);
    r.cut(new Blob(['seg0']));
    await r.flush();
    expect(r.store.chunks.size, '区間 0 の控えを消している').toBe(1);
    r.d.dispatch({ type: 'CANCEL_EDIT' });
    await r.flush();
    expect(r.store.chunks.size).toBe(0);
  });
});

describe('控えを消す順序(書込の着地)', () => {
  it('🔴 ノート + 添付の書込が着地するまで控えは残り、着地したら消える', async () => {
    let land!: () => void;
    const gate = new Promise<void>((res) => (land = res));
    const r = rig({ landed: () => gate });
    await r.svc.start('audio');
    r.chunk(0, 0);
    r.svc.stop();
    await r.flush();
    expect(r.d.getState().entryMetas.size, '添付はもうできている').toBeGreaterThan(1);
    expect(r.store.chunks.size, '着地前は控えが要る').toBe(1);
    expect(r.store.metas.size).toBe(1);
    land();
    await r.flush();
    expect(r.store.chunks.size).toBe(0);
    expect(r.store.metas.size).toBe(0);
  });

  it('🔴 着地を待つのが失敗したら控えは残す(次の起動で復元できる)', async () => {
    const r = rig({ landed: () => Promise.reject(new Error('io')) });
    await r.svc.start('audio');
    r.chunk(0, 0);
    r.svc.stop();
    await r.flush();
    expect(r.store.chunks.size).toBe(1);
  });
});

describe('守られていないときの見え方', () => {
  it('🔴 書けなくても収録は続き、帯に「途中保存できていません」が出る / 知らせは 1 度', async () => {
    const r = rig({ failChunk: true });
    await r.svc.start('audio');
    expect(r.svc.line()).not.toContain('途中保存できていません');
    r.chunk(0, 0);
    r.chunk(0, 1);
    await r.flush();
    expect(r.svc.line()).toContain('途中保存できていません');
    expect(r.notices.filter((n) => n.includes('途中保存に失敗しました'))).toHaveLength(1);
    // 録るのは止まっていない
    expect(r.svc.line()).not.toBeNull();
  });

  it('対照群: 書けているあいだは帯に出ない', async () => {
    const r = rig();
    await r.svc.start('audio');
    r.chunk(0, 0);
    await r.flush();
    expect(r.svc.line()).not.toContain('途中保存');
  });
});

describe('復元の入口(deliverRecovered)', () => {
  it('入り先のノートへ添付として入り、done が呼ばれる', async () => {
    const r = rig();
    let done = 0;
    const res = await r.svc.deliverRecovered(new Blob(['x'], { type: 'audio/webm' }), 'audio', null, new Date(2026, 10, 1), 'a', () => done++);
    expect(res).toBe('in');
    expect(done).toBe(1);
  });
  it('添付にできなければ done は呼ばれない', async () => {
    const r = rig({ attachFails: true });
    let done = 0;
    const res = await r.svc.deliverRecovered(new Blob(['x'], { type: 'audio/webm' }), 'audio', null, new Date(), 'a', () => done++);
    expect(res).toBe('failed');
    expect(done).toBe(0);
  });
});
