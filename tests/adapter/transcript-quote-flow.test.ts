/** @vitest-environment happy-dom */
/**
 * 🔴 **文字起こし ⇄ ノートのタイムライン**(#1966 4-3 ①。user 裁定 2026-11-17 = 案 B の 1 段目)── 押し口と流れ。
 *
 * - 行の末尾の「ノートへ引用」を押すと、入れ先(留めた枠 → 結びつき → 直前のノート → 録音自身)の末尾へ
 *   `> [0:15](entry:<録音>#t=15) 字` が**既存の追記**で入る(結末まで待って知らせる。「元に戻す」は追記と同じ)
 * - 引用のリンク(`entry:<録音>#t=15`)を押すと、録音のノートが開いてその時刻から鳴る
 * - 鳴っている間、光る行が画面の外へ出たら送る(入 / 切つき。既定は入)
 * ⚠ reducer・Dispatcher・binder は実物。effect(worker への書込)だけは置けないので、追記の結末の ack を test が撃つ。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { appTranscriptFollow } from '../../src/adapter/ui/render/transcript-follow';
import type { EntryMeta } from '../../src/core/model/entry-meta';

function meta(lid: string, archetype = 'text'): EntryMeta {
  return {
    lid,
    title: `題-${lid}`,
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

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function fakeAudio(paused = false): { el: HTMLAudioElement; time: () => number; play: ReturnType<typeof vi.fn> } {
  const el = document.createElement('audio');
  el.setAttribute('data-pkc-field', 'attachment-media');
  let t = 0;
  Object.defineProperty(el, 'currentTime', { get: () => t, set: (v: number) => (t = v), configurable: true });
  Object.defineProperty(el, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(el, 'duration', { value: 600, configurable: true });
  Object.defineProperty(el, 'seekable', { value: { length: 1 }, configurable: true });
  Object.defineProperty(el, 'paused', { get: () => paused, configurable: true });
  const play = vi.fn(() => Promise.resolve());
  Object.defineProperty(el, 'play', { value: play, configurable: true });
  return { el, time: () => t, play };
}

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  bindActions(root, d, {});
  raw({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('rec', 'attachment'), meta('meet'), meta('other')],
    relations: [],
  });
  // 議事録(meet)を開いてから、録音(rec)を開いた
  raw({ type: 'SELECT_ENTRY', lid: 'meet' });
  raw({ type: 'BODY_LOADED', lid: 'meet', body: '議事録' });
  raw({ type: 'SELECT_ENTRY', lid: 'rec' });
  raw({ type: 'BODY_LOADED', lid: 'rec', body: '0:15 見積は来週\n0:30 **次**の件\n' });
  // 録音の詳細(説明 + 再生機)を模す
  const detail = root.querySelector<HTMLElement>('[data-pkc-region="detail"]')!;
  const host = document.createElement('div');
  const prose = document.createElement('div');
  prose.setAttribute('data-pkc-prose', '');
  prose.innerHTML = renderMarkdown('0:15 見積は来週\n0:30 **次**の件\n', { interactiveSeek: true });
  const preview = document.createElement('div');
  preview.setAttribute('data-pkc-field', 'attachment-preview');
  host.append(preview, prose);
  detail.append(host);
  const quote = (i: number): HTMLButtonElement =>
    [...prose.querySelectorAll<HTMLButtonElement>('[data-pkc-action="quote-transcript-line"]')][i]!;
  const appends = (): Array<{ lid: string; text: string }> =>
    sent.flatMap((a) => (a.type === 'APPEND_TO_ENTRY' ? [{ lid: a.lid, text: a.text }] : []));
  const ack = (lid: string): void =>
    d.dispatch({
      type: 'ENTRY_APPENDED',
      lid,
      gen: d.getState().lockGen,
      body: 'x',
      status: null,
      date: null,
      archived: false,
      inserted: ['x'],
    });
  return { root, d, sent, prose, preview, quote, appends, ack };
}

afterEach(() => {
  document.body.textContent = '';
  appTranscriptFollow.set(true);
  vi.useRealTimers();
});

describe('ノートへ引用', () => {
  it('🔴 行の末尾に押し口がある。押し口は字を持たない(行の字・コピーを汚さない)', () => {
    const { prose, quote } = setup();
    expect(quote(0).getAttribute('aria-label')).toBe('この行をノートへ引用');
    expect(quote(0).textContent).toBe('');
    expect([...prose.querySelectorAll('[data-pkc-seek-line]')].map((l) => l.textContent)).toEqual([
      '0:15 見積は来週',
      '0:30 次の件',
    ]);
  });

  it('🔴 押すと直前に開いていたノートの末尾へ時刻つきの引用が入り、着いてから知らせる', async () => {
    const { d, quote, appends, ack } = setup();
    quote(0).click();
    await settle();
    expect(appends()).toEqual([{ lid: 'meet', text: '> [0:15](entry:rec#t=15) 見積は来週' }]);
    expect(d.getState().notice ?? '', '着く前に知らせた').not.toContain('引用しました');
    ack('meet');
    await settle();
    expect(d.getState().notice).toBe('『題-meet』の末尾へ 0:15 の行を引用しました');
    // 「開く」の身元(知らせの隣の押し口)は入れ先
    expect(d.getState().noticeOpen).toBe('meet');
  });

  it('🔴 横に留めた枠があれば、そちらが入れ先。記法は描いた後の字(** は残らない)', async () => {
    const { d, quote, appends } = setup();
    d.dispatch({ type: 'PIN_SPLIT_ENTRY', lid: 'other' });
    expect(d.getState().splitLids, '横に留められていない(この検査の前提)').toContain('other');
    quote(1).click();
    await settle();
    expect(appends()).toEqual([{ lid: 'other', text: '> [0:30](entry:rec#t=30) 次の件' }]);
  });

  it('🔴 「戻る」で録音へ戻ってきたなら、離れたばかりのノートへ入る(履歴の未来の先頭)', async () => {
    const { d, quote, appends } = setup();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'other' });
    d.dispatch({ type: 'NAV_HISTORY', dir: 'back' });
    expect(d.getState().selectedLid, '戻れていない(この検査の前提)').toBe('rec');
    quote(0).click();
    await settle();
    expect(appends().map((a) => a.lid)).toEqual(['other']);
  });

  it('⚠ 終わりつきの行(0:07 〜0:12 字)は、終わりの時刻を字に入れない', async () => {
    const { prose, appends } = setup();
    prose.innerHTML = renderMarkdown('0:07 〜0:12 区切りのある字\n', { interactiveSeek: true });
    prose.querySelector<HTMLButtonElement>('[data-pkc-action="quote-transcript-line"]')!.click();
    await settle();
    expect(appends()).toEqual([{ lid: 'meet', text: '> [0:07](entry:rec#t=7) 区切りのある字' }]);
  });

  it('⚠ 追記が断られたら(編集中など)理由を出す / 知らせは出さない', async () => {
    const { d, quote } = setup();
    // 入れ先(meet)へ書けない状態 ── 書込の錠を先に掛けておく
    d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'meet', text: '先客', heading: null, target: null });
    quote(0).click();
    await settle();
    expect(d.getState().error ?? '').not.toBe('');
    expect(d.getState().notice ?? '').not.toContain('引用しました');
  });
});

describe('引用のリンクから鳴らす', () => {
  it('🔴 entry:<録音>#t=15 を押すと録音のノートが開き、その時刻から鳴る', async () => {
    const { root, d, preview } = setup();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'meet' });
    const m = fakeAudio(true);
    preview.append(m.el);
    const a = document.createElement('a');
    a.setAttribute('href', 'entry:rec#t=15');
    a.setAttribute('data-pkc-action', 'navigate-entry-ref');
    a.setAttribute('data-pkc-entry-ref', 'entry:rec#t=15');
    root.append(a);
    a.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(d.getState().selectedLid).toBe('rec');
    expect(m.time(), 'その時刻へ移っていない').toBe(15);
    expect(m.play).toHaveBeenCalledTimes(1);
  });

  it('⚠ 再生機が来なければ黙らずに言う', async () => {
    const { root, d, preview } = setup();
    preview.textContent = '';
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'meet' });
    const a = document.createElement('a');
    a.setAttribute('data-pkc-action', 'navigate-entry-ref');
    a.setAttribute('data-pkc-entry-ref', 'entry:rec#t=15');
    root.append(a);
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    a.click();
    for (let i = 0; i < 80; i += 1) {
      vi.advanceTimersByTime(50);
      await settle();
    }
    expect(d.getState().notice).toBe('このノートには再生できる音・動画がありません');
  });
});

describe('再生に合わせて送る', () => {
  function playing(paused: boolean) {
    const s = setup();
    const m = fakeAudio(paused);
    s.preview.append(m.el);
    const lines = [...s.prose.querySelectorAll<HTMLElement>('[data-pkc-seek-line]')];
    const scrolled: string[] = [];
    for (const l of lines) l.scrollIntoView = () => scrolled.push(l.textContent ?? '');
    const move = (sec: number): void => {
      m.el.currentTime = sec;
      m.el.dispatchEvent(new Event('timeupdate'));
    };
    return { ...s, move, scrolled };
  }

  it('🔴 鳴っている間、光る行が変わるたびにその行へ送る(既定は入)', () => {
    const { move, scrolled } = playing(false);
    move(16);
    move(17);
    move(31);
    expect(scrolled).toEqual(['0:15 見積は来週', '0:30 次の件']);
  });

  it('🔴 「再生に合わせて送る」を切ると送らない / 止まっているときも送らない', () => {
    appTranscriptFollow.set(false);
    const off = playing(false);
    off.move(16);
    expect(off.scrolled).toEqual([]);
    appTranscriptFollow.set(true);
    document.body.textContent = '';
    const paused = playing(true);
    paused.move(16);
    expect(paused.scrolled, '止まっているのに送った').toEqual([]);
  });

  it('🔴 入 / 切の欄を押すと、好みが変わる', () => {
    const { root } = setup();
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.setAttribute('data-pkc-action', 'toggle-transcript-follow');
    root.append(box);
    box.click();
    expect(appTranscriptFollow.enabled()).toBe(false);
    box.click();
    expect(appTranscriptFollow.enabled()).toBe(true);
  });
});
