/** @vitest-environment happy-dom */
/**
 * 別窓へ落とした file / link で、窓ごと移らない(#1087)。
 *
 * 守る主張:各別窓の document へ撃った cancelable な `dragover` / `drop` が、
 * 誰にも受け取られなければ `defaultPrevented` になる(= ブラウザの「落とした URL へ移る」を止める)。
 * ⚠ 守っていない物:実ブラウザでの OS からの file 落とし(happy-dom は既定動作を持たない)。
 */
import { describe, expect, it, vi } from 'vitest';
import { blockWindowDrop } from '../../src/adapter/platform/window-drop-guard';
import { wireChapterWindow } from '../../src/adapter/platform/chapter-window';
import { fillManualWindow } from '../../src/adapter/platform/manual-window';
import {
  grabArchiveWindow,
  pickInArchiveWindow,
  showArchiveWindowError,
} from '../../src/adapter/platform/archive-window';
import { openAssetWindow } from '../../src/adapter/platform/asset-window';
import { openImageDrawWindow } from '../../src/adapter/platform/image-draw-window';
import { buildManualPage } from '../../src/features/help/manual-page';
import { THEME_STORAGE_KEY } from '../../src/adapter/ui/render/theme';

const TYPES = ['dragover', 'drop'] as const;

function fire(doc: Document, type: string, target: EventTarget = doc): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
}
function expectBlocked(doc: Document): void {
  for (const t of TYPES) {
    expect(fire(doc, t).defaultPrevented, `${t} が止まっていない(窓ごと移る)`).toBe(true);
    // 子要素からの落としも同じ
    expect(fire(doc, t, doc.body).defaultPrevented, `${t}(body から)が止まっていない`).toBe(true);
  }
}
function blank(): Document {
  return document.implementation.createHTMLDocument('');
}

describe('別窓への落としを止める(#1087)', () => {
  it('共有の口:内側が受けた落としには触れず、受けなかった落としだけ止める', () => {
    const doc = blank();
    blockWindowDrop(doc);
    blockWindowDrop(doc); // 2 度付けない
    const spy = vi.fn((ev: Event) => ev.preventDefault());
    const inner = doc.createElement('div');
    doc.body.append(inner);
    inner.addEventListener('drop', spy);
    const claimed = fire(doc, 'drop', inner);
    expect(spy, '内側の handler が受けていない').toHaveBeenCalledTimes(1);
    expect(claimed.defaultPrevented).toBe(true);
    expectBlocked(doc);
  });

  it('章の窓', () => {
    const win = { document: blank() } as unknown as Window;
    wireChapterWindow(win, () => undefined);
    expectBlocked(win.document);
  });

  it('マニュアルの窓(持ち歩ける 1 枚)', () => {
    const doc = blank();
    fillManualWindow(doc, { title: 't', version: 'v', tag: 'g', html: '<h1>a</h1>', text: 'a', sections: [] });
    expectBlocked(doc);
  });

  it('マニュアルの窓(焼いた page の script)', () => {
    const page = buildManualPage({
      title: 't',
      version: 'v',
      tag: 'g',
      html: '<h1 id="a">a</h1>',
      sections: [],
      tokensCss: '',
      bodyCss: '',
      themeStorageKey: THEME_STORAGE_KEY,
      textScaleStorageKey: 'pkc3-text-scale-test',
    });
    const scripts = [...page.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts.length, 'page に inline script が無い').toBeGreaterThan(0);
    const handlers = new Map<string, Array<(ev: Event) => void>>();
    vi.stubGlobal('addEventListener', (type: string, fn: (ev: Event) => void) => {
      handlers.set(type, [...(handlers.get(type) ?? []), fn]);
    });
    try {
      for (const s of scripts) new Function(s)();
    } finally {
      vi.unstubAllGlobals();
    }
    for (const t of TYPES) {
      const hs = handlers.get(t) ?? [];
      expect(hs, `${t} の handler が無い`).toHaveLength(1);
      const ev = new Event(t, { cancelable: true });
      hs[0]!(ev);
      expect(ev.defaultPrevented, `${t} が止まっていない`).toBe(true);
    }
  });

  const fakeWindow = (): Window & { closed: boolean } =>
    ({ closed: false, document: blank(), focus: () => undefined, close: () => undefined }) as unknown as Window & {
      closed: boolean;
    };

  it('書庫の窓(掴んだ直後 / 一覧 / 失敗の面)', () => {
    const a = fakeWindow();
    grabArchiveWindow('a.zip', 'k', () => a);
    expectBlocked(a.document);
    const b = fakeWindow();
    void pickInArchiveWindow(b, {
      assetKey: 'k',
      title: 'a.zip',
      rows: [],
      countFiles: () => 0,
      toggle: (m) => [...m],
      themeFrom: document.documentElement,
      onReloaded: () => {},
      waitClose: () => new Promise<void>(() => undefined),
    });
    expectBlocked(b.document);
    const c = fakeWindow();
    showArchiveWindowError(c, 't', 'e');
    expectBlocked(c.document);
  });

  it('添付の窓', async () => {
    const win = fakeWindow();
    await openAssetWindow({
      kind: 'image',
      lent: { url: 'blob:x', dispose: vi.fn() },
      title: 'a.png',
      open: () => win,
      waitClose: () => new Promise(() => undefined),
    });
    expectBlocked(win.document);
  });

  it('描き込みの窓', () => {
    const w = {
      document: blank(),
      closed: false,
      opener: { closed: false },
      focus: vi.fn(),
      close: vi.fn(),
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => undefined,
      addEventListener: () => undefined,
    };
    openImageDrawWindow({
      title: 'p.png',
      windowName: 'n',
      onClosed: vi.fn(),
      open: () => w as unknown as Window,
      waitClose: () => new Promise<void>(() => undefined),
      createBitmap: async () => ({ width: 1, height: 1, close: vi.fn() }),
    });
    expectBlocked(w.document);
  });
});
