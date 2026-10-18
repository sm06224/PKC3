/** @vitest-environment happy-dom */
/**
 * 🔴 **紙に出すときの図**(#1163 依頼 232 / 233 の紙側 / 234 / 349。Gemini の裁定:刷るときだけ図を明るい配色で描き直す /
 * 折りたたんだ部分は開いて図も描いてから刷る)。
 *
 * 画面の物語:ダークの配色で「PDF で書き出す」を押すと、図が暗い地の四角のまま紙に出ていた。折りたたんだ部分の中の図は、
 * 閉じている間は描かれないので、図の書き方の字がそのまま紙に出ることがあった。
 *
 * 守る主張:
 * 1. 紙の色は `tokens.css` の明るい配色(`:root`)と同じ 6 色(CSS を読まず定数で持つので、ずれを検算する)
 * 2. 刷る間だけ明るい配色で描き直し、**画面のテーマの属性は変えず**、戻したら画面の配色で描き直す
 * 3. まだ描いていない図(画面の外)も、最初から明るい配色で描く
 * 4. 折りたたみは開けた物だけ戻し、最初から開いていた物には触らない。閉じたままの中の図も描く
 * 5. 用意が遅れて終わった回は、終わった瞬間に自分で戻す(開きっぱなし・明るいままにしない)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  hydrateAllNow,
  hydrateMermaid,
  renderDiagramsLightForPrint,
} from '../../src/adapter/ui/render/mermaid-hydrate';
import { renderToPng } from '../../src/adapter/ui/render/mermaid-raster';
import { openFoldsForPrint, preparePrintBody } from '../../src/adapter/ui/render/print-prepare';
import { PRINT_PALETTE, PRINT_THEME, printLightActive } from '../../src/adapter/ui/render/diagram-print';

vi.mock('../../src/adapter/ui/render/mermaid-raster', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/adapter/ui/render/mermaid-raster')>();
  return {
    cacheKey: real.cacheKey,
    DeviceRenderError: real.DeviceRenderError,
    renderToPng: vi.fn(async () => ({ png: new Blob(['png'], { type: 'image/png' }), cssWidth: 320 })),
    // 画面の配色 ── ダークのときはダークの 6 色(本物は CSS 変数から読む)
    readPalette: () =>
      document.documentElement.getAttribute('data-pkc-theme') === 'dark'
        ? {
            bg: '#1c2024',
            alt: '#23282d',
            fg: '#e3e7eb',
            line: '#9aa4af',
            border: '#333a41',
            accent: '#2f8f5b',
            dark: true,
          }
        : { bg: '#ffffff', alt: '#f5f6f8', fg: '#16191d', line: '#59616b', border: '#cdd2d9', accent: '#14663c', dark: false },
  };
});

class FakeIO {
  constructor(public cb: (entries: { target: Element; isIntersecting: boolean }[]) => void) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
class FakeRO {
  observe(): void {}
  disconnect(): void {}
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function host(src: string): HTMLElement {
  const outer = document.createElement('div');
  outer.className = 'pkc-md-block';
  const h = document.createElement('div');
  h.setAttribute('data-pkc-mermaid-src', src);
  outer.append(h);
  return outer;
}

beforeEach(() => {
  vi.mocked(renderToPng).mockClear();
  document.documentElement.setAttribute('data-pkc-theme', 'dark');
  vi.stubGlobal('IntersectionObserver', FakeIO);
  vi.stubGlobal('ResizeObserver', FakeRO);
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('requestIdleCallback', undefined);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:x');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('紙の色(1)', () => {
  it('🔴 紙の配色 6 色が、tokens.css の明るい配色(:root)と同じ', () => {
    const css = readFileSync('src/styles/tokens.css', 'utf-8');
    // ⚠ 最初の `:root, :root[data-pkc-theme='light'] { … }` の塊だけを見る(他のテーマの同名の変数に満たされない)
    const start = css.indexOf(":root[data-pkc-theme='light'] {");
    expect(start, '明るい配色の塊が見つからない(前提が崩れている)').toBeGreaterThan(0);
    const block = css.slice(start, css.indexOf('}', start));
    const v = (name: string): string => new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(block)?.[1] ?? '(無い)';
    expect({
      bg: v('--surface'),
      alt: v('--surface-2'),
      fg: v('--fg'),
      line: v('--muted'),
      border: v('--border'),
      accent: v('--accent'),
    }).toEqual({
      bg: PRINT_PALETTE.bg,
      alt: PRINT_PALETTE.alt,
      fg: PRINT_PALETTE.fg,
      line: PRINT_PALETTE.line,
      border: PRINT_PALETTE.border,
      accent: PRINT_PALETTE.accent,
    });
    expect(PRINT_PALETTE.dark).toBe(false);
  });
});

describe('刷る間だけ、図を明るい配色で描き直す(2・3)', () => {
  it('🔴 ダークで描いた図は、刷る間だけ明るい色で描き直され、画面のテーマの属性は変わらず、戻すと画面の配色で描き直る', async () => {
    const root = document.createElement('div');
    const drawn = host('graph TD\n A-->B');
    const never = host('graph TD\n C-->D'); // 画面の外 ── 一度も描かれていない
    root.append(drawn, never);
    document.body.append(root);
    const scope = hydrateMermaid([...root.children]);
    // 画面に出ている 1 枚だけ描く(もう 1 枚は誰も描いていない ── 根を 1 枚に絞って描かせる)
    await hydrateAllNow(drawn);
    await settle();
    const calls = vi.mocked(renderToPng).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0].theme, '前提: 画面はダーク').toBe('dark');
    expect(calls[0]![0].palette.dark).toBe(true);

    const restore = await renderDiagramsLightForPrint(root);
    await settle();
    // 画面のテーマは変えていない
    expect(document.documentElement.getAttribute('data-pkc-theme'), '画面のテーマを書き換えた').toBe('dark');
    expect(printLightActive()).toBe(true);
    const lightCalls = vi.mocked(renderToPng).mock.calls.slice(1).map((c) => c[0]);
    // 描いた 1 枚の描き直し + 一度も描いていない 1 枚 = 2 件。どちらも明るい配色
    expect(lightCalls, '描き直しと初描画の 2 件になっていない').toHaveLength(2);
    for (const k of lightCalls) {
      expect(k.theme).toBe(PRINT_THEME);
      expect(k.palette).toEqual(PRINT_PALETTE);
    }
    expect(new Set(lightCalls.map((k) => k.source)).size, '同じ図を 2 度描いた').toBe(2);
    expect(never.querySelector('img[data-pkc-field="mermaid-image"]'), '画面の外の図が描かれていない').not.toBeNull();

    // 戻す ── 画面の配色(ダーク)で描き直す
    vi.mocked(renderToPng).mockClear();
    restore();
    await settle();
    expect(printLightActive()).toBe(false);
    const back = vi.mocked(renderToPng).mock.calls.map((c) => c[0]);
    expect(back.length, '戻したのに描き直していない').toBeGreaterThan(0);
    for (const k of back) expect(k.theme).toBe('dark');
    // 二度呼んでも二重に描き直さない
    vi.mocked(renderToPng).mockClear();
    restore();
    await settle();
    expect(vi.mocked(renderToPng)).not.toHaveBeenCalled();

    scope.dispose();
    root.remove();
  });

  it('🔴 対照群: 画面がもともと明るい配色なら、刷っても描き直さない(同じ鍵の絵を使い回す)', async () => {
    document.documentElement.setAttribute('data-pkc-theme', 'light');
    const root = document.createElement('div');
    const a = host('graph TD\n A-->B');
    root.append(a);
    document.body.append(root);
    const scope = hydrateMermaid([...root.children]);
    await hydrateAllNow(root);
    await settle();
    expect(vi.mocked(renderToPng)).toHaveBeenCalledTimes(1);
    const restore = await renderDiagramsLightForPrint(root);
    await settle();
    expect(vi.mocked(renderToPng), '明るいままなのに描き直した').toHaveBeenCalledTimes(1);
    restore();
    scope.dispose();
    root.remove();
  });
});

describe('折りたたみ(4)', () => {
  it('🔴 閉じていた物だけ開き、戻すと閉じていた物だけ閉じる(最初から開いていた物は開いたまま)', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<details id="c1"><summary>a</summary>x</details><details id="o1" open><summary>b</summary>y</details><details id="c2"><summary>c</summary>z</details>';
    document.body.append(root);
    const restore = openFoldsForPrint(root);
    const open = (id: string): boolean => (root.querySelector(`#${id}`) as HTMLDetailsElement).open;
    expect([open('c1'), open('o1'), open('c2')], '開いていない').toEqual([true, true, true]);
    restore();
    expect([open('c1'), open('o1'), open('c2')], '最初の状態へ戻っていない').toEqual([false, true, false]);
    root.remove();
  });

  it('🔴 閉じた折りたたみの中の図も、刷る前に描かれる(閉じたままでは描かれない ── 対照群つき)', async () => {
    // happy-dom に無い `checkVisibility` を、閉じた <details> の中は偽にして差す(本物のブラウザの振る舞い)
    vi.stubGlobal('requestIdleCallback', undefined);
    const proto = HTMLElement.prototype as unknown as { checkVisibility?: () => boolean };
    const saved = proto.checkVisibility;
    proto.checkVisibility = function (this: HTMLElement): boolean {
      const d = this.closest('details');
      return d === null || d.open;
    };
    try {
      const root = document.createElement('div');
      const d = document.createElement('details');
      d.innerHTML = '<summary>畳み</summary>';
      const inner = host('graph TD\n P-->Q');
      d.append(inner);
      root.append(d);
      document.body.append(root);
      const scope = hydrateMermaid([...d.children].filter((c) => c !== d.firstElementChild));
      await hydrateAllNow(root);
      await settle();
      expect(vi.mocked(renderToPng), '対照群: 閉じたままでは描かれないはず').not.toHaveBeenCalled();

      const restore = await preparePrintBody(root);
      await settle();
      expect(d.open, '開いていない').toBe(true);
      expect(inner.querySelector('img[data-pkc-field="mermaid-image"]'), '中の図が描かれていない').not.toBeNull();
      restore();
      expect(d.open, '刷り終えても開いたまま').toBe(false);
      expect(printLightActive()).toBe(false);
      scope.dispose();
      root.remove();
    } finally {
      if (saved === undefined) delete proto.checkVisibility;
      else proto.checkVisibility = saved;
    }
  });

  it('🔴 見出しで折りたたんだ章([data-pkc-folded])の中の図も、刷る前に開いて描かれ、刷り終えたら元へ戻る', async () => {
    vi.stubGlobal('requestIdleCallback', undefined);
    const proto = HTMLElement.prototype as unknown as { checkVisibility?: () => boolean };
    const saved = proto.checkVisibility;
    proto.checkVisibility = function (this: HTMLElement): boolean {
      return this.closest('[hidden]') === null;
    };
    try {
      const root = document.createElement('div');
      const h2 = document.createElement('h2');
      h2.textContent = '章';
      h2.setAttribute('data-pkc-folded', '');
      const inner = host('graph TD\n H-->M');
      inner.hidden = true;
      root.append(h2, inner);
      document.body.append(root);
      const scope = hydrateMermaid([inner]);
      await hydrateAllNow(root);
      await settle();
      expect(vi.mocked(renderToPng), '対照群: 見出しの畳みで隠れている間は描かれないはず').not.toHaveBeenCalled();

      const restore = await preparePrintBody(root);
      await settle();
      expect(inner.hidden, '見出しの畳みが開いていない').toBe(false);
      expect(inner.querySelector('img[data-pkc-field="mermaid-image"]'), '畳んだ章の中の図が描かれていない').not.toBeNull();
      restore();
      expect(inner.hidden, '刷り終えても隠れていない').toBe(true);
      expect(h2.hasAttribute('data-pkc-folded'), '見出しの畳みの印が消えている').toBe(true);
      scope.dispose();
      root.remove();
    } finally {
      if (saved === undefined) delete proto.checkVisibility;
      else proto.checkVisibility = saved;
    }
  });
});

describe('用意が遅れて終わった回(5)', () => {
  it('🔴 「この回の刷り」でなくなった後に終わったら、返す前に自分で戻す(開きっぱなし・明るいままにしない)', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<details id="late"><summary>a</summary>x</details>';
    document.body.append(root);
    const restore = await preparePrintBody(root, () => false);
    const d = root.querySelector('#late') as HTMLDetailsElement;
    expect(d.open, '遅れて終わったのに開いたまま').toBe(false);
    expect(printLightActive(), '遅れて終わったのに明るいまま').toBe(false);
    expect(() => restore()).not.toThrow();
    root.remove();
  });
});
