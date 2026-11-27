/**
 * 🔴 **`file://` / opaque origin で `localStorage` が `SecurityError` を投げる環境**でも、ウィジェットが落ちない(#2097 / #2098)。
 *
 * データ埋め込み済み PKC(`portable-bundle.ts`)は本体のコードそのものなので、`file://` で直に開かれる。
 * そこではブラウザの設定次第で `window.localStorage` の参照そのもの、または `getItem` などが例外を投げる。
 * 見るのは 2 つの形:①参照が投げる(Chrome のサイトデータを塞いだ `file://`)②置き場は在るが操作が全部投げる。
 */
/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hydrateWidgets,
  installWidgetBridge,
  resolveWidgetSeed,
  setWidgetNoteHost,
  setWidgetPermissionGate,
  WIDGET_LID_ATTR,
  type WidgetNoteHost,
} from '../../src/adapter/ui/render/widget-bridge';
import { resetWidgetIoForTest, setWidgetIoPressGuardForTest } from '../../src/adapter/ui/render/widget-io-bar';
import { WidgetPermissionGate } from '../../src/adapter/platform/widget-permission-grants';
import {
  applyWidgetStorageOp,
  clearWidgetStorage,
  hasWidgetStorage,
  readWidgetStorage,
} from '../../src/adapter/platform/widget-storage';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { hydrateFenceHosts } from '../../src/adapter/ui/render/fence-asset-hydrate';
import {
  WIDGET_DL_REQ_MSG_TYPE,
  WIDGET_DL_RES_MSG_TYPE,
  WIDGET_FILE_REQ_MSG_TYPE,
  WIDGET_FILE_RES_MSG_TYPE,
} from '../../src/features/markdown/widget-io';
import { WIDGET_STORAGE_MESSAGE } from '../../src/features/markdown/widget-bridge';

const deny = (): never => {
  throw new DOMException('The operation is insecure.', 'SecurityError');
};
/** ②置き場は在るが、操作が全部投げる。 */
const throwingStore = {
  getItem: deny,
  setItem: deny,
  removeItem: deny,
  key: deny,
  clear: deny,
  get length(): number {
    return deny();
  },
} as unknown as Storage;

type Mode = 'getter' | 'methods';
const realDesc = Object.getOwnPropertyDescriptor(window, 'localStorage');

function lockStorage(mode: Mode): void {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get: mode === 'getter' ? deny : () => throwingStore,
  });
}

type FakeWin = { posted: Record<string, unknown>[]; postMessage: (m: unknown) => void };
function giveWindow(f: HTMLIFrameElement): FakeWin {
  const w: FakeWin = { posted: [], postMessage: (m) => w.posted.push(m as Record<string, unknown>) };
  Object.defineProperty(f, 'contentWindow', { value: w, configurable: true });
  return w;
}
function post(data: unknown, source: object | null): void {
  const ev = new MessageEvent('message', { data });
  Object.defineProperty(ev, 'source', { value: source, configurable: true });
  window.dispatchEvent(ev);
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function host(bodies: Record<string, string>): WidgetNoteHost & { attached: string[] } {
  const h = {
    attached: [] as string[],
    bodyOf: (lid: string) => bodies[lid] ?? null,
    titleOf: () => '道具',
    writeBlockReason: () => null,
    saveState: () => undefined,
    removeState: () => Promise.resolve(true),
    fail: () => undefined,
    attachFile: (lid: string, file: File) => {
      h.attached.push(`${lid}:${file.name}`);
      return Promise.resolve(true);
    },
    listNoteAssets: (lid: string) =>
      Promise.resolve(lid === 'L1' ? [{ key: 'k1', name: 'in.csv', mime: 'text/csv', size: 3 }] : []),
    readAssetBlob: (k: string) => Promise.resolve(k === 'k1' ? new Blob(['1,2'], { type: 'text/csv' }) : null),
  };
  return h as unknown as WidgetNoteHost & { attached: string[] };
}

const TOOL = '<p id="n">0</p><script>var n=localStorage.getItem("count")</script>';
async function mount(md: string): Promise<HTMLElement> {
  const body = document.createElement('div');
  body.className = 'pkc-md-rendered';
  body.setAttribute(WIDGET_LID_ATTR, 'L1');
  body.innerHTML = renderMarkdown(md, { liveWidgets: true });
  document.body.append(body);
  hydrateWidgets(body);
  await hydrateFenceHosts({
    hosts: [...body.querySelectorAll<HTMLElement>('[data-pkc-fence-asset-key]')],
    getBlob: async () => new Blob([TOOL], { type: 'text/html' }),
    texts: new Map(),
    env: { allowExternalImages: false, currentContainerId: 'c1', liveWidgets: true },
    stale: () => false,
    onReplaced: (next) => hydrateWidgets(next),
  });
  return body;
}

function catchDl(): { names: string[]; revoked: string[] } {
  const names: string[] = [];
  const revoked: string[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:f/${String(names.length + revoked.length)}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => {
    revoked.push(u);
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    names.push(this.download);
  });
  return { names, revoked };
}

let off: (() => void) | null = null;
beforeEach(() => {
  document.body.innerHTML = '';
  vi.stubGlobal('IntersectionObserver', undefined);
  setWidgetIoPressGuardForTest(0);
  off = installWidgetBridge();
});
afterEach(() => {
  off?.();
  off = null;
  resetWidgetIoForTest();
  setWidgetIoPressGuardForTest(null);
  setWidgetNoteHost(null);
  setWidgetPermissionGate(null);
  if (realDesc) Object.defineProperty(window, 'localStorage', realDesc);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each<Mode>(['getter', 'methods'])('🔴 localStorage が投げる環境(%s)', (mode) => {
  it('ウィジェットの保存は例外を外へ投げず、断る / 空を返す', () => {
    lockStorage(mode);
    expect(readWidgetStorage('L1', 'w')).toEqual({});
    expect(hasWidgetStorage('L1', 'w')).toBe(false);
    expect(applyWidgetStorageOp('L1', 'w', { op: 'set', key: 'a', value: 'b' })).toBe(false);
    expect(() => clearWidgetStorage('L1', 'w')).not.toThrow();
    setWidgetNoteHost(host({ L1: '```json widget-state="w"\n{"a":"1"}\n```\n' }));
    // 🔑 端末に保存できなくても、本文の状態ブロックから続きの値で起きる
    expect(resolveWidgetSeed('L1', 'w')).toEqual({ a: '1' });
  });

  it('🔴 権限の確認は落ちず、許した権限はこのタブの間だけ効く', () => {
    lockStorage(mode);
    // 既定の置き場(localStorage)を読む門と、置き場を直に渡した門の両方
    for (const gate of [new WidgetPermissionGate(), new WidgetPermissionGate(throwingStore)]) {
      const key = 'sha256-' + 'a'.repeat(64);
      expect(gate.get(key)).toEqual(new WidgetPermissionGate(null).get(key));
      expect(gate.set(key, 'network', true)).toBe('session');
      expect(gate.get(key).network).toBe(true);
      expect(() => gate.listEntries()).not.toThrow();
    }
  });

  it('添付の HTML ウィジェットが箱になり、保存の合図・「HTML で保存」も落ちない', async () => {
    lockStorage(mode);
    const h = host({ L1: '```html asset:k-tool id="tool"\n```\n' });
    setWidgetNoteHost(h);
    setWidgetPermissionGate(new WidgetPermissionGate());
    const dl = catchDl();
    const errors: unknown[] = [];
    const onErr = (e: ErrorEvent): void => {
      errors.push(e.error);
    };
    window.addEventListener('error', onErr);
    try {
      const body = await mount('```html asset:k-tool id="tool"\n```\n');
      const f = body.querySelector<HTMLIFrameElement>('iframe.pkc-widget-frame')!;
      expect(f, '箱が置かれなかった').not.toBeNull();
      expect(f.getAttribute('sandbox')).toBe('allow-scripts');
      const w = giveWindow(f);
      post({ tag: WIDGET_STORAGE_MESSAGE, op: 'set', key: 'count', value: '3', seq: 1 }, w);
      body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-download"]')!.click();
      expect(dl.names).toEqual(['tool.html']);
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener('error', onErr);
    }
  });

  it('確認バーの保存(PC へ保存・このノートへ添付)と読み込み(PC から選ぶ・このノートの添付から選ぶ)が動く', async () => {
    lockStorage(mode);
    const h = host({ L1: '```html\n<p>t</p>\n```\n' });
    setWidgetNoteHost(h);
    const dl = catchDl();
    const body = await mount('```html\n<p>t</p>\n```\n');
    const f = body.querySelector<HTMLIFrameElement>('iframe.pkc-html-render')!;
    const w = giveWindow(f);
    const id = f.getAttribute('data-pkc-html-render-id')!;
    const press = (field: string): void => body.querySelector<HTMLButtonElement>(`[data-pkc-field="${field}"]`)!.click();
    // ⚠ 1 秒に 3 回の流量の上限に当てない(この test は 4 つの要求を続けて送る)
    let t = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 2000));

    post({ type: WIDGET_DL_REQ_MSG_TYPE, id, reqId: 1, name: 'a.csv', mime: 'text/csv', data: 'x' }, w);
    press('widget-io-save');
    expect(dl.names).toEqual(['a.csv']);
    expect(w.posted.at(-1)).toEqual({ type: WIDGET_DL_RES_MSG_TYPE, reqId: 1, ok: true, action: 'save' });

    post({ type: WIDGET_DL_REQ_MSG_TYPE, id, reqId: 2, name: 'b.csv', mime: 'text/csv', data: 'y' }, w);
    press('widget-io-attach');
    await flush();
    expect(h.attached).toEqual(['L1:b.csv']);
    expect(w.posted.at(-1)).toMatchObject({ reqId: 2, ok: true, action: 'attach' });

    post({ type: WIDGET_FILE_REQ_MSG_TYPE, id, reqId: 3, accept: '.csv' }, w);
    await flush();
    press('widget-io-pick-note');
    const radio = body.querySelector<HTMLInputElement>('[data-pkc-field="widget-io-note-asset"]')!;
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    press('widget-io-note-give');
    await flush();
    expect(w.posted.at(-1)).toMatchObject({ type: WIDGET_FILE_RES_MSG_TYPE, reqId: 3, ok: true });

    const opened: HTMLInputElement[] = [];
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      opened.push(this);
    });
    post({ type: WIDGET_FILE_REQ_MSG_TYPE, id, reqId: 4, accept: '.csv' }, w);
    press('widget-io-pick-pc');
    Object.defineProperty(opened[0]!, 'files', { value: [new File(['9'], 'pc.csv', { type: 'text/csv' })], configurable: true });
    opened[0]!.dispatchEvent(new Event('change'));
    await flush();
    expect(w.posted.at(-1)).toMatchObject({ type: WIDGET_FILE_RES_MSG_TYPE, reqId: 4, ok: true });
  });
});
