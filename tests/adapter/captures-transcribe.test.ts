/** @vitest-environment happy-dom */
/**
 * 🔴 **「音/動画」の行の「文字にする」**(#772 段②。裁定 2026-10-01 ② = 「聞く」「切り出す」と同じ並び)。
 *
 * 守りたい主張:
 *  ① **中身の鍵が無い行には出さない**(押しても何も起きない口を作らない)/ 部品が無くても**出す**
 *     (押すと取り込みを案内する ── 出さないと、機能があることが分からない)
 *  ② 🔴 **走っている間は押した行に出し、ほかの行は押せなくする**(2 本同時に走らせない)
 *  ③ 🔴 **その差し替えで一覧を組み直さない** ── 組み直すと `<audio>` が作り直され、
 *     聞いている音が止まって頭へ戻る(文字にするのは聞きながらでも押される)
 *  ④ 押した行の lid を運び、binder が実体へ渡す
 */
import { describe, expect, it, vi } from 'vitest';
import { CapturesRenderer } from '../../src/adapter/ui/render/captures';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { captureItemsFrom, type CaptureItem } from '../../src/features/capture/capture-item';
import { ASR_TRANSCRIBE_LABEL, ASR_TRANSCRIBING_LABEL } from '../../src/features/asr/asr-text';
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
    { lid: 'b', title: 'b', body: body('画面収録-2026-09-09-030102.webm', 'video/webm', 'k-2') },
    { lid: 'c', title: 'c', body: body('鍵なし.webm', 'audio/webm', null) },
  ]);

function lender() {
  return {
    getBlob: async () => null,
    lend: async (k: string) => ({ url: `blob:${k}`, dispose: () => {} }),
  };
}

function pane(state: Partial<AppState>, withLender = true) {
  const host = document.createElement('div');
  document.body.append(host);
  const r = new CapturesRenderer(host, withLender ? lender() : null, () => {});
  let cur = { ...initialState, ...state } as AppState;
  const paint = (s: Partial<AppState> = {}): void => {
    cur = { ...cur, ...s } as AppState;
    r.render(cur);
  };
  paint();
  return { host, paint };
}

const btn = (host: HTMLElement, lid: string): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>(
    `[data-pkc-capture="${lid}"] [data-pkc-field="capture-transcribe"]`,
  );

describe('「文字にする」の出し分け', () => {
  it('🔴 中身の鍵がある行(音も動画も)に出て、鍵が無い行には出ない', () => {
    const { host } = pane({ captureItems: ITEMS() });
    expect(btn(host, 'a'), '録音に出ていない').not.toBeNull();
    expect(btn(host, 'b'), '画面収録(声が入る)に出ていない').not.toBeNull();
    expect(btn(host, 'c'), '鍵の無い行に出ている(dead click)').toBeNull();
  });

  it('🔴 部品が無くても出る(押すと取り込みを案内する)── 聞く道が無い(借り口なし)行でも出る', () => {
    const { host } = pane({ captureItems: ITEMS() }, false);
    expect(host.querySelector('[data-pkc-field="capture-play"]'), '前提: 聞く口は無い').toBeNull();
    expect(btn(host, 'a')).not.toBeNull();
  });

  it('字は「文字にする」で、押した行の lid を持つ(binder が対象を採る口)', () => {
    const { host } = pane({ captureItems: ITEMS() });
    const b = btn(host, 'a')!;
    expect(b.textContent).toBe(ASR_TRANSCRIBE_LABEL);
    expect(b.getAttribute('data-pkc-action')).toBe('capture-transcribe');
    expect(b.getAttribute('data-pkc-entry')).toBe('a');
    expect(b.disabled).toBe(false);
  });
});

describe('走っている間', () => {
  it('🔴 走っている行は「文字にしています…」で押せず、ほかの行も押せない(字は変えない)', () => {
    const p = pane({ captureItems: ITEMS() });
    p.paint({ captureTranscribeLid: 'a' });
    const a = btn(p.host, 'a')!;
    const b = btn(p.host, 'b')!;
    expect(a.textContent).toBe(ASR_TRANSCRIBING_LABEL);
    expect(a.disabled).toBe(true);
    expect(b.textContent, 'ほかの行まで「文字にしています…」になった').toBe(ASR_TRANSCRIBE_LABEL);
    expect(b.disabled, '2 本目を押せる').toBe(true);
    // 理由が hover に出る(灰色のまま黙らない)
    expect(b.title).toMatch(/別の録音を文字にしています/);
    expect(a.title).toMatch(/文字にしています/);
  });

  it('終わったら元へ戻る(押せる・字が戻る)', () => {
    const p = pane({ captureItems: ITEMS() });
    p.paint({ captureTranscribeLid: 'a' });
    p.paint({ captureTranscribeLid: null });
    const a = btn(p.host, 'a')!;
    expect(a.textContent).toBe(ASR_TRANSCRIBE_LABEL);
    expect(a.disabled).toBe(false);
    expect(btn(p.host, 'b')!.disabled).toBe(false);
  });

  /**
   * 🔴 **ここが本題** ── 聞きながら押す。差し替えで一覧を組み直すと、`<audio>` が作り直されて
   * 音が頭へ戻る(`syncTrimBar` が同じ理由で守っている)。
   */
  it('🔴 聞いている最中に押しても、<audio> も行も作り直されない(同じ要素のまま字だけ変わる)', async () => {
    const p = pane({ captureItems: ITEMS() });
    p.paint({ capturePlayingLid: 'a' });
    await Promise.resolve();
    await Promise.resolve();
    p.paint();
    const media = p.host.querySelector('[data-pkc-field="capture-media"]');
    const row = p.host.querySelector('[data-pkc-capture="a"]');
    const before = btn(p.host, 'a');
    expect(media, '前提: 再生機が出ている').not.toBeNull();
    p.paint({ captureTranscribeLid: 'a' });
    expect(p.host.querySelector('[data-pkc-field="capture-media"]'), '<audio> が作り直された').toBe(media);
    expect(p.host.querySelector('[data-pkc-capture="a"]'), '行が作り直された').toBe(row);
    expect(btn(p.host, 'a'), 'ボタンが作り直された(押している最中のボタンが消える)').toBe(before);
    expect(btn(p.host, 'a')!.textContent).toBe(ASR_TRANSCRIBING_LABEL);
    p.paint({ captureTranscribeLid: null });
    expect(p.host.querySelector('[data-pkc-field="capture-media"]')).toBe(media);
    expect(btn(p.host, 'a')!.textContent).toBe(ASR_TRANSCRIBE_LABEL);
  });

  it('一覧を組み直した回(件数が変わる)でも、走っている行の字は保たれる', () => {
    const p = pane({ captureItems: ITEMS(), captureTranscribeLid: 'a' });
    expect(btn(p.host, 'a')!.textContent).toBe(ASR_TRANSCRIBING_LABEL);
    p.paint({ captureItems: ITEMS().slice(0, 2), filterQuery: '録音' });
    expect(btn(p.host, 'a')!.textContent, '組み直したら「走っている」が消えた').toBe(ASR_TRANSCRIBING_LABEL);
    expect(btn(p.host, 'a')!.disabled).toBe(true);
  });
});

describe('押したら binder が実体へ渡す', () => {
  function harness(services: BinderServices) {
    const root = document.createElement('div');
    document.body.append(root);
    bindActions(root, new Dispatcher({ ...initialState, phase: 'ready' } as AppState), services);
    const p = pane({ captureItems: ITEMS() });
    root.append(p.host);
    return { root, host: p.host };
  }

  it('🔴 押した行の lid が transcribeCapture まで届く(選択中のノートから採らない)', () => {
    const transcribeCapture = vi.fn();
    const { host } = harness({ transcribeCapture });
    btn(host, 'b')!.dispatchEvent(new Event('click', { bubbles: true }));
    expect(transcribeCapture).toHaveBeenCalledTimes(1);
    expect(transcribeCapture).toHaveBeenCalledWith('b');
  });

  it('配線が無い版では、黙らず断る', () => {
    const d = new Dispatcher({ ...initialState, phase: 'ready' } as AppState);
    const root = document.createElement('div');
    document.body.append(root);
    bindActions(root, d, {});
    const p = pane({ captureItems: ITEMS() });
    root.append(p.host);
    btn(p.host, 'a')!.dispatchEvent(new Event('click', { bubbles: true }));
    expect(d.getState().error).toMatch(/このページが古いままのため、文字にできません/);
  });
});
