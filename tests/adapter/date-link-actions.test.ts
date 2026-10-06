/** @vitest-environment happy-dom */
/**
 * 🔴 **本文の `@2026-10-15` を押すと、その日のノートが開く / 無ければ作るかを聞く**(#1169)。
 *
 * ⚠ 描画(押せる字になるか)は `tests/features/markdown-date-link.test.ts`、探し方の規則は
 * `tests/features/today-note.test.ts`。**ここが見るのは繋がり**である ──
 * 押した所から dispatch まで届くか / 断るときに理由が画面へ出るか / 作るのは「作る」を押した
 * ときだけか。
 *
 * 🔴 **無言で終わる枝を 1 つも持たない**ことを、いちばん強く見る(`open-today` は
 * `phase !== 'ready'` で黙って返すが、こちらはそれを写さない)。
 */
import { describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { paintStatusCreate } from '../../src/adapter/ui/render/status-open';

function meta(lid: string, title: string, over: Partial<EntryMeta> = {}): EntryMeta {
  return {
    lid,
    title,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: 0,
    ...over,
  };
}

function setup(metas: EntryMeta[], services: BinderServices = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const regions = buildShell(root);
  const d = new Dispatcher();
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  const showStatus = vi.fn();
  /**
   * ⚠ 状態の行の字は **`main.ts` の `noticeLine` と同じ作法**で持つ ── `OP_NOTICE` の字を
   *   行へ写し、押し口は `paintStatusCreate` が出し入れする。台が嘘をつかないよう、
   *   写す処理は 1 か所にする。
   */
  let line = '';
  const repaint = (): void => void paintStatusCreate(regions.statusCreate, d.getState(), line);
  d.onState((st) => {
    if (st.notice !== null && st.notice !== line) line = st.notice;
    repaint();
  });
  bindActions(root, d, {
    ...services,
    showStatus: (t, o) => {
      showStatus(t, o);
      line = t;
      repaint();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  sent.length = 0;
  /** 本文に出ている `@日付` を模す(描画そのものは別の test が見る)。 */
  const link = (date: string): HTMLElement => {
    const el = document.createElement('span');
    el.setAttribute('data-pkc-action', 'open-date-note');
    el.setAttribute('data-pkc-date', date);
    el.setAttribute('role', 'link');
    el.setAttribute('tabindex', '0');
    el.textContent = `@${date}`;
    root.append(el);
    return el;
  };
  const edit = (): void => {
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'other' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'other', body: '本文' });
    d.dispatch({ type: 'START_EDIT' });
  };
  return { root, regions, d, sent, showStatus, link, edit, repaint };
}

const created = (sent: Dispatchable[]): Array<Extract<Dispatchable, { type: 'CREATE_ENTRY' }>> =>
  sent.filter((a): a is Extract<Dispatchable, { type: 'CREATE_ENTRY' }> => a.type === 'CREATE_ENTRY');

describe('日付を押す(open-date-note)', () => {
  it('🔴 その日のノートが在れば、それを開く(作らない・聞かない)', () => {
    const { d, sent, link } = setup([meta('t', '2026-10-15'), meta('other', 'ほかのノート')]);
    link('2026-10-15').click();
    expect(sent).toContainEqual({ type: 'SELECT_ENTRY', lid: 't' });
    expect(d.getState().selectedLid, '開けていない').toBe('t');
    expect(created(sent), '在るのに作った').toEqual([]);
    expect(sent.some((a) => a.type === 'OP_NOTICE'), '在るのに「作る」を聞いた').toBe(false);
  });

  /**
   * 🔴 **押した時点では作らない**(打ち間違いの日付でノートが増えない)。
   * ⚠ 聞く字は画面の下の 1 行へ**直に**も書く ── 同じ知らせが続くと state の字が動かず、
   *   押したのに「作る」が出ない dead click になる(`binder.ts` の注記)。
   */
  it('🔴 無ければ作らず、「作る」を画面の下に出す', () => {
    const { d, sent, link, regions, showStatus } = setup([meta('other', 'ほかのノート')]);
    link('2026-10-15').click();
    expect(created(sent), '押しただけで作った').toEqual([]);
    expect(sent).toContainEqual({
      type: 'OP_NOTICE',
      message: '2026-10-15 のノートはまだありません',
      createDate: '2026-10-15',
    });
    // 🔴 積むのは上の `OP_NOTICE`(`main.ts` が結果として積む)── 画面下の直書きは積まない(1 件にする。#1017 C5)
    expect(showStatus).toHaveBeenCalledWith('2026-10-15 のノートはまだありません', { post: false });
    expect(d.getState().noticeCreate).toBe('2026-10-15');
    const btn = regions.statusCreate;
    expect(btn.hidden, '「作る」が出ていない').toBe(false);
    expect(btn.textContent).toBe('2026-10-15 のノートを作る');
    expect(btn.getAttribute('data-pkc-date')).toBe('2026-10-15');
    expect(btn.getAttribute('data-pkc-action')).toBe('create-date-note');
  });

  it('🔴 ゴミ箱の中の同じ題名は「在る」に数えない(開いても一覧に無い、にしない)', () => {
    const { sent, link } = setup([meta('old', '2026-10-15', { archived: true })]);
    link('2026-10-15').click();
    expect(sent.some((a) => a.type === 'SELECT_ENTRY'), 'ゴミ箱のノートを開いた').toBe(false);
    expect(sent.some((a) => a.type === 'OP_NOTICE')).toBe(true);
  });

  it('🔴 実在しない日の印(属性が書き換わった)は、作らず理由を言う', () => {
    const { d, sent, link } = setup([]);
    link('2026-02-31').click();
    expect(created(sent)).toEqual([]);
    expect(d.getState().error, '黙って終わった').toBe('日付の書き方が読めません');
  });

  /**
   * 🔴 **編集中は断り、理由を日付で名指しして言う**(「リンク先」ではない)。
   * ⚠ 在る / 無いのどちらでも同じ ── **無言の dead click を作らない**のが主張である。
   */
  it('🔴 編集中に押すと、在っても理由が出て動かない', () => {
    const { d, sent, link, edit } = setup([meta('t', '2026-10-15'), meta('other', 'ほか')]);
    edit();
    expect(d.getState().phase, '前提: 編集に入れていない').toBe('editing');
    sent.length = 0;
    link('2026-10-15').click();
    expect(d.getState().error, '黙って断った(押したのに何も出ない)').toBe(
      '編集を終了してから2026-10-15 のノートを開いてください',
    );
    expect(d.getState().selectedLid, '編集中に選択を動かした').toBe('other');
    expect(sent.some((a) => a.type === 'SELECT_ENTRY' && a.lid === 't')).toBe(false);
  });

  it('🔴 編集中に押すと、無くても理由が出る(作るかも聞かない)', () => {
    const { d, sent, link, edit } = setup([meta('other', 'ほか')]);
    edit();
    sent.length = 0;
    link('2026-10-15').click();
    expect(d.getState().error).toBe('編集を終了してから2026-10-15 のノートを開いてください');
    expect(sent.some((a) => a.type === 'OP_NOTICE'), '編集中に「作る」を出した').toBe(false);
    expect(created(sent)).toEqual([]);
  });

  it('⚠ 取り込み・書き出しの最中でも、開くことは止めない(読むだけ)', () => {
    const { sent, link } = setup([meta('t', '2026-10-15')], { busy: () => true });
    link('2026-10-15').click();
    expect(sent).toContainEqual({ type: 'SELECT_ENTRY', lid: 't' });
  });

  it('⚠ キーボード(Enter)でも押せる(tabindex="0" の既存の道に乗る)', () => {
    const { sent, link } = setup([meta('t', '2026-10-15')]);
    const el = link('2026-10-15');
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(sent, 'Enter で開かない(焦点が乗るのに押せない)').toContainEqual({
      type: 'SELECT_ENTRY',
      lid: 't',
    });
  });
});

describe('「○○のノートを作る」を押す(create-date-note)', () => {
  /** 日付を押して「作る」を出し、その口を返す。 */
  const offer = (s: ReturnType<typeof setup>, date: string): HTMLElement => {
    s.link(date).click();
    s.sent.length = 0;
    return s.regions.statusCreate;
  };

  it('🔴 その日付を題名にして作り、開く(編集には入らない)', () => {
    const s = setup([meta('other', 'ほか')]);
    const btn = offer(s, '2026-10-15');
    btn.click();
    const c = created(s.sent);
    expect(c, '作っていない').toHaveLength(1);
    expect(c[0]!.title, '題名が日付でない').toBe('2026-10-15');
    expect(c[0]!.archetype).toBe('text');
    // 🔑 編集に入らない ── 読んでいた本文から日付を押しただけで、書く気になったとは限らない
    expect(c[0]!.edit, '編集に入る作りになっている').toBe(false);
    const st = s.d.getState();
    expect(st.phase, '編集に入った').toBe('ready');
    expect(st.selectedLid, '作ったノートを開いていない').toBe(c[0]!.lid);
    expect(st.entryMetas.get(c[0]!.lid)?.title).toBe('2026-10-15');
  });

  it('🔴 作ったら「作る」の口は畳まれ、知らせが変わる(押し直せない)', () => {
    const s = setup([meta('other', 'ほか')]);
    const btn = offer(s, '2026-10-15');
    btn.click();
    expect(s.d.getState().notice).toBe('2026-10-15 のノートを作りました');
    expect(btn.hidden, '作った後も「作る」が残っている').toBe(true);
  });

  /** 🔑 押す前に別の窓などが作っていたら、2 つ目を作らずに開く(日の入れ物は 1 つ)。 */
  it('🔴 聞いている間に在るようになったら、作らずにそれを開く', () => {
    const s = setup([meta('other', 'ほか')]);
    const btn = offer(s, '2026-10-15');
    s.d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('other', 'ほか'), meta('late', '2026-10-15', { entryOrder: 2 })],
      relations: [],
    });
    s.sent.length = 0;
    btn.click();
    expect(created(s.sent), '在るのに 2 つ目を作った').toEqual([]);
    expect(s.d.getState().selectedLid).toBe('late');
  });

  it('🔴 編集に入ったら口は出ず、押されても作らず理由を言う', () => {
    const s = setup([meta('other', 'ほか')]);
    const btn = offer(s, '2026-10-15');
    expect(btn.hidden).toBe(false);
    s.edit();
    s.repaint();
    expect(btn.hidden, '編集中なのに「作る」が出ている(押しても断られるだけ)').toBe(true);
    // それでも押された(口が畳まれる前に押した / 古い口が残った)ときは、黙らず断る
    s.sent.length = 0;
    const stale = document.createElement('button');
    stale.setAttribute('data-pkc-action', 'create-date-note');
    stale.setAttribute('data-pkc-date', '2026-10-15');
    s.root.append(stale);
    stale.click();
    expect(created(s.sent), '編集の裏でノートを作った').toEqual([]);
    expect(s.d.getState().error).toBe('編集を終了してから2026-10-15 のノートを開いてください');
  });

  it('🔴 取り込み・書き出しの最中は作らず、理由を言う(`CREATE_ENTRY` は即永続)', () => {
    const s = setup([meta('other', 'ほか')], { busy: () => true });
    const btn = offer(s, '2026-10-15');
    btn.click();
    expect(created(s.sent), '取り込みの裏でノートを作った').toEqual([]);
    expect(s.d.getState().error, '黙って断った').toBe(
      '書き出し / 取り込みが実行中です。完了してから操作してください',
    );
  });

  it('🔴 別の知らせに字が替わったら、前の日付の「作る」は消える', () => {
    const s = setup([meta('other', 'ほか')]);
    const btn = offer(s, '2026-10-15');
    expect(btn.hidden).toBe(false);
    s.d.dispatch({ type: 'OP_NOTICE', message: 'コピーしました' });
    expect(btn.hidden, '別の知らせの隣に前の日付の「作る」が残っている').toBe(true);
  });
});
