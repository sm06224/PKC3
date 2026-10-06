/**
 * 窓から届いた「ノートへ引く」を、本体が**親ノートの末尾へ追記**する(#275 段①)。
 *
 * 守るもの:①引く先は結びついたノート(無ければ添付自身)②書くのは**既存の追記**(`REQUEST_APPEND`)で、
 * 頁番号と添付名が引用に付く ③追記が断られる回(保存中 / 編集中)は**通ったことにしない**
 * ④窓の言い分(lid)を信じない(`session.lid` から本体が解く)
 * ⑤🔴 **「引きました」は disk に着いてから**(`ENTRY_APPENDED`)── 錠を掛けた時点では言わない。
 *   失敗(`APPEND_FAILED`)なら理由を返し、結末が来なければ**時間切れ**で断る。
 * ⚠ reducer と Dispatcher は**実物**。effect(worker への書込)だけは置けないので、**結末の ack を
 *   test が撃つ**(`ENTRY_APPENDED` / `APPEND_FAILED` ── effect が撃つものと同じ action)。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { initialState, reduce, type DomainEvent } from '../../src/adapter/state/app-state';
import {
  QUOTE_SETTLE_TIMEOUT_MESSAGE,
  QUOTE_SETTLE_TIMEOUT_MS,
  quoteIntoNote,
  type QuoteTimers,
} from '../../src/adapter/platform/pdf/quote-into-note';
import type { PdfSession } from '../../src/adapter/platform/pdf/pdf-window';
import type { EntryMeta, Relation } from '../../src/core/model/entry-meta';

function meta(lid: string, archetype: string, title = `題-${lid}`): EntryMeta {
  return {
    lid,
    title,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}
function rel(id: string, fromLid: string, toLid: string, kind: string): Relation {
  return { id, fromLid, toLid, kind, createdAt: null, updatedAt: null };
}

function rig(metas: EntryMeta[], relations: Relation[]): {
  d: Dispatcher;
  events: DomainEvent[];
  notes: string[];
} {
  const booted = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas, relations }).state;
  const d = new Dispatcher(booted);
  const events: DomainEvent[] = [];
  d.onEvent((e) => events.push(e));
  return { d, events, notes: [] };
}
const session = (lid: string | null, name = '報告書.pdf'): PdfSession => ({
  token: 't',
  assetKey: 'k',
  name,
  lid,
});
/** 時計の台(時間切れを手で撃つ)。 */
function clock(): { timers: QuoteTimers; fire(): void; set: { fn: () => void; ms: number; live: boolean }[] } {
  const set: { fn: () => void; ms: number; live: boolean }[] = [];
  return {
    set,
    timers: {
      setTimer: (fn, ms) => {
        const t = { fn, ms, live: true };
        set.push(t);
        return t;
      },
      clearTimer: (h) => {
        (h as { live: boolean }).live = false;
      },
    },
    fire: () => {
      for (const t of set) if (t.live) t.fn();
    },
  };
}
/** effect が disk に着いたあとに撃つ ack(成功)。 */
function ackOk(d: Dispatcher, lid: string, body = 'x'): void {
  d.dispatch({
    type: 'ENTRY_APPENDED',
    lid,
    gen: d.getState().lockGen,
    body,
    status: null,
    date: null,
    archived: false,
    inserted: [body],
  });
}
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};
const appended = (events: DomainEvent[]) =>
  events.filter((e): e is Extract<DomainEvent, { type: 'REQUEST_APPEND' }> => e.type === 'REQUEST_APPEND');

describe('quoteIntoNote', () => {
  it('結びついたノートの末尾へ、頁番号と添付名つきの引用として追記する', async () => {
    const g = rig(
      [meta('att', 'attachment'), meta('memo', 'text', 'メモ')],
      [rel('r1', 'memo', 'att', 'semantic')],
    );
    const p = quoteIntoNote(g.d, session('att'), '結論は\n次のとおり', 7, (t) => g.notes.push(t));
    const ev = appended(g.events);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.lid).toBe('memo');
    expect(ev[0]?.text).toBe('> 結論は\n> 次のとおり (p.7、報告書.pdf)');
    expect(ev[0]?.target).toBeNull(); // 末尾
    ackOk(g.d, 'memo');
    const r = await p;
    expect(r).toEqual({ ok: true, message: '「メモ」の末尾へ引用しました(7 ページ)' });
    expect(g.notes).toEqual(['「メモ」の末尾へ引用しました(7 ページ)']);
  });

  it('結びついたノートが無ければ、添付のノート自身へ追記する', async () => {
    const g = rig([meta('att', 'attachment', '添付題')], []);
    const p = quoteIntoNote(g.d, session('att'), 'x', 1, (t) => g.notes.push(t));
    expect(appended(g.events)[0]?.lid).toBe('att');
    ackOk(g.d, 'att');
    expect((await p).ok).toBe(true);
  });

  it('頁番号を落とさない(出典の頁がそのまま本文に載る)', async () => {
    const g = rig([meta('att', 'attachment')], []);
    const p = quoteIntoNote(g.d, session('att'), 'x', 42, () => undefined);
    expect(appended(g.events)[0]?.text).toContain('(p.42、報告書.pdf)');
    ackOk(g.d, 'att'); // 待ちを畳む(時計を残さない)
    expect((await p).message).toContain('42 ページ');
  });

  it('lid を持たない窓・消えたノート・空の選びは、書かずに理由を返す', async () => {
    const g = rig([meta('att', 'attachment')], []);
    expect((await quoteIntoNote(g.d, session(null), 'x', 1, () => undefined)).ok).toBe(false);
    expect((await quoteIntoNote(g.d, session('gone'), 'x', 1, () => undefined)).ok).toBe(false);
    expect((await quoteIntoNote(g.d, session('att'), '  \n ', 1, () => undefined)).ok).toBe(false);
    expect(appended(g.events)).toEqual([]);
  });

  it('🔴 追記が断られる回(書込中)は、通ったことにしない ── 状態の行にも出さない', async () => {
    const g = rig([meta('att', 'attachment')], []);
    const first = quoteIntoNote(g.d, session('att'), 'a', 1, (t) => g.notes.push(t));
    // 錠が掛かったまま(書込の結果がまだ戻っていない)2 つ目を引く
    const second = await quoteIntoNote(g.d, session('att'), 'b', 1, (t) => g.notes.push(t));
    expect(second.ok).toBe(false);
    expect(second.message.length).toBeGreaterThan(0);
    expect(appended(g.events)).toHaveLength(1);
    expect(g.notes).toEqual([]); // 2 つ目は断られ、1 つ目はまだ着いていない
    ackOk(g.d, 'att');
    expect((await first).ok).toBe(true);
    expect(g.notes).toHaveLength(1);
  });

  it('🔴 錠を掛けただけでは「引きました」と言わない ── 結末(disk に着いた)まで待つ', async () => {
    const g = rig([meta('att', 'attachment', '添付題')], []);
    let settled = false;
    const p = quoteIntoNote(g.d, session('att'), 'x', 1, (t) => g.notes.push(t)).then((r) => {
      settled = true;
      return r;
    });
    await flush();
    // 錠は掛かっている(= 直す前なら、この時点で ok:true を返していた)
    expect(g.d.getState().writeLock).not.toBeNull();
    expect(settled, '錠を掛けた時点で返事をしている').toBe(false);
    expect(g.notes).toEqual([]);
    ackOk(g.d, 'att');
    expect((await p).ok).toBe(true);
    expect(settled).toBe(true);
    expect(g.notes).toEqual(['「添付題」の末尾へ引用しました(1 ページ)']);
  });

  it('🔴 追記が失敗した(APPEND_FAILED)なら、理由を返し、「引きました」とは言わない', async () => {
    const g = rig([meta('att', 'attachment')], []);
    const p = quoteIntoNote(g.d, session('att'), 'x', 1, (t) => g.notes.push(t));
    g.d.dispatch({
      type: 'APPEND_FAILED',
      lid: 'att',
      gen: g.d.getState().lockGen,
      error: '別のウィンドウがこのノートを書き換えたため、追記できませんでした(もう一度押してください)',
    });
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toContain('別のウィンドウ');
    expect(g.notes).toEqual([]);
  });

  it('🔴 結末が来なければ時間切れで断る(窓を待たせ続けない)── 後から着いても言い直さない', async () => {
    const g = rig([meta('att', 'attachment')], []);
    const c = clock();
    const p = quoteIntoNote(g.d, session('att'), 'x', 1, (t) => g.notes.push(t), c.timers);
    expect(c.set.map((t) => t.ms)).toEqual([QUOTE_SETTLE_TIMEOUT_MS]);
    c.fire();
    const r = await p;
    expect(r).toEqual({ ok: false, message: QUOTE_SETTLE_TIMEOUT_MESSAGE });
    // 断ったあとに ack が来ても、状態の行へ「引きました」を出さない(窓は既に違うことを聞いている)
    ackOk(g.d, 'att');
    expect(g.notes).toEqual([]);
  });

  it('🔴 別のノートの結末は、自分の結末にしない(lid を見る)', async () => {
    const g = rig([meta('att', 'attachment')], []);
    const c = clock();
    let settled = false;
    const p = quoteIntoNote(g.d, session('att'), 'x', 1, (t) => g.notes.push(t), c.timers).then((r) => {
      settled = true;
      return r;
    });
    // 同じ世代の、別のノートの結末(錠は解ける ── 自分の追記が着いたわけではない)
    ackOk(g.d, 'other');
    await flush();
    expect(settled, '別のノートの結末で「引けた」と言っている').toBe(false);
    expect(g.notes).toEqual([]);
    c.fire();
    expect((await p).message).toBe(QUOTE_SETTLE_TIMEOUT_MESSAGE);
  });

  it('対照群: 結末が時間内に来たら時計は外れ、時間切れの字は出ない', async () => {
    const g = rig([meta('att', 'attachment')], []);
    const c = clock();
    const p = quoteIntoNote(g.d, session('att'), 'x', 1, () => undefined, c.timers);
    ackOk(g.d, 'att');
    expect((await p).ok).toBe(true);
    expect(c.set.every((t) => !t.live)).toBe(true);
  });

  it('編集中のノート自身へは引けない(別のノートへの追記は通る)', async () => {
    const g = rig(
      [meta('att', 'attachment'), meta('memo', 'text', 'メモ')],
      [rel('r1', 'memo', 'att', 'semantic')],
    );
    // memo を編集中にする(`START_EDIT` の不変量どおり openBody を伴う)
    const st = g.d.getState();
    const editing = {
      ...st,
      phase: 'editing' as const,
      openBody: { lid: 'memo', body: 'x', baseline: 'x', persisted: 'x', diskAhead: false },
    };
    const d2 = new Dispatcher(editing);
    const ev: DomainEvent[] = [];
    d2.onEvent((e) => ev.push(e));
    const r = await quoteIntoNote(d2, session('att'), 'x', 1, () => undefined);
    expect(r.ok).toBe(false);
    expect(appended(ev)).toEqual([]);
  });
});

describe('APPEND_SETTLED(追記の結末)── 呼び側が「着いた」と言える唯一の根拠', () => {
  const locked = () => {
    const g = rig([meta('att', 'attachment')], []);
    void quoteIntoNote(g.d, session('att'), 'x', 1, () => undefined, clock().timers);
    return g;
  };
  const settled = (events: DomainEvent[]) =>
    events.filter((e): e is Extract<DomainEvent, { type: 'APPEND_SETTLED' }> => e.type === 'APPEND_SETTLED');

  it('成功 / 失敗のそれぞれで 1 つだけ出て、lid と世代と理由を運ぶ', () => {
    const ok = locked();
    ackOk(ok.d, 'att');
    expect(settled(ok.events)).toEqual([{ type: 'APPEND_SETTLED', lid: 'att', gen: 0, ok: true, error: null }]);

    const ng = locked();
    ng.d.dispatch({ type: 'APPEND_FAILED', lid: 'att', gen: 0, error: '保存できません' });
    expect(settled(ng.events)).toEqual([
      { type: 'APPEND_SETTLED', lid: 'att', gen: 0, ok: false, error: '保存できません' },
    ]);
  });

  it('🔴 世代の合わない ack(強制解放の後着)からは出さない ── 画面を動かさない ack を結末に数えない', () => {
    const g = locked();
    g.d.dispatch({ type: 'FORCE_RELEASE_LOCK', discardDraft: false });
    expect(g.d.getState().lockGen).toBe(1);
    g.d.dispatch({
      type: 'ENTRY_APPENDED',
      lid: 'att',
      gen: 0,
      body: 'x',
      status: null,
      date: null,
      archived: false,
      inserted: ['x'],
    });
    g.d.dispatch({ type: 'APPEND_FAILED', lid: 'att', gen: 0, error: 'e' });
    expect(settled(g.events)).toEqual([]);
  });

  it('着いたのにノートが state から消えていた回は、「引けた」にせず失敗として出す', () => {
    const g = locked();
    // 再 boot で一覧が入れ替わった(同じ錠の世代のまま、ノートだけ居ない)
    const gone = new Dispatcher({ ...g.d.getState(), entryMetas: new Map() });
    const ev: DomainEvent[] = [];
    gone.onEvent((e) => ev.push(e));
    ackOk(gone, 'att');
    expect(settled(ev).map((e) => e.ok)).toEqual([false]);
  });
});
