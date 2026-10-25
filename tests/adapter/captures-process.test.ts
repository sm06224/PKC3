/** @vitest-environment happy-dom */
/**
 * 🔴 **「音/動画」の行の「仕上げ ▾」**(#952 A2・A4・A5・B1・B4・B5・B6、#674)。
 *
 * 守りたい主張:
 *  ① 行には**ボタンを 1 つだけ**置く(道具を 1 つずつ並べない ── 業務画面の「詰まっていない」)
 *  ② 出す道具は形に合う物だけ(音の行に静止区間・VP9 の動画に映像の道具・鍵の無い行には何も出ない)
 *  ③ 押すと一覧(他の行のメニューと同じ作り)が出て、項目は塊に切れ、選ぶと押した行の lid と道具の id が実体まで届く
 *  ④ 配線が無い版では黙らず断る
 *  ⑤ 「話者を直す」は本文に話者の一覧がある行にだけ出る
 */
import { describe, expect, it, vi } from 'vitest';
import { CapturesRenderer } from '../../src/adapter/ui/render/captures';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { captureItemsFrom, type CaptureItem } from '../../src/features/capture/capture-item';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { PROCESS_MENU_LABEL, PROCESS_TOOLS, processToolOf } from '../../src/features/capture/capture-process';

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

const openers = (host: HTMLElement, lid: string): HTMLButtonElement[] =>
  [...host.querySelectorAll<HTMLButtonElement>(`[data-pkc-capture="${lid}"] [data-pkc-action="open-capture-process"]`)];
const toolsOf = (host: HTMLElement, lid: string): string[] =>
  (openers(host, lid)[0]?.getAttribute('data-pkc-tools') ?? '').split(',').filter((x) => x !== '');

describe('行の押し所', () => {
  it('🔴 行に置くのは「仕上げ ▾」の 1 つだけ。道具のボタンを 1 つずつ並べない', () => {
    const host = pane({ captureItems: ITEMS() });
    for (const lid of ['a', 'b', 'd', 'e']) {
      expect(openers(host, lid), `${lid} の「仕上げ」が 1 つではない`).toHaveLength(1);
      expect(openers(host, lid)[0]!.textContent).toBe(PROCESS_MENU_LABEL);
      expect(host.querySelectorAll(`[data-pkc-capture="${lid}"] [data-pkc-action="capture-process"]`), `${lid} に道具のボタンが並んでいる`).toHaveLength(0);
    }
    expect(openers(host, 'b')[0]!.getAttribute('aria-haspopup')).toBe('menu');
  });

  it('🔴 VP8 の画面録画には全部の道具(話者を直すを除く)が、表の順(塊ごと)で運ばれる', () => {
    const host = pane({ captureItems: ITEMS() });
    expect(toolsOf(host, 'b')).toEqual(['fold-still', 'contact-sheet', 'denoise', 'separate', 'balance', 'chapters', 'speakers']);
  });

  it('🔴 音の行・VP9 の動画には映像の道具が運ばれず、鍵の無い行には「仕上げ」自体が出ない', () => {
    const host = pane({ captureItems: ITEMS() });
    expect(toolsOf(host, 'a')).toEqual(['denoise', 'separate', 'balance', 'chapters', 'speakers']);
    expect(toolsOf(host, 'd')).toEqual(['denoise', 'separate', 'balance', 'chapters', 'speakers']);
    expect(openers(host, 'c')).toHaveLength(0);
  });

  it('🔴 「話者を直す」は本文に話者の一覧がある行にだけ運ばれる', () => {
    const host = pane({ captureItems: ITEMS() });
    expect(toolsOf(host, 'e')).toContain('fix-speakers');
    for (const lid of ['a', 'b', 'd']) expect(toolsOf(host, lid)).not.toContain('fix-speakers');
  });

  it('表の塊は隣り合って並ぶ(メニューは並びのまま塊に切るので、離れると同じ塊が 2 つ出る)', () => {
    const groups = PROCESS_TOOLS.map((t) => t.group);
    const seen: string[] = [];
    for (const g of groups) if (seen[seen.length - 1] !== g) seen.push(g);
    expect(new Set(seen).size, '同じ塊が離れている').toBe(seen.length);
    expect(seen).toEqual(['映像', '音を作る', 'ノートに書く']);
  });
});

describe('一覧を開いて選ぶ(binder まで)', () => {
  function harness(services: BinderServices) {
    const d = new Dispatcher({ ...initialState, phase: 'ready' } as AppState);
    const root = document.createElement('div');
    document.body.append(root);
    bindActions(root, d, services);
    const host = pane({ captureItems: ITEMS() });
    root.append(host);
    return { d, host, root };
  }
  const click = (el: Element): void => void el.dispatchEvent(new Event('click', { bubbles: true }));
  const menuOf = (root: HTMLElement): HTMLElement | null => root.querySelector<HTMLElement>('[data-pkc-region="context-menu"]');

  it('🔴 押すと一覧が出る:項目は表の字・説明・塊のとおり、全項目が押した行の lid を運ぶ', () => {
    const { host, root } = harness({});
    click(openers(host, 'b')[0]!);
    const menu = menuOf(root);
    expect(menu, '一覧が出ない').not.toBeNull();
    const items = [...menu!.querySelectorAll<HTMLButtonElement>('button[data-pkc-action="capture-process"]')];
    expect(items.map((b) => b.getAttribute('data-pkc-part'))).toEqual(['fold-still', 'contact-sheet', 'denoise', 'separate', 'balance', 'chapters', 'speakers']);
    for (const b of items) {
      const t = processToolOf(b.getAttribute('data-pkc-part')!)!;
      expect(b.textContent).toBe(t.label);
      expect(b.getAttribute('data-pkc-hint')).toBe(t.title);
      expect(b.getAttribute('data-pkc-entry'), '押した行の lid を運んでいない').toBe('b');
    }
    expect([...menu!.querySelectorAll('[data-pkc-group]')].map((g) => g.getAttribute('data-pkc-group'))).toEqual(['映像', '音を作る', 'ノートに書く']);
  });

  it('🔴 項目を選ぶと、押した行の lid と道具の id が processCapture まで届き、一覧は閉じる', () => {
    const processCapture = vi.fn();
    const { host, root } = harness({ processCapture });
    click(openers(host, 'a')[0]!);
    click(menuOf(root)!.querySelector('[data-pkc-part="denoise"]')!);
    expect(processCapture.mock.calls).toEqual([['a', 'denoise']]);
    expect(menuOf(root), '選んだのに一覧が残っている').toBeNull();
  });

  it('配線が無い版では、黙らず断る', () => {
    const { d, host, root } = harness({});
    click(openers(host, 'b')[0]!);
    click(menuOf(root)!.querySelector('[data-pkc-part="chapters"]')!);
    expect(d.getState().error).toMatch(/このタブの PKC3 が古いままのため/);
  });

  it('道具の無い印(壊れた属性)を押しても一覧は出ない', () => {
    const { host, root } = harness({});
    const b = openers(host, 'b')[0]!;
    b.setAttribute('data-pkc-tools', 'nothing,unknown');
    click(b);
    expect(menuOf(root)).toBeNull();
  });
});
