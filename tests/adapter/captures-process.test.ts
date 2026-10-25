/** @vitest-environment happy-dom */
/**
 * 🔴 **「音/動画」の行の仕上げの道具の押し所**(#952 A2・A4・A5・B1・B4・B5・B6、#674)。
 *
 * 守りたい主張:
 *  ① 形に合う道具にだけ出る(音の行に静止区間・VP9 の動画に映像の道具・鍵の無い行には何も出ない)
 *  ② 押した行の lid と、押した道具の id が binder から実体まで届く(選択中のノートから採らない)
 *  ③ 配線が無い版では黙らず断る
 *  ④ 「話者を直す」は本文に話者の一覧がある行にだけ出る
 */
import { describe, expect, it, vi } from 'vitest';
import { CapturesRenderer } from '../../src/adapter/ui/render/captures';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { captureItemsFrom, type CaptureItem } from '../../src/features/capture/capture-item';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { PROCESS_TOOLS } from '../../src/features/capture/capture-process';

function body(name: string, mime: string, key: string | null = 'k-1', extra = ''): string {
  return [
    '---',
    `attachment.name: ${name}`,
    `attachment.mime: ${mime}`,
    'attachment.size: 2048',
    ...(key === null ? [] : [`attachment.asset_key: ${key}`]),
    '---',
    extra,
  ].join('\n');
}

const ITEMS = (): CaptureItem[] =>
  captureItemsFrom([
    { lid: 'a', title: 'a', body: body('録音-2026-09-09-030102.webm', 'audio/webm;codecs=opus') },
    { lid: 'b', title: 'b', body: body('画面録画-2026-09-09-030102.webm', 'video/webm;codecs=vp8,opus', 'k-2') },
    { lid: 'c', title: 'c', body: body('鍵なし.webm', 'video/webm', null) },
    { lid: 'd', title: 'd', body: body('VP9.webm', 'video/webm;codecs=vp9,opus', 'k-4') },
    { lid: 'e', title: 'e', body: body('話者あり.webm', 'audio/webm', 'k-5', '## 話者 2026-10-25 10:00\n- 0:00 話者A') },
  ]);

function pane(state: Partial<AppState>) {
  const host = document.createElement('div');
  document.body.append(host);
  const r = new CapturesRenderer(host, { getBlob: async () => null, lend: async (k: string) => ({ url: `blob:${k}`, dispose: () => {} }) }, () => {});
  r.render({ ...initialState, ...state } as AppState);
  return host;
}

const tools = (host: HTMLElement, lid: string): string[] =>
  [...host.querySelectorAll<HTMLButtonElement>(`[data-pkc-capture="${lid}"] [data-pkc-action="capture-process"]`)].map(
    (b) => b.getAttribute('data-pkc-part')!,
  );
const btn = (host: HTMLElement, lid: string, tool: string): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>(`[data-pkc-capture="${lid}"] [data-pkc-field="capture-process-${tool}"]`);

describe('道具の出し分け', () => {
  it('🔴 VP8 の画面録画には全部の道具(話者を直すを除く)が表の順に出る', () => {
    const host = pane({ captureItems: ITEMS() });
    expect(tools(host, 'b')).toEqual(['fold-still', 'chapters', 'contact-sheet', 'denoise', 'separate', 'speakers', 'balance']);
  });

  it('🔴 音の行には映像の道具が出ず、VP9 の動画にも出ない。鍵の無い行には何も出ない', () => {
    const host = pane({ captureItems: ITEMS() });
    expect(tools(host, 'a')).toEqual(['chapters', 'denoise', 'separate', 'speakers', 'balance']);
    expect(tools(host, 'd')).toEqual(['chapters', 'denoise', 'separate', 'speakers', 'balance']);
    expect(tools(host, 'c')).toEqual([]);
  });

  it('🔴 「話者を直す」は本文に話者の一覧がある行にだけ出る', () => {
    const host = pane({ captureItems: ITEMS() });
    expect(tools(host, 'e')).toContain('fix-speakers');
    for (const lid of ['a', 'b', 'd']) expect(tools(host, lid)).not.toContain('fix-speakers');
  });

  it('押し所の字・説明は表(PROCESS_TOOLS)どおりで、元が残ることを押す前に言う道具は説明にそう書いてある', () => {
    const host = pane({ captureItems: ITEMS() });
    for (const t of PROCESS_TOOLS) {
      const lid = t.id === 'fix-speakers' ? 'e' : 'b';
      const b = btn(host, lid, t.id)!;
      expect(b, t.id).not.toBeNull();
      expect(b.textContent).toBe(t.label);
      expect(b.title).toBe(t.title);
      if (t.nameTag !== null || t.id === 'separate') expect(b.title, `${t.id} の説明に「元」が無い`).toContain('元');
    }
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

  it('🔴 押した行の lid と道具の id が processCapture まで届く', () => {
    const processCapture = vi.fn();
    const { host } = harness({ processCapture });
    btn(host, 'b', 'fold-still')!.dispatchEvent(new Event('click', { bubbles: true }));
    btn(host, 'a', 'denoise')!.dispatchEvent(new Event('click', { bubbles: true }));
    expect(processCapture.mock.calls).toEqual([
      ['b', 'fold-still'],
      ['a', 'denoise'],
    ]);
  });

  it('配線が無い版では、黙らず断る', () => {
    const { d, host } = harness({});
    btn(host, 'b', 'chapters')!.dispatchEvent(new Event('click', { bubbles: true }));
    expect(d.getState().error).toMatch(/このタブの PKC3 が古いままのため/);
  });
});
