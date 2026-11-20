/** @vitest-environment happy-dom */
/**
 * 🔴 途中で終わった録音・録画の復元(#1985 項目 2)。起動の調べ → メッセージ + 状態の行 → 復元する / 破棄する。
 */
import { describe, expect, it } from 'vitest';
import { createCaptureRecovery } from '../../src/adapter/ui/actions/capture-recovery';
import { MemoryJournalStore } from '../../src/adapter/platform/capture-journal-store';
import { paintStatusCaptureRecovery } from '../../src/adapter/ui/render/status-open';

async function seed(store: MemoryJournalStore, rec = 'r1', over: { startedLid?: string | null; cid?: string } = {}) {
  await store.putMeta({
    id: rec,
    kind: 'audio',
    startedLid: over.startedLid === undefined ? 'n1' : over.startedLid,
    startedAt: Date.UTC(2026, 10, 20),
    ...(over.cid === undefined ? {} : { cid: over.cid }),
  });
  for (let i = 0; i < 3; i++) {
    await store.putChunk({ rec, seg: 0, idx: i, elapsedMs: (i + 1) * 1000, blob: new Blob(['ab'], { type: 'audio/webm;codecs=opus' }) });
  }
}

function rig(store: MemoryJournalStore, o: { answers?: boolean[]; deliver?: 'in' | 'held' | 'failed'; live?: string[]; cid?: string; seen?: { get(): string | null; set(s: string): void } } = {}) {
  const heldDone: Array<() => void> = [];
  const posts: string[] = [];
  const counts: number[] = [];
  const notices: string[] = [];
  const asked: string[] = [];
  const delivered: Array<{ blob: Blob; part: number | null; home: string | null; at: Date }> = [];
  const answers = [...(o.answers ?? [])];
  const withDur: number[] = [];
  const rec = createCaptureRecovery({
    store,
    ...(o.cid === undefined ? {} : { cid: o.cid }),
    liveIds: async () => new Set(o.live ?? []),
    service: {
      deliverRecovered: async (blob, _kind, part, at, home, done) => {
        delivered.push({ blob, part, home, at });
        const r = o.deliver ?? 'in';
        if (r === 'held') heldDone.push(done);
        else if (r !== 'failed') done();
        return r;
      },
    },
    post: (t) => posts.push(t),
    confirm: async (m) => {
      asked.push(m);
      return answers.shift() ?? false;
    },
    notify: (t) => notices.push(t),
    onChange: (n) => counts.push(n),
    ...(o.seen === undefined ? {} : { seen: o.seen }),
    withDuration: async (b, ms) => {
      withDur.push(ms);
      return b;
    },
  });
  return { rec, posts, counts, notices, asked, delivered, withDur, heldDone };
}

const settle = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0));

describe('起動の調べ', () => {
  it('🔴 復元できる区間があれば、システムのメッセージを 1 件残し、数を知らせる', async () => {
    const store = new MemoryJournalStore();
    await seed(store);
    const t = rig(store);
    expect(await t.rec.scan()).toBe(1);
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0]).toContain('復元する');
    expect(t.counts.at(-1)).toBe(1);
  });

  it('🔴 何も無ければメッセージも状態の行も出ない(0 件)', async () => {
    const t = rig(new MemoryJournalStore());
    expect(await t.rec.scan()).toBe(0);
    expect(t.posts).toEqual([]);
    expect(t.counts.at(-1)).toBe(0);
  });

  it('別のタブがいま録っている収録は出さない', async () => {
    const store = new MemoryJournalStore();
    await seed(store, 'live1');
    const t = rig(store, { live: ['live1'] });
    expect(await t.rec.scan()).toBe(0);
    expect(store.chunks.size, '録っている最中の控えを消した').toBe(3);
  });

  it('別の保存先の収録は出さず、触らない', async () => {
    const store = new MemoryJournalStore();
    await seed(store, 'other', { cid: 'c-other' });
    const t = rig(store, { cid: 'c1' });
    expect(await t.rec.scan()).toBe(0);
    expect(store.chunks.size).toBe(3);
  });

  it('復元できない控え(0 番が無い)と空の身元は掃除する', async () => {
    const store = new MemoryJournalStore();
    await store.putMeta({ id: 'bad', kind: 'audio', startedLid: null, startedAt: 1 });
    await store.putChunk({ rec: 'bad', seg: 0, idx: 1, elapsedMs: 1, blob: new Blob(['x']) });
    await store.putMeta({ id: 'empty', kind: 'audio', startedLid: null, startedAt: 2 });
    const t = rig(store);
    expect(await t.rec.scan()).toBe(0);
    expect(store.chunks.size).toBe(0);
    expect(store.metas.has('empty')).toBe(false);
  });
});

describe('🔴 2 度押し・重複の防止', () => {
  it('編集中(held)に「復元する」を 2 度押しても、添付は 1 件(預かり中の区間は対象にしない)', async () => {
    const store = new MemoryJournalStore();
    await seed(store);
    const t = rig(store, { answers: [true, true], deliver: 'held' });
    await t.rec.scan();
    await t.rec.open();
    expect(t.notices.at(-1)).toContain('編集を終えると入ります');
    expect(t.notices.at(-1)).not.toContain('残しています');
    await t.rec.open();
    expect(t.delivered).toHaveLength(1);
    expect(t.asked, '2 度目は確認も出さない').toHaveLength(1);
    // 編集が終わって入ったら控えが消える
    t.heldDone[0]!();
    await settle();
    expect(store.chunks.size).toBe(0);
    expect(t.rec.count()).toBe(0);
  });

  it('対照群: 入れられなかった(failed)区間は、もう 1 度押せば再び試せる', async () => {
    const store = new MemoryJournalStore();
    await seed(store);
    const t = rig(store, { answers: [true, true], deliver: 'failed' });
    await t.rec.scan();
    await t.rec.open();
    await t.rec.open();
    expect(t.delivered).toHaveLength(2);
  });
});

describe('🔴 起動のたびに同じ知らせを積まない / 件数の単位', () => {
  it('同じ組が残ったままの 2 回目の起動(別の実体・同じ目印の置き場)では、メッセージを積まない', async () => {
    const store = new MemoryJournalStore();
    await seed(store);
    let saved: string | null = null;
    const seen = { get: () => saved, set: (s: string) => void (saved = s) };
    const a = rig(store, { seen });
    await a.rec.scan();
    const b = rig(store, { seen });
    await b.rec.scan();
    expect(a.posts).toHaveLength(1);
    expect(b.posts).toHaveLength(0);
    expect(b.counts.at(-1)).toBe(1); // 状態の行は出る
    // 組が増えたら、また残す
    await seed(store, 'r2');
    const c = rig(store, { seen });
    await c.rec.scan();
    expect(c.posts).toHaveLength(1);
  });

  it('同じ実体で 2 度 scan しても 1 件', async () => {
    const store = new MemoryJournalStore();
    await seed(store);
    const t = rig(store);
    await t.rec.scan();
    await t.rec.scan();
    expect(t.posts).toHaveLength(1);
  });

  it('🔴 状態の行の数は収録の件数(区間が 2 つあっても 1 件)', async () => {
    const store = new MemoryJournalStore();
    await seed(store);
    for (let i = 0; i < 2; i++) await store.putChunk({ rec: 'r1', seg: 1, idx: i, elapsedMs: 1000, blob: new Blob(['ab']) });
    const t = rig(store);
    expect(await t.rec.scan()).toBe(1);
    expect(t.counts.at(-1)).toBe(1);
    expect(t.rec.count()).toBe(1);
  });
});

describe('復元する / 破棄する', () => {
  it('🔴 復元する: 断片が順につながり、長さを書いて、録り始めたノートへ渡し、控えが空になる', async () => {
    const store = new MemoryJournalStore();
    await seed(store);
    const t = rig(store, { answers: [true] });
    await t.rec.scan();
    await t.rec.open();
    expect(t.delivered).toHaveLength(1);
    expect(t.delivered[0]!.home).toBe('n1');
    expect(t.delivered[0]!.blob.size).toBe(6); // 2 バイト × 3 断片
    expect(t.delivered[0]!.blob.type).toBe('audio/webm;codecs=opus');
    expect(t.delivered[0]!.at.getTime()).toBe(Date.UTC(2026, 10, 20));
    expect(t.withDur).toEqual([3000]);
    expect(store.chunks.size).toBe(0);
    expect(store.metas.size).toBe(0);
    expect(t.counts.at(-1)).toBe(0);
    expect(t.notices.at(-1)).toContain('復元しました');
  });

  it('🔴 復元する: 断片は書いた順で連結される(内容で確かめる)', async () => {
    const store = new MemoryJournalStore();
    await store.putMeta({ id: 'o', kind: 'audio', startedLid: null, startedAt: 5 });
    for (const [i, c] of ['A', 'B', 'C'].entries()) {
      await store.putChunk({ rec: 'o', seg: 0, idx: 2 - i, elapsedMs: 1, blob: new Blob([c]) });
    }
    const t = rig(store, { answers: [true] });
    await t.rec.scan();
    await t.rec.open();
    expect(await t.delivered[0]!.blob.text()).toBe('CBA'); // idx 0 = 'C', 1 = 'B', 2 = 'A'
  });

  it('入れられなかった区間の控えは残り、状態の行も残る', async () => {
    const store = new MemoryJournalStore();
    await seed(store);
    const t = rig(store, { answers: [true], deliver: 'failed' });
    await t.rec.scan();
    await t.rec.open();
    expect(store.chunks.size).toBe(3);
    expect(t.rec.count()).toBe(1);
    expect(t.notices.at(-1)).toContain('残しています');
  });

  it('破棄する: 「復元しない」→「破棄する」で全部消える / 取り消せないと確認する', async () => {
    const store = new MemoryJournalStore();
    await seed(store);
    const t = rig(store, { answers: [false, true] });
    await t.rec.scan();
    await t.rec.open();
    expect(t.delivered).toEqual([]);
    expect(t.asked[1]).toContain('取り消せません');
    expect(store.chunks.size).toBe(0);
    expect(store.metas.size).toBe(0);
    expect(t.counts.at(-1)).toBe(0);
  });

  it('破棄するを選ばなければ(残しておく)何も消えない', async () => {
    const store = new MemoryJournalStore();
    await seed(store);
    const t = rig(store, { answers: [false, false] });
    await t.rec.scan();
    await t.rec.open();
    expect(store.chunks.size).toBe(3);
    expect(t.rec.count()).toBe(1);
  });

  it('復元できる物が無ければ open は何も聞かない', async () => {
    const t = rig(new MemoryJournalStore());
    await t.rec.scan();
    await t.rec.open();
    await settle();
    expect(t.asked).toEqual([]);
  });

  it('置き場が開けなくても起動を止めない(0 件)', async () => {
    const store = new MemoryJournalStore();
    store.listMetas = async () => {
      throw new Error('idb');
    };
    const t = rig(store);
    expect(await t.rec.scan()).toBe(0);
  });
});

describe('状態の行(ステータスバーの静かな 1 行)', () => {
  it('🔴 復元できる物が在るときだけ出て、0 件では畳まれ字も空', () => {
    const btn = document.createElement('button');
    btn.hidden = true;
    paintStatusCaptureRecovery(btn, 0);
    expect(btn.hidden).toBe(true);
    expect(btn.textContent).toBe('');
    paintStatusCaptureRecovery(btn, 2);
    expect(btn.hidden).toBe(false);
    expect(btn.textContent).toContain('途中で終わった録音・録画');
    paintStatusCaptureRecovery(btn, 0);
    expect(btn.hidden).toBe(true);
    expect(btn.textContent).toBe('');
  });
});
