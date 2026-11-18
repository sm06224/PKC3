/** @vitest-environment happy-dom */
/**
 * 🔴 **その場の小さなプレーヤー**(#1966 4-3 ②。user 裁定 2026-11-17)── 押し口・鳴らし方・寿命。
 *
 * - 別のノートに書いた `[0:15](entry:<録音>#t=15)` を押すと、ノートを移らずに段落の下にプレーヤーが出て 0:15 から鳴る
 * - 「録音のノートを開く」で録音へ移ってその時刻から鳴る / 「×」で閉じる
 * - 閉じる・別のノートへ移る・本文が描き直されて外れる、のどれでも借りた URL を返す(1 度だけ)
 * - 録音の長さを超える時刻は鳴らさず言う / 音・動画でない添付は言う
 * - 録音のノートの中の引用・読む口の無い配線は、今までどおり録音のノートを開く(4-3 ①)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions, runChapterWindowAction, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { attachmentBody } from '../../src/features/flavor/attachment-flavor';
import {
  closeInlinePlayer,
  INLINE_PLAYER_BEYOND,
  INLINE_PLAYER_NOT_MEDIA,
} from '../../src/adapter/ui/render/inline-player';
import type { EntryMeta } from '../../src/core/model/entry-meta';

function meta(lid: string, archetype = 'text', title = `題-${lid}`): EntryMeta {
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

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

let created: string[];
let revoked: string[];
let played: number;

beforeEach(() => {
  created = [];
  revoked = [];
  played = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const u = `blob:x${String(created.length)}`;
    created.push(u);
    return u;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => {
    revoked.push(u);
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    played += 1;
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
});
afterEach(() => {
  closeInlinePlayer();
  document.body.textContent = '';
  vi.restoreAllMocks();
});

function setup(opts: { mime?: string; services?: boolean; blobType?: string } = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  const recBody = attachmentBody({ name: '会議.webm', mime: opts.mime ?? 'audio/webm', size: 3, assetKey: 'ast-1' });
  const services: BinderServices =
    opts.services === false
      ? {}
      : {
          readNoteBody: async (lid) => (lid === 'rec' ? recBody : null),
          readAssetBlob: async (key) => (key === 'ast-1' ? new Blob(['x'], { type: opts.blobType ?? 'audio/webm' }) : null),
        };
  const unbind = bindActions(root, d, services);
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('rec', 'attachment', '会議の録音'), meta('meet'), meta('other')],
    relations: [],
  });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'meet' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'meet', body: '> [0:15](entry:rec#t=15) 字' });
  const detail = root.querySelector<HTMLElement>('[data-pkc-region="detail"]')!;
  const quote = document.createElement('blockquote');
  const a = document.createElement('a');
  a.setAttribute('href', 'entry:rec#t=15');
  a.setAttribute('data-pkc-action', 'navigate-entry-ref');
  a.setAttribute('data-pkc-entry-ref', 'entry:rec#t=15');
  a.textContent = '0:15';
  quote.append(a, document.createTextNode(' 字'));
  detail.append(quote);
  const box = (): HTMLElement | null => root.querySelector('[data-pkc-field="inline-player"]');
  const media = (): HTMLMediaElement | null => root.querySelector('[data-pkc-field="inline-player-media"]');
  const loaded = (duration: number): void => {
    const m = media()!;
    Object.defineProperty(m, 'duration', { value: duration, configurable: true });
    m.dispatchEvent(new Event('loadedmetadata'));
  };
  return { root, d, a, quote, box, media, loaded, unbind, services, detail };
}

describe('その場で鳴らす', () => {
  it('🔴 ノートを移らずに、引用の段落のすぐ下にプレーヤーが出て、その時刻から鳴る', async () => {
    const { d, a, quote, box, media, loaded } = setup();
    a.click();
    await settle();
    expect(d.getState().selectedLid, 'ノートを移った(その場で鳴らしていない)').toBe('meet');
    expect(box(), 'プレーヤーが出ない').not.toBeNull();
    expect(quote.nextElementSibling, '引用の段落の直後に出ていない').toBe(box());
    expect(box()!.textContent).toContain('会議.webm ── 0:15 から');
    expect(media()!.getAttribute('src')).toBe('blob:x0');
    loaded(600);
    expect(media()!.currentTime).toBe(15);
    expect(played).toBe(1);
  });

  it('🔴 「×」で閉じると、借りた URL を返す(1 度だけ)', async () => {
    const { a, box } = setup();
    a.click();
    await settle();
    box()!.querySelector<HTMLButtonElement>('[data-pkc-action="inline-player-close"]')!.click();
    expect(box()).toBeNull();
    expect(revoked).toEqual(['blob:x0']);
    closeInlinePlayer();
    expect(revoked, '2 度返した').toEqual(['blob:x0']);
  });

  it('🔴 もう 1 度押すと、前のプレーヤーを返してから新しく出す(同時に 1 枚)', async () => {
    const { root, a } = setup();
    a.click();
    await settle();
    a.click();
    await settle();
    expect(root.querySelectorAll('[data-pkc-field="inline-player"]')).toHaveLength(1);
    expect(revoked).toEqual(['blob:x0']);
  });

  it('🔴 別のノートへ移ると閉じて返す / 本文が描き直されて外れても返す', async () => {
    const s1 = setup();
    s1.a.click();
    await settle();
    s1.d.dispatch({ type: 'SELECT_ENTRY', lid: 'other' });
    expect(s1.box()).toBeNull();
    expect(revoked).toEqual(['blob:x0']);
    document.body.textContent = '';
    const s2 = setup();
    s2.a.click();
    await settle();
    s2.quote.parentElement!.textContent = '';
    await settle();
    expect(revoked, '描き直しで外れたのに返していない').toEqual(['blob:x0', 'blob:x1']);
  });

  it('⚠ 実体を借りている間に閉じたら、遅れて借りた URL もすぐ返す(器も再生機も差さない)', async () => {
    let release: (b: Blob | null) => void = () => undefined;
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const d = new Dispatcher();
    bindActions(root, d, {
      readNoteBody: async () => attachmentBody({ name: 'r.webm', mime: 'audio/webm', size: 1, assetKey: 'k' }),
      readAssetBlob: () => new Promise<Blob | null>((r) => (release = r)),
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('rec', 'attachment'), meta('meet')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'meet' });
    const a = document.createElement('a');
    a.setAttribute('data-pkc-action', 'navigate-entry-ref');
    a.setAttribute('data-pkc-entry-ref', 'entry:rec#t=15');
    const p = document.createElement('p');
    p.append(a);
    root.querySelector('[data-pkc-region="detail"]')!.append(p);
    a.click();
    await settle();
    closeInlinePlayer();
    release(new Blob(['x']));
    await settle();
    expect(created, '借りていない(この検査の前提)').toHaveLength(1);
    expect(revoked, '閉じた後に借りた URL を返していない').toEqual(created);
    expect(root.querySelector('[data-pkc-field="inline-player-media"]')).toBeNull();
  });

  it('🔴 「録音のノートを開く」で録音へ移り、プレーヤーは閉じる', async () => {
    const { d, a, box } = setup();
    a.click();
    await settle();
    box()!.querySelector<HTMLButtonElement>('[data-pkc-action="inline-player-open-note"]')!.click();
    expect(d.getState().selectedLid).toBe('rec');
    expect(box()).toBeNull();
    expect(revoked).toEqual(['blob:x0']);
  });

  it('⚠ 録音の長さを超える時刻は鳴らさずに言う', async () => {
    const { a, box, loaded } = setup();
    a.click();
    await settle();
    loaded(10);
    expect(played).toBe(0);
    expect(box()!.textContent).toContain(INLINE_PLAYER_BEYOND);
  });

  it('⚠ 音・動画でない添付は鳴らさずに、そう言う(借りない)', async () => {
    const { a, box, media } = setup({ mime: 'application/pdf' });
    a.click();
    await settle();
    expect(media()).toBeNull();
    expect(box()!.textContent).toContain(INLINE_PLAYER_NOT_MEDIA);
    expect(created).toEqual([]);
  });

  it('⚠ 保存した種類が汎用(octet-stream)でも、実体が音なら鳴らす / 実体も音でなければ言う', async () => {
    const ok = setup({ mime: 'application/octet-stream', blobType: 'audio/ogg' });
    ok.a.click();
    await settle();
    expect(ok.media()?.tagName).toBe('AUDIO');
    closeInlinePlayer();
    document.body.textContent = '';
    const ng = setup({ mime: 'application/octet-stream', blobType: 'application/zip' });
    ng.a.click();
    await settle();
    expect(ng.media()).toBeNull();
    expect(ng.box()!.textContent).toContain(INLINE_PLAYER_NOT_MEDIA);
    expect(revoked, '借りた物を返していない').toEqual(created.slice(0, 1));
  });

  it('🔴 動画の録音は <video> で出す', async () => {
    const { a, media } = setup({ mime: 'video/webm' });
    a.click();
    await settle();
    expect(media()?.tagName).toBe('VIDEO');
  });

  it('🔴 閉じるときは再生機を止めて src を外す(鳴りっぱなしにしない)', async () => {
    const { a, media } = setup();
    a.click();
    await settle();
    const m = media()!;
    const paused = vi.spyOn(m, 'pause');
    closeInlinePlayer();
    expect(paused).toHaveBeenCalled();
    expect(m.getAttribute('src')).toBeNull();
  });

  it('🔴 横に留めた別のノートの枠で押しても、開いているノートが変わらない間は閉じない', async () => {
    const { d, a, box, detail } = setup();
    const frame = document.createElement('div');
    frame.setAttribute('data-pkc-split-lid', 'other');
    detail.append(frame);
    frame.append(a.closest('blockquote')!);
    a.click();
    await settle();
    expect(box()).not.toBeNull();
    // 別の状態の変化(開いているノートは meet のまま)
    d.dispatch({ type: 'BODY_LOADED', lid: 'meet', body: '> [0:15](entry:rec#t=15) 字\n' });
    expect(box(), '開いているノートは同じなのに閉じた').not.toBeNull();
  });

  it('🔴 畳むとき(unbind)に閉じて返す', async () => {
    const { a, box, unbind } = setup();
    a.click();
    await settle();
    (unbind as () => void)();
    expect(box()).toBeNull();
    expect(revoked).toEqual(['blob:x0']);
  });

  it('⚠ 章の別ウィンドウで押したリンクは、今までどおり本体で録音を開く(窓の中にプレーヤーを出さない)', async () => {
    const { d, root, services } = setup();
    const other = document.implementation.createHTMLDocument('窓');
    const a = other.createElement('a');
    a.setAttribute('data-pkc-action', 'navigate-entry-ref');
    a.setAttribute('data-pkc-entry-ref', 'entry:rec#t=15');
    other.body.append(a);
    expect(runChapterWindowAction(d, a, services, root)).toBe(true);
    await settle();
    expect(other.querySelector('[data-pkc-field="inline-player"]')).toBeNull();
    expect(root.querySelector('[data-pkc-field="inline-player"]')).toBeNull();
    expect(d.getState().selectedLid).toBe('rec');
  });
});

describe('今までどおり開く道(4-3 ①)', () => {
  it('🔴 読む口の無い配線では、録音のノートを開く', async () => {
    const { d, a, box } = setup({ services: false });
    a.click();
    await settle();
    expect(box()).toBeNull();
    expect(d.getState().selectedLid).toBe('rec');
  });

  it('🔴 録音のノートの中で押した引用は、同じ画面の再生機で鳴らす(その場のプレーヤーは出さない)', async () => {
    const { d, a, box } = setup();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'rec' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'rec', body: 'x' });
    a.click();
    await settle();
    expect(box()).toBeNull();
    expect(d.getState().selectedLid).toBe('rec');
  });
});
