/** @vitest-environment happy-dom */
/**
 * 🔴 **文字起こしの行頭の時刻を押すと、同じ詳細の再生機がその位置から鳴る**(#1232 段 b)。
 *
 * ⚠ 描画(押せる字になるか)は `tests/features/markdown-seek-link.test.ts`、どの面が旗を立てるかは
 * `tests/adapter/detail-seek-links.test.ts`。**ここが見るのは繋がり**である ──
 * 押した所から再生機まで届くか / **別の添付の再生機を動かさないか** / 再生機がまだ無いときに
 * **黙らず**次にすることを言うか。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';

interface FakeMedia {
  el: HTMLAudioElement;
  play: ReturnType<typeof vi.fn>;
  time: () => number;
}

/** 本物の `<audio>` に、`readyState` / `duration` / `seekable` / `play` / `currentTime` を差す(happy-dom は鳴らさない)。 */
function fakeAudio(
  over: { readyState?: number; duration?: number; seekable?: number; play?: () => Promise<void> } = {},
): FakeMedia {
  const el = document.createElement('audio');
  el.setAttribute('data-pkc-field', 'attachment-media');
  let t = 0;
  Object.defineProperty(el, 'currentTime', { get: () => t, set: (v: number) => (t = v), configurable: true });
  Object.defineProperty(el, 'readyState', { value: over.readyState ?? 4, configurable: true });
  Object.defineProperty(el, 'duration', { value: over.duration ?? 600, configurable: true });
  Object.defineProperty(el, 'seekable', {
    value: { length: over.seekable ?? 1 },
    configurable: true,
  });
  const play = vi.fn(over.play ?? (() => Promise.resolve()));
  Object.defineProperty(el, 'play', { value: play, configurable: true });
  return { el, play, time: () => t };
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
  /**
   * 添付の詳細の形を模す ── 説明の器(`data-pkc-prose`)と再生機の器(`attachment-preview`)は
   * **同じ host の兄弟**(`detail.ts` の `renderAttachment`)。
   */
  const detail = (ms: string, media: FakeMedia | null) => {
    const host = document.createElement('div');
    const prose = document.createElement('div');
    prose.setAttribute('data-pkc-prose', '');
    const link = document.createElement('span');
    link.setAttribute('data-pkc-action', 'seek-media');
    link.setAttribute('data-pkc-seek-ms', ms);
    link.setAttribute('role', 'button');
    link.setAttribute('tabindex', '0');
    link.textContent = '0:15';
    prose.append(link);
    const preview = document.createElement('div');
    preview.setAttribute('data-pkc-field', 'attachment-preview');
    if (media !== null) preview.append(media.el);
    host.append(prose, preview);
    root.append(host);
    return link;
  };
  const notices = (): string[] =>
    sent.flatMap((a) => (a.type === 'OP_NOTICE' ? [a.message] : []));
  return { root, d, sent, detail, notices };
}

describe('時刻を押す(seek-media)', () => {
  it('🔴 再生機の位置がその時刻になり、再生が始まる', () => {
    const { detail, notices } = setup();
    const m = fakeAudio();
    detail('15000', m).click();
    expect(m.time(), '位置が動いていない').toBe(15);
    expect(m.play, '再生が始まっていない').toHaveBeenCalledTimes(1);
    expect(notices(), '動いたのに言い訳が出た').toEqual([]);
  });

  it('🔴 同じ詳細の再生機だけを動かす(別の添付の再生機に触らない)', () => {
    const { detail } = setup();
    const mine = fakeAudio();
    const other = fakeAudio();
    // ⚠ 先に別の添付の詳細(留めた枠など)を置く ── ページ全体から探す実装は、こちらを掴む
    detail('99000', other);
    detail('15000', mine).click();
    expect(mine.time()).toBe(15);
    expect(other.time(), '別の添付の再生機が動いた').toBe(0);
    expect(other.play, '別の添付が鳴った').not.toHaveBeenCalled();
  });

  it('⚠ キーボード(Enter / Space)でも押せる(tabindex="0" の既存の道に乗る)', () => {
    const { detail } = setup();
    const m = fakeAudio();
    const el = detail('7000', m);
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(m.time(), 'Enter で動かない(焦点が乗るのに押せない)').toBe(7);
    const m2 = fakeAudio();
    const el2 = detail('9000', m2);
    el2.focus();
    el2.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(m2.time(), 'Space で動かない').toBe(9);
  });

  /**
   * 🔴 **黙らない** ── 再生機は非同期で差すので、押した瞬間に無いことがある。
   * 押しても何も起きないと、user は「壊れた」と読む。
   */
  it('🔴 再生機がまだ無いときは、動かさず、状態の行に次にすることを出す', () => {
    const { detail, notices } = setup();
    detail('15000', null).click();
    expect(notices(), '黙って終わった').toEqual(['再生の準備ができてから、もう一度押してください']);
  });

  it('🔴 再生機はあるが読み込みが始まっていない(readyState 0)ときも同じ ── 位置を書かない', () => {
    const { detail, notices } = setup();
    const m = fakeAudio({ readyState: 0 });
    detail('15000', m).click();
    expect(m.time(), '読み込み前に位置を書いた').toBe(0);
    expect(m.play).not.toHaveBeenCalled();
    expect(notices()).toEqual(['再生の準備ができてから、もう一度押してください']);
  });

  it('🔴 長さの取れない録音(duration が Infinity)で移れないときは、黙らず言う', () => {
    const { detail, notices } = setup();
    const m = fakeAudio({ duration: Infinity, seekable: 0 });
    detail('15000', m).click();
    expect(notices(), '移れないのに黙った').toEqual([
      'この録音は途中へ移れません。先頭から再生してください',
    ]);
    // 🔑 長さが取れなくても、移れるなら(seekable が在る)黙って動かす
    const ok = fakeAudio({ duration: Infinity, seekable: 1 });
    const before = notices().length;
    detail('15000', ok).click();
    expect(ok.time()).toBe(15);
    expect(notices().length, '移れるのに言い訳が出た').toBe(before);
  });

  it('再生を始められなかったときは言う(ただし押し直しの中断は言わない)', async () => {
    const { detail, notices } = setup();
    const refused = fakeAudio({ play: () => Promise.reject(new DOMException('no', 'NotAllowedError')) });
    detail('15000', refused).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(notices()).toEqual(['再生を始められませんでした']);

    const { detail: detail2, notices: notices2 } = setup();
    const aborted = fakeAudio({ play: () => Promise.reject(new DOMException('x', 'AbortError')) });
    detail2('15000', aborted).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(notices2(), '押し直しの中断まで言った').toEqual([]);
  });

  it('⚠ 位置の印が壊れていたら(負・数でない)何も起こさず、言い訳も出さない(押し口自身の不整合)', () => {
    const { detail, notices } = setup();
    const m = fakeAudio();
    detail('-5', m).click();
    detail('abc', m).click();
    expect(m.time()).toBe(0);
    expect(m.play).not.toHaveBeenCalled();
    expect(notices()).toEqual([]);
  });
});
