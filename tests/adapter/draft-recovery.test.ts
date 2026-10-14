/** @vitest-environment happy-dom */
/**
 * 保存していない編集の復元(#1376)── 控える側(draft-writer)と聞く側(draft-offer)を
 * 本物の Dispatcher / 本物の reducer につないで通す。
 *
 * 守るもの:
 * - 打った字が控えられ、確定・取り消し・打って消したら控えが消える(別タブの控えは消さない)
 * - 起動のとき:戻せる控えだけ 1 行で聞く / 戻しても disk は 1 バイトも動かない / 消すと消える
 * - 別の場所で更新されていたらそう言う / ノートが消えていたら黙って片付ける
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectDraftWriter } from '../../src/adapter/platform/draft-writer';
import { MemoryDraftStore, mayRemove } from '../../src/adapter/platform/draft-store';
import {
  DRAFT_DISCARD_TITLE,
  DRAFT_ENTER_FAILED_NOTE,
  DRAFT_RESTORED_NOTE,
  DRAFT_RESTORE_TITLE,
  createDraftOffer,
  draftBusyNote,
  type DraftOffer,
} from '../../src/adapter/ui/render/draft-offer';
import {
  DRAFT_BYTES_MAX,
  fingerprint,
  type DraftClock,
  type DraftRecord,
} from '../../src/features/draft/draft-recovery';

const CID = 'c1';
const DISK = '# 買い物\n牛乳\n';

function meta(lid: string, title: string) {
  return {
    lid,
    title,
    archetype: 'text' as const,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

function boot(): Dispatcher {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: CID, metas: [meta('n1', '買い物'), meta('n2', '予定')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: DISK });
  return d;
}

function fakeClock() {
  let now = 1_000_000;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  let seq = 0;
  const clock: DraftClock = {
    now: () => now,
    set: (fn, ms) => {
      const id = ++seq;
      timers.push({ id, at: now + ms, fn });
      return id;
    },
    clear: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  return {
    clock,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.splice(timers.indexOf(next), 1);
        now = next.at;
        next.fn();
      }
      now = end;
    },
  };
}

function setup(tab = 'A') {
  const d = boot();
  const store = new MemoryDraftStore();
  const f = fakeClock();
  const w = connectDraftWriter({ dispatcher: d, store, cid: CID, tab, clock: f.clock, readTitle: () => null });
  return { d, store, f, w };
}

async function settle(f: ReturnType<typeof fakeClock>, w: { settled(): Promise<void> }, ms = 1000) {
  f.advance(ms);
  await w.settled();
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('draft-writer(控える側)', () => {
  it('編集に入っただけでは控えない。打って 1 秒止まると、本文・編集前の指紋・時刻・タブつきで控える', async () => {
    const { d, store, f, w } = setup();
    d.dispatch({ type: 'START_EDIT' });
    await settle(f, w, 10_000);
    expect(store.map.size).toBe(0);
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: DISK + 'パン\n' });
    f.advance(999);
    await w.settled();
    expect(store.map.size, '1 秒の手前で控えた').toBe(0);
    await settle(f, w, 1);
    const [rec] = [...store.map.values()];
    expect(rec).toMatchObject({ cid: CID, lid: 'n1', body: DISK + 'パン\n', tab: 'A', base: fingerprint(DISK) });
    expect(rec?.at).toBe(f.clock.now());
  });

  it('戻して入った回は、まだ打っていなくても控えを持つ。基準は disk の本文のまま(戻した字ではない)', async () => {
    const { d, store, f, w } = setup();
    d.dispatch({ type: 'START_EDIT', restoreBody: DISK + '戻した字\n' });
    await settle(f, w);
    const [rec] = [...store.map.values()];
    expect(rec?.body).toBe(DISK + '戻した字\n');
    expect(rec?.base, '基準が戻した字になっている(次の起動で「別の場所で更新」と誤る)').toBe(fingerprint(DISK));
  });

  it('🔴 保存(確定)した瞬間には消さない。disk に届いた(persisted が確定した本文になった)ときに消す', async () => {
    const { d, store, f, w } = setup();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: DISK + 'a' });
    await settle(f, w);
    expect(store.map.size).toBe(1);
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: DISK + 'ab' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await settle(f, w, 10_000);
    // 書込がまだ着いていない(落ちたかもしれない)── 字の行き場はこの控えだけ
    expect(store.map.size, '確定した瞬間に消している(書込が落ちたら字がどこにも残らない)').toBe(1);
    // 別の本文の ack では消えない(対照群:自分の確定した本文の ack だけが消す)
    d.dispatch({ type: 'BODY_PERSISTED', lid: 'n1', body: DISK + 'a' });
    await w.settled();
    expect(store.map.size).toBe(1);
    d.dispatch({ type: 'BODY_PERSISTED', lid: 'n1', body: DISK + 'ab' });
    await w.settled();
    expect(store.map.size).toBe(0);
  });

  it('🔴 保存の確認の前に別のノートへ移っても、disk に届いた控えは消える(#1087)', async () => {
    const d = boot();
    const store = new MemoryDraftStore();
    const f = fakeClock();
    const disk = new Map<string, string>();
    let reads = 0;
    const w = connectDraftWriter({
      dispatcher: d, store, cid: CID, tab: 'A', clock: f.clock, readTitle: () => null,
      readDiskBody: async (lid) => {
        reads++;
        return disk.get(lid) ?? null;
      },
    });
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: DISK + 'ab' });
    await settle(f, w);
    d.dispatch({ type: 'COMMIT_EDIT' });
    // 書込そのものは届いている(本物の `readDiskBody` は書込の列が済むのを待ってから読む)
    disk.set('n1', DISK + 'ab');
    // 確認(BODY_PERSISTED)の前に別のノートへ移る ── 画面は n1 の確認を受け取らない
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: '予定\n' });
    await new Promise((r) => setTimeout(r, 0));
    await w.settled();
    expect(store.map.size, '保存済みの控えが残り、次の起動で「保存していない編集」として出る').toBe(0);
    // 読みに行くのは 1 つの保存につき 1 回だけ(状態が変わるたびに worker を叩かない)
    const before = reads;
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    expect(reads).toBe(before);
  });

  it('対照群: disk に届いていなければ(書込が落ちた)、ノートを離れても控えは残る', async () => {
    const d = boot();
    const store = new MemoryDraftStore();
    const f = fakeClock();
    const w = connectDraftWriter({
      dispatcher: d, store, cid: CID, tab: 'A', clock: f.clock, readTitle: () => null,
      readDiskBody: async () => DISK, // 古いまま
    });
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: DISK + 'ab' });
    await settle(f, w);
    d.dispatch({ type: 'COMMIT_EDIT' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    await new Promise((r) => setTimeout(r, 0));
    await w.settled();
    expect(store.map.size).toBe(1);
  });

  it('確定した本文が着く前に次の編集が始まったら、新しい編集の控えを消さない', async () => {
    const { d, store, f, w } = setup();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: DISK + 'a' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: DISK + 'a + 次の編集' });
    await settle(f, w);
    d.dispatch({ type: 'BODY_PERSISTED', lid: 'n1', body: DISK + 'a' });
    await w.settled();
    expect(store.map.get(`${CID}\u0000n1`)?.body).toBe(DISK + 'a + 次の編集');
  });

  it('🔴 前の保存の到着待ちが、次の(戻して入った)編集の控えを消さない', async () => {
    const { d, store, f, w } = setup();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: DISK + 'a' });
    d.dispatch({ type: 'COMMIT_EDIT' }); // 到着待ち(A)
    d.dispatch({ type: 'START_EDIT', restoreBody: DISK + '戻した字' }); // 次の編集(戻して入った回)
    await settle(f, w);
    expect(store.map.get(`${CID}\u0000n1`)?.body).toBe(DISK + '戻した字');
    d.dispatch({ type: 'BODY_PERSISTED', lid: 'n1', body: DISK + 'a' }); // 前の保存が着く(編集中)
    d.dispatch({ type: 'CANCEL_EDIT' }); // 戻した編集をやめる ── 控えは残るはず
    await settle(f, w, 10_000);
    expect(store.map.get(`${CID}\u0000n1`)?.body, '前の保存の到着待ちが、戻した編集の控えを消した').toBe(DISK + '戻した字');
  });

  it('取り消すと控えが消える', async () => {
    const { d, store, f, w } = setup();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: DISK + 'a' });
    await settle(f, w);
    expect(store.map.size).toBe(1);
    d.dispatch({ type: 'CANCEL_EDIT' });
    await w.settled();
    expect(store.map.size).toBe(0);
  });

  it('打って消して編集前の本文に戻ったら、控えも消える(戻す物が無い)', async () => {
    const { d, store, f, w } = setup();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: DISK + 'a' });
    await settle(f, w);
    expect(store.map.size).toBe(1);
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: DISK });
    await settle(f, w);
    expect(store.map.size).toBe(0);
  });

  it('自分が書いた控えだけ消す ── 別のタブの控えは、こちらの保存で消えない', async () => {
    const { d, store, f, w } = setup('A');
    const theirs: DraftRecord = {
      cid: CID, lid: 'n1', body: 'B が打っている', title: '', base: 'x', at: 5, tab: 'B',
    };
    store.map.set(`${CID}\u0000n1`, theirs);
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'COMMIT_EDIT' }); // 打たずに確定
    await settle(f, w);
    expect(store.map.get(`${CID}\u0000n1`)).toEqual(theirs);
    // 同じノートを A も打てば、後に書いたほうが残る(last-writer-wins)
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: 'A が打った' });
    await settle(f, w);
    expect(store.map.get(`${CID}\u0000n1`)?.tab).toBe('A');
  });

  it('題名だけ打っても控える(題名の欄は state に写らないので欄の値を読む)', async () => {
    const d = boot();
    const store = new MemoryDraftStore();
    const f = fakeClock();
    let titleNow = '買い物';
    const w = connectDraftWriter({
      dispatcher: d, store, cid: CID, tab: 'A', clock: f.clock, readTitle: () => titleNow,
    });
    d.dispatch({ type: 'START_EDIT' });
    const input = document.createElement('input');
    input.setAttribute('data-pkc-field', 'editor-title');
    document.body.append(input);
    titleNow = '買い物リスト';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(f, w);
    expect(store.map.get(`${CID}\u0000n1`)).toMatchObject({ title: '買い物リスト', body: DISK });
  });

  it('編集の欄でない input では控えない(対照群)', async () => {
    const { d, store, f, w } = setup();
    d.dispatch({ type: 'START_EDIT' });
    const other = document.createElement('input');
    document.body.append(other);
    other.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(f, w, 10_000);
    expect(store.map.size).toBe(0);
  });

  it('2 MB を超えたら控えない。それまでの控えも消す(古い版を戻すと新しい字が失われて見える)', async () => {
    const { d, store, f, w } = setup();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: 'ok' });
    await settle(f, w);
    expect(store.map.size).toBe(1);
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: 'a'.repeat(DRAFT_BYTES_MAX + 1) });
    await settle(f, w);
    expect(store.map.size).toBe(0);
  });

  it('ページを離れる(pagehide)と、待っている分をすぐ控える', async () => {
    const { d, store, w } = setup();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: DISK + 'a' });
    window.dispatchEvent(new Event('pagehide'));
    await w.settled();
    expect(store.map.size).toBe(1);
  });

  it('🔴 隠れた(visibilitychange が hidden)ときも、待っている分を 1 秒を待たずに控える。見えているままでは控えない', async () => {
    const { d, store, w } = setup();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: DISK + 'a' });
    // 対照群:見えているまま visibilitychange が来ても控えない
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await w.settled();
    expect(store.map.size).toBe(0);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await w.settled();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    expect(store.map.size, '隠れたのに、タイマーを待っている(落ちたら失う)').toBe(1);
  });

  it('止めると何も控えない(dispose)', async () => {
    const { d, store, f, w } = setup();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: DISK + 'a' });
    w.dispose();
    await settle(f, w, 10_000);
    expect(store.map.size).toBe(0);
  });
});

describe('draft-store(置き場の上限)', () => {
  it('全コレクション通しで 20 件。超えた分は古い順に消える', async () => {
    const store = new MemoryDraftStore();
    for (let i = 0; i < 23; i++) {
      await store.put({ cid: i % 2 === 0 ? 'a' : 'b', lid: `n${i}`, body: 'x', title: '', base: '', at: i, tab: 'T' });
    }
    const all = [...(await store.list('a')), ...(await store.list('b'))];
    expect(all).toHaveLength(20);
    expect(Math.min(...all.map((r) => r.at))).toBe(3);
  });
  it('tab を渡した remove は、その tab が書いた控えだけ消す', async () => {
    const store = new MemoryDraftStore();
    await store.put({ cid: 'a', lid: 'n', body: 'x', title: '', base: '', at: 1, tab: 'T1' });
    await store.remove('a', 'n', 'T2');
    expect(await store.list('a')).toHaveLength(1);
    await store.remove('a', 'n', 'T1');
    expect(await store.list('a')).toHaveLength(0);
  });
});

describe('mayRemove(消してよい控えか ── 置き場 2 つが通る 1 関数)', () => {
  const r: DraftRecord = { cid: 'a', lid: 'n', body: '', title: '', base: '', at: 1, tab: 'T1' };
  it('tab 無し = 誰の控えでも消す / tab あり = 自分の控えだけ / 無い控えは消さない', () => {
    expect(mayRemove(r, undefined)).toBe(true);
    expect(mayRemove(r, 'T1')).toBe(true);
    expect(mayRemove(r, 'T2')).toBe(false);
    expect(mayRemove(undefined, undefined)).toBe(false);
  });
  it('IndexedDB の置き場もこの関数を通る(メモリ側だけ直って本物が緩む事故を止める)', () => {
    // IndexedDB は unit に無いので、原文で「呼んでいる」ことを見る。注釈は落としてから数える
    const src = readFileSync('src/adapter/platform/draft-store.ts', 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const idb = src.slice(src.indexOf('class IdbDraftStore'));
    expect(idb, 'IdbDraftStore を引けていない').not.toBe('');
    expect(idb.match(/mayRemove\(/g)?.length).toBe(1);
    expect(src.slice(0, src.indexOf('class IdbDraftStore')).match(/mayRemove\(/g)?.length).toBe(2); // 定義 + メモリ側
  });
});

describe('draft-offer(起動のとき 1 行で聞く側)', () => {
  /** 書き手と聞く側を、main.ts と同じ順(書き手が先)・同じ結び方でつなぐ。 */
  function offerSetup(
    opts: {
      disk?: Record<string, string | null>;
      live?: Set<string> | null;
      waitMs?: number;
      enterEdit?: (d: Dispatcher, body: string) => void;
    } = {},
  ) {
    const d = boot();
    const store = new MemoryDraftStore();
    const region = document.createElement('section');
    region.hidden = true; // 実物の既定(shell.ts)
    document.body.append(region);
    const say = vi.fn();
    const setTitle = vi.fn();
    const f = fakeClock();
    const disk = opts.disk ?? { n1: DISK, n2: '予定の本文' };
    const holder: { offer: DraftOffer | null } = { offer: null };
    const w = connectDraftWriter({
      dispatcher: d,
      store,
      cid: CID,
      tab: 'NEW',
      clock: f.clock,
      readTitle: () => null,
      isPending: (lid) => holder.offer?.has(lid) === true,
      onEnded: (lid, committed) => holder.offer?.editEnded(lid, committed),
    });
    const offer = createDraftOffer({
      region,
      dispatcher: d,
      store,
      cid: CID,
      tab: 'NEW',
      now: () => 9_999_999,
      liveTabs: async () => (opts.live === undefined ? new Set<string>() : opts.live),
      readBody: async (lid) => disk[lid] ?? null,
      enterEdit: (body) =>
        opts.enterEdit
          ? opts.enterEdit(d, body)
          : d.dispatch({ type: 'START_EDIT', restoreBody: body }),
      setTitle,
      say,
      ...(opts.waitMs === undefined ? {} : { waitMs: opts.waitMs }),
    });
    holder.offer = offer;
    return { d, store, region, say, setTitle, offer, f, w, disk };
  }
  const draft = (over: Partial<DraftRecord> = {}): DraftRecord => ({
    cid: CID, lid: 'n1', body: DISK + 'パン\n', title: '買い物', base: fingerprint(DISK), at: 10, tab: 'OLD', ...over,
  });
  const put = (store: MemoryDraftStore, r: DraftRecord): void => {
    store.map.set(`${r.cid}\u0000${r.lid}`, r);
  };
  const key = `${CID}\u0000n1`;
  /** 非同期の読み直し(load)が済むのを待つ。 */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('戻せる控えがあれば、題名つきの 1 行と [戻す][消す] だけを出す(モーダルにしない)。ボタンはノートを消す操作に読まれない', async () => {
    const { store, region, offer } = offerSetup();
    put(store, draft());
    await offer.present();
    expect(region.hidden).toBe(false);
    expect(region.querySelector('[data-pkc-field="draft-offer-text"]')?.textContent).toBe(
      '保存していない編集が残っています(買い物)',
    );
    const buttons = [...region.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['戻す', '消す']);
    expect(buttons.map((b) => b.getAttribute('data-pkc-action'))).toEqual(['restore-draft', 'discard-draft']);
    expect(buttons.map((b) => b.title)).toEqual([DRAFT_RESTORE_TITLE, DRAFT_DISCARD_TITLE]);
    expect(DRAFT_DISCARD_TITLE).toContain('ノートは消えません');
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('控えが無ければ何も出さない', async () => {
    const { region, offer } = offerSetup();
    await offer.present();
    expect(region.hidden).toBe(true);
    expect(region.textContent).toBe('');
  });

  it('戻す:そのノートを編集で開き、打っていた字が入る。disk は動かず、一度だけ知らせる。🔴 控えはまだ消さない', async () => {
    const { d, store, region, setTitle, offer, say } = offerSetup();
    const events: string[] = [];
    d.onEvent((e) => events.push(e.type));
    // 別のノートを見ている状態から戻す(本文は後から届く)
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: '予定の本文' });
    put(store, draft());
    await offer.present();
    offer.restore();
    expect(region.hidden, '戻している間は 1 行を隠す').toBe(true);
    // n1 の本文が届くまで編集には入らない
    expect(d.getState().phase).toBe('ready');
    expect(say).not.toHaveBeenCalled();
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: DISK });
    const s = d.getState();
    expect(s.phase).toBe('editing');
    expect(s.openBody?.lid).toBe('n1');
    expect(s.openBody?.body).toBe(DISK + 'パン\n');
    // 🔴 書かない:基準は disk のまま、書込の要求も出ていない
    expect(s.openBody?.baseline).toBe(DISK);
    expect(s.openBody?.persisted).toBe(DISK);
    expect(events).not.toContain('PERSIST_ENTRY');
    expect(setTitle).toHaveBeenCalledWith('買い物');
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith(DRAFT_RESTORED_NOTE);
    expect(DRAFT_RESTORED_NOTE).toContain('保存を押すまでノートは変わりません');
    // 🔴 編集に入れても控えは消さない(消すのは「消す」と、保存が disk に着いたときだけ)
    expect(store.map.has(key)).toBe(true);
  });

  it('🔴 入れなかった(受け付けられない):控えは残り、1 行が戻り、理由を言う', async () => {
    vi.useFakeTimers();
    try {
      const { d, store, region, offer, say } = offerSetup({ enterEdit: () => {} /* 編集に入れない */ });
      put(store, draft());
      await offer.present();
      offer.restore();
      expect(region.hidden).toBe(true);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(d.getState().phase).toBe('ready');
      expect(store.map.has(key), '入れなかったのに控えが消えた').toBe(true);
      expect(region.hidden, '1 行が戻っていない').toBe(false);
      expect(say).toHaveBeenCalledWith(DRAFT_ENTER_FAILED_NOTE);
      expect(say).not.toHaveBeenCalledWith(DRAFT_RESTORED_NOTE);
    } finally {
      vi.useRealTimers();
    }
  });

  it('🔴 入れなかった(本文が届かない):控えは残り、1 行が戻り、理由を言う', async () => {
    vi.useFakeTimers();
    try {
      const { d, store, region, offer, say } = offerSetup();
      d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' }); // n1 の本文は届かないまま
      put(store, draft());
      await offer.present();
      offer.restore();
      await vi.advanceTimersByTimeAsync(10_001);
      expect(store.map.has(key)).toBe(true);
      expect(region.hidden).toBe(false);
      expect(say).toHaveBeenCalledWith(DRAFT_ENTER_FAILED_NOTE);
    } finally {
      vi.useRealTimers();
    }
  });

  it('🔴 入れなかった(待つ間に別のノートへ移った):待たずに 1 行を戻す。控えは残る', async () => {
    const { d, store, region, offer, say } = offerSetup();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: '予定の本文' });
    put(store, draft());
    await offer.present();
    offer.restore();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' }); // 戻す先ではないノートへ
    expect(store.map.has(key)).toBe(true);
    expect(region.hidden).toBe(false);
    expect(say).toHaveBeenCalledWith(DRAFT_ENTER_FAILED_NOTE);
  });

  it('🔴 受け付けられなかった(追記の書込が飛んでいて reducer が断る):待ち切って、控えは残り 1 行が戻る', async () => {
    vi.useFakeTimers();
    try {
      const { d, store, offer, say, region } = offerSetup();
      // 本物の reducer の断り:追記の書込が飛んでいる間は編集に入れない
      d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'n1', text: 'x', heading: null, target: null });
      expect(d.getState().writeLock, '前提が崩れている(追記の書込が飛んでいない)').not.toBeNull();
      put(store, draft());
      await offer.present();
      offer.restore();
      await vi.advanceTimersByTimeAsync(10_001);
      expect(d.getState().phase, 'reducer が断らなかった(前提が崩れている)').toBe('ready');
      expect(store.map.has(key)).toBe(true);
      expect(region.hidden).toBe(false);
      expect(say).toHaveBeenCalledWith(DRAFT_ENTER_FAILED_NOTE);
    } finally {
      vi.useRealTimers();
    }
  });

  it('戻す:すでに開いているノートなら、その場で編集に入る(題名も戻る)', async () => {
    const { d, store, offer, setTitle } = offerSetup();
    put(store, draft());
    await offer.present();
    offer.restore();
    expect(d.getState().phase).toBe('editing');
    expect(d.getState().openBody?.body).toBe(DISK + 'パン\n');
    expect(setTitle, '題名が戻っていない(その場で編集に入れた回)').toHaveBeenCalledWith('買い物');
  });

  it('🔴 編集中は 1 行を隠し、編集が終わったらまた出す', async () => {
    const { d, store, region, offer } = offerSetup();
    put(store, draft({ lid: 'n2', title: '予定', body: '予定を直した', base: fingerprint('予定の本文') }));
    await offer.present();
    expect(region.hidden).toBe(false);
    d.dispatch({ type: 'START_EDIT' }); // n1 を編集(n2 の控えは別ノート)
    expect(region.hidden, '編集中も 1 行が残っている(押しても断られるだけ)').toBe(true);
    d.dispatch({ type: 'CANCEL_EDIT' });
    await flush();
    expect(region.hidden, '編集が終わっても 1 行が戻らない').toBe(false);
  });

  it('いま編集中に restore を撃たれたら戻さない。理由を言い、控えはそのまま', async () => {
    const { d, store, offer, say } = offerSetup();
    put(store, draft());
    await offer.present();
    d.dispatch({ type: 'START_EDIT' });
    offer.restore();
    expect(say).toHaveBeenCalledWith(draftBusyNote(d.getState()));
    expect(draftBusyNote(d.getState()), '編集中の理由が空').toContain('編集を保存するか、編集をやめてから');
    expect(store.map.size).toBe(1);
    expect(d.getState().openBody?.body).toBe(DISK);
  });

  it('🔴 戻して「編集をやめる」:控えは消えず、1 行がまた出る(戻した字を二度と戻せなくしない)。書き手が控えを引き取った後でも', async () => {
    const { d, store, region, offer, f, w } = offerSetup();
    put(store, draft());
    await offer.present();
    offer.restore();
    expect(d.getState().phase).toBe('editing');
    // 戻した編集も控えられる(答えのいらなくなった戻し先は、書き手が自分の控えとして書き直す)
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: DISK + 'パン\nさらに打った\n' });
    f.advance(1000);
    await w.settled();
    expect(store.map.get(key)?.tab, '戻した編集を書き手が控えていない').toBe('NEW');
    expect(store.map.get(key)?.body).toBe(DISK + 'パン\nさらに打った\n');
    d.dispatch({ type: 'CANCEL_EDIT' });
    f.advance(10_000);
    await w.settled();
    await flush();
    expect(d.getState().openBody?.body, '取り消したので disk の本文に戻る').toBe(DISK);
    expect(store.map.has(key), '戻して取り消したら控えが消えた').toBe(true);
    expect(region.hidden, '1 行が戻っていない').toBe(false);
    expect(region.textContent).toContain('保存していない編集が残っています');
  });

  it('編集が終わったら聞き直す:その間に disk が変わっていたら、戻った 1 行はそう言う', async () => {
    const { d, store, region, offer, disk, w, f } = offerSetup();
    put(store, draft());
    await offer.present();
    expect(region.textContent).not.toContain('別の場所で更新されています');
    offer.restore();
    disk['n1'] = DISK + '編集中に別の場所で足した\n';
    d.dispatch({ type: 'CANCEL_EDIT' });
    f.advance(1000);
    await w.settled();
    await flush();
    expect(region.hidden).toBe(false);
    expect(region.textContent, '編集が終わっても判定し直していない').toContain('別の場所で更新されています');
  });

  it('対照群:戻していない普通の編集の取り消しは、これまでどおり控えを消す', async () => {
    const { d, store, f, w } = offerSetup();
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: DISK + 'a' });
    f.advance(1000);
    await w.settled();
    expect(store.map.size).toBe(1);
    d.dispatch({ type: 'CANCEL_EDIT' });
    await w.settled();
    expect(store.map.size).toBe(0);
  });

  it('戻して保存:disk に着くまで控えは残り、着いたら消える。1 行は出ない', async () => {
    const { d, store, region, offer, f, w } = offerSetup();
    put(store, draft());
    await offer.present();
    offer.restore();
    d.dispatch({ type: 'COMMIT_EDIT' });
    f.advance(10_000);
    await w.settled();
    await flush();
    expect(store.map.has(key), '書込が着く前に消えた').toBe(true);
    expect(region.hidden, '保存した控えをまた聞いている').toBe(true);
    d.dispatch({ type: 'BODY_PERSISTED', lid: 'n1', body: DISK + 'パン\n' });
    await w.settled();
    expect(store.map.has(key)).toBe(false);
    expect(region.hidden).toBe(true);
  });

  it('🔴 1 行を無視して同じノートを打っても、答えていない控えは上書きされない(別のノートは控える)', async () => {
    const { d, store, f, w, offer } = offerSetup();
    const old = draft();
    put(store, old);
    await offer.present();
    expect(offer.has('n1')).toBe(true);
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: DISK + '無視して打った字\n' });
    f.advance(10_000);
    await w.settled();
    expect(store.map.get(key), '答えていない控えが新しい字で上書きされた').toEqual(old);
    // 対照群:答えのいらない別のノートは普通に控える
    d.dispatch({ type: 'CANCEL_EDIT' });
    await flush();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: '予定の本文' });
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '予定を直した' });
    f.advance(1000);
    await w.settled();
    expect(store.map.get(`${CID}\u0000n2`)?.body).toBe('予定を直した');
  });

  it('消す:控えが消え、1 行も消える。ノートの本文は動かない', async () => {
    const { d, store, region, offer } = offerSetup();
    put(store, draft());
    await offer.present();
    offer.discard();
    expect(store.map.size).toBe(0);
    expect(region.hidden).toBe(true);
    expect(d.getState().phase).toBe('ready');
    expect(d.getState().openBody?.body).toBe(DISK);
  });

  it('🔴 題名だけ直した控えは聞く(本文が同じでも黙って片付けない)。題名も同じなら聞かない', async () => {
    const titleOnly = draft({ body: DISK, title: '買い物リスト' });
    const a = offerSetup();
    put(a.store, titleOnly);
    await a.offer.present();
    expect(a.region.hidden).toBe(false);
    expect(a.store.map.size).toBe(1);
    const b = offerSetup();
    put(b.store, draft({ body: DISK, title: '買い物' })); // 保存されている題名('買い物')と同じ
    await b.offer.present();
    expect(b.region.hidden).toBe(true);
    expect(b.store.map.size).toBe(0);
  });

  it('保存されている本文が編集前と変わっていたら、そう言う。🔴 その言い方どおり、戻して保存すると新しいほうが履歴に積まれる', async () => {
    const newer = DISK + '別の場所で足した\n';
    const { d, store, region, offer } = offerSetup({ disk: { n1: newer } });
    // いま disk(画面が持つ本文)も newer
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: '予定の本文' });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: newer });
    put(store, draft());
    await offer.present();
    expect(region.textContent).toContain('別の場所で更新されています。戻して保存すると、その更新は履歴に残ります');
    const persist: { checkpoint?: boolean; body?: string }[] = [];
    d.onEvent((e) => {
      if (e.type === 'PERSIST_ENTRY') persist.push(e as never);
    });
    offer.restore();
    expect(d.getState().openBody?.body).toBe(DISK + 'パン\n');
    expect(d.getState().openBody?.persisted, '基準が新しい disk になっていない').toBe(newer);
    d.dispatch({ type: 'COMMIT_EDIT' });
    expect(persist, '保存の要求が出ていない').toHaveLength(1);
    // checkpoint = 保存の直前の disk の本文(newer)を履歴へ積む(worker 側の意味論は storage-worker.test.ts)
    expect(persist[0]?.checkpoint, '新しい disk の本文を履歴に積まない保存になっている').toBe(true);
  });

  it('控えと保存されている本文が同じなら聞かない。ノートが消えていても聞かない(どちらも黙って片付ける)', async () => {
    const { store, region, offer } = offerSetup({ disk: { n1: DISK + 'パン\n', n2: null } });
    put(store, draft());
    put(store, draft({ lid: 'n2', body: 'x' }));
    await offer.present();
    expect(region.hidden).toBe(true);
    expect(store.map.size).toBe(0);
  });

  it('別のコレクションの控えは聞かない', async () => {
    const { store, region, offer } = offerSetup();
    put(store, draft({ cid: 'other' }));
    await offer.present();
    expect(region.hidden).toBe(true);
    expect(store.map.size).toBe(1);
  });

  it('いま別のタブが編集している控えは聞かない(対照群:印が無ければ聞く)', async () => {
    const live = offerSetup({ live: new Set(['OLD']) });
    put(live.store, draft());
    await live.offer.present();
    expect(live.region.hidden).toBe(true);
    expect(live.store.map.size).toBe(1);
    const dead = offerSetup({ live: new Set() });
    put(dead.store, draft());
    await dead.offer.present();
    expect(dead.region.hidden).toBe(false);
  });

  it('複数あるときは新しい順に 1 件ずつ。「ほか N 件」を添え、1 件片付けたら次を聞く', async () => {
    const { store, region, offer } = offerSetup();
    put(store, draft({ at: 1 }));
    put(store, draft({ lid: 'n2', title: '予定', body: '予定の本文を直した', base: fingerprint('予定の本文'), at: 2 }));
    await offer.present();
    expect(region.textContent).toContain('(予定)');
    expect(region.textContent).toContain('ほか 1 件');
    offer.discard();
    expect(region.textContent).toContain('(買い物)');
    expect(region.textContent).not.toContain('ほか');
    offer.discard();
    expect(region.hidden).toBe(true);
  });
});

describe('clearAll(中身を消してまっさらにする / 建て直し)', () => {
  it('置き場の控えを全部消す(コレクションをまたいで)', async () => {
    const store = new MemoryDraftStore();
    await store.put({ cid: 'a', lid: 'n', body: 'x', title: '', base: '', at: 1, tab: 'T' });
    await store.put({ cid: 'b', lid: 'n', body: 'x', title: '', base: '', at: 2, tab: 'T' });
    await store.clearAll();
    expect(await store.list('a')).toHaveLength(0);
    expect(await store.list('b')).toHaveLength(0);
  });
  it('main.ts の forgetLocal(消す口と建て直しの口)が両方 clearAll を呼ぶ。IndexedDB 版も実装している', () => {
    const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const main = strip(readFileSync('src/main.ts', 'utf-8'));
    const blocks = main.match(/forgetLocal:\s*\(\)\s*=>\s*\{[^}]*\}/g) ?? [];
    expect(blocks, 'forgetLocal の口が 2 つ(消す / 建て直し)に見つからない').toHaveLength(2);
    for (const b of blocks) expect(b, 'forgetLocal が控えを消していない').toContain('draftStore.clearAll()');
    const store = strip(readFileSync('src/adapter/platform/draft-store.ts', 'utf-8'));
    expect(store.slice(store.indexOf('class IdbDraftStore'))).toMatch(/async clearAll\(\)[\s\S]*s\.clear\(\)/);
  });
});

describe('main.ts の配線(main.ts はどの test からも実行されない ── 原文で pin する。弱いと自覚して使う)', () => {
  const main = readFileSync('src/main.ts', 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  it('控える側・聞く側・戻す口(startEditAt の 1 本)・押し口が全部つながっている', () => {
    expect(main).toMatch(/connectDraftWriter\(\{/);
    expect(main).toMatch(/createDraftOffer\(\{/);
    // 書き手 ↔ 聞く側:答えていない控えは上書きしない / 編集の終わり(保存か取り消しか)を伝える
    expect(main).toMatch(/isPending:\s*\(lid\)\s*=>\s*draftOfferRef\?\.has\(lid\)\s*===\s*true/);
    expect(main).toMatch(/onEnded:\s*\(lid,\s*committed\)\s*=>\s*draftOfferRef\?\.editEnded\(lid,\s*committed\)/);
    expect(main).toMatch(/enterEdit:\s*\(body\)\s*=>\s*startEditRestoring\(dispatcher,\s*services,\s*body\)/);
    expect(main).toMatch(/restoreDraft:\s*\(\)\s*=>\s*draftOfferRef\?\.restore\(\)/);
    expect(main).toMatch(/discardDraft:\s*\(\)\s*=>\s*draftOfferRef\?\.discard\(\)/);
    // 聞くのは本体の窓だけ(付箋・別窓は聞かない)
    expect(main).toMatch(/heldViewWindow === null && !heldNoteWindow\) \{\s*draftOfferRef = createDraftOffer/);
  });
});

describe('readAfterSettle(#1087)', () => {
  it('🔴 書込の列が済むのを待ってから読む(待たずに読むと、列に残った保存より先に古い本文を読む)', async () => {
    const { readAfterSettle } = await import('../../src/adapter/platform/draft-writer');
    const order: string[] = [];
    let release!: () => void;
    const settled = new Promise<void>((r) => (release = r));
    const read = readAfterSettle(
      async () => {
        order.push('settle:start');
        await settled;
        order.push('settle:end');
      },
      async (lid) => {
        order.push(`read:${lid}`);
        return 'disk';
      },
    );
    const p = read('n1');
    await Promise.resolve();
    expect(order, '待つ前に読んだ').toEqual(['settle:start']);
    release();
    expect(await p).toBe('disk');
    expect(order).toEqual(['settle:start', 'settle:end', 'read:n1']);
  });
});
