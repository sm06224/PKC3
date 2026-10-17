/** @vitest-environment happy-dom */
/**
 * 🔴 **動画の行の「音だけ取り出す」「絵だけ取り出す」**(#952 A1)。
 *
 * 守りたい主張:
 *  ① **動画の行にだけ出る**(音の行・中身の鍵が無い行・取り出せない形の動画には出ない ── 押しても何も起きない口を作らない)
 *  ② **押した行の lid と、押したボタンが運ぶ「何を取り出すか」が binder から実体まで届く**
 *  ③ 配線が無い版では黙らず断る
 */
import { describe, expect, it, vi } from 'vitest';
import { CapturesRenderer } from '../../src/adapter/ui/render/captures';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { captureItemsFrom, type CaptureItem } from '../../src/features/capture/capture-item';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';

function body(name: string, mime: string, key: string | null = 'k-1'): string {
  return [
    '---',
    `attachment.name: ${name}`,
    `attachment.mime: ${mime}`,
    'attachment.size: 2048',
    ...(key === null ? [] : [`attachment.asset_key: ${key}`]),
    '---',
    '',
  ].join('\n');
}

const ITEMS = (): CaptureItem[] =>
  captureItemsFrom([
    { lid: 'a', title: 'a', body: body('録音-2026-09-09-030102.webm', 'audio/webm') },
    { lid: 'b', title: 'b', body: body('画面収録-2026-09-09-030102.webm', 'video/webm;codecs=vp8,opus', 'k-2') },
    { lid: 'c', title: 'c', body: body('鍵なし.webm', 'video/webm', null) },
    { lid: 'd', title: 'd', body: body('他の形.mp4', 'video/mp4', 'k-4') },
    { lid: 'e', title: 'e', body: body('音なし.webm', 'video/webm;codecs=vp8', 'k-5') },
  ]);

function pane(state: Partial<AppState>) {
  const host = document.createElement('div');
  document.body.append(host);
  const r = new CapturesRenderer(host, { getBlob: async () => null, lend: async (k: string) => ({ url: `blob:${k}`, dispose: () => {} }) }, () => {});
  r.render({ ...initialState, ...state } as AppState);
  return host;
}

const btn = (host: HTMLElement, lid: string, part: 'audio' | 'picture'): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>(`[data-pkc-capture="${lid}"] [data-pkc-field="capture-extract-${part}"]`);

describe('取り出しの出し分け', () => {
  it('🔴 取り出せる動画の行には 2 つとも出て、字は「音だけ取り出す」「絵だけ取り出す」', () => {
    const host = pane({ captureItems: ITEMS() });
    expect(btn(host, 'b', 'audio')?.textContent).toBe('音だけ取り出す');
    expect(btn(host, 'b', 'picture')?.textContent).toBe('絵だけ取り出す');
  });

  it('🔴 音の行・鍵の無い行・取り出せない形の動画には出ない', () => {
    const host = pane({ captureItems: ITEMS() });
    for (const lid of ['a', 'c', 'd']) {
      expect(btn(host, lid, 'audio'), `${lid} に「音だけ」が出ている`).toBeNull();
      expect(btn(host, lid, 'picture'), `${lid} に「絵だけ」が出ている`).toBeNull();
    }
    // 前提(空振り防止):出る行は在る
    expect(host.querySelectorAll('[data-pkc-action="capture-extract"]').length).toBeGreaterThan(0);
  });

  it('🔴 音が入っていない宣言(codecs に opus が無い)の動画には「絵だけ」だけが出る', () => {
    const host = pane({ captureItems: ITEMS() });
    expect(btn(host, 'e', 'audio')).toBeNull();
    expect(btn(host, 'e', 'picture')).not.toBeNull();
  });

  it('押し所は押した行の lid と取り出す物を運ぶ', () => {
    const host = pane({ captureItems: ITEMS() });
    const a = btn(host, 'b', 'audio')!;
    const p = btn(host, 'b', 'picture')!;
    expect([a.getAttribute('data-pkc-action'), a.getAttribute('data-pkc-entry'), a.getAttribute('data-pkc-part')]).toEqual([
      'capture-extract',
      'b',
      'audio',
    ]);
    expect(p.getAttribute('data-pkc-part')).toBe('picture');
    // 「元は残る」ことを押す前に言う
    expect(a.title).toContain('元の動画はそのまま残ります');
    expect(p.title).toContain('元の動画はそのまま残ります');
  });
});

describe('binder まで届く', () => {
  function harness(services: BinderServices) {
    const d = new Dispatcher({ ...initialState, phase: 'ready' } as AppState);
    const root = document.createElement('div');
    document.body.append(root);
    bindActions(root, d, services);
    const host = pane({ captureItems: ITEMS() });
    root.append(host);
    return { d, host };
  }

  it('🔴 押した行の lid と取り出す物が extractCapture まで届く(選択中のノートから採らない)', () => {
    const extractCapture = vi.fn();
    const { host } = harness({ extractCapture });
    btn(host, 'b', 'picture')!.dispatchEvent(new Event('click', { bubbles: true }));
    btn(host, 'b', 'audio')!.dispatchEvent(new Event('click', { bubbles: true }));
    expect(extractCapture.mock.calls).toEqual([
      ['b', 'picture'],
      ['b', 'audio'],
    ]);
  });

  it('配線が無い版では、黙らず断る', () => {
    const { d, host } = harness({});
    btn(host, 'b', 'audio')!.dispatchEvent(new Event('click', { bubbles: true }));
    expect(d.getState().error).toMatch(/このタブの PKC3 が古いままのため、取り出せません/);
  });

  it('知らない物を取り出せと言う押し所は何もしない', () => {
    const extractCapture = vi.fn();
    const { host } = harness({ extractCapture });
    const b = btn(host, 'b', 'audio')!;
    b.setAttribute('data-pkc-part', 'video');
    b.dispatchEvent(new Event('click', { bubbles: true }));
    expect(extractCapture).not.toHaveBeenCalled();
  });
});
