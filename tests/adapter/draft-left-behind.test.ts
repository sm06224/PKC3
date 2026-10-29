/** @vitest-environment happy-dom */
/**
 * 別のウィンドウの書きかけを本体へ知らせる(依頼 219・329)/ 追記欄の打ちかけを控える(依頼 330)。
 *
 * 守るもの:
 * - 別のウィンドウが印を放送し、本体はその窓が閉じたとき(だけ)書きかけを探す ── 閉じる前は聞かない(対照群)
 * - 閉じた窓の控えがあれば 1 行を出し、無ければ出さない / 同じ窓の印は 2 度待たない / 別のコレクションは聞かない
 * - 追記欄の字は**全文編集の控えとは別の鍵**で控える(同じノートで 2 件持てる)/ 送れたら消える / 空にしたら消える
 * - 追記欄の控えを戻す:ノートを選び、欄へ字が入る。書かない(disk は動かない)
 * - もう本文に入っている追記の控えは聞かずに片付ける
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectDraftWriter } from '../../src/adapter/platform/draft-writer';
import { MemoryDraftStore } from '../../src/adapter/platform/draft-store';
import {
  DRAFT_TAB_OPEN,
  announceDraftTab,
  watchDraftTabs,
  type MakeDraftChannel,
} from '../../src/adapter/platform/draft-tab-watch';
import {
  DRAFT_APPEND_RESTORED_NOTE,
  createDraftOffer,
  type DraftOffer,
} from '../../src/adapter/ui/render/draft-offer';
import {
  DRAFT_LEFT_MESSAGE,
  draftKey,
  fingerprint,
  judgeAppendDraft,
  type DraftClock,
  type DraftRecord,
} from '../../src/features/draft/draft-recovery';
import { sanitizeMessageText } from '../../src/features/message/message-log';

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

/** 偽の放送路(同じ名前の路に繋いだ全員へ配る。自分には返さない)。 */
function fakeBus(): MakeDraftChannel {
  const all: { name: string; ch: { onmessage: ((ev: MessageEvent) => void) | null } }[] = [];
  return (name) => {
    const ch = {
      onmessage: null as ((ev: MessageEvent) => void) | null,
      postMessage(data: unknown) {
        for (const o of all) if (o.name === name && o.ch !== ch) o.ch.onmessage?.({ data } as MessageEvent);
      },
      close() {
        const i = all.findIndex((o) => o.ch === ch);
        if (i >= 0) all.splice(i, 1);
      },
    };
    all.push({ name, ch });
    return ch;
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('別のウィンドウの印(draft-tab-watch)', () => {
  it('放送された印は、その窓が閉じたとき(待ちが true で返ったとき)だけ onEnded になる。閉じる前は何も起きない', async () => {
    const make = fakeBus();
    let close!: (v: boolean) => void;
    const waiting = new Promise<boolean>((r) => (close = r));
    const ended: string[] = [];
    const stop = watchDraftTabs({ cid: CID, make, waitEnd: () => waiting, onEnded: (t) => ended.push(t) });
    announceDraftTab('NOTE-1', CID, make);
    await flush();
    expect(ended, '閉じる前に知らせた(開いている窓の書きかけを「残っている」と言ってしまう)').toEqual([]);
    close(true);
    await flush();
    expect(ended).toEqual(['NOTE-1']);
    stop();
  });

  it('対照群:待てない端末(false)は閉じたと言わない / 別のコレクションの印は聞かない / 同じ印は 2 度待たない', async () => {
    const make = fakeBus();
    const waits: string[] = [];
    const ended: string[] = [];
    watchDraftTabs({
      cid: CID,
      make,
      waitEnd: async (t) => {
        waits.push(t);
        return t !== 'NO-LOCKS';
      },
      onEnded: (t) => ended.push(t),
    });
    announceDraftTab('NO-LOCKS', CID, make);
    announceDraftTab('OTHER-CID', 'c2', make);
    announceDraftTab('DUP', CID, make);
    announceDraftTab('DUP', CID, make);
    await flush();
    expect(ended).toEqual(['DUP']);
    expect(waits.sort()).toEqual(['DUP', 'NO-LOCKS']);
  });

  it('放送に乗せるのは印と cid だけ(控えの中身・題名を載せない)', () => {
    const sent: unknown[] = [];
    announceDraftTab('T', CID, () => ({ postMessage: (m) => sent.push(m), close: () => {}, onmessage: null }));
    expect(sent).toEqual([{ kind: DRAFT_TAB_OPEN, tab: 'T', cid: CID }]);
  });
});

describe('leftBehind(別のウィンドウが閉じたあと、本体が書きかけを探す)', () => {
  function setup(live: Set<string> | null = new Set()) {
    const d = boot();
    const store = new MemoryDraftStore();
    const region = document.createElement('section');
    region.hidden = true;
    document.body.append(region);
    const say = vi.fn();
    const offer = createDraftOffer({
      region,
      dispatcher: d,
      store,
      cid: CID,
      tab: 'MAIN',
      now: () => 9_999_999,
      liveTabs: async () => live,
      readBody: async (lid) => (lid === 'n1' ? DISK : lid === 'n2' ? '予定の本文' : null),
      enterEdit: () => {},
      setTitle: () => {},
      enterPart: () => {},
      setPartText: async () => true,
      copyText: async () => true,
      say,
    });
    return { d, store, region, offer, say };
  }
  const full = (over: Partial<DraftRecord> = {}): DraftRecord => ({
    cid: CID, lid: 'n1', body: DISK + 'パン\n', title: '買い物', base: fingerprint(DISK), at: 10, tab: 'NOTE-1', ...over,
  });

  it('閉じた窓の書きかけが在れば、起動を待たずに 1 行を出し true を返す。対照群:その窓の控えが無ければ出さず false', async () => {
    const { store, region, offer } = setup();
    expect(await offer.leftBehind('NOTE-1'), '控えが無いのに「残っている」と言った').toBe(false);
    expect(region.hidden).toBe(true);
    store.map.set(draftKey(CID, 'n1'), full());
    expect(await offer.leftBehind('NOTE-1')).toBe(true);
    expect(region.hidden).toBe(false);
    expect(region.querySelector('[data-pkc-field="draft-offer-text"]')?.textContent).toBe(
      '保存していない編集が残っています(買い物)',
    );
    // 別の窓の控えは「その窓」の問いには答えない
    expect(await offer.leftBehind('NOTE-2')).toBe(false);
  });

  it('🔴 まだ生きている窓の控えは聞かない(閉じるまで待つ理由)', async () => {
    const { store, offer } = setup(new Set(['NOTE-1']));
    store.map.set(draftKey(CID, 'n1'), full());
    expect(await offer.leftBehind('NOTE-1')).toBe(false);
  });

  it('「もう聞かない」に入れたノートでも、別の窓が新しく残した書きかけは聞く', async () => {
    const { store, offer } = setup();
    // 編集を保存して終えた(= この起動のあいだ、n1 はもう聞かない)
    offer.editEnded('n1', true);
    store.map.set(draftKey(CID, 'n1'), full({ tab: 'OLD' }));
    await offer.present();
    expect(offer.has('n1'), '台の前提: 「もう聞かない」に入っていない').toBe(false);
    store.map.set(draftKey(CID, 'n1'), full({ tab: 'NOTE-1' }));
    expect(await offer.leftBehind('NOTE-1')).toBe(true);
  });

  it('メッセージに足す字はノートの題名を含まず、メッセージの伏せ字処理を通っても変わらない', () => {
    expect(DRAFT_LEFT_MESSAGE).not.toContain('買い物');
    expect(sanitizeMessageText(DRAFT_LEFT_MESSAGE)).toBe(DRAFT_LEFT_MESSAGE);
    // 伏せ字処理は「」の中を全部伏せる ── ボタン名を「」で囲むと「…」になる(通ったうえで、押す物の名前は残っている)
    expect(DRAFT_LEFT_MESSAGE).toContain('戻すボタン');
  });
});

describe('追記欄の控え(依頼 330)', () => {
  function append(d: Dispatcher, text: string, ta: HTMLTextAreaElement): void {
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    void d;
  }
  function setup(opts: { tab?: string; pending?: (lid: string, append?: boolean) => boolean } = {}) {
    const d = boot();
    const store = new MemoryDraftStore();
    const f = fakeClock();
    const ta = document.createElement('textarea');
    ta.setAttribute('data-pkc-field', 'append-input');
    document.body.append(ta);
    const w = connectDraftWriter({
      dispatcher: d,
      store,
      cid: CID,
      tab: opts.tab ?? 'A',
      clock: f.clock,
      readTitle: () => null,
      readAppendText: () => ta.value,
      isAppendInput: (el) => el.getAttribute('data-pkc-field') === 'append-input',
      ...(opts.pending === undefined ? {} : { isPending: opts.pending }),
    });
    return { d, store, f, w, ta };
  }
  const settle = async (f: ReturnType<typeof fakeClock>, w: { settled(): Promise<void> }, ms = 1000) => {
    f.advance(ms);
    await w.settled();
  };

  it('打って 1 秒止まると、追記欄の字を append の控えとして書く。全文編集の控えとは別の鍵で、同じノートに 2 件持てる', async () => {
    const { d, store, f, w, ta } = setup();
    // 全文編集の控えが先に在る
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: DISK + 'パン\n' });
    await settle(f, w);
    expect(store.map.size, '台の前提: 全文編集の控えが書けていない').toBe(1);
    // 追記欄に打つ(全文編集の控えが在る間も、別の鍵で書ける)
    append(d, '追記の下書き', ta);
    f.advance(999);
    await w.settled();
    const appends = () => [...store.map.values()].filter((r) => r.append === true);
    expect(appends(), '1 秒の手前で書いた').toHaveLength(0);
    await settle(f, w, 1);
    expect(appends()).toHaveLength(1);
    expect(appends()[0]).toMatchObject({ cid: CID, lid: 'n1', body: '追記の下書き', tab: 'A', append: true });
    // 🔴 全文編集の控えを取り合って消さない(同じ鍵なら 1 件になる)
    expect(store.map.has(draftKey(CID, 'n1'))).toBe(true);
    expect(store.map.has(draftKey(CID, 'n1', true))).toBe(true);
    expect(store.map.size).toBe(2);
  });

  it('欄を空にしたら控えも消える。対照群:空にしなければ残る', async () => {
    const { d, store, f, w, ta } = setup();
    append(d, '書きかけ', ta);
    await settle(f, w);
    expect(store.map.size).toBe(1);
    append(d, '書きかけ+', ta);
    await settle(f, w);
    expect(store.map.size, '打ち足しただけで消えた').toBe(1);
    append(d, '', ta);
    await settle(f, w);
    expect(store.map.size, '空にしたのに「戻す」の材料が残る').toBe(0);
  });

  it('追記が通ったら(lastAppend が入れ替わる)控えが消える。対照群:別のノートへの追記では消えない', async () => {
    const { d, store, f, w, ta } = setup();
    append(d, '送る字', ta);
    await settle(f, w);
    expect(store.map.has(draftKey(CID, 'n1', true))).toBe(true);
    // 別のノートへの追記が通っても、n1 の控えは残る
    d.dispatch({ type: 'ENTRY_APPENDED', gen: 0, lid: 'n2', body: '予定の本文\n\nよそ\n', status: null, date: null, archived: false, inserted: ['よそ'] } as never);
    await settle(f, w);
    expect(store.map.has(draftKey(CID, 'n1', true)), '別のノートの追記で消えた').toBe(true);
    d.dispatch({ type: 'ENTRY_APPENDED', gen: 0, lid: 'n1', body: DISK + '\n送る字\n', status: null, date: null, archived: false, inserted: ['送る字'] } as never);
    await settle(f, w);
    expect(store.map.has(draftKey(CID, 'n1', true)), '送れたのに控えが残る').toBe(false);
  });

  it('答えていない追記の控えが在るノートは上書きしない(対照群:在らなければ書く)', async () => {
    const pending = new Set<string>();
    const { d, store, f, w, ta } = setup({ pending: (lid, ap) => ap === true && pending.has(lid) });
    pending.add('n1');
    append(d, '新しい字', ta);
    await settle(f, w);
    expect(store.map.size, '答えていない控えを上書きした').toBe(0);
    pending.clear();
    append(d, '新しい字2', ta);
    await settle(f, w);
    expect(store.map.size).toBe(1);
  });

  it('大きすぎる字は控えない(編集は続く)', async () => {
    const { d, store, f, w, ta } = setup();
    append(d, 'あ'.repeat(800_000), ta); // 3 バイト × 80 万 = 2.4MB > 2MB
    await settle(f, w);
    expect(store.map.size).toBe(0);
  });

  it('judgeAppendDraft:ノートが無い=gone / 空・もう本文に入っている=same / それ以外=plain', () => {
    const r: DraftRecord = { cid: CID, lid: 'n1', body: '牛乳', title: '', base: '', at: 1, tab: 'X', append: true };
    expect(judgeAppendDraft(r, null)).toBe('gone');
    expect(judgeAppendDraft({ ...r, body: '  ' }, DISK)).toBe('same');
    expect(judgeAppendDraft(r, DISK), '本文に入っている字を「保存していない」と聞いた').toBe('same');
    expect(judgeAppendDraft({ ...r, body: 'パン' }, DISK)).toBe('plain');
  });
});

describe('追記欄の控えを戻す(draft-offer)', () => {
  function setup(setAppendText?: (lid: string, text: string) => Promise<boolean>) {
    const d = boot();
    const store = new MemoryDraftStore();
    const region = document.createElement('section');
    region.hidden = true;
    document.body.append(region);
    const say = vi.fn();
    const events: string[] = [];
    d.onEvent((e) => events.push(e.type));
    // 別のノートを見ている状態から戻す
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: '予定の本文' });
    const holder: { offer: DraftOffer | null } = { offer: null };
    const offer = createDraftOffer({
      region,
      dispatcher: d,
      store,
      cid: CID,
      tab: 'MAIN',
      now: () => 9_999_999,
      liveTabs: async () => new Set<string>(),
      readBody: async (lid) => (lid === 'n1' ? DISK : lid === 'n2' ? '予定の本文' : null),
      enterEdit: vi.fn(),
      setTitle: vi.fn(),
      enterPart: vi.fn(),
      setPartText: async () => true,
      copyText: async () => true,
      ...(setAppendText === undefined ? {} : { setAppendText }),
      say,
    });
    holder.offer = offer;
    return { d, store, region, offer, say, events };
  }
  const ap = (over: Partial<DraftRecord> = {}): DraftRecord => ({
    cid: CID, lid: 'n1', body: 'パンも買う', title: '', base: '', at: 10, tab: 'OLD', append: true, ...over,
  });

  it('1 行は「保存していない追記が残っています(題名)」。戻す = ノートを選んで欄へ字を入れる。書かない(disk は動かない)', async () => {
    const put = vi.fn(async () => true);
    const { d, store, region, offer, say, events } = setup(put);
    store.map.set(draftKey(CID, 'n1', true), ap());
    await offer.present();
    expect(region.querySelector('[data-pkc-field="draft-offer-text"]')?.textContent).toBe(
      '保存していない追記が残っています(買い物)',
    );
    expect(offer.has('n1', true)).toBe(true);
    expect(offer.has('n1'), '全文編集の控えと取り違えた').toBe(false);
    offer.restore();
    // n1 の本文が届くまで欄へは入れない
    expect(put).not.toHaveBeenCalled();
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: DISK });
    await flush();
    expect(put).toHaveBeenCalledWith('n1', 'パンも買う');
    expect(say).toHaveBeenCalledWith(DRAFT_APPEND_RESTORED_NOTE);
    expect(DRAFT_APPEND_RESTORED_NOTE).toContain('追記');
    expect(d.getState().selectedLid).toBe('n1');
    // 編集には入らない / disk へは書かない
    expect(d.getState().phase).toBe('ready');
    expect(events).not.toContain('PERSIST_ENTRY');
    expect(region.hidden, '戻したのに 1 行が残る').toBe(true);
  });

  it('欄が出なかった(false)なら「戻しました」と言わず、控えを残して 1 行を戻す', async () => {
    const { d, store, region, offer, say } = setup(async () => false);
    store.map.set(draftKey(CID, 'n1', true), ap());
    await offer.present();
    offer.restore();
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: DISK });
    await flush();
    expect(say).not.toHaveBeenCalledWith(DRAFT_APPEND_RESTORED_NOTE);
    expect(store.map.has(draftKey(CID, 'n1', true)), '入れなかったのに控えが消えた').toBe(true);
    expect(region.hidden, '1 行が戻っていない').toBe(false);
  });

  it('消す:追記欄の控えだけが消える(同じノートの全文編集の控えは残る)', async () => {
    const { store, offer } = setup(async () => true);
    store.map.set(draftKey(CID, 'n1', true), ap({ tab: 'OLD' }));
    store.map.set(draftKey(CID, 'n1'), {
      cid: CID, lid: 'n1', body: DISK + 'x\n', title: '買い物', base: fingerprint(DISK), at: 5, tab: 'OLD2',
    });
    await offer.present();
    // 新しい順:追記(at 10)が先頭
    offer.discard();
    expect(store.map.has(draftKey(CID, 'n1', true))).toBe(false);
    expect(store.map.has(draftKey(CID, 'n1')), '全文編集の控えまで消えた').toBe(true);
  });

  it('もう本文に入っている追記の控えは、聞かずに片付ける。自分のタブの打ちかけは聞かない(対照群)', async () => {
    const { store, region, offer } = setup(async () => true);
    store.map.set(draftKey(CID, 'n1', true), ap({ body: '牛乳' })); // DISK に入っている
    await offer.present();
    expect(region.hidden).toBe(true);
    expect(store.map.has(draftKey(CID, 'n1', true))).toBe(false);
    // 自分(MAIN)が打っている最中の控えは、聞き直しで 1 行に出さない
    store.map.set(draftKey(CID, 'n1', true), ap({ tab: 'MAIN' }));
    await offer.present();
    expect(region.hidden, '打っている最中の字を「残っています」と言った').toBe(true);
    expect(store.map.has(draftKey(CID, 'n1', true))).toBe(true);
  });
});

describe('main.ts の配線(main.ts はどの test からも実行されない ── 原文で pin する。弱いと自覚して使う)', () => {
  const main = readFileSync('src/main.ts', 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  it('別のウィンドウ(openedByUs)は印を放送し、本体は閉じたら探して、見つけたらメッセージに足す', () => {
    // 旗(heldNoteWindow など)は起動の後に立つので、ここでは読まない(読むと常に偽 = 放送されない)
    expect(main).toMatch(/if \(openedByUs\) \{\s*announceDraftTab\(draftTab, cid\);\s*\} else if \(draftOfferRef !== null\)/);
    expect(main).toMatch(/watchDraftTabs\(\{\s*cid,/);
    expect(main).toMatch(/offer\.leftBehind\(tab\)/);
    expect(main).toMatch(/appMessagePost\.post\(\{ kind: 'caution', source: 'draft', text: DRAFT_LEFT_MESSAGE \}\)/);
    // 追記欄の控え(依頼 330):書き手に欄の読み口を渡し、聞く側に欄への戻し口を渡す
    expect(main).toMatch(/readAppendText:/);
    expect(main).toMatch(/isAppendInput:/);
    expect(main).toMatch(/setAppendText:/);
  });
});

/**
 * 依頼 209(Gemini 回答:ペインの幅と畳み方は、窓ごとに別のままがよい。小さい窓だけ畳む使い方を守る)。
 * 変えない決めなので、コードを足さない ── 配色・文字の大きさ(`storage` を聞いて他の窓へ反映する)と違い、
 * ペインの幅と畳み方は他の窓の変更を聞かないことを pin する。
 */
describe('ペインの幅と畳み方は窓ごとに別(依頼 209)', () => {
  const code = (path: string): string =>
    readFileSync(path, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  it('対照群:配色の追従は storage を聞く(この検査が「聞いている」を見分けられる)', () => {
    expect(code('src/adapter/ui/render/theme.ts')).toContain("addEventListener('storage'");
  });
  it('ペインの幅・畳み方の 2 つの口は、他の窓の変更を聞かない', () => {
    for (const path of ['src/adapter/ui/render/pane-size.ts', 'src/adapter/ui/render/pane-visibility.ts']) {
      const src = code(path);
      expect(src.length, `${path} を読めていない`).toBeGreaterThan(500);
      expect(src, `${path} が他の窓の変更を聞いている(窓ごとに別、の決めに反する)`).not.toMatch(/['"]storage['"]/);
    }
  });
});
