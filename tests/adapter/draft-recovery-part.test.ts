/** @vitest-environment happy-dom */
/**
 * 章の欄 / コード枠の欄に打っていた字の控えと復元(#1728)── 控える側(draft-writer)と聞く側(draft-offer)を
 * 本物の Dispatcher / 本物の reducer につないで通す。全文編集の控え(`draft-recovery.test.ts`)の隣の検査。
 *
 * 守るもの:
 * - 欄に打った字が、全文編集と同じ置き場・同じ間隔で控えられる(どの欄か + 開いたときの原文つき)
 * - 保存が disk に着いた / 欄をやめた で控えが消える。別の場所の操作で閉じられたときは消えない
 * - 「戻す」:欄を開き直し、打っていた字が入る。disk は動かない
 * - 🔴 欄が見つからない / 変わっている:書かない。打った字をコピーで渡し、控えは残す
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectDraftWriter } from '../../src/adapter/platform/draft-writer';
import { MemoryDraftStore } from '../../src/adapter/platform/draft-store';
import {
  DRAFT_ENTER_FAILED_NOTE,
  DRAFT_RESTORED_NOTE,
  createDraftOffer,
  draftPartCopyFailedNote,
  draftPartRefusedNote,
  type DraftOffer,
} from '../../src/adapter/ui/render/draft-offer';
import {
  DRAFT_BYTES_MAX,
  fingerprint,
  isDraftPart,
  partMovedTail,
  type DraftClock,
  type DraftPart,
  type DraftRecord,
} from '../../src/features/draft/draft-recovery';
import { judgePartDraft, locateDraftPart } from '../../src/features/draft/draft-part';
import { isCodeDraft } from '../../src/adapter/state/app-state';

const CID = 'c1';
const NOTE = '# 買い物\n牛乳\n\n## 予定\n会議\n\n```js\nlet a = 1;\n```\n';
const SECTION_LINE = 3; // `## 予定`
const CODE_LINE = 6; // ```js
const SECTION_FIELD = 'section-draft-input';
const CODE_FIELD = 'code-draft-input';

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

function boot(body = NOTE): Dispatcher {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: CID, metas: [meta('n1', '買い物'), meta('n2', '予定')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
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

/** 欄(textarea)を画面に置く ── 実物は `section-box.ts` / `code-box.ts`。 */
function putBox(field: string, value: string): HTMLTextAreaElement {
  document.body.querySelectorAll('textarea').forEach((e) => e.remove());
  const ta = document.createElement('textarea');
  ta.setAttribute('data-pkc-field', field);
  ta.value = value;
  document.body.append(ta);
  return ta;
}
function type(ta: HTMLTextAreaElement, text: string): void {
  ta.value = text;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

const partDeps = {
  readPartText: (): string | null =>
    document.querySelector<HTMLTextAreaElement>(`[data-pkc-field="${SECTION_FIELD}"], [data-pkc-field="${CODE_FIELD}"]`)
      ?.value ?? null,
  isPartInput: (el: Element): boolean => [SECTION_FIELD, CODE_FIELD].includes(el.getAttribute('data-pkc-field') ?? ''),
};

function openSection(d: Dispatcher): { original: string; ta: HTMLTextAreaElement } {
  d.dispatch({ type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: SECTION_LINE });
  const sd = d.getState().sectionDraft;
  if (sd == null) throw new Error('前提が崩れている:章の欄が開いていない');
  return { original: sd.original, ta: putBox(SECTION_FIELD, sd.original) };
}
function openCode(d: Dispatcher): { original: string; ta: HTMLTextAreaElement } {
  d.dispatch({ type: 'OPEN_CODE_DRAFT', lid: 'n1', line: CODE_LINE });
  const sd = d.getState().sectionDraft;
  if (sd == null || !isCodeDraft(sd)) throw new Error('前提が崩れている:コード枠の欄が開いていない');
  return { original: sd.original, ta: putBox(CODE_FIELD, sd.original) };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('draft-writer(欄に打った字を控える側)', () => {
  function setup(tab = 'A', isPending?: (lid: string) => boolean) {
    const d = boot();
    const store = new MemoryDraftStore();
    const f = fakeClock();
    const ended: [string, boolean][] = [];
    const w = connectDraftWriter({
      dispatcher: d,
      store,
      cid: CID,
      tab,
      clock: f.clock,
      readTitle: () => null,
      ...partDeps,
      ...(isPending === undefined ? {} : { isPending }),
      onEnded: (lid, committed) => ended.push([lid, committed]),
    });
    const settle = async (ms = 1000) => {
      f.advance(ms);
      await w.settled();
    };
    return { d, store, f, w, settle, ended };
  }

  it('章の欄:開いただけでは控えない。打って 1 秒止まると、字・どの章か・開いたときの原文つきで控える', async () => {
    const { d, store, settle } = setup();
    const { original, ta } = openSection(d);
    await settle(10_000);
    expect(store.map.size).toBe(0);
    type(ta, original + '追記\n');
    await settle(999);
    expect(store.map.size, '1 秒の手前で控えた').toBe(0);
    await settle(1);
    const [rec] = [...store.map.values()];
    expect(rec).toMatchObject({
      cid: CID,
      lid: 'n1',
      body: original + '追記\n',
      title: '',
      tab: 'A',
      base: fingerprint(original),
      part: { kind: 'section', heading: '予定', original },
    });
  });

  it('コード枠の欄:字・枠の身元(行・開きの行・引用の深さ)・原文つきで控える', async () => {
    const { d, store, settle } = setup();
    const { original, ta } = openCode(d);
    expect(original).toBe('let a = 1;');
    type(ta, 'let a = 2;');
    await settle();
    const [rec] = [...store.map.values()];
    expect(rec?.body).toBe('let a = 2;');
    expect(rec?.part).toEqual({ kind: 'code', line: CODE_LINE, openLine: '```js', quote: 0, original: 'let a = 1;' });
  });

  it('打ち続けても 5 秒で必ず控える(全文編集と同じ間隔)', async () => {
    const { d, store, f, w } = setup();
    const { original, ta } = openSection(d);
    for (let i = 1; i <= 8; i++) {
      type(ta, original + 'x'.repeat(i));
      f.advance(700);
    }
    await w.settled();
    expect(store.map.size, '5 秒を超えても控えていない').toBe(1);
  });

  it('🔴 打って元に戻したら控えを消す / 2 MB を超えたら控えない(古い控えも消す)', async () => {
    const { d, store, settle } = setup();
    const { original, ta } = openSection(d);
    type(ta, original + 'a');
    await settle();
    expect(store.map.size).toBe(1);
    type(ta, original);
    await settle();
    expect(store.map.size, '元の字に戻したのに、古い字が控えに残っている').toBe(0);
    type(ta, original + 'a');
    await settle();
    expect(store.map.size).toBe(1);
    type(ta, 'あ'.repeat(Math.ceil(DRAFT_BYTES_MAX / 3) + 1));
    await settle();
    expect(store.map.size, '大きすぎる字を控えた / 古い控えが残った').toBe(0);
  });

  it('欄の外の input では控えない(対照群)', async () => {
    const { d, store, settle } = setup();
    const { original } = openSection(d);
    const other = document.createElement('input');
    document.body.append(other);
    other.value = 'x';
    other.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(10_000);
    expect(original).not.toBe('');
    expect(store.map.size).toBe(0);
  });

  it('🔴 欄をやめると控えが消える(自分が書いた控えだけ ── 別のタブの控えは残す)', async () => {
    const { d, store, settle, ended } = setup('A');
    const { original, ta } = openSection(d);
    type(ta, original + 'a');
    await settle();
    expect(store.map.size).toBe(1);
    d.dispatch({ type: 'CANCEL_SECTION_DRAFT' });
    await settle(10);
    expect(store.map.size, 'やめたのに控えが残っている').toBe(0);
    expect(ended).toEqual([['n1', false]]);
    // 対照群:別のタブが書いた控えは、こちらのやめるで消えない
    const { original: o2, ta: ta2 } = openSection(d);
    type(ta2, o2 + 'b');
    await settle();
    store.map.set(`${CID}\u0000n1`, { ...store.map.get(`${CID}\u0000n1`)!, tab: 'OTHER' });
    d.dispatch({ type: 'CANCEL_SECTION_DRAFT' });
    await settle(10);
    expect(store.map.size, '別のタブの控えを消した').toBe(1);
  });

  it('🔴 保存が disk に着いたら(SECTION_SAVED)控えが消える。committed で知らせる', async () => {
    const { d, store, settle, ended } = setup();
    const { original, ta } = openSection(d);
    type(ta, original + 'a');
    await settle();
    expect(store.map.size).toBe(1);
    d.dispatch({ type: 'SAVE_SECTION_DRAFT', text: original + 'a' });
    // 保存中(まだ disk に着いていない)── 控えは残す
    await settle(10);
    expect(store.map.size, '着く前に消した(書込が落ちた回に字がどこにも残らない)').toBe(1);
    d.dispatch({
      type: 'SECTION_SAVED',
      lid: 'n1',
      gen: d.getState().lockGen,
      heading: '予定',
      body: NOTE.replace('会議', '会議a'),
      status: null,
      date: null,
      archived: false,
    });
    await settle(10);
    expect(d.getState().sectionDraft).toBeNull();
    expect(store.map.size, '保存が着いたのに控えが残っている').toBe(0);
    expect(ended).toEqual([['n1', true]]);
  });

  it('🔴 保存が断られた(SECTION_SAVE_FAILED)ときは欄が残る ── 控えも残る', async () => {
    const { d, store, settle } = setup();
    const { original, ta } = openSection(d);
    type(ta, original + 'a');
    await settle();
    d.dispatch({ type: 'SAVE_SECTION_DRAFT', text: original + 'a' });
    d.dispatch({ type: 'SECTION_SAVE_FAILED', lid: 'n1', gen: d.getState().lockGen, heading: '予定', error: 'x' });
    await settle(10);
    expect(d.getState().sectionDraft).not.toBeNull();
    expect(store.map.size).toBe(1);
  });

  it('🔴 別の場所の操作で閉じられた(ノートが消えた)ときは控えを消さない ── 打った字の最後の置き場', async () => {
    const { d, store, settle, ended } = setup();
    const { original, ta } = openSection(d);
    type(ta, original + 'a');
    await settle();
    d.dispatch({ type: 'SYS_BOOTED', cid: CID, metas: [meta('n2', '予定')], relations: [] });
    expect(d.getState().sectionDraft, '前提:別の場所の操作で閉じた').toBeNull();
    await settle(10);
    expect(store.map.size, '閉じられただけで字を失った').toBe(1);
    expect(ended).toEqual([['n1', false]]);
  });

  it('🔴 答えていない控えが在るノートは、欄を打っても上書きしない', async () => {
    const pending = new Set(['n1']);
    const { d, store, settle } = setup('NEW', (lid) => pending.has(lid));
    const old: DraftRecord = {
      cid: CID, lid: 'n1', body: '古い字', title: '', base: 'x', at: 1, tab: 'OLD',
      part: { kind: 'section', heading: '予定', original: 'o' },
    };
    store.map.set(`${CID}\u0000n1`, old);
    const { original, ta } = openSection(d);
    type(ta, original + 'a');
    await settle();
    expect(store.map.get(`${CID}\u0000n1`)).toBe(old);
    // 対照群:答えが済めば書く
    pending.clear();
    type(ta, original + 'ab');
    await settle();
    expect(store.map.get(`${CID}\u0000n1`)?.body).toBe(original + 'ab');
  });

  it('欄の控えを取る口(readPartText)を渡していない書き手は、欄を控えない', async () => {
    const d = boot();
    const store = new MemoryDraftStore();
    const f = fakeClock();
    const w = connectDraftWriter({ dispatcher: d, store, cid: CID, tab: 'A', clock: f.clock, readTitle: () => null });
    const { original, ta } = openSection(d);
    type(ta, original + 'a');
    f.advance(10_000);
    await w.settled();
    expect(store.map.size).toBe(0);
  });
});

describe('draft-offer(欄の控えを戻す側)', () => {
  function offerSetup(
    opts: {
      disk?: string | null;
      screen?: string;
      copy?: (t: string) => Promise<boolean>;
      /** 欄を開く口を差し替える(ロック待ちで遅れる開き方を作る)。 */
      enterPart?: (kind: DraftPart['kind'], line: number) => void;
      /** 字を入れる口の答え(既定 = 入れられた)。 */
      put?: boolean;
    } = {},
  ) {
    const d = boot(opts.screen ?? NOTE);
    const store = new MemoryDraftStore();
    const region = document.createElement('section');
    region.hidden = true;
    document.body.append(region);
    const say = vi.fn();
    const copyText = vi.fn(opts.copy ?? (async () => true));
    const f = fakeClock();
    const holder: { offer: DraftOffer | null } = { offer: null };
    const w = connectDraftWriter({
      dispatcher: d,
      store,
      cid: CID,
      tab: 'NEW',
      clock: f.clock,
      readTitle: () => null,
      ...partDeps,
      isPending: (lid) => holder.offer?.has(lid) === true,
      onEnded: (lid, committed) => holder.offer?.editEnded(lid, committed),
      isRestoring: (lid) => holder.offer?.isRestoring(lid) === true,
    });
    const enterPart = vi.fn(
      opts.enterPart ??
        ((kind: DraftPart['kind'], line: number) => {
          d.dispatch(
            kind === 'code' ? { type: 'OPEN_CODE_DRAFT', lid: 'n1', line } : { type: 'OPEN_SECTION_DRAFT', lid: 'n1', line },
          );
        }),
    );
    const setPartText = vi.fn(async (text: string) => {
      if (opts.put === false) return false;
      const sd = d.getState().sectionDraft;
      const ta = putBox(sd != null && isCodeDraft(sd) ? CODE_FIELD : SECTION_FIELD, text);
      type(ta, text);
      return true;
    });
    const offer = createDraftOffer({
      region,
      dispatcher: d,
      store,
      cid: CID,
      tab: 'NEW',
      now: () => 9_999_999,
      liveTabs: async () => new Set<string>(),
      readBody: async (lid) => (lid === 'n1' ? (opts.disk === undefined ? NOTE : opts.disk) : '予定の本文'),
      enterEdit: vi.fn(),
      enterPart,
      setPartText,
      copyText,
      setTitle: vi.fn(),
      say,
    });
    holder.offer = offer;
    return { d, store, region, say, offer, copyText, enterPart, setPartText, f, w };
  }
  const SECTION_ORIGINAL = '## 予定\n会議\n\n```js\nlet a = 1;\n```\n';
  const sectionDraft = (over: Partial<DraftRecord> = {}): DraftRecord => ({
    cid: CID, lid: 'n1', body: SECTION_ORIGINAL + '打った字\n', title: '', base: fingerprint(SECTION_ORIGINAL),
    at: 10, tab: 'OLD', part: { kind: 'section', heading: '予定', original: SECTION_ORIGINAL }, ...over,
  });
  const codeDraft = (): DraftRecord => ({
    cid: CID, lid: 'n1', body: 'let a = 2;', title: '', base: fingerprint('let a = 1;'), at: 10, tab: 'OLD',
    part: { kind: 'code', line: CODE_LINE, openLine: '```js', quote: 0, original: 'let a = 1;' },
  });
  const put = (store: MemoryDraftStore, r: DraftRecord): void => {
    store.map.set(`${r.cid}\u0000${r.lid}`, r);
  };
  const key = `${CID}\u0000n1`;
  const textarea = (): HTMLTextAreaElement | null => document.querySelector('textarea');
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('章の欄の控えは「章の編集」と言い、[戻す][消す] を出す', async () => {
    const { store, region, offer } = offerSetup();
    put(store, sectionDraft());
    await offer.present();
    expect(region.hidden).toBe(false);
    expect(region.querySelector('[data-pkc-field="draft-offer-text"]')?.textContent).toBe(
      '保存していない章の編集が残っています(買い物)',
    );
    expect([...region.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['戻す', '消す']);
  });

  it('戻す(章):欄を同じ章で開き直し、打っていた字が入る。disk は動かず、控えはまだ残る', async () => {
    const { d, store, offer, say } = offerSetup();
    const events: string[] = [];
    d.onEvent((e) => events.push(e.type));
    put(store, sectionDraft());
    await offer.present();
    offer.restore();
    const sd = d.getState().sectionDraft;
    expect(sd?.lid).toBe('n1');
    expect(sd != null && !isCodeDraft(sd) ? sd.heading : null).toBe('予定');
    expect(textarea()?.value).toBe(SECTION_ORIGINAL + '打った字\n');
    await flush();
    expect(say).toHaveBeenCalledWith(DRAFT_RESTORED_NOTE);
    expect(events).not.toContain('REQUEST_SECTION_SAVE');
    expect(store.map.has(key), '欄に入れても控えは消さない(保存が着くまで)').toBe(true);
  });

  it('戻す(コード枠):枠を開き直し、打っていた字が入る', async () => {
    const { d, store, offer } = offerSetup();
    put(store, codeDraft());
    await offer.present();
    expect(document.querySelector('[data-pkc-field="draft-offer-text"]')?.textContent).toBe(
      '保存していないコードの編集が残っています(買い物)',
    );
    offer.restore();
    const sd = d.getState().sectionDraft;
    expect(sd != null && isCodeDraft(sd)).toBe(true);
    expect(textarea()?.value).toBe('let a = 2;');
  });

  it('🔴 戻した欄を保存すると、保存が着いたあと控えが消え、1 行も出ない', async () => {
    const { d, store, offer, f, w } = offerSetup();
    put(store, sectionDraft());
    await offer.present();
    offer.restore();
    d.dispatch({ type: 'SAVE_SECTION_DRAFT', text: textarea()!.value });
    expect(store.map.has(key), '着く前に消した').toBe(true);
    d.dispatch({
      type: 'SECTION_SAVED', lid: 'n1', gen: d.getState().lockGen, heading: '予定',
      body: NOTE.replace('会議', '会議!'), status: null, date: null, archived: false,
    });
    f.advance(10);
    await w.settled();
    await flush();
    expect(store.map.has(key)).toBe(false);
    expect(document.querySelector('section')?.hidden).toBe(true);
  });

  it('🔴 戻した欄をやめると、控えが消える(死んだタブが書いた控えでも)。1 行は戻らない', async () => {
    const { d, store, offer, f, w, region } = offerSetup();
    put(store, sectionDraft({ tab: 'DEAD' }));
    await offer.present();
    offer.restore();
    // まだ打ち足していない(書き手が自分の控えに置き換える前)にやめる
    d.dispatch({ type: 'CANCEL_SECTION_DRAFT' });
    // 読み直し(非同期)より先に ── やめた控えの 1 行が一瞬でも戻らない
    expect(region.hidden, 'やめた直後に、消えるはずの控えの 1 行が出た').toBe(true);
    f.advance(10);
    await w.settled();
    await flush();
    expect(store.map.has(key), '戻した控えが、やめても残っている').toBe(false);
    expect(region.hidden, 'やめたのに 1 行がまた出た').toBe(true);
  });

  it('🔴 章が変わっていたら(disk)戻さない:書き込まず、打った字をコピーで渡し、控えと 1 行は残す', async () => {
    // 画面の本文は古いまま(章の原文に一致)── 画面側の検査では止まらず、読み込み時の判定だけが止める
    const { d, store, region, offer, copyText, say, enterPart } = offerSetup({
      disk: NOTE.replace('会議', '会議が変わった'),
    });
    put(store, sectionDraft());
    await offer.present();
    expect(region.querySelector('[data-pkc-field="draft-offer-text"]')?.textContent).toContain(partMovedTail('section'));
    offer.restore();
    await flush();
    expect(enterPart, '変わった章を開いた').not.toHaveBeenCalled();
    expect(d.getState().sectionDraft).toBeNull();
    expect(copyText).toHaveBeenCalledWith(SECTION_ORIGINAL + '打った字\n');
    expect(say).toHaveBeenCalledWith(draftPartRefusedNote('section'));
    expect(store.map.has(key), '字の最後の置き場を消した').toBe(true);
    expect(region.hidden).toBe(false);
  });

  it('🔴 章が見つからない(見出しが消えた)ときも同じ ── 戻さずコピーで渡す', async () => {
    const { store, offer, copyText, enterPart } = offerSetup({ disk: '# 買い物\n牛乳\n' });
    put(store, sectionDraft());
    await offer.present();
    offer.restore();
    await flush();
    expect(enterPart).not.toHaveBeenCalled();
    expect(copyText).toHaveBeenCalledTimes(1);
  });

  it('🔴 待つ間に画面の本文が変わっていたら(読み込み時は戻せた)開く直前の探し直しで止める', async () => {
    // disk は原文のまま(戻せると判定)だが、画面の本文は章が変わっている
    const { d, store, offer, copyText, enterPart, region } = offerSetup({ screen: NOTE.replace('会議', '別の会議') });
    put(store, sectionDraft());
    await offer.present();
    expect(region.querySelector('[data-pkc-field="draft-offer-text"]')?.textContent).not.toContain('戻せません');
    offer.restore();
    await flush();
    expect(enterPart).not.toHaveBeenCalled();
    expect(d.getState().sectionDraft).toBeNull();
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(store.map.has(key)).toBe(true);
    expect(region.hidden, '止めたら 1 行を戻す').toBe(false);
  });

  it('🔴 開く口が遅れる間に同じノートの別の章が開いたら、字は別の章へ入れない:コピーで渡し、控えは残す', async () => {
    // ロック待ちで OPEN が遅れる ── その間に利用者が先頭の章(# 買い物)を開く
    const { d, store, offer, copyText, setPartText, say } = offerSetup({ enterPart: () => {} });
    put(store, sectionDraft());
    await offer.present();
    offer.restore();
    expect(d.getState().sectionDraft, '前提:まだ欄は開いていない').toBeNull();
    d.dispatch({ type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 0 });
    const sd = d.getState().sectionDraft;
    expect(sd != null && !isCodeDraft(sd) ? sd.heading : null, '前提:別の章が開いた').toBe('買い物');
    await flush();
    expect(setPartText, '別の章へ字を入れた').not.toHaveBeenCalled();
    expect(copyText).toHaveBeenCalledWith(SECTION_ORIGINAL + '打った字\n');
    expect(say).toHaveBeenCalledWith(draftPartRefusedNote('section', 'other'));
    expect(say).not.toHaveBeenCalledWith(DRAFT_RESTORED_NOTE);
    expect(store.map.has(key), '控えを消した').toBe(true);
  });

  it('🔴 同じ見出しでも原文が変わった章が開いたら、字を入れない(身元は見出し + 開いたときの原文)', async () => {
    const { d, store, offer, copyText, setPartText } = offerSetup({ enterPart: () => {} });
    put(store, sectionDraft());
    await offer.present();
    offer.restore();
    // 開く口が遅れる間に、別の場所で「予定」の中身が書き換わって届く
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: NOTE.replace('会議', '別の会議') });
    d.dispatch({ type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: SECTION_LINE });
    const sd = d.getState().sectionDraft;
    expect(sd != null && !isCodeDraft(sd) ? sd.heading : null, '前提:同じ見出しの章が開いた').toBe('予定');
    expect(sd?.original, '前提:原文は控えの物と違う').not.toBe(SECTION_ORIGINAL);
    await flush();
    expect(setPartText, '原文が変わった章へ字を入れた').not.toHaveBeenCalled();
    expect(copyText).toHaveBeenCalledTimes(1);
  });

  it('🔴 字を入れる口が入れられなかった(欄が出ない)なら「戻しました」と言わない。控えは残す', async () => {
    const { store, offer, say, setPartText } = offerSetup({ put: false });
    put(store, sectionDraft());
    await offer.present();
    offer.restore();
    await flush();
    expect(setPartText).toHaveBeenCalledTimes(1);
    expect(say).not.toHaveBeenCalledWith(DRAFT_RESTORED_NOTE);
    expect(say).toHaveBeenCalledWith(DRAFT_ENTER_FAILED_NOTE);
    expect(store.map.has(key)).toBe(true);
  });

  it('コピーできなかったときは、そう言って控えを残す', async () => {
    const { store, offer, say } = offerSetup({ disk: '# 買い物\n', copy: async () => false });
    put(store, sectionDraft());
    await offer.present();
    offer.restore();
    await flush();
    expect(say).toHaveBeenCalledWith(draftPartCopyFailedNote('section'));
    expect(draftPartCopyFailedNote('section')).toContain('「戻す」');
    expect(store.map.has(key)).toBe(true);
  });

  it('保存済みの字と同じ(欄はもう保存されている)/ ノートが無い:聞かず、控えを片付ける', async () => {
    const saved = NOTE.replace('会議', '会議\n打った字').replace('会議\n打った字', '会議');
    // 打った字 = 章の全文。disk の章がそれと同じ
    const d1 = offerSetup({ disk: NOTE.replace(SECTION_ORIGINAL, SECTION_ORIGINAL + '打った字\n') });
    put(d1.store, sectionDraft());
    await d1.offer.present();
    expect(d1.region.hidden, '保存済みなのに聞いた').toBe(true);
    expect(d1.store.map.size).toBe(0);
    expect(saved).toBeTruthy();
    const d2 = offerSetup({ disk: null });
    put(d2.store, sectionDraft());
    await d2.offer.present();
    expect(d2.region.hidden).toBe(true);
    expect(d2.store.map.size).toBe(0);
  });

  it('消す:控えが消える。ノートの本文は動かない', async () => {
    const { d, store, offer, region } = offerSetup();
    put(store, sectionDraft());
    await offer.present();
    offer.discard();
    await flush();
    expect(store.map.size).toBe(0);
    expect(region.hidden).toBe(true);
    expect(d.getState().openBody?.body).toBe(NOTE);
  });

  it('編集中(欄が開いている)に押されたら戻さない:理由を言い、控えは残す', async () => {
    const { d, store, offer, say, enterPart } = offerSetup();
    put(store, sectionDraft());
    await offer.present();
    d.dispatch({ type: 'OPEN_CODE_DRAFT', lid: 'n1', line: CODE_LINE });
    offer.restore();
    expect(enterPart).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledTimes(1);
    expect(store.map.size).toBe(1);
  });
});

describe('locateDraftPart / judgePartDraft / isDraftPart(純関数)', () => {
  const sec: DraftPart = { kind: 'section', heading: '予定', original: '## 予定\n会議\n\n```js\nlet a = 1;\n```\n' };
  const code: DraftPart = { kind: 'code', line: 6, openLine: '```js', quote: 0, original: 'let a = 1;' };

  it('章:名前で探し、原文が同じなら行(frontmatter を剥がした側)を返す。0 個 / 2 個 / 原文違いは理由つきで断る', () => {
    expect(locateDraftPart(NOTE, sec)).toEqual({ ok: true, line: SECTION_LINE });
    // frontmatter があっても、返す行は剥がした側
    const fm = '---\ntitle: x\n---\n' + NOTE;
    expect(locateDraftPart(fm, sec)).toEqual({ ok: true, line: SECTION_LINE });
    expect(locateDraftPart('# 買い物\n', sec)).toEqual({ ok: false, reason: 'missing' });
    expect(locateDraftPart(NOTE + '\n## 予定\nもう一つ\n', sec)).toEqual({ ok: false, reason: 'ambiguous' });
    expect(locateDraftPart(NOTE.replace('会議', '別'), sec)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('枠:身元で探す。中身が変わっていれば断る。行がずれても身元が同じなら見つける', () => {
    expect(locateDraftPart(NOTE, code)).toEqual({ ok: true, line: CODE_LINE });
    expect(locateDraftPart('追加の行\n' + NOTE, code)).toEqual({ ok: true, line: CODE_LINE + 1 });
    expect(locateDraftPart(NOTE.replace('let a = 1;', 'let a = 9;'), code).ok).toBe(false);
  });

  it('judgePartDraft:gone / same / plain / moved(「same」は打った字がいまの欄と同じ)', () => {
    const rec = (part: DraftPart, body: string): DraftRecord & { part: DraftPart } => ({
      cid: CID, lid: 'n1', body, title: '', base: '', at: 1, tab: 'T', part,
    });
    expect(judgePartDraft(rec(sec, 'x'), null)).toBe('gone');
    expect(judgePartDraft(rec(sec, 'x'), NOTE)).toBe('plain');
    expect(judgePartDraft(rec(sec, 'x'), NOTE.replace('会議', '別'))).toBe('moved');
    expect(judgePartDraft(rec(sec, '## 予定\n別\n'), '# 買い物\n\n## 予定\n別\n')).toBe('same');
    expect(judgePartDraft(rec(code, 'let a = 2;'), NOTE)).toBe('plain');
    expect(judgePartDraft(rec(code, 'let a = 2;'), NOTE.replace('let a = 1;', 'let a = 2;'))).toBe('same');
    expect(judgePartDraft(rec(code, 'let a = 2;'), NOTE.replace('let a = 1;', 'let a = 3;'))).toBe('moved');
  });

  it('isDraftPart:形が壊れた物は欄の控えと読まない(別の欄を開かない)', () => {
    expect(isDraftPart(sec)).toBe(true);
    expect(isDraftPart(code)).toBe(true);
    expect(isDraftPart({ kind: 'section', original: 'x' })).toBe(false);
    expect(isDraftPart({ kind: 'code', line: '6', openLine: '', quote: 0, original: '' })).toBe(false);
    expect(isDraftPart({ kind: 'x', original: '' })).toBe(false);
    expect(isDraftPart(null)).toBe(false);
  });
});
