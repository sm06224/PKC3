/** @vitest-environment happy-dom */
/**
 * ウィジェットと親の口(v4.0 Phase 2 / PR-07)。
 *
 * 守る主張(セキュリティが先):
 * 1. 置いた箱は `sandbox="allow-scripts"` のみ(`allow-same-origin` 無し)、CSP に `connect-src 'none'` / `frame-src 'none'`
 * 2. 🔴 **なりすまし拒否** ── 箱 A が別の箱 B の id や別ノートの lid を名乗って書いても、B / 別ノートには 1 バイトも書かれない
 *    (保存先は親の DOM の `(lid, widgetId)` だけで決まる)
 * 3. 🔴 `id=` の無い箱(状態を持たない箱)の保存要求は捨てる
 * 4. 🔴 512 KB を超える書込は親で断る(箱の shim を経ない直の要求でも)
 * 5. テーマが変わっても箱を作り直さず、`pkc-widget-theme` を配る
 * 6. 「状態を初期化」で保存が消え、はじめの状態で置き直される(押せる / 押せないも合う)
 * 7. 別のノートへ持ち越された箱は、前のノートの領域へ書かない
 * 8. ノートを完全に消したら、そのノートのウィジェットの保存も消える
 *
 * PR-08(ビジョン 5-B):
 * 9. 🔴 `readNoteContext` / `readTables` / `readFrontmatter` は**置いたノート 1 件**の前書きと表だけを返す。
 *    なりすまし・別ノートへ持ち越された箱・登録の無い箱には空を返す
 * 10. 「ノートへ保存」で本文に状態ブロックを書き、端末の保存を消して置き直すとブロックから元どおりになる
 * 11. 🔴 「状態を初期化」で端末の保存と本文の状態ブロックの両方が消え、置き直しても復活しない
 * 12. 🔴 箱の合図からは本文を書かない(書くのは親のボタンだけ)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hydrateWidgets,
  installWidgetBridge,
  resolveWidgetSeed,
  setWidgetNoteHost,
  CONTEXT_MAX_PENDING,
  CONTEXT_MIN_INTERVAL_MS,
  type WidgetNoteHost,
  keepWidgetSeedFresh,
  remountStaleWidgets,
  WIDGET_LID_ATTR,
  widgetFrameCount,
  notifyWidgetBlocked,
  remountAssetWidgets,
  routeWidgetBlocked,
  setWidgetPermissionGate,
  widgetAssetLabel,
  widgetIoLidOf,
} from '../../src/adapter/ui/render/widget-bridge';
import {
  resetWidgetIoForTest,
  setWidgetIoPressGuardForTest,
  widgetIoPendingCount,
  widgetIoPendingForTest,
} from '../../src/adapter/ui/render/widget-io-bar';
import {
  WIDGET_DL_REQ_MSG_TYPE,
  WIDGET_DL_RES_MSG_TYPE,
  WIDGET_FILE_REQ_MSG_TYPE,
  WIDGET_FILE_RES_MSG_TYPE,
  WIDGET_IO_PRESS_GUARD_MS,
  WIDGET_IO_REASONS,
  WIDGET_IO_TIMEOUT_MS,
} from '../../src/features/markdown/widget-io';
import { WidgetPermissionGate } from '../../src/adapter/platform/widget-permission-grants';
import {
  applyWidgetStorageOp,
  clearEntryWidgetStorage,
  hasWidgetStorage,
  readWidgetStorage,
} from '../../src/adapter/platform/widget-storage';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { buildHtmlSandboxIframe } from '../../src/features/markdown/html-sandbox';
import {
  WIDGET_CONTEXT_REQ_MSG_TYPE,
  WIDGET_CONTEXT_RES_MSG_TYPE,
  WIDGET_CONTEXT_TIMEOUT_MS,
  WIDGET_READY_MSG_TYPE,
  WIDGET_STORAGE_LIMIT,
  WIDGET_TOTAL_STORAGE_LIMIT,
  WIDGET_STORAGE_MESSAGE,
  WIDGET_THEME_MSG_TYPE,
  widgetStoragePrefix,
} from '../../src/features/markdown/widget-bridge';
import { resetAppDialogForTest, DIALOG_REGION } from '../../src/adapter/ui/render/app-dialog';
import { hydrateReact, setReactRuntimeLoader } from '../../src/adapter/ui/render/react-sandbox';
import { hydrateFenceHosts } from '../../src/adapter/ui/render/fence-asset-hydrate';
import {
  readWidgetStateBlock,
  removeWidgetStateBlock,
  upsertWidgetStateBlock,
} from '../../src/features/markdown/widget-state-block';
import { applyBodyRewrite } from '../../src/features/markdown/body-rewrite';
import { reduce, initialState, type AppState } from '../../src/adapter/state/app-state';

type FakeWin = { posted: unknown[]; postMessage: (m: unknown) => void };
const fakeWin = (): FakeWin => {
  const w: FakeWin = { posted: [], postMessage: (m) => w.posted.push(m) };
  return w;
};

/** 箱に送り主(contentWindow)を持たせる。⚠ happy-dom の iframe は差し替えられないので定義する。 */
function giveWindow(f: HTMLIFrameElement): FakeWin {
  const w = fakeWin();
  Object.defineProperty(f, 'contentWindow', { value: w, configurable: true });
  return w;
}

function post(data: unknown, source: object | null): void {
  const ev = new MessageEvent('message', { data });
  Object.defineProperty(ev, 'source', { value: source, configurable: true });
  window.dispatchEvent(ev);
}

/** 本文の器(lid つき)に markdown を描いて、ウィジェットを置く。 */
function mount(lid: string | null, md: string): { body: HTMLElement; scope: ReturnType<typeof hydrateWidgets> } {
  const body = document.createElement('div');
  body.className = 'pkc-md-rendered';
  if (lid !== null) body.setAttribute(WIDGET_LID_ATTR, lid);
  body.innerHTML = renderMarkdown(md, { liveWidgets: true });
  document.body.append(body);
  const scope = hydrateWidgets(body);
  return { body, scope };
}

const frameOf = (root: ParentNode): HTMLIFrameElement => root.querySelector<HTMLIFrameElement>('iframe.pkc-widget-frame')!;
const storageKeys = (): string[] => {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i)!);
  return out.sort();
};
const set = (key: string, value: string, seq = 1): Record<string, unknown> => ({
  tag: WIDGET_STORAGE_MESSAGE,
  op: 'set',
  key,
  value,
  seq,
});

let off: (() => void) | null = null;
beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  resetAppDialogForTest();
  // IntersectionObserver が無い環境では即座に置く(見えた扱い)
  vi.stubGlobal('IntersectionObserver', undefined);
  off = installWidgetBridge();
});
afterEach(() => {
  off?.();
  off = null;
  setWidgetNoteHost(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setReactRuntimeLoader(null);
});

describe('🔴 セキュリティ', () => {
  it('置いた箱は allow-scripts のみ・CSP は外へ出られない(状態を持つ箱も持たない箱も)', () => {
    const { body, scope } = mount('L1', '```html id="a"\n<p>x</p>\n```\n');
    const f = frameOf(body);
    expect(f).not.toBeNull();
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(f.srcdoc).toContain("connect-src 'none'");
    expect(f.srcdoc).toContain("frame-src 'none'");
    expect(f.srcdoc).toContain("object-src 'none'");
    expect(f.srcdoc).toContain("base-uri 'none'");
    // 状態を持たない箱(markdown の箱そのもの)
    const plain = document.createElement('div');
    plain.innerHTML = buildHtmlSandboxIframe('<p>x</p>');
    const pf = plain.querySelector('iframe')!;
    expect(pf.getAttribute('sandbox')).toBe('allow-scripts');
    expect(pf.srcdoc).toContain("connect-src 'none'");
    expect(pf.srcdoc).toContain("frame-src 'none'");
    scope.dispose();
  });

  it('🔴 なりすまし拒否:A の窓から B の id・別ノートの lid を名乗っても、B と別ノートには 1 バイトも書かれない', () => {
    const { body, scope } = mount('L1', '```html id="a"\n<p>A</p>\n```\n\n```html id="b"\n<p>B</p>\n```\n');
    const frames = body.querySelectorAll<HTMLIFrameElement>('iframe.pkc-widget-frame');
    expect(frames).toHaveLength(2);
    const wa = giveWindow(frames[0]!);
    giveWindow(frames[1]!);
    post(
      { ...set('k', 'v', 7), id: 'b', widgetId: 'b', lid: 'L2', entryLid: 'L2', prefix: widgetStoragePrefix('L2', 'b') },
      wa,
    );
    // B にも別ノートにも何も無い
    expect(readWidgetStorage('L1', 'b')).toEqual({});
    expect(readWidgetStorage('L2', 'b')).toEqual({});
    expect(readWidgetStorage('L2', 'a')).toEqual({});
    // A 自身の領域にだけ閉じる
    expect(readWidgetStorage('L1', 'a')).toEqual({ k: 'v' });
    expect(storageKeys()).toEqual([`${widgetStoragePrefix('L1', 'a')}k`]);
    // 返事は送り主へ
    expect(wa.posted).toContainEqual({ tag: WIDGET_STORAGE_MESSAGE, op: 'ack', seq: 7, ok: true });
    scope.dispose();
  });

  it('🔴 送り主の分からない要求・登録の無い窓からの要求は捨てる', () => {
    const { body, scope } = mount('L1', '```html id="a"\n<p>A</p>\n```\n');
    giveWindow(frameOf(body));
    post(set('k', 'v'), null);
    post(set('k', 'v'), fakeWin());
    post(set('k', 'v'), window);
    expect(storageKeys()).toEqual([]);
    scope.dispose();
  });

  it('🔴 id= の無い箱(状態を持たない箱)からの保存要求は完全に無視する', () => {
    const host = document.createElement('div');
    host.setAttribute(WIDGET_LID_ATTR, 'L1');
    host.innerHTML = renderMarkdown('```html\n<p>x</p>\n```\n');
    document.body.append(host);
    const f = host.querySelector('iframe')!;
    const w = giveWindow(f);
    post(set('k', 'v', 1), w);
    post({ tag: WIDGET_STORAGE_MESSAGE, op: 'clear', seq: 2 }, w);
    expect(storageKeys(), '状態を持たない箱が書いた').toEqual([]);
    expect(w.posted, '状態を持たない箱へ返事をした').toEqual([]);
  });

  it('🔴 lid の決まらない面では、id= があっても保存しない(箱の中はその場限りの localStorage で 1 行目から動く)', () => {
    applyWidgetStorageOp('L1', 'a', { op: 'set', key: 'k', value: 'old' });
    const { body, scope } = mount(null, '```html id="a"\n<p>x</p>\n```\n');
    const f = frameOf(body);
    // shim は入る(読むだけで投げない)が、seed は空(どのノートの値も焼かない)
    expect(f.srcdoc).toContain(WIDGET_STORAGE_MESSAGE);
    expect(f.srcdoc).not.toContain('"old"');
    expect(widgetFrameCount(), '登録した(保存できてしまう)').toBe(0);
    localStorage.clear();
    expect(body.querySelector('[data-pkc-field="widget-reset"]')).toBeNull();
    post(set('k', 'v'), giveWindow(f));
    expect(storageKeys()).toEqual([]);
    scope.dispose();
  });

  it('🔴 512 KB を超える書込は親で断る(箱の shim を経ない直の要求でも)', () => {
    const { body, scope } = mount('L1', '```html id="a"\n<p>x</p>\n```\n');
    const w = giveWindow(frameOf(body));
    post(set('big', 'A'.repeat(WIDGET_STORAGE_LIMIT), 3), w);
    expect(readWidgetStorage('L1', 'a')).toEqual({});
    expect(w.posted).toContainEqual({ tag: WIDGET_STORAGE_MESSAGE, op: 'ack', seq: 3, ok: false });
    // 上限ちょうどまでは入る(鍵 1 字 + 値)
    post(set('k', 'A'.repeat(WIDGET_STORAGE_LIMIT - 1), 4), w);
    expect(w.posted).toContainEqual({ tag: WIDGET_STORAGE_MESSAGE, op: 'ack', seq: 4, ok: true });
    // もう 1 字も入らない(積み増しで超える)
    post(set('j', '', 5), w);
    expect(w.posted).toContainEqual({ tag: WIDGET_STORAGE_MESSAGE, op: 'ack', seq: 5, ok: false });
    // 同じ鍵の上書きは差し引きで数える(縮めれば入る)
    post(set('k', 'short', 6), w);
    expect(w.posted).toContainEqual({ tag: WIDGET_STORAGE_MESSAGE, op: 'ack', seq: 6, ok: true });
    expect(readWidgetStorage('L1', 'a')).toEqual({ k: 'short' });
    scope.dispose();
  });

  it('🔴 全ウィジェットの合計は 2 MB まで(id を増やしても origin の localStorage を食い潰せない)', () => {
    const big = 'A'.repeat(WIDGET_STORAGE_LIMIT - 1);
    let ok = 0;
    for (let i = 0; i < 10; i += 1) if (applyWidgetStorageOp('L', `w${i}`, { op: 'set', key: 'k', value: big })) ok += 1;
    // 512 KB × 4 は 2 MB を前置きの字数ぶん超えるので、入るのは 3 つまで
    expect(ok).toBe(3);
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith('pkc3.widget.')) total += k.length + localStorage.getItem(k)!.length;
    }
    expect(total).toBeLessThanOrEqual(WIDGET_TOTAL_STORAGE_LIMIT);
    // 小さな書込は入る(合計に余りがある)
    expect(applyWidgetStorageOp('L', 'small', { op: 'set', key: 'k', value: 'v' })).toBe(true);
  });

  it('🔴 別のタブが書いた分も数える(使用量を覚えて古くしない)', () => {
    expect(applyWidgetStorageOp('L', 'w', { op: 'set', key: 'a', value: 'x' })).toBe(true);
    // 別のタブが同じウィジェットへ書いた(この口を通らない)
    localStorage.setItem(`${widgetStoragePrefix('L', 'w')}b`, 'A'.repeat(WIDGET_STORAGE_LIMIT - 10));
    expect(applyWidgetStorageOp('L', 'w', { op: 'set', key: 'c', value: 'A'.repeat(20) })).toBe(false);
  });

  it('🔴 保存つきでない面(埋め込み・プレビュー・書き出し)の id= の箱は、lid の在る器の中でも保存しない', async () => {
    // 別ノートを埋め込んだ枠を想定:器(このノートの lid)の中に、保存つきでない描き方の箱
    const body = document.createElement('div');
    body.setAttribute(WIDGET_LID_ATTR, 'A');
    body.innerHTML =
      renderMarkdown('```html id="x"\n<p>B の箱</p>\n```\n') +
      renderMarkdown('```react id="x"\nexport default function App(){return <b/>}\n```\n');
    document.body.append(body);
    applyWidgetStorageOp('A', 'x', { op: 'set', key: 'secret', value: 'A の値' });
    const scope = hydrateWidgets(body);
    expect(body.querySelector('.pkc-widget-placeholder')).toBeNull();
    const f = body.querySelector<HTMLIFrameElement>('iframe')!;
    expect(f.srcdoc, '埋め込み側のノートの保存を焼いた').not.toContain('A の値');
    post(set('secret', '書き換え', 1), giveWindow(f));
    expect(readWidgetStorage('A', 'x')).toEqual({ secret: 'A の値' });
    expect(widgetFrameCount()).toBe(0);
    scope.dispose();
    // React の器も同じ(保存つきの印が無ければ lid を引かない)
    setReactRuntimeLoader(() => Promise.resolve({ runtime: '/*R*/', tailwind: '/*T*/' }));
    const rs = hydrateReact(body);
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    const rf = body.querySelector<HTMLIFrameElement>('.pkc-react-placeholder iframe')!;
    expect(rf, 'React の箱が置かれていない').not.toBeNull();
    expect(rf.srcdoc, '埋め込み側のノートの保存を React の箱に焼いた').not.toContain('A の値');
    expect(rf.srcdoc, 'React の箱に shim が無い(1 行目で止まる)').toContain(WIDGET_STORAGE_MESSAGE);
    expect(widgetFrameCount()).toBe(0);
    expect(body.querySelector('[data-pkc-field="widget-reset"]')).toBeNull();
    rs.dispose();
  });

  it('親の口(applyWidgetStorageOp)単体でも上限を数える(使用量の覚えが無い状態から)', () => {
    localStorage.setItem(`${widgetStoragePrefix('L', 'w')}old`, 'A'.repeat(WIDGET_STORAGE_LIMIT - 10));
      expect(applyWidgetStorageOp('L', 'w', { op: 'set', key: 'n', value: 'A'.repeat(20) })).toBe(false);
    expect(applyWidgetStorageOp('L', 'w', { op: 'set', key: 'n', value: 'A' })).toBe(true);
    expect(applyWidgetStorageOp('L', 'w', { op: 'remove', key: 'old' })).toBe(true);
    expect(applyWidgetStorageOp('L', 'w', { op: 'set', key: 'n', value: 'A'.repeat(1000) })).toBe(true);
  });
});

describe('テーマ', () => {
  it('🔴 ready を送った箱へ今の配色を返し、配色が変わっても箱を作り直さずに配る', async () => {
    const root = document.documentElement;
    root.setAttribute('data-pkc-tone', 'light');
    root.style.setProperty('--fg', '#111');
    const { body, scope } = mount('L1', '```html id="a"\n<p>x</p>\n```\n');
    const f = frameOf(body);
    const srcdoc = f.srcdoc;
    const w = giveWindow(f);
    post({ type: WIDGET_READY_MSG_TYPE, id: f.getAttribute('data-pkc-html-render-id') }, w);
    expect(w.posted).toHaveLength(1);
    expect(w.posted[0]).toMatchObject({ type: WIDGET_THEME_MSG_TYPE, tone: 'light', tokens: { '--pkc-fg': '#111' } });
    // 配色を変える
    root.setAttribute('data-pkc-tone', 'dark');
    root.style.setProperty('--fg', '#eee');
    await new Promise((r) => setTimeout(r, 20));
    expect(w.posted.length).toBeGreaterThanOrEqual(2);
    expect(w.posted.at(-1)).toMatchObject({ type: WIDGET_THEME_MSG_TYPE, tone: 'dark', tokens: { '--pkc-fg': '#eee' } });
    // 箱は同じ・中身も同じ(読み直していない)
    expect(frameOf(body)).toBe(f);
    expect(f.srcdoc).toBe(srcdoc);
    scope.dispose();
    root.removeAttribute('data-pkc-tone');
    root.removeAttribute('style');
  });

  it('🔴 名乗った id と実体が食い違う ready には返さない(別の箱の名を騙らせない)', () => {
    const { body, scope } = mount('L1', '```html id="a"\n<p>x</p>\n```\n');
    const w = giveWindow(frameOf(body));
    post({ type: WIDGET_READY_MSG_TYPE, id: 'pkc-html-render-other' }, w);
    expect(w.posted).toEqual([]);
    scope.dispose();
  });

  it('状態を持たない ```html の箱も ready でテーマを受け取る', () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown('```html\n<p>x</p>\n```\n');
    document.body.append(host);
    const f = host.querySelector('iframe')!;
    const w = giveWindow(f);
    post({ type: WIDGET_READY_MSG_TYPE, id: f.getAttribute('data-pkc-html-render-id') }, w);
    expect(w.posted[0]).toMatchObject({ type: WIDGET_THEME_MSG_TYPE });
  });
});

describe('保存と「状態を初期化」', () => {
  it('🔴 置くときに前回の保存を seed に焼く(1 行目の同期 getItem が前回の値を返せる)', () => {
    applyWidgetStorageOp('L1', 'a', { op: 'set', key: 'count', value: '2' });
    const { body, scope } = mount('L1', '```html id="a"\n<p>x</p>\n```\n');
    expect(frameOf(body).srcdoc).toContain('{"count":"2"}');
    scope.dispose();
  });

  it('🔴 保存が 0 件なら押せず、保存すると押せ、確認して初期化すると消えて、はじめの状態で置き直される', async () => {
    const { body, scope } = mount('L1', '```html id="a"\n<p>x</p>\n```\n');
    const btn = body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-reset"]')!;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('状態を初期化');
    expect(btn.disabled, '保存が無いのに押せる').toBe(true);
    const w = giveWindow(frameOf(body));
    post(set('count', '2', 1), w);
    expect(btn.disabled, '保存したのに押せない').toBe(false);
    const before = frameOf(body);
    btn.click();
    const dialog = document.querySelector<HTMLDialogElement>(`[data-pkc-region="${DIALOG_REGION}"]`)!;
    expect(dialog.open).toBe(true);
    // やめる → 何も消えない
    document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-cancel"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(hasWidgetStorage('L1', 'a')).toBe(true);
    expect(frameOf(body)).toBe(before);
    // 初期化する
    btn.click();
    document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-ok"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(hasWidgetStorage('L1', 'a')).toBe(false);
    const after = frameOf(body);
    expect(after, '置き直していない').not.toBe(before);
    expect(before.isConnected).toBe(false);
    expect(after.srcdoc).not.toContain('"count"');
    expect(btn.disabled).toBe(true);
    // バーは 1 本のまま・登録も 1 つ
    expect(body.querySelectorAll('[data-pkc-field="widget-bar"]')).toHaveLength(1);
    expect(widgetFrameCount()).toBe(1);
    // 古い窓からの書込はもう通らない
    post(set('count', '9', 2), w);
    expect(hasWidgetStorage('L1', 'a')).toBe(false);
    scope.dispose();
    expect(widgetFrameCount(), 'dispose で登録が残った').toBe(0);
  });

  it('🔴 別のノートへ持ち越された箱は前のノートへ書かず、新しい lid で置き直される', () => {
    const { body, scope } = mount('L1', '```html id="a"\n<p>x</p>\n```\n');
    const old = frameOf(body);
    const w = giveWindow(old);
    // 差分描画が塊を持ち越したまま、器の lid だけが変わった
    body.setAttribute(WIDGET_LID_ATTR, 'L2');
    post(set('k', 'v', 1), w);
    expect(storageKeys(), '前のノートへ書いた').toEqual([]);
    expect(w.posted).toContainEqual({ tag: WIDGET_STORAGE_MESSAGE, op: 'ack', seq: 1, ok: false });
    expect(remountStaleWidgets(body)).toBe(1);
    const next = frameOf(body);
    expect(next).not.toBe(old);
    post(set('k', 'v', 2), giveWindow(next));
    expect(readWidgetStorage('L2', 'a')).toEqual({ k: 'v' });
    expect(readWidgetStorage('L1', 'a')).toEqual({});
    scope.dispose();
  });

  it('🔴 箱が読み直されたら、置いた後に保存した値で焼き直す(古い seed で起き上がらせない)', () => {
    const f = document.createElement('iframe');
    applyWidgetStorageOp('L', 'w', { op: 'set', key: 'n', value: '0' });
    const rebuild = vi.fn((seed: Readonly<Record<string, string>>) => JSON.stringify(seed));
    keepWidgetSeedFresh(f, 'L', 'w', readWidgetStorage('L', 'w'), rebuild);
    f.dispatchEvent(new Event('load')); // 1 回目(置いたとき)
    applyWidgetStorageOp('L', 'w', { op: 'set', key: 'n', value: '2' });
    f.dispatchEvent(new Event('load')); // 器ごと外れて戻った
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(f.srcdoc).toBe('{"n":"2"}');
    f.dispatchEvent(new Event('load')); // 焼き直した読み込み
    f.dispatchEvent(new Event('load')); // 変わっていなければ焼き直さない
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('🔴 ノートを完全に消したら、そのノートのウィジェットの保存だけが消える', () => {
    applyWidgetStorageOp('L1', 'a', { op: 'set', key: 'k', value: 'v' });
    applyWidgetStorageOp('L1', 'b', { op: 'set', key: 'k', value: 'v' });
    applyWidgetStorageOp('L10', 'a', { op: 'set', key: 'k', value: 'v' });
    applyWidgetStorageOp('L1.x', 'a', { op: 'set', key: 'k', value: 'v' });
    localStorage.setItem('pkc3.theme', 'dark');
    clearEntryWidgetStorage('L1');
    expect(storageKeys()).toEqual(
      [`${widgetStoragePrefix('L10', 'a')}k`, `${widgetStoragePrefix('L1.x', 'a')}k`, 'pkc3.theme'].sort(),
    );
  });
});

describe('React のウィジェット', () => {
  it('🔴 id= の在る React の箱は保存の shim とテーマの prelude を焼き、登録され、初期化のボタンを持つ', async () => {
    applyWidgetStorageOp('L1', 'c', { op: 'set', key: 'n', value: '5' });
    setReactRuntimeLoader(() => Promise.resolve({ runtime: '/*R*/', tailwind: '/*T*/' }));
    const body = document.createElement('div');
    body.setAttribute(WIDGET_LID_ATTR, 'L1');
    body.innerHTML = renderMarkdown('```react id="c"\nexport default function App(){return <b/>}\n```\n', { liveWidgets: true });
    document.body.append(body);
    const scope = hydrateReact(body);
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    const f = body.querySelector<HTMLIFrameElement>('iframe')!;
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.hasAttribute('data-pkc-widget-frame')).toBe(true);
    expect(f.srcdoc).toContain(WIDGET_STORAGE_MESSAGE);
    expect(f.srcdoc).toContain('{"n":"5"}');
    expect(f.srcdoc).toContain(WIDGET_READY_MSG_TYPE);
    // prelude はランタイムより前
    expect(f.srcdoc.indexOf(WIDGET_STORAGE_MESSAGE)).toBeLessThan(f.srcdoc.indexOf('/*R*/'));
    expect(body.querySelector('[data-pkc-field="widget-reset"]')).not.toBeNull();
    post(set('n', '6', 1), giveWindow(f));
    expect(readWidgetStorage('L1', 'c')).toEqual({ n: '6' });
    scope.dispose();
    expect(widgetFrameCount()).toBe(0);
  });

  it('id= の無い React はテーマだけ(保存の shim を焼かず、登録もしない)', async () => {
    setReactRuntimeLoader(() => Promise.resolve({ runtime: '/*R*/', tailwind: '/*T*/' }));
    const body = document.createElement('div');
    body.setAttribute(WIDGET_LID_ATTR, 'L1');
    body.innerHTML = renderMarkdown('```react\nexport default function App(){return <b/>}\n```\n', { liveWidgets: true });
    document.body.append(body);
    const scope = hydrateReact(body);
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    const f = body.querySelector<HTMLIFrameElement>('iframe')!;
    expect(f.srcdoc).not.toContain(WIDGET_STORAGE_MESSAGE);
    expect(f.srcdoc).toContain(WIDGET_READY_MSG_TYPE);
    expect(widgetFrameCount()).toBe(0);
    expect(body.querySelector('[data-pkc-field="widget-reset"]')).toBeNull();
    post(set('n', '6', 1), giveWindow(f));
    expect(storageKeys()).toEqual([]);
    scope.dispose();
  });
});

describe('ゴミ箱を空にする配線(store-port)', () => {
  it('🔴 完全に消した lid のウィジェットの保存だけを畳む(ゴミ箱に残るノートの保存は残す)', async () => {
    const { createStorePort } = await import('../../src/adapter/platform/storage/store-port');
    applyWidgetStorageOp('gone', 'a', { op: 'set', key: 'k', value: 'v' });
    applyWidgetStorageOp('kept', 'a', { op: 'set', key: 'k', value: 'v' });
    applyWidgetStorageOp('alive', 'a', { op: 'set', key: 'k', value: 'v' });
    const client = {
      request: (req: { op: string }) =>
        Promise.resolve(
          req.op === 'listTrash' ? [{ entry_lid: 'gone' }, { entry_lid: 'kept' }] : { purged: 1 },
        ),
      terminate: () => undefined,
    };
    const port = createStorePort(client as never, 'c1');
    await port.purgeTrash('gone');
    expect(hasWidgetStorage('gone', 'a')).toBe(false);
    expect(hasWidgetStorage('kept', 'a'), '1 件だけ消した回に、ほかのゴミ箱のノートの保存まで消えた').toBe(true);
    expect(hasWidgetStorage('alive', 'a')).toBe(true);
    await port.purgeTrash();
    expect(hasWidgetStorage('kept', 'a')).toBe(false);
    expect(hasWidgetStorage('alive', 'a'), 'ゴミ箱に無いノートの保存が消えた').toBe(true);
  });
});

/** 本文を持つ親の口(reducer の代わりに、書く側の純関数で本文を書き換える)。 */
function fakeHost(bodies: Record<string, string>): WidgetNoteHost & { calls: string[]; fails: string[]; blocked: string | null } {
  const h = {
    calls: [] as string[],
    fails: [] as string[],
    blocked: null as string | null,
    bodyOf: (lid: string) => bodies[lid] ?? null,
    writeBlockReason: () => h.blocked,
    saveState: (lid: string, wid: string, state: Readonly<Record<string, string>>) => {
      h.calls.push(`save:${lid}:${wid}`);
      const r = upsertWidgetStateBlock(bodies[lid] ?? '', wid, state);
      if (r.ok) bodies[lid] = r.body;
    },
    removeState: (lid: string, wid: string): Promise<boolean> => {
      h.calls.push(`remove:${lid}:${wid}`);
      bodies[lid] = removeWidgetStateBlock(bodies[lid] ?? '', wid);
      return Promise.resolve(true);
    },
    fail: (m: string) => {
      h.fails.push(m);
    },
  };
  return h;
}

const ask = (id: string, reqId: number): Record<string, unknown> => ({ type: WIDGET_CONTEXT_REQ_MSG_TYPE, id, reqId });
const answers = (w: FakeWin): { reqId: number; context: { frontmatter: Record<string, unknown>; tables: unknown[] } }[] =>
  w.posted.filter((m) => (m as { type?: string }).type === WIDGET_CONTEXT_RES_MSG_TYPE) as never;
const NOTE_L1 = '---\ntitle: 家計\nbudget: 5000\n---\n| 品目 | 金額 |\n|---|---|\n| 米 | 2000 |\n\n```html id="sum"\n<p>x</p>\n```\n';
const NOTE_L2 = '---\nsecret: 他のノート\n---\n```csv\na,b\n9,9\n```\n';

describe('🔴 同じノートのデータの読み取り(PR-08)', () => {
  it('🔴 登録した箱には、置いたノート 1 件の前書きと表だけを返す', () => {
    setWidgetNoteHost(fakeHost({ L1: NOTE_L1, L2: NOTE_L2 }));
    const { body, scope } = mount('L1', NOTE_L1);
    const f = frameOf(body);
    const w = giveWindow(f);
    post(ask(f.getAttribute('data-pkc-html-render-id')!, 7), w);
    const got = answers(w);
    expect(got).toHaveLength(1);
    expect(got[0]!.reqId).toBe(7);
    expect(got[0]!.context.frontmatter).toEqual({ title: '家計', budget: 5000 });
    expect(got[0]!.context.tables).toEqual([{ index: 0, kind: 'markdown', headers: ['品目', '金額'], rows: [['米', '2000']] }]);
    // 他のノートの字は 1 字も来ない
    expect(JSON.stringify(w.posted)).not.toContain('他のノート');
    scope.dispose();
  });

  it('🔴 なりすまし(別の窓が箱の id を名乗る)・登録の無い箱・持ち越された箱には空を返す', () => {
    setWidgetNoteHost(fakeHost({ L1: NOTE_L1, L2: NOTE_L2 }));
    const { body, scope } = mount('L1', NOTE_L1);
    const f = frameOf(body);
    const id = f.getAttribute('data-pkc-html-render-id')!;
    giveWindow(f);
    // ① 別の窓が箱の id を名乗る
    const spoof = fakeWin();
    post(ask(id, 1), spoof);
    expect(answers(spoof)).toEqual([{ type: WIDGET_CONTEXT_RES_MSG_TYPE, reqId: 1, context: { frontmatter: {}, tables: [] } }]);
    // ② id= の無い(登録の無い)箱
    const plain = document.createElement('div');
    plain.setAttribute(WIDGET_LID_ATTR, 'L1');
    plain.innerHTML = buildHtmlSandboxIframe('<p>y</p>', '', 0);
    document.body.append(plain);
    const pf = plain.querySelector('iframe')!;
    const pw = giveWindow(pf);
    post(ask(pf.getAttribute('data-pkc-html-render-id')!, 2), pw);
    expect(answers(pw)[0]!.context).toEqual({ frontmatter: {}, tables: [] });
    // ③ 別のノート(L2)へ持ち越された箱 ── L2 の本文も L1 の本文も返さない
    const w = giveWindow(f);
    body.setAttribute(WIDGET_LID_ATTR, 'L2');
    post(ask(id, 3), w);
    expect(answers(w)[0]!.context).toEqual({ frontmatter: {}, tables: [] });
    // ④ reqId の無い問い合わせは捨てる
    post({ type: WIDGET_CONTEXT_REQ_MSG_TYPE, id }, w);
    expect(answers(w)).toHaveLength(1);
    scope.dispose();
  });

  it('🔴 保存しない面(プレビュー・埋め込み)の id= の箱には空を返す', () => {
    setWidgetNoteHost(fakeHost({ L1: NOTE_L1 }));
    const body = document.createElement('div');
    body.setAttribute(WIDGET_LID_ATTR, 'L1');
    body.innerHTML = renderMarkdown(NOTE_L1, {});
    document.body.append(body);
    const f = body.querySelector<HTMLIFrameElement>('iframe')!;
    const w = giveWindow(f);
    post(ask(f.getAttribute('data-pkc-html-render-id')!, 1), w);
    expect(answers(w)[0]!.context).toEqual({ frontmatter: {}, tables: [] });
  });

  it('箱の中の口(readTables / readFrontmatter / readNoteContext)と、答えの来ないときの空', () => {
    const f = buildHtmlSandboxIframe('<p>z</p>', '', 0);
    const doc = f.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    expect(doc).toContain('api.readNoteContext=');
    expect(doc).toContain('api.readTables=');
    expect(doc).toContain('api.readFrontmatter=');
    expect(doc).toContain(WIDGET_CONTEXT_REQ_MSG_TYPE);
    expect(doc).toContain(WIDGET_CONTEXT_RES_MSG_TYPE);
    // 🔴 答えは親(e.source===parent)からの物だけ受ける(同じ listener の門)
    expect(doc).toMatch(/if\(e\.source!==window\.parent\)return;var d=e\.data;if\(d&&d\.type===CRES/);
  });
});

describe('🔴 ノートへ保存と、状態ブロックからの復元(PR-08)', () => {
  it('🔴 保存 → 端末の保存を消して置き直す → 本文の状態ブロックから元どおり', () => {
    const bodies: Record<string, string> = { L1: '```html id="a"\n<p>x</p>\n```\n' };
    const host = fakeHost(bodies);
    setWidgetNoteHost(host);
    const { body, scope } = mount('L1', bodies.L1!);
    const save = body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-save"]')!;
    expect(save.textContent).toBe('ノートへ保存');
    expect(save.disabled, '保存が無いのに押せる').toBe(true);
    post(set('count', '4', 1), giveWindow(frameOf(body)));
    expect(save.disabled, '保存したのに押せない').toBe(false);
    save.click();
    expect(host.calls).toEqual(['save:L1:a']);
    expect(readWidgetStateBlock(bodies.L1!, 'a')).toEqual({ count: '4' });
    scope.dispose();
    // 別の端末(端末の保存が空)で開いた形
    localStorage.clear();
    const again = mount('L1', bodies.L1!);
    expect(frameOf(again.body).srcdoc, '本文の状態ブロックから seed されていない').toContain('{"count":"4"}');
    // 🔑 読んだ値は端末の保存へ写す(次に変えた鍵だけが届いても、他の鍵が消えない)
    expect(readWidgetStorage('L1', 'a')).toEqual({ count: '4' });
    again.scope.dispose();
  });

  it('🔴 端末の保存が在れば、本文の状態ブロックより端末の保存が勝つ', () => {
    const bodies: Record<string, string> = { L1: '```html id="a"\n<p>x</p>\n```\n\n```json widget-state="a"\n{"count":"1"}\n```\n' };
    setWidgetNoteHost(fakeHost(bodies));
    applyWidgetStorageOp('L1', 'a', { op: 'set', key: 'count', value: '9' });
    expect(resolveWidgetSeed('L1', 'a')).toEqual({ count: '9' });
    localStorage.clear();
    expect(resolveWidgetSeed('L1', 'a')).toEqual({ count: '1' });
    // 壊れたブロックは無視(空)
    bodies.L1 = '```json widget-state="a"\n{oops\n```\n';
    localStorage.clear();
    expect(resolveWidgetSeed('L1', 'a')).toEqual({});
  });

  it('🔴 書けないとき(編集中など)は押せず、押されても書かずに理由を言う', () => {
    const bodies: Record<string, string> = { L1: '```html id="a"\n<p>x</p>\n```\n' };
    const host = fakeHost(bodies);
    host.blocked = '編集を保存するか、編集をやめてからもう一度押してください';
    setWidgetNoteHost(host);
    applyWidgetStorageOp('L1', 'a', { op: 'set', key: 'k', value: 'v' });
    const { body, scope } = mount('L1', bodies.L1!);
    const save = body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-save"]')!;
    expect(save.disabled).toBe(true);
    expect(save.title).toContain('編集を保存するか');
    save.disabled = false;
    save.click();
    expect(host.calls).toEqual([]);
    expect(host.fails).toEqual([host.blocked]);
    scope.dispose();
  });

  it('🔴 箱の合図(保存の差分)では本文を書かない', () => {
    const bodies: Record<string, string> = { L1: '```html id="a"\n<p>x</p>\n```\n' };
    const host = fakeHost(bodies);
    setWidgetNoteHost(host);
    const { body, scope } = mount('L1', bodies.L1!);
    const w = giveWindow(frameOf(body));
    post(set('count', '4', 1), w);
    post({ type: 'pkc-widget-save', state: { count: '4' } }, w);
    expect(host.calls).toEqual([]);
    expect(bodies.L1).toBe('```html id="a"\n<p>x</p>\n```\n');
    scope.dispose();
  });

  it('🔴 「状態を初期化」で端末の保存と本文の状態ブロックの両方を消し、置き直しても復活しない', async () => {
    const bodies: Record<string, string> = {
      L1: '```html id="a"\n<p>x</p>\n```\n\n```json widget-state="a"\n{"count":"4"}\n```\n',
    };
    const host = fakeHost(bodies);
    setWidgetNoteHost(host);
    const { body, scope } = mount('L1', bodies.L1!);
    expect(frameOf(body).srcdoc).toContain('{"count":"4"}');
    const btn = body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-reset"]')!;
    expect(btn.disabled).toBe(false);
    btn.click();
    const dialog = document.querySelector<HTMLDialogElement>(`[data-pkc-region="${DIALOG_REGION}"]`)!;
    expect(dialog.textContent).toContain('ノートに保存済みの状態ブロックも削除します');
    document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-ok"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(host.calls).toEqual(['remove:L1:a']);
    expect(hasWidgetStorage('L1', 'a')).toBe(false);
    expect(readWidgetStateBlock(bodies.L1!, 'a')).toBeNull();
    expect(bodies.L1).toBe('```html id="a"\n<p>x</p>\n```\n');
    expect(frameOf(body).srcdoc, '置き直した箱に古い値が残った').not.toContain('"count"');
    expect(btn.disabled).toBe(true);
    scope.dispose();
    // 開き直しても(端末の保存も本文のブロックも無い)はじめの状態
    const again = mount('L1', bodies.L1!);
    expect(frameOf(again.body).srcdoc).not.toContain('"count"');
    again.scope.dispose();
  });

  it('🔴 本文の書込が終わる前に置き直しても、消すはずのブロックから復活させない', async () => {
    const bodies: Record<string, string> = {
      L1: '```html id="a"\n<p>x</p>\n```\n\n```json widget-state="a"\n{"count":"4"}\n```\n',
    };
    const host = fakeHost(bodies);
    // 書込が遅れる形(removeState は記録だけして本文を変えない)
    let settle: (ok: boolean) => void = () => undefined;
    host.removeState = (lid, wid) => {
      host.calls.push(`remove:${lid}:${wid}`);
      return new Promise<boolean>((r) => {
        settle = r;
      });
    };
    setWidgetNoteHost(host);
    const { body, scope } = mount('L1', bodies.L1!);
    body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-reset"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-ok"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(frameOf(body).srcdoc).not.toContain('"count"');
    expect(hasWidgetStorage('L1', 'a'), '古いブロックを端末の保存へ写した').toBe(false);
    // もう一度「ノートへ保存」したら、本文のブロックがまた正になる
    post(set('count', '1', 1), giveWindow(frameOf(body)));
    body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-save"]')!.click();
    expect(host.calls.at(-1)).toBe('save:L1:a');
    settle(true);
    scope.dispose();
  });

  it('🔴 本文から消せなかったら(別のタブの編集中・書込の失敗)、端末の保存も元に戻す(食い違いを残さない)', async () => {
    const bodies: Record<string, string> = {
      L1: '```html id="a"\n<p>x</p>\n```\n\n```json widget-state="a"\n{"count":"4"}\n```\n',
    };
    const host = fakeHost(bodies);
    host.removeState = (lid, wid) => {
      host.calls.push(`remove:${lid}:${wid}`);
      return Promise.resolve(false);
    };
    setWidgetNoteHost(host);
    applyWidgetStorageOp('L1', 'a', { op: 'set', key: 'count', value: '6' });
    const { body, scope } = mount('L1', bodies.L1!);
    body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-reset"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-ok"]')!.click();
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(host.calls).toEqual(['remove:L1:a']);
    expect(readWidgetStorage('L1', 'a'), '端末の保存が戻っていない').toEqual({ count: '6' });
    expect(frameOf(body).srcdoc).toContain('{"count":"6"}');
    // 印は残さない(次に置くときは、端末 → 本文の順に戻る)
    localStorage.clear();
    expect(resolveWidgetSeed('L1', 'a')).toEqual({ count: '4' });
    scope.dispose();
  });

  it('🔴 保存しない面(書き出し・プレビュー)の箱も、本文の状態ブロックを初期値にする(保存はしない)', () => {
    const md = '```html id="a"\n<p>x</p>\n```\n\n```json widget-state="a"\n{"count":"7"}\n```\n';
    const html = renderMarkdown(md, {});
    expect(html.replace(/&quot;/g, '"')).toContain('{"count":"7"}');
    // 状態ブロックの無い本文では初期値は空のまま
    expect(renderMarkdown('```html id="a"\n<p>x</p>\n```\n', {}).replace(/&quot;/g, '"')).not.toContain('"count"');
    // React の器にも写しを添える(保存つきの面には添えない)
    const r = '```react id="c"\nexport default function A(){return <b/>}\n```\n\n```json widget-state="c"\n{"n":"3"}\n```\n';
    expect(renderMarkdown(r, {})).toContain('data-pkc-widget-seed=');
    expect(renderMarkdown(r, { liveWidgets: true })).not.toContain('data-pkc-widget-seed=');
  });
});

describe('🔴 書込の経路(reducer → REQUEST_BODY_REWRITE。PR-08)', () => {
  const withEntry = (): AppState => {
    const st = initialState as AppState;
    const metas = new Map(st.entryMetas);
    metas.set('L1', { lid: 'L1', title: 't', archetype: 'text', entryOrder: 0 } as never);
    return { ...st, phase: 'ready', entryMetas: metas };
  };
  it('SET_WIDGET_STATE は本文の書換の 1 本(widget-state)を撃ち、書けないときは断る', () => {
    const r = reduce(withEntry(), { type: 'SET_WIDGET_STATE', lid: 'L1', widgetId: 'a', state: { k: 'v' } });
    expect(r.events).toEqual([
      expect.objectContaining({
        type: 'REQUEST_BODY_REWRITE',
        lid: 'L1',
        rewrite: { kind: 'widget-state', widgetId: 'a', state: { k: 'v' } },
      }),
    ]);
    const del = reduce(withEntry(), { type: 'SET_WIDGET_STATE', lid: 'L1', widgetId: 'a', state: null });
    expect(del.events[0]).toMatchObject({ rewrite: { kind: 'widget-state', widgetId: 'a', state: null } });
    const busy = reduce({ ...withEntry(), phase: 'initializing' }, { type: 'SET_WIDGET_STATE', lid: 'L1', widgetId: 'a', state: { k: 'v' } });
    expect(busy.events).toEqual([]);
    expect(busy.state.error).toContain('ウィジェットの状態をノートに保存してください');
  });
  it('applyBodyRewrite(widget-state)は書く・消す・上限で断る', () => {
    const body = '```html id="a"\nx\n```\n';
    const saved = applyBodyRewrite(body, { kind: 'widget-state', widgetId: 'a', state: { k: 'v' } })!;
    expect(readWidgetStateBlock(saved, 'a')).toEqual({ k: 'v' });
    expect(applyBodyRewrite(saved, { kind: 'widget-state', widgetId: 'a', state: null })).toBe(body);
    expect(applyBodyRewrite(body, { kind: 'widget-state', widgetId: 'a', state: { k: 'x'.repeat(70000) } })).toBeNull();
  });
});

describe('🔴 問い合わせの流量の上限(PR-08 レビュー)', () => {
  it('休みなく問い合わせても、1 つの箱につき 100ms に 1 回だけ組み、待たせるのは 16 件まで', () => {
    vi.useFakeTimers();
    try {
      setWidgetNoteHost(fakeHost({ L1: NOTE_L1 }));
      const { body, scope } = mount('L1', NOTE_L1);
      const f = frameOf(body);
      const id = f.getAttribute('data-pkc-html-render-id')!;
      const w = giveWindow(f);
      for (let i = 1; i <= 40; i += 1) post(ask(id, i), w);
      expect(answers(w).map((a) => a.reqId), '最初の 1 件はすぐ答える').toEqual([1]);
      vi.advanceTimersByTime(CONTEXT_MIN_INTERVAL_MS);
      const got = answers(w).map((a) => a.reqId);
      expect(got).toHaveLength(1 + CONTEXT_MAX_PENDING);
      expect(got.slice(1)).toEqual(Array.from({ length: CONTEXT_MAX_PENDING }, (_, i) => i + 2));
      // 答えの中身は同じノートの物
      expect(answers(w).at(-1)!.context.tables).toHaveLength(1);
      scope.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('🔴 箱の中の口を実際に走らせる(PR-08 レビュー:文字列の検査だけでは空振る)', () => {
  /** 箱の中の window を模して prelude を走らせる。親へ送った物と、親から届ける口を返す。 */
  function runPrelude(): {
    api: { readTables: () => Promise<unknown>; readFrontmatter: () => Promise<unknown>; readNoteContext: () => Promise<unknown> };
    sent: Record<string, unknown>[];
    deliver: (data: unknown, fromParent?: boolean) => void;
  } {
    const html = buildHtmlSandboxIframe('<p>z</p>', '', 0);
    const doc = html.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const all = [...doc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    const prelude = all.find((x) => x.includes('api.readTables='))!;
    expect(prelude, 'prelude が見つからない').toBeTruthy();
    const sent: Record<string, unknown>[] = [];
    const listeners: ((e: { source: unknown; data: unknown }) => void)[] = [];
    const parentWin = { postMessage: (m: Record<string, unknown>) => sent.push(m) };
    const win: Record<string, unknown> = {
      parent: parentWin,
      addEventListener: (t: string, cb: (e: { source: unknown; data: unknown }) => void) => {
        if (t === 'message') listeners.push(cb);
      },
      localStorage: null,
    };
    const fakeDoc = { documentElement: { style: { setProperty() {}, removeProperty() {} }, setAttribute() {} } };
    new Function('window', 'document', prelude)(win, fakeDoc);
    return {
      api: win.pkcWidget as never,
      sent,
      deliver: (data, fromParent = true) => {
        for (const l of listeners) l({ source: fromParent ? parentWin : {}, data });
      },
    };
  }

  it('readTables / readFrontmatter / readNoteContext は親へ問い合わせ、親の答えの該当部分を返す', async () => {
    const { api, sent, deliver } = runPrelude();
    const ctx = { frontmatter: { a: 1 }, tables: [{ index: 0, kind: 'csv', headers: ['h'], rows: [['1']] }] };
    const pT = api.readTables();
    const pF = api.readFrontmatter();
    const pC = api.readNoteContext();
    // 1 通目は起動時の ready(テーマを受け取る合図)
    expect(sent.map((m) => m.type)).toEqual([
      WIDGET_READY_MSG_TYPE,
      WIDGET_CONTEXT_REQ_MSG_TYPE,
      WIDGET_CONTEXT_REQ_MSG_TYPE,
      WIDGET_CONTEXT_REQ_MSG_TYPE,
    ]);
    const ids = sent.slice(1).map((m) => m.reqId);
    expect(new Set(ids).size, 'reqId が重なっている').toBe(3);
    // 🔴 親以外から来た答えは受けない
    deliver({ type: WIDGET_CONTEXT_RES_MSG_TYPE, reqId: ids[0], context: { frontmatter: {}, tables: ['偽'] } }, false);
    for (const id of ids) deliver({ type: WIDGET_CONTEXT_RES_MSG_TYPE, reqId: id, context: ctx });
    expect(await pT).toEqual(ctx.tables);
    expect(await pF).toEqual(ctx.frontmatter);
    expect(await pC).toEqual(ctx);
  });

  it('🔴 答えが来なければ、待ち時間の後に空の答えを返す(書き出した HTML でも止まらない)', async () => {
    vi.useFakeTimers();
    try {
      const { api } = runPrelude();
      const p = api.readNoteContext();
      const pt = api.readTables();
      vi.advanceTimersByTime(WIDGET_CONTEXT_TIMEOUT_MS + 1);
      expect(await p).toEqual({ frontmatter: {}, tables: [] });
      expect(await pt).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('壊れた答え(配列の前書き・表でない表)は空に直す', async () => {
    const { api, sent, deliver } = runPrelude();
    const p = api.readNoteContext();
    deliver({ type: WIDGET_CONTEXT_RES_MSG_TYPE, reqId: sent[1]!.reqId, context: { frontmatter: [1], tables: 'x' } });
    expect(await p).toEqual({ frontmatter: {}, tables: [] });
  });
});

describe('🔴 添付の HTML のウィジェット(#2090 ①)と単体の HTML で保存(#2090 ③)', () => {
  const TOOL = '<div id="n">0</div><script>var n=Number(localStorage.getItem("count")||0);</script>';
  /** 本文に添付の囲みを描き、添付の中身で埋めて、ウィジェットを置く(読む面と同じ配線: hydrateFenceHosts → hydrateWidgets)。 */
  async function mountAsset(
    lid: string | null,
    md: string,
    live: boolean,
  ): Promise<{ body: HTMLElement; scopes: ReturnType<typeof hydrateWidgets>[] }> {
    const body = document.createElement('div');
    body.className = 'pkc-md-rendered';
    if (lid !== null) body.setAttribute(WIDGET_LID_ATTR, lid);
    body.innerHTML = renderMarkdown(md, { liveWidgets: live });
    document.body.append(body);
    const scopes: ReturnType<typeof hydrateWidgets>[] = [];
    await hydrateFenceHosts({
      hosts: [...body.querySelectorAll<HTMLElement>('[data-pkc-fence-asset-key]')],
      getBlob: async (k) => (k === 'ast-tool' ? new Blob([TOOL], { type: 'text/html' }) : null),
      texts: new Map(),
      env: { allowExternalImages: false, currentContainerId: 'c1', ...(live ? { liveWidgets: true } : {}) },
      stale: () => false,
      onReplaced: (next) => scopes.push(hydrateWidgets(next)),
    });
    return { body, scopes };
  }

  /** ダウンロードを捕まえる(⚠ `<a download>` の click を止める ── happy-dom がナビゲーションとして処理しないように)。 */
  function catchDownloads(): { files: { name: string; blob: Blob; url: string }[]; revoked: string[] } {
    const files: { name: string; blob: Blob; url: string }[] = [];
    const revoked: string[] = [];
    const pending = new Map<string, Blob>();
    let n = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      n += 1;
      const url = `blob:test/${n}`;
      pending.set(url, b as Blob);
      return url;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => {
      revoked.push(u);
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      files.push({ name: this.download, blob: pending.get(this.href)!, url: this.href });
    });
    return { files, revoked };
  }

  it.each([
    ['asset が先', '```html asset:ast-tool id="tool1"\n```\n'],
    ['id が先', '```html id="tool1" asset:ast-tool\n```\n'],
  ])('🔴 `asset:` と `id=` を合わせると状態を持つウィジェットになる(%s)', async (_n, md) => {
    setWidgetNoteHost(fakeHost({ L1: md }));
    const { body, scopes } = await mountAsset('L1', md, true);
    const ph = body.querySelector<HTMLElement>('.pkc-widget-placeholder')!;
    expect(ph, '器にならない').not.toBeNull();
    expect(ph.getAttribute('data-pkc-widget-asset')).toBe('ast-tool');
    expect(ph.getAttribute('data-pkc-widget-id')).toBe('tool1');
    expect(ph.getAttribute('data-pkc-widget-live')).toBe('1');
    const f = frameOf(body);
    // 🔴 直書きと同じ箱(緩めない)
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.srcdoc).toContain("connect-src 'none'");
    expect(f.srcdoc).toContain('localStorage.getItem("count")');
    // 保存は器の (lid, id) へ
    post(set('count', '7', 1), giveWindow(f));
    expect(readWidgetStorage('L1', 'tool1')).toEqual({ count: '7' });
    // バーは 4 つ(保存・初期化・HTML で保存・権限 ── 権限は添付の HTML だけ。#2090 ②)
    const fields = [...body.querySelectorAll('[data-pkc-field="widget-bar"] button')].map((b) => b.getAttribute('data-pkc-field'));
    expect(fields).toEqual(['widget-save', 'widget-reset', 'widget-download', 'widget-permissions']);
    expect(body.querySelector('[data-pkc-field="widget-download"]')!.textContent).toBe('HTML で保存');
    for (const s of scopes) s.dispose();
  });

  it('🔴 `id=` の無い添付の HTML は器になるが保存は持たない(バーは「HTML で保存」だけ・同じノートの参照には答える)', async () => {
    const md = '| 品目 | 金額 |\n|---|---|\n| 米 | 2000 |\n\n```html asset:ast-tool\n```\n';
    setWidgetNoteHost(fakeHost({ L1: md }));
    const { body, scopes } = await mountAsset('L1', md, true);
    const ph = body.querySelector<HTMLElement>('.pkc-widget-placeholder')!;
    expect(ph.getAttribute('data-pkc-widget-asset')).toBe('ast-tool');
    expect(ph.hasAttribute('data-pkc-widget-id')).toBe(false);
    expect(ph.hasAttribute('data-pkc-widget-live')).toBe(false);
    const f = frameOf(body);
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    // 保存の shim は入れない(状態を持たない)
    expect(f.srcdoc).not.toContain(WIDGET_STORAGE_MESSAGE);
    const fields = [...body.querySelectorAll('[data-pkc-field="widget-bar"] button')].map((b) => b.getAttribute('data-pkc-field'));
    expect(fields).toEqual(['widget-download', 'widget-permissions']);
    // 🔴 保存要求は捨てる(直の要求でも)
    const w = giveWindow(f);
    post(set('count', '9', 1), w);
    expect(storageKeys()).toEqual([]);
    // 同じノートの参照には答える(置いたノート 1 件の表)
    post({ type: WIDGET_CONTEXT_REQ_MSG_TYPE, id: f.getAttribute('data-pkc-html-render-id'), reqId: 1 }, w);
    await new Promise((r) => setTimeout(r, 0));
    const res = w.posted.find((m) => (m as { type?: string }).type === WIDGET_CONTEXT_RES_MSG_TYPE) as {
      context: { tables: unknown[] };
    };
    expect(res.context.tables.length, '同じノートの表が返らない').toBe(1);
    for (const s of scopes) s.dispose();
    expect(widgetFrameCount()).toBe(0);
  });

  it('🔴 埋め込みの面(liveWidgets なし)では器にならず、保存しない(別のノートへ越境しない)', async () => {
    const md = '```html asset:ast-tool id="tool1"\n```\n';
    setWidgetNoteHost(fakeHost({ L1: md }));
    const { body, scopes } = await mountAsset('L1', md, false);
    expect(body.querySelector('.pkc-widget-placeholder')).toBeNull();
    expect(body.querySelector('[data-pkc-widget-asset]')).toBeNull();
    const f = body.querySelector<HTMLIFrameElement>('iframe')!;
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    // 箱の中だけの保存(1 行目で止まらない)は入る
    expect(f.srcdoc).toContain(WIDGET_STORAGE_MESSAGE);
    post(set('count', '9', 1), giveWindow(f));
    expect(storageKeys()).toEqual([]);
    expect(widgetFrameCount()).toBe(0);
    expect(body.querySelector('[data-pkc-field="widget-bar"]')).toBeNull();
    for (const s of scopes) s.dispose();
  });

  it('🔴「HTML で保存」で、端末の保存と今の配色を焼いた単体の .html を落とし、ObjectURL を手放す', async () => {
    const md = '```html asset:ast-tool id="tool1"\n```\n';
    const host = fakeHost({ L1: md });
    setWidgetNoteHost({ ...host, titleOf: () => '家計のノート' });
    document.documentElement.setAttribute('data-pkc-tone', 'dark');
    const dl = catchDownloads();
    try {
      const { body, scopes } = await mountAsset('L1', md, true);
      post(set('count', '42', 1), giveWindow(frameOf(body)));
      body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-download"]')!.click();
      expect(dl.files).toHaveLength(1);
      expect(dl.files[0]!.name).toBe('tool1.html');
      const text = await dl.files[0]!.blob.text();
      expect(dl.files[0]!.blob.type).toContain('text/html');
      expect(text.startsWith('<!DOCTYPE html><html lang="ja" data-pkc-tone="dark">')).toBe(true);
      expect(text, '端末の保存が焼かれていない').toContain('{"count":"42"}');
      expect(text).toContain('localStorage.getItem("count")');
      expect(text).toContain("connect-src 'none'");
      // 🔴 ObjectURL は読み終えた頃に必ず revoke(即破棄)
      await new Promise((r) => setTimeout(r, 1100));
      expect(dl.revoked).toEqual([dl.files[0]!.url]);
      for (const s of scopes) s.dispose();
    } finally {
      document.documentElement.removeAttribute('data-pkc-tone');
    }
  });

  it('「HTML で保存」の seed は端末の保存 → 本文の状態ブロックの順(端末が空なら本文のブロック)', async () => {
    const md = '```html asset:ast-tool id="tool1"\n```\n\n```json widget-state="tool1"\n{"count":"5"}\n```\n';
    setWidgetNoteHost(fakeHost({ L1: md }));
    const dl = catchDownloads();
    const { body, scopes } = await mountAsset('L1', md, true);
    localStorage.clear(); // 別の端末で開いた形(置いた後に端末の保存が空)
    body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-download"]')!.click();
    expect(await dl.files[0]!.blob.text()).toContain('{"count":"5"}');
    // 端末の保存が在れば、そちらが勝つ
    applyWidgetStorageOp('L1', 'tool1', { op: 'set', key: 'count', value: '8' });
    body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-download"]')!.click();
    const second = await dl.files[1]!.blob.text();
    expect(second).toContain('{"count":"8"}');
    expect(second).not.toContain('{"count":"5"}');
    for (const s of scopes) s.dispose();
  });

  it('`id=` の無い添付の HTML の「HTML で保存」はノートの題名をファイル名にし、保存の shim を入れない', async () => {
    const md = '```html asset:ast-tool\n```\n';
    setWidgetNoteHost({ ...fakeHost({ L1: md }), titleOf: () => '計算 ツール' });
    const dl = catchDownloads();
    const { body, scopes } = await mountAsset('L1', md, true);
    body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-download"]')!.click();
    expect(dl.files[0]!.name).toBe('計算-ツール.html');
    const text = await dl.files[0]!.blob.text();
    expect(text).toContain('<title>計算-ツール</title>');
    expect(text).not.toContain('pkc3-widget-export.');
    for (const s of scopes) s.dispose();
  });

  it('直書きの `id=` の HTML と React の `id=` のバーにも「HTML で保存」が在る(React はランタイム込みの文書)', async () => {
    const dl = catchDownloads();
    setWidgetNoteHost(fakeHost({ L1: '' }));
    const { body, scope } = mount('L1', '```html id="a"\n<p>x</p>\n```\n\n```react id="r"\nexport default function App(){return <b>r</b>}\n```\n');
    expect(body.querySelectorAll('[data-pkc-field="widget-download"]')).toHaveLength(1);
    setReactRuntimeLoader(() => Promise.resolve({ runtime: '/*RUNTIME*/', tailwind: '/*TW*/' }));
    const rs = hydrateReact(body);
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
    const btns = body.querySelectorAll<HTMLButtonElement>('[data-pkc-field="widget-download"]');
    expect(btns).toHaveLength(2);
    applyWidgetStorageOp('L1', 'r', { op: 'set', key: 'clicks', value: '3' });
    body.querySelector<HTMLButtonElement>('.pkc-react-placeholder [data-pkc-field="widget-download"]')!.click();
    expect(dl.files[0]!.name).toBe('r.html');
    const text = await dl.files[0]!.blob.text();
    expect(text.startsWith('<!DOCTYPE html><html lang="ja"')).toBe(true);
    expect(text).toContain('/*RUNTIME*/');
    expect(text).toContain('{"clicks":"3"}');
    expect(text).toContain("connect-src 'none'");
    rs.dispose();
    scope.dispose();
  });

  it('🔴 親の居ない所(window.parent === window)では、ノートの参照は待たずに空で答える', async () => {
    const html = buildHtmlSandboxIframe('<p>z</p>', '', 0);
    const doc = html.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const prelude = [...doc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).find((x) => x.includes('api.readTables='))!;
    const sent: unknown[] = [];
    const win: Record<string, unknown> = {
      postMessage: (m: unknown) => sent.push(m),
      addEventListener: () => undefined,
      localStorage: null,
    };
    win.parent = win;
    const fakeDoc = { documentElement: { style: { setProperty() {}, removeProperty() {} }, setAttribute() {} } };
    new Function('window', 'document', prelude)(win, fakeDoc);
    const api = win.pkcWidget as { readTables: () => Promise<unknown>; readNoteContext: () => Promise<unknown> };
    vi.useFakeTimers();
    try {
      // ⚠ 時計を進めずに解決する(3 秒の待ちに入っていない)
      await expect(api.readNoteContext()).resolves.toEqual({ frontmatter: {}, tables: [] });
      await expect(api.readTables()).resolves.toEqual([]);
      expect(sent.filter((m) => (m as { type?: string }).type === WIDGET_CONTEXT_REQ_MSG_TYPE)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('🔴 添付 HTML ウィジェットの追加権限(#2090 ②)', () => {
  const KEY = `ast-${'c'.repeat(64)}`;
  // ⚠ 外部の script を中身に書かない(happy-dom が srcdoc の中を読みに行き stderr を汚す)── 主張は CSP の字で測る
  const TOOL = '<p id="tool">tool</p>';
  let gate: WidgetPermissionGate;
  beforeEach(() => {
    gate = new WidgetPermissionGate(localStorage);
    setWidgetPermissionGate(gate);
  });
  afterEach(() => setWidgetPermissionGate(null));

  async function mountKey(md: string, lid = 'L1'): Promise<{ body: HTMLElement; scopes: ReturnType<typeof hydrateWidgets>[] }> {
    const body = document.createElement('div');
    body.className = 'pkc-md-rendered';
    body.setAttribute(WIDGET_LID_ATTR, lid);
    body.innerHTML = renderMarkdown(md, { liveWidgets: true });
    document.body.append(body);
    const scopes: ReturnType<typeof hydrateWidgets>[] = [];
    await hydrateFenceHosts({
      hosts: [...body.querySelectorAll<HTMLElement>('[data-pkc-fence-asset-key]')],
      getBlob: async (k) => (k === KEY ? new Blob([TOOL], { type: 'text/html' }) : null),
      texts: new Map(),
      env: { allowExternalImages: false, currentContainerId: 'c1', liveWidgets: true },
      stale: () => false,
      onReplaced: (next) => scopes.push(hydrateWidgets(next)),
    });
    return { body, scopes };
  }
  const frames = (root: ParentNode): HTMLIFrameElement[] => [...root.querySelectorAll<HTMLIFrameElement>('iframe.pkc-widget-frame')];
  const permBtn = (root: ParentNode): HTMLButtonElement | null =>
    root.querySelector<HTMLButtonElement>('[data-pkc-field="widget-permissions"]');
  const answer = async (checks: Record<string, boolean>, ok = true): Promise<void> => {
    await new Promise((r) => setTimeout(r, 0));
    const dialog = document.querySelector<HTMLDialogElement>(`[data-pkc-region="${DIALOG_REGION}"]`)!;
    expect(dialog.open).toBe(true);
    for (const [id, v] of Object.entries(checks)) {
      const box = dialog.querySelector<HTMLInputElement>(`input[data-pkc-check-id="${id}"]`)!;
      expect(box, id).not.toBeNull();
      box.checked = v;
    }
    document.querySelector<HTMLButtonElement>(`[data-pkc-field="${ok ? 'dialog-ok' : 'dialog-cancel'}"]`)!.click();
    for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
  };

  it('🔴 直書きの ```html には「権限」も案内帯も出ず、常に厳格な CSP(台帳に何があっても)', () => {
    // 直書きの箱が鍵を名乗れないこと ── 台帳に全権限があっても効かない
    gate.set(KEY, 'external-scripts', true);
    gate.set(KEY, 'network', true);
    const { body, scope } = mount('L1', '```html id="a"\n<p>direct</p>\n```\n');
    const f = frameOf(body);
    expect(permBtn(body)).toBeNull();
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.srcdoc).toContain("connect-src 'none'");
    expect(f.srcdoc).toContain("script-src 'unsafe-inline'; ");
    expect(f.srcdoc).not.toContain('https: http:');
    // 止めた申告が来ても案内帯は出さず、一般の案内へそのまま回す
    expect(notifyWidgetBlocked(f, ['script-src-elem', 'connect-src'])).toBe(false);
    expect(routeWidgetBlocked(f, ['script-src-elem'])).toEqual(['script-src-elem']);
    expect(body.querySelector('[data-pkc-field="widget-perm-notice"]')).toBeNull();
    scope.dispose();
  });

  it('🔴 添付は既定で厳格 →「権限」で許すと即置き直して該当項目だけ開く(sandbox は不変)→ 外すと戻る', async () => {
    const { body, scopes } = await mountKey(`\`\`\`html asset:${KEY}\n\`\`\`\n`);
    const before = frames(body)[0]!;
    expect(before.srcdoc).toContain("connect-src 'none'");
    expect(before.srcdoc).toContain("script-src 'unsafe-inline'; ");
    expect(permBtn(body)!.textContent).toBe('権限');
    // 外部スクリプトだけ許す
    permBtn(body)!.click();
    await answer({ 'external-scripts': true, network: false });
    const after = frames(body)[0]!;
    expect(after, '置き直されていない').not.toBe(before);
    expect(before.isConnected).toBe(false);
    expect(after.getAttribute('sandbox')).toBe('allow-scripts');
    expect(after.srcdoc).toContain("script-src 'unsafe-inline' https: http:");
    expect(after.srcdoc).toContain("connect-src 'none'");
    expect(after.srcdoc).not.toContain('unsafe-eval');
    expect(permBtn(body)!.textContent).toBe('権限 (1)');
    expect(frames(body)).toHaveLength(1);
    // 通信も足す
    permBtn(body)!.click();
    await answer({ network: true });
    expect(frames(body)[0]!.srcdoc).toContain('connect-src https: http: wss: ws:');
    expect(permBtn(body)!.textContent).toBe('権限 (2)');
    // やめる → 何も変わらない(置き直さない)
    const kept = frames(body)[0]!;
    permBtn(body)!.click();
    await answer({ 'external-scripts': false, network: false }, false);
    expect(frames(body)[0]).toBe(kept);
    expect(gate.get(KEY)).toEqual({ externalScripts: true, network: true });
    // 外す
    permBtn(body)!.click();
    await answer({ 'external-scripts': false, network: false });
    expect(frames(body)[0]!.srcdoc).toContain("connect-src 'none'");
    expect(frames(body)[0]!.srcdoc).toContain("script-src 'unsafe-inline'; ");
    expect(permBtn(body)!.textContent).toBe('権限');
    for (const s of scopes) s.dispose();
  });

  it('🔴 止めた申告で案内帯が出て、「権限を開く」から許して置き直すと消える', async () => {
    const { body, scopes } = await mountKey(`\`\`\`html asset:${KEY} id="t1"\n\`\`\`\n`);
    const f = frames(body)[0]!;
    // 画像・frame だけの申告は案内しない(権限で開かない)
    expect(notifyWidgetBlocked(f, ['img-src', 'frame-src'])).toBe(false);
    expect(routeWidgetBlocked(f, ['script-src-elem', 'connect-src', 'frame-src'])).toEqual(['frame-src']);
    const notice = body.querySelector<HTMLElement>('[data-pkc-field="widget-perm-notice"]')!;
    expect(notice).not.toBeNull();
    expect(notice.textContent).toContain('外部スクリプトの読み込み・外部への通信を止めました');
    expect(notice.textContent).toContain('権限を開く');
    // 2 回目の申告で帯を増やさない
    notifyWidgetBlocked(f, ['connect-src']);
    expect(body.querySelectorAll('[data-pkc-field="widget-perm-notice"]')).toHaveLength(1);
    notice.querySelector<HTMLButtonElement>('[data-pkc-field="widget-perm-notice-open"]')!.click();
    await answer({ 'external-scripts': true, network: true });
    expect(body.querySelector('[data-pkc-field="widget-perm-notice"]'), '置き直しても帯が残る').toBeNull();
    const f2 = frames(body)[0]!;
    expect(f2).not.toBe(f);
    // 許した後に止められても(eval 等)、もう足りない権限は無い ── 案内しない
    expect(notifyWidgetBlocked(f2, ['script-src', 'connect-src'])).toBe(false);
    for (const s of scopes) s.dispose();
  });

  it('🔴 設定画面からの取り消し(remountAssetWidgets)で即厳格な CSP に戻る・変わっていない器は置き直さない', async () => {
    gate.set(KEY, 'network', true);
    const { body, scopes } = await mountKey(`\`\`\`html asset:${KEY}\n\`\`\`\n\n\`\`\`html asset:${KEY} id="t2"\n\`\`\`\n`);
    const fs = frames(body);
    expect(fs).toHaveLength(2);
    for (const f of fs) expect(f.srcdoc).toContain('connect-src https: http: wss: ws:');
    expect(remountAssetWidgets(KEY), '変わっていないのに置き直した').toBe(0);
    gate.revoke(KEY);
    expect(remountAssetWidgets(KEY)).toBe(2);
    const now = frames(body);
    expect(now).toHaveLength(2);
    for (const f of now) {
      expect(fs).not.toContain(f);
      expect(f.srcdoc).toContain("connect-src 'none'");
      expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    }
    // 別の鍵の取り消しは触らない
    gate.set(KEY, 'network', true);
    expect(remountAssetWidgets(`ast-${'d'.repeat(64)}`)).toBe(0);
    expect(remountAssetWidgets(null)).toBe(2);
    for (const s of scopes) s.dispose();
  });

  it('🔴 `id=` の在る添付は、読み直しの焼き直し(keepWidgetSeedFresh)でもその時点の権限を引く', async () => {
    gate.set(KEY, 'network', true);
    const { body, scopes } = await mountKey(`\`\`\`html asset:${KEY} id="t3"\n\`\`\`\n`);
    const f = frames(body)[0]!;
    f.dispatchEvent(new Event('load'));
    applyWidgetStorageOp('L1', 't3', { op: 'set', key: 'k', value: 'v' });
    gate.revoke(KEY); // 取り消した後に読み直された
    f.dispatchEvent(new Event('load'));
    expect(f.srcdoc).toContain('"k":"v"');
    expect(f.srcdoc, '古い権限で焼き直した').toContain("connect-src 'none'");
    for (const s of scopes) s.dispose();
  });

  it('🔴「HTML で保存」は許している権限を単体の HTML の CSP に引き継ぐ(未許可なら厳格)', async () => {
    setWidgetNoteHost({ ...fakeHost({ L1: '' }), titleOf: () => '道具のノート' });
    const files: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      files.push(b as Blob);
      return `blob:t/${files.length}`;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const { body, scopes } = await mountKey(`\`\`\`html asset:${KEY}\n\`\`\`\n`);
    const dl = (): HTMLButtonElement => body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-download"]')!;
    dl().click();
    const strict = await files[0]!.text();
    expect(strict).toContain("connect-src 'none'");
    expect(strict).not.toContain('https: http:');
    gate.set(KEY, 'external-scripts', true);
    dl().click();
    const opened = await files[1]!.text();
    expect(opened).toContain("script-src 'unsafe-inline' https: http:");
    expect(opened).toContain("connect-src 'none'");
    expect(widgetAssetLabel(KEY)).toBe('道具のノート');
    for (const s of scopes) s.dispose();
  });
});

describe('🔴 ファイルの入出力(#2097 ── 確認バーを押したときだけ保存・添付・読み込み)', () => {
  const PLAIN = '```html\n<p>tool</p>\n```\n';
  let urlSeq = 0;
  function catchDl(): { files: { name: string; blob: Blob; url: string }[]; revoked: string[] } {
    const files: { name: string; blob: Blob; url: string }[] = [];
    const revoked: string[] = [];
    const made = new Map<string, Blob>();
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      // ⚠ test をまたいで一意にする(前の test の 1 秒後の revoke が同じ名前で紛れ込まない)
      urlSeq += 1;
      const url = `blob:io/${urlSeq}`;
      made.set(url, b as Blob);
      return url;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => {
      revoked.push(u);
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      files.push({ name: this.download, blob: made.get(this.href)!, url: this.href });
    });
    return { files, revoked };
  }
  type IoHost = WidgetNoteHost & {
    fails: string[];
    blocked: string | null;
    attached: { lid: string; file: File }[];
    listed: string[];
    read: string[];
  };
  function ioHost(bodies: Record<string, string>, assets: Record<string, { name: string; mime: string; bytes: string }[]> = {}): IoHost {
    const base = fakeHost(bodies);
    const h: IoHost = {
      ...base,
      attached: [],
      listed: [],
      read: [],
      attachFile: (lid, file) => {
        h.attached.push({ lid, file });
        return Promise.resolve(true);
      },
      listNoteAssets: (lid) => {
        h.listed.push(lid);
        return Promise.resolve(
          (assets[lid] ?? []).map((a, i) => ({ key: `${lid}-k${String(i)}`, name: a.name, mime: a.mime, size: a.bytes.length })),
        );
      },
      readAssetBlob: (key) => {
        h.read.push(key);
        for (const [lid, list] of Object.entries(assets)) {
          const i = list.findIndex((_, j) => `${lid}-k${String(j)}` === key);
          if (i >= 0) return Promise.resolve(new Blob([list[i]!.bytes], { type: list[i]!.mime }));
        }
        return Promise.resolve(null);
      },
    };
    // ⚠ fakeHost の writeBlockReason は自分の `blocked` を読む ── 写した h から読ませる
    h.writeBlockReason = () => h.blocked;
    return h;
  }
  const plainFrame = (root: ParentNode): HTMLIFrameElement => root.querySelector<HTMLIFrameElement>('iframe.pkc-html-render')!;
  const idOf = (f: HTMLIFrameElement): string => f.getAttribute('data-pkc-html-render-id')!;
  const dlReq = (f: HTMLIFrameElement, reqId: number, name: string, data: unknown, mime = 'text/csv'): Record<string, unknown> => ({
    type: WIDGET_DL_REQ_MSG_TYPE,
    id: idOf(f),
    reqId,
    name,
    mime,
    data,
  });
  const bar = (root: ParentNode = document): HTMLElement | null => root.querySelector<HTMLElement>('[data-pkc-field="widget-io-bar"]');
  const press = (field: string): void => {
    const b = document.querySelector<HTMLButtonElement>(`[data-pkc-field="${field}"]`);
    expect(b, `${field} が無い`).not.toBeNull();
    b!.click();
  };
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  };
  // ⚠ 出した直後に押せない時間(すり替え対策)は専用の test で見る ── 他の test はすぐ押す
  beforeEach(() => setWidgetIoPressGuardForTest(0));
  afterEach(() => {
    resetWidgetIoForTest();
    setWidgetIoPressGuardForTest(null);
  });

  it('🔴 確認バーを出した直後・差し替えた直後は押せない(すり替え対策)── 時間が来たら押せる', () => {
    setWidgetIoPressGuardForTest(null);
    vi.useFakeTimers();
    try {
      const { body } = mount('L1', PLAIN);
      const f = plainFrame(body);
      const w = giveWindow(f);
      post(dlReq(f, 1, 'safe.csv', 'x'), w);
      const save1 = body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-io-save"]')!;
      expect(save1.disabled, '出した直後に押せる').toBe(true);
      vi.advanceTimersByTime(WIDGET_IO_PRESS_GUARD_MS - 50);
      // 押せるようになる直前に差し替える
      post(dlReq(f, 2, 'evil.html', 'x', 'text/html'), w);
      const save2 = body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-io-save"]')!;
      expect(save2.disabled, '差し替えた直後に押せる').toBe(true);
      vi.advanceTimersByTime(100);
      expect(save2.disabled, '前の要求の時間で押せるようになった').toBe(true);
      vi.advanceTimersByTime(WIDGET_IO_PRESS_GUARD_MS);
      expect(save2.disabled).toBe(false);
      expect(body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-io-cancel"]')!.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('🔴 書けない理由で止めた「このノートへ添付」は、押せない時間が過ぎても止めたまま', () => {
    setWidgetIoPressGuardForTest(null);
    vi.useFakeTimers();
    try {
      const h = ioHost({ L1: PLAIN });
      h.blocked = '編集中です';
      setWidgetNoteHost(h);
      const { body } = mount('L1', PLAIN);
      const f = plainFrame(body);
      post(dlReq(f, 1, 'a.csv', 'x'), giveWindow(f));
      vi.advanceTimersByTime(WIDGET_IO_PRESS_GUARD_MS + 1);
      expect(body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-io-attach"]')!.disabled).toBe(true);
      expect(body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-io-save"]')!.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('🔴 箱が諦める時間で親も確認バーを閉じ、預かった bytes を手放す', () => {
    vi.useFakeTimers();
    try {
      const { body } = mount('L1', PLAIN);
      const f = plainFrame(body);
      const w = giveWindow(f);
      post(dlReq(f, 1, 'a.csv', 'abc'), w);
      const p = widgetIoPendingForTest(f)!;
      expect(p.bytes?.byteLength).toBe(3);
      vi.advanceTimersByTime(WIDGET_IO_TIMEOUT_MS + 1);
      expect(bar(body)).toBeNull();
      expect(p.bytes, '時間切れで bytes を握り続けた').toBeNull();
      expect(w.posted).toEqual([{ type: WIDGET_DL_RES_MSG_TYPE, reqId: 1, ok: false, action: 'cancel', reason: WIDGET_IO_REASONS.timeout }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('🔴 置き換え・やめる・保存のどれでも、預かった bytes を手放す', () => {
    catchDl();
    const { body } = mount('L1', PLAIN);
    const f = plainFrame(body);
    const w = giveWindow(f);
    post(dlReq(f, 1, 'a.csv', 'x'), w);
    const p1 = widgetIoPendingForTest(f)!;
    post(dlReq(f, 2, 'b.csv', 'y'), w);
    expect(p1.bytes, '置き換えで手放していない').toBeNull();
    const p2 = widgetIoPendingForTest(f)!;
    press('widget-io-cancel');
    expect(p2.bytes, 'やめるで手放していない').toBeNull();
    post(dlReq(f, 3, 'c.csv', 'z'), w);
    const p3 = widgetIoPendingForTest(f)!;
    press('widget-io-save');
    expect(p3.bytes, '保存で手放していない').toBeNull();
  });

  it('🔴 添付の最中に来た新しい要求は断り(置き換えない)、添付の答え attach を返す', async () => {
    const h = ioHost({ L1: PLAIN });
    let finish: (ok: boolean) => void = () => undefined;
    h.attachFile = (lid, file) => {
      h.attached.push({ lid, file });
      return new Promise<boolean>((r) => {
        finish = r;
      });
    };
    setWidgetNoteHost(h);
    const { body } = mount('L1', PLAIN);
    const f = plainFrame(body);
    const w = giveWindow(f);
    post(dlReq(f, 1, 'a.csv', 'x'), w);
    press('widget-io-attach');
    expect(widgetIoPendingForTest(f)!.busy).toBe(true);
    post(dlReq(f, 2, 'b.csv', 'y'), w);
    expect(w.posted).toEqual([{ type: WIDGET_DL_RES_MSG_TYPE, reqId: 2, ok: false, action: 'rejected', reason: WIDGET_IO_REASONS.busy }]);
    expect(bar(body)!.textContent).toContain('a.csv');
    finish(true);
    await flush();
    expect(w.posted.at(-1)).toEqual({ type: WIDGET_DL_RES_MSG_TYPE, reqId: 1, ok: true, action: 'attach' });
  });

  it('🔴 添付が効かなかったら(口が false)「添付できませんでした」で返す(attach と偽らない)', async () => {
    const h = ioHost({ L1: PLAIN });
    h.attachFile = () => Promise.resolve(false);
    setWidgetNoteHost(h);
    const { body } = mount('L1', PLAIN);
    const f = plainFrame(body);
    const w = giveWindow(f);
    post(dlReq(f, 1, 'a.csv', 'x'), w);
    press('widget-io-attach');
    await flush();
    expect(w.posted).toEqual([{ type: WIDGET_DL_RES_MSG_TYPE, reqId: 1, ok: false, action: 'cancel', reason: WIDGET_IO_REASONS.attachFailed }]);
  });

  it('🔴 流量で断る要求は中身を検めない(大きな文字列を符号化しない)', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => 5000);
    const { body } = mount('L1', PLAIN);
    const f = plainFrame(body);
    const w = giveWindow(f);
    for (let i = 1; i <= 3; i++) post(dlReq(f, i, 'a.csv', 'x'), w);
    const enc = vi.spyOn(TextEncoder.prototype, 'encode');
    post(dlReq(f, 4, 'a.csv', 'y'.repeat(1000)), w);
    expect(enc, '断る要求を符号化した').not.toHaveBeenCalled();
    expect(w.posted.at(-1)).toMatchObject({ reqId: 4, action: 'rejected', reason: WIDGET_IO_REASONS.rateLimited });
  });

  it('🔴 埋め込みの中なら、中に別の lid の器が入れ子になっていても「このノート」としない', () => {
    const { body } = mount('L1', 'x');
    const embed = document.createElement('div');
    embed.setAttribute('data-pkc-embed-ref', 'entry:L2');
    const inner = document.createElement('div');
    inner.setAttribute(WIDGET_LID_ATTR, 'L2');
    inner.innerHTML = renderMarkdown(PLAIN, {});
    embed.append(inner);
    body.append(embed);
    expect(widgetIoLidOf(plainFrame(inner))).toBeNull();
    // 対照:埋め込みでない器なら引ける
    const { body: b2 } = mount('L3', PLAIN);
    expect(widgetIoLidOf(plainFrame(b2))).toBe('L3');
  });

  it('🔴 `id=` の無い直書きの ```html の箱も対象で、sandbox は allow-scripts のまま(allow-downloads を足さない)', () => {
    const { body } = mount('L1', PLAIN);
    const f = plainFrame(body);
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.srcdoc).toContain('api.requestDownload=');
    expect(f.srcdoc).toContain('api.requestFile=');
    const w = giveWindow(f);
    post(dlReq(f, 1, 'out.csv', 'a,b'), w);
    expect(bar(body)).not.toBeNull();
    // 🔑 箱の直前に置く
    expect(bar(body)!.nextElementSibling).toBe(f);
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('🔴 保存の要求だけでは何も保存しない → 「PC へ保存」で保存し、箱へ save を返し、ObjectURL を手放す', async () => {
    setWidgetNoteHost(ioHost({ L1: PLAIN }));
    const dl = catchDl();
    const { body } = mount('L1', PLAIN);
    const f = plainFrame(body);
    const w = giveWindow(f);
    const bytes = new TextEncoder().encode('名前,値\n');
    post(dlReq(f, 5, '../../売上.csv', bytes.buffer), w);
    expect(dl.files, '要求だけで保存された(ドライブバイ)').toHaveLength(0);
    expect(w.posted, '押す前に答えた').toEqual([]);
    expect(bar(body)!.textContent).toContain('「売上.csv」');
    expect(bar(body)!.querySelector('[data-pkc-field="widget-io-risk"]')).toBeNull();
    press('widget-io-save');
    expect(dl.files).toHaveLength(1);
    expect(dl.files[0]!.name).toBe('売上.csv');
    expect(new Uint8Array(await dl.files[0]!.blob.arrayBuffer())).toEqual(bytes);
    expect(dl.files[0]!.blob.type).toBe('text/csv');
    expect(w.posted).toEqual([{ type: WIDGET_DL_RES_MSG_TYPE, reqId: 5, ok: true, action: 'save' }]);
    expect(bar(body), '保存した後もバーが残る').toBeNull();
    expect(widgetIoPendingCount()).toBe(0);
    await new Promise((r) => setTimeout(r, 1100));
    // ⚠ 前の test が残した 1 秒後の revoke もここへ来る ── この test で作った URL だけを見る
    expect(dl.revoked.filter((u) => u === dl.files[0]!.url)).toEqual([dl.files[0]!.url]);
  });

  it('🔴「このノートへ添付」は置いたノートの lid と同じ中身の File で正規の口を呼び、attach を返す', async () => {
    const h = ioHost({ L1: PLAIN });
    setWidgetNoteHost(h);
    const dl = catchDl();
    const { body } = mount('L1', PLAIN);
    const f = plainFrame(body);
    const w = giveWindow(f);
    post(dlReq(f, 2, 'data.json', '{"a":1}', 'application/json'), w);
    press('widget-io-attach');
    await flush();
    expect(h.attached.map((a) => a.lid)).toEqual(['L1']);
    expect(h.attached[0]!.file.name).toBe('data.json');
    expect(h.attached[0]!.file.type).toBe('application/json');
    expect(await h.attached[0]!.file.text()).toBe('{"a":1}');
    expect(dl.files).toHaveLength(0);
    expect(w.posted).toEqual([{ type: WIDGET_DL_RES_MSG_TYPE, reqId: 2, ok: true, action: 'attach' }]);
    expect(bar(body)).toBeNull();
  });

  it('🔴 書けないノートでは「このノートへ添付」を押せず理由を添え、押されても添付しない', async () => {
    const h = ioHost({ L1: PLAIN });
    h.blocked = '編集中です';
    setWidgetNoteHost(h);
    const { body } = mount('L1', PLAIN);
    const f = plainFrame(body);
    const w = giveWindow(f);
    post(dlReq(f, 2, 'a.csv', 'x'), w);
    const b = body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-io-attach"]')!;
    expect(b.disabled).toBe(true);
    expect(b.title).toContain('編集中です');
    b.disabled = false;
    b.click();
    await flush();
    expect(h.attached).toEqual([]);
    expect(h.fails).toEqual(['編集中です']);
    expect(bar(body), '断ったら要求は残る(PC へ保存・やめるを選べる)').not.toBeNull();
  });

  it('🔴 埋め込み(別のノートの塊)の中の箱・lid の無い面には「このノートへ添付」を出さない', () => {
    setWidgetNoteHost(ioHost({ L1: PLAIN }));
    const { body } = mount('L1', 'x');
    const embed = document.createElement('div');
    embed.setAttribute('data-pkc-embed-ref', 'entry:L2');
    embed.innerHTML = renderMarkdown(PLAIN, {});
    body.append(embed);
    const f = plainFrame(embed);
    expect(widgetIoLidOf(f)).toBeNull();
    post(dlReq(f, 1, 'a.csv', 'x'), giveWindow(f));
    expect(bar(embed)).not.toBeNull();
    expect(embed.querySelector('[data-pkc-field="widget-io-attach"]')).toBeNull();
    expect(embed.querySelector('[data-pkc-field="widget-io-save"]')).not.toBeNull();
    resetWidgetIoForTest();
    const { body: nolid } = mount(null, PLAIN);
    const f2 = plainFrame(nolid);
    post(dlReq(f2, 1, 'a.csv', 'x'), giveWindow(f2));
    expect(nolid.querySelector('[data-pkc-field="widget-io-attach"]')).toBeNull();
  });

  it('🔴 要注意の拡張子(.html / .exe)は注意の文を出す(保存は止めない)', () => {
    setWidgetNoteHost(ioHost({ L1: PLAIN }));
    const { body } = mount('L1', PLAIN);
    const f = plainFrame(body);
    const w = giveWindow(f);
    post(dlReq(f, 1, 'report.html', '<p>', 'text/html'), w);
    expect(bar(body)!.querySelector('[data-pkc-field="widget-io-risk"]')!.textContent).toMatch(/スクリプトや実行コード/);
    post(dlReq(f, 2, 'setup.EXE', 'MZ', 'application/octet-stream'), w);
    expect(bar(body)!.querySelector('[data-pkc-field="widget-io-risk"]')).not.toBeNull();
    expect(bar(body)!.querySelector('[data-pkc-field="widget-io-save"]')).not.toBeNull();
  });

  it('🔴 なりすまし(別の窓が箱の id を名乗る)・実体の無い送り主には確認バーも答えも出さない', () => {
    const { body } = mount('L1', PLAIN + '\n```html\n<p>other</p>\n```\n');
    const [a, b] = [...body.querySelectorAll<HTMLIFrameElement>('iframe.pkc-html-render')];
    const wa = giveWindow(a!);
    const wb = giveWindow(b!);
    // A の窓が B の id を名乗る
    post({ ...dlReq(b!, 1, 'x.csv', 'x') }, wa);
    post(dlReq(a!, 1, 'x.csv', 'x'), fakeWin());
    post(dlReq(a!, 1, 'x.csv', 'x'), null);
    expect(bar(body)).toBeNull();
    expect(wa.posted).toEqual([]);
    expect(wb.posted).toEqual([]);
  });

  it('🔴 1 つの箱から 1 秒に 4 回送っても、4 回目は断り、確認バーは 1 枚のまま(UI を荒らさない)', () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { body } = mount('L1', PLAIN);
    const f = plainFrame(body);
    const w = giveWindow(f);
    for (let i = 1; i <= 4; i++) post(dlReq(f, i, `a${String(i)}.csv`, 'x'), w);
    expect(body.querySelectorAll('[data-pkc-field="widget-io-bar"]')).toHaveLength(1);
    const types = w.posted.map((m) => (m as { reqId: number; action: string; reason?: string }));
    // 1〜2 は置き換わり、4 は流量で断る
    expect(types).toEqual([
      expect.objectContaining({ reqId: 1, action: 'cancel', reason: WIDGET_IO_REASONS.replaced }),
      expect.objectContaining({ reqId: 2, action: 'cancel', reason: WIDGET_IO_REASONS.replaced }),
      expect.objectContaining({ reqId: 4, action: 'rejected', reason: WIDGET_IO_REASONS.rateLimited }),
    ]);
    expect(bar(body)!.textContent).toContain('a3.csv');
    now += 1000;
    post(dlReq(f, 5, 'a5.csv', 'x'), w);
    expect(bar(body)!.textContent).toContain('a5.csv');
  });

  it('🔴 2 つ目の要求で前の要求は「置き換わりました」で閉じ、預かった bytes を手放す(古い方は保存できない)', async () => {
    const dl = catchDl();
    const { body } = mount('L1', PLAIN);
    const f = plainFrame(body);
    const w = giveWindow(f);
    post(dlReq(f, 1, 'old.csv', 'OLD'), w);
    const oldSave = body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-io-save"]')!;
    post(dlReq(f, 2, 'new.csv', 'NEW'), w);
    expect(w.posted).toEqual([{ type: WIDGET_DL_RES_MSG_TYPE, reqId: 1, ok: false, action: 'cancel', reason: WIDGET_IO_REASONS.replaced }]);
    expect(oldSave.isConnected).toBe(false);
    oldSave.click();
    expect(dl.files, '置き換わった要求で保存できた').toHaveLength(0);
    press('widget-io-save');
    expect(dl.files.map((x) => x.name)).toEqual(['new.csv']);
    expect(await dl.files[0]!.blob.text()).toBe('NEW');
  });

  it('🔴 50 MB を超える・壊れた要求はバーを出さずに断る', () => {
    const { body } = mount('L1', PLAIN);
    const f = plainFrame(body);
    const w = giveWindow(f);
    post(dlReq(f, 1, 'a.csv', { not: 'bytes' }), w);
    expect(bar(body)).toBeNull();
    expect(w.posted).toEqual([{ type: WIDGET_DL_RES_MSG_TYPE, reqId: 1, ok: false, action: 'rejected', reason: WIDGET_IO_REASONS.badData }]);
  });

  it('「やめる」で cancel を返し、箱が外れたら確認バーを片付けて cancel を返す', async () => {
    const { body } = mount('L1', PLAIN);
    const f = plainFrame(body);
    const w = giveWindow(f);
    post(dlReq(f, 1, 'a.csv', 'x'), w);
    press('widget-io-cancel');
    expect(w.posted).toEqual([{ type: WIDGET_DL_RES_MSG_TYPE, reqId: 1, ok: false, action: 'cancel' }]);
    post(dlReq(f, 2, 'a.csv', 'x'), w);
    expect(widgetIoPendingCount()).toBe(1);
    body.remove();
    await flush();
    expect(widgetIoPendingCount()).toBe(0);
    expect(w.posted.at(-1)).toMatchObject({ reqId: 2, ok: false, action: 'cancel', reason: WIDGET_IO_REASONS.closed });
  });

  it('🔴 読み込みの要求 →「PC から選ぶ」を押したときだけファイル選択を開き、中身を Transferable で返す', async () => {
    const { body } = mount('L1', PLAIN);
    const f = plainFrame(body);
    const w = giveWindow(f);
    const transfers: unknown[][] = [];
    w.postMessage = (m: unknown, _o?: unknown, t?: unknown[]) => {
      w.posted.push(m);
      transfers.push(t ?? []);
    };
    const opened: HTMLInputElement[] = [];
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      opened.push(this);
    });
    post({ type: WIDGET_FILE_REQ_MSG_TYPE, id: idOf(f), reqId: 9, accept: '.csv', multiple: false }, w);
    expect(opened, '要求だけでファイル選択が開いた').toHaveLength(0);
    expect(bar(body)!.textContent).toContain('対象: .csv');
    press('widget-io-pick-pc');
    expect(opened).toHaveLength(1);
    expect(opened[0]!.accept).toBe('.csv');
    expect(opened[0]!.multiple).toBe(false);
    const file = new File(['a,b\n1,2'], 'in.csv', { type: 'text/csv' });
    Object.defineProperty(opened[0]!, 'files', { value: [file], configurable: true });
    opened[0]!.dispatchEvent(new Event('change'));
    await flush();
    const res = w.posted.at(-1) as { type: string; reqId: number; ok: boolean; files: { name: string; mime: string; size: number; data: ArrayBuffer }[] };
    expect(res).toMatchObject({ type: WIDGET_FILE_RES_MSG_TYPE, reqId: 9, ok: true });
    expect(res.files.map((x) => [x.name, x.mime, x.size])).toEqual([['in.csv', 'text/csv', 7]]);
    expect(new TextDecoder().decode(res.files[0]!.data)).toBe('a,b\n1,2');
    expect(transfers.at(-1), 'buffer を移していない').toEqual([res.files[0]!.data]);
    expect(bar(body)).toBeNull();
  });

  it('🔴 accept はブラウザで強制されない ── 指定外の種類を選んでも箱へ渡さない', async () => {
    const { body } = mount('L1', PLAIN);
    const f = plainFrame(body);
    const w = giveWindow(f);
    const opened: HTMLInputElement[] = [];
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      opened.push(this);
    });
    post({ type: WIDGET_FILE_REQ_MSG_TYPE, id: idOf(f), reqId: 1, accept: '.csv' }, w);
    press('widget-io-pick-pc');
    Object.defineProperty(opened[0]!, 'files', { value: [new File(['MZ'], 'tool.exe')], configurable: true });
    opened[0]!.dispatchEvent(new Event('change'));
    await flush();
    expect(w.posted).toEqual([{ type: WIDGET_FILE_RES_MSG_TYPE, reqId: 1, ok: false, files: [], reason: WIDGET_IO_REASONS.wrongType }]);
  });

  it('🔴 読み込みで大きすぎる・数が多すぎるファイルは渡さない / 選択をやめたら cancel', async () => {
    const { body } = mount('L1', PLAIN);
    const f = plainFrame(body);
    const w = giveWindow(f);
    const opened: HTMLInputElement[] = [];
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      opened.push(this);
    });
    post({ type: WIDGET_FILE_REQ_MSG_TYPE, id: idOf(f), reqId: 1, maxBytes: 3 }, w);
    press('widget-io-pick-pc');
    Object.defineProperty(opened[0]!, 'files', { value: [new File(['12345'], 'big.txt')], configurable: true });
    opened[0]!.dispatchEvent(new Event('change'));
    await flush();
    expect(w.posted.at(-1)).toMatchObject({ reqId: 1, ok: false, files: [] });
    expect((w.posted.at(-1) as { reason: string }).reason).toMatch(/大きすぎ/);
    post({ type: WIDGET_FILE_REQ_MSG_TYPE, id: idOf(f), reqId: 2 }, w);
    press('widget-io-pick-pc');
    opened[1]!.dispatchEvent(new Event('cancel'));
    expect(w.posted.at(-1)).toEqual({ type: WIDGET_FILE_RES_MSG_TYPE, reqId: 2, ok: false, files: [], reason: WIDGET_IO_REASONS.cancelled });
  });

  it('🔴「このノートの添付から選ぶ」は置いたノートの添付だけを並べ(種類で絞る)、選んだ物を返す', async () => {
    const h = ioHost(
      { L1: PLAIN },
      {
        L1: [
          { name: 'mine.csv', mime: 'text/csv', bytes: 'x,y' },
          { name: 'photo.png', mime: 'image/png', bytes: 'PNG' },
        ],
        L2: [{ name: 'other.csv', mime: 'text/csv', bytes: 'secret' }],
      },
    );
    setWidgetNoteHost(h);
    const { body } = mount('L1', PLAIN);
    const f = plainFrame(body);
    const w = giveWindow(f);
    post({ type: WIDGET_FILE_REQ_MSG_TYPE, id: idOf(f), reqId: 3, accept: '.csv' }, w);
    await flush();
    expect(h.listed).toEqual(['L1']);
    const pick = body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-io-pick-note"]')!;
    expect(pick.hidden).toBe(false);
    pick.click();
    const items = [...body.querySelectorAll<HTMLInputElement>('[data-pkc-field="widget-io-note-asset"]')];
    expect(items.map((i) => i.getAttribute('data-pkc-asset-key'))).toEqual(['L1-k0']);
    expect(body.textContent).not.toContain('other.csv');
    expect(body.textContent).not.toContain('photo.png');
    const give = body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-io-note-give"]')!;
    expect(give.disabled).toBe(true);
    items[0]!.checked = true;
    items[0]!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(give.disabled).toBe(false);
    give.click();
    await flush();
    expect(h.read).toEqual(['L1-k0']);
    const res = w.posted.at(-1) as { ok: boolean; files: { name: string; data: ArrayBuffer }[] };
    expect(res.ok).toBe(true);
    expect(res.files.map((x) => x.name)).toEqual(['mine.csv']);
    expect(new TextDecoder().decode(res.files[0]!.data)).toBe('x,y');
  });

  it('このノートに合う添付が無ければ「このノートの添付から選ぶ」を出さない', async () => {
    const h = ioHost({ L1: PLAIN }, { L1: [{ name: 'p.png', mime: 'image/png', bytes: 'P' }] });
    setWidgetNoteHost(h);
    const { body } = mount('L1', PLAIN);
    const f = plainFrame(body);
    post({ type: WIDGET_FILE_REQ_MSG_TYPE, id: idOf(f), reqId: 1, accept: '.csv' }, giveWindow(f));
    await flush();
    expect(body.querySelector<HTMLButtonElement>('[data-pkc-field="widget-io-pick-note"]')!.hidden).toBe(true);
  });

  it('`id=` の在るウィジェット・添付 HTML ウィジェットの箱も同じ確認バーを使う', () => {
    setWidgetNoteHost(ioHost({ L1: '```html id="w1"\n<p>w</p>\n```\n' }));
    const { body } = mount('L1', '```html id="w1"\n<p>w</p>\n```\n');
    const f = frameOf(body);
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    post(dlReq(f, 1, 'a.csv', 'x'), giveWindow(f));
    expect(bar(body)).not.toBeNull();
    expect(body.querySelector('[data-pkc-field="widget-io-attach"]')).not.toBeNull();
  });
});

describe('🔴 箱の中の口(requestDownload / requestFile / <a download> の救済)を実際に走らせる', () => {
  interface Run {
    api: {
      requestDownload: (o: unknown) => Promise<Record<string, unknown>>;
      requestFile: (o?: unknown) => Promise<Record<string, unknown>>;
    };
    sent: { msg: Record<string, unknown>; transfer: unknown[] }[];
    deliver: (data: unknown) => void;
    docListeners: ((e: unknown) => void)[];
    anchorProto: { click: () => unknown };
    urls: { created: Blob[]; revoked: string[] };
    win: Record<string, unknown>;
  }
  /** 箱の中の window を模して prelude を走らせる(`standalone` = 親の居ない所)。 */
  function runIo(standalone = false): Run {
    const html = buildHtmlSandboxIframe('<p>z</p>', '', 0);
    const doc = html.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const prelude = [...doc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).find((x) => x.includes('api.requestDownload='))!;
    const sent: Run['sent'] = [];
    const listeners: ((e: { source: unknown; data: unknown }) => void)[] = [];
    const docListeners: ((e: unknown) => void)[] = [];
    const urls = { created: [] as Blob[], revoked: [] as string[] };
    class FakeAnchor {
      click(): string {
        return 'original';
      }
    }
    const parentWin = { postMessage: (m: Record<string, unknown>, _o: string, t: unknown[]) => sent.push({ msg: m, transfer: t }) };
    const win: Record<string, unknown> = {
      addEventListener: (t: string, cb: (e: { source: unknown; data: unknown }) => void) => {
        if (t === 'message') listeners.push(cb);
      },
      localStorage: null,
      Blob,
      TextEncoder,
      atob,
      HTMLAnchorElement: FakeAnchor,
      URL: {
        createObjectURL: (b: Blob) => {
          urls.created.push(b);
          return `blob:fake/${String(urls.created.length)}`;
        },
        revokeObjectURL: (u: string) => urls.revoked.push(u),
      },
    };
    win.parent = standalone ? win : parentWin;
    const fakeDoc = {
      documentElement: { style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, appendChild() {} },
      body: document.body,
      addEventListener: (t: string, cb: (e: unknown) => void) => {
        if (t === 'click') docListeners.push(cb);
      },
      createElement: (t: string) => document.createElement(t),
    };
    new Function('window', 'document', prelude)(win, fakeDoc);
    return {
      api: win.pkcWidget as Run['api'],
      sent,
      deliver: (data) => {
        for (const l of listeners) l({ source: parentWin, data });
      },
      docListeners,
      anchorProto: FakeAnchor.prototype,
      urls,
      win,
    };
  }
  const ioSent = (r: Run): Run['sent'] => r.sent.filter((s) => s.msg.type !== WIDGET_READY_MSG_TYPE);

  it('requestDownload は親へ頼み、箱の中で作った buffer を移し、親の答えを返す', async () => {
    const r = runIo();
    const p = r.api.requestDownload({ name: 'a.csv', mime: 'text/csv', data: 'あ' });
    await new Promise((res) => setTimeout(res, 0));
    const [s] = ioSent(r);
    expect(s!.msg).toMatchObject({ type: WIDGET_DL_REQ_MSG_TYPE, name: 'a.csv', mime: 'text/csv', reqId: 1 });
    expect(s!.msg.id).toMatch(/^pkc-html-render-/);
    expect(s!.transfer).toEqual([s!.msg.data]);
    expect(new Uint8Array(s!.msg.data as ArrayBuffer)).toEqual(new TextEncoder().encode('あ'));
    // 🔴 種類の違う答え(番号が同じでも)は受けない
    r.deliver({ type: WIDGET_FILE_RES_MSG_TYPE, reqId: 1, ok: true, files: [] });
    r.deliver({ type: WIDGET_DL_RES_MSG_TYPE, reqId: 1, ok: true, action: 'save' });
    expect(await p).toEqual({ ok: true, action: 'save' });
  });

  it('呼び手が渡した ArrayBuffer は移さない(呼び手の手元で使えなくしない)/ Blob は中身を移す', async () => {
    const r = runIo();
    const mine = new Uint8Array([1, 2]).buffer;
    void r.api.requestDownload({ name: 'a.bin', data: mine });
    void r.api.requestDownload({ name: 'b.txt', data: new Blob(['hi'], { type: 'text/plain' }) });
    await new Promise((res) => setTimeout(res, 10));
    const [a, b] = ioSent(r);
    expect(a!.transfer).toEqual([]);
    expect(a!.msg.data).toBe(mine);
    expect(b!.msg.mime).toBe('text/plain');
    expect(b!.transfer).toEqual([b!.msg.data]);
  });

  it('requestFile は親へ頼み、ArrayBuffer の付いたファイルだけを返す', async () => {
    const r = runIo();
    const p = r.api.requestFile({ accept: '.csv', multiple: true, maxBytes: 100 });
    const [s] = ioSent(r);
    expect(s!.msg).toMatchObject({ type: WIDGET_FILE_REQ_MSG_TYPE, accept: '.csv', multiple: true, maxBytes: 100 });
    const data = new TextEncoder().encode('x').buffer;
    r.deliver({ type: WIDGET_FILE_RES_MSG_TYPE, reqId: s!.msg.reqId, ok: true, files: [{ name: 'a.csv', mime: 'text/csv', data }, { name: 'bad' }] });
    expect(await p).toEqual({ ok: true, files: [{ name: 'a.csv', mime: 'text/csv', size: 1, data }] });
  });

  it('🔴 答えが来なければ待ち時間の後に cancel(止まらない)', async () => {
    vi.useFakeTimers();
    try {
      const r = runIo();
      const p = r.api.requestFile();
      vi.advanceTimersByTime(WIDGET_IO_TIMEOUT_MS + 1);
      expect(await p).toEqual({ ok: false, files: [], reason: WIDGET_IO_REASONS.timeout });
    } finally {
      vi.useRealTimers();
    }
  });

  it('🔴 <a download href="blob:"> のクリックを捕まえて親へ頼む(繋いだ <a> も、文書に繋いでいない a.click() も)', async () => {
    const r = runIo();
    const U = r.win.URL as { createObjectURL: (b: Blob) => string; revokeObjectURL: (u: string) => void };
    const blob = new Blob(['a,b'], { type: 'text/csv' });
    const url = U.createObjectURL(blob);
    const anchor = (href: string, connected: boolean): Record<string, unknown> => ({
      isConnected: connected,
      hasAttribute: (n: string) => n === 'download',
      getAttribute: (n: string) => (n === 'href' ? href : n === 'download' ? 'out.csv' : null),
    });
    // ① 繋いだ <a> を押す(文書のキャプチャで捕まえる)
    let prevented = 0;
    const a1 = anchor(url, true);
    for (const l of r.docListeners) l({ target: { closest: () => a1 }, preventDefault: () => (prevented += 1) });
    // ⚠ 押した直後に revoke されても届く
    U.revokeObjectURL(url);
    expect(prevented).toBe(1);
    // ② 文書に繋いでいない <a> の click()
    const url2 = U.createObjectURL(new Blob(['z'], { type: 'text/plain' }));
    const res = r.anchorProto.click.call(anchor(url2, false));
    expect(res, '元の click が走った(捕まえていない)').toBeUndefined();
    // ③ https: は捕まえない(元の click へ流す)
    expect(r.anchorProto.click.call(anchor('https://example.com/x.csv', false))).toBe('original');
    let ext = 0;
    for (const l of r.docListeners) l({ target: { closest: () => anchor('https://example.com/a', true) }, preventDefault: () => (ext += 1) });
    expect(ext).toBe(0);
    await new Promise((res2) => setTimeout(res2, 10));
    const reqs = ioSent(r);
    expect(reqs.map((s) => [s.msg.type, s.msg.name, s.msg.mime])).toEqual([
      [WIDGET_DL_REQ_MSG_TYPE, 'out.csv', 'text/csv'],
      [WIDGET_DL_REQ_MSG_TYPE, 'out.csv', 'text/plain'],
    ]);
    expect(new TextDecoder().decode(reqs[0]!.msg.data as ArrayBuffer)).toBe('a,b');
  });

  it('<a download href="data:"> も救う(base64 と URL 符号化)', async () => {
    const r = runIo();
    const mk = (href: string): Record<string, unknown> => ({
      isConnected: false,
      hasAttribute: () => true,
      getAttribute: (n: string) => (n === 'href' ? href : 'x.txt'),
    });
    r.anchorProto.click.call(mk('data:text/plain;base64,' + btoa('hi')));
    r.anchorProto.click.call(mk('data:text/csv;charset=utf-8,' + encodeURIComponent('名,値')));
    await new Promise((res) => setTimeout(res, 10));
    const reqs = ioSent(r);
    expect(reqs.map((s) => s.msg.mime)).toEqual(['text/plain', 'text/csv']);
    expect(new TextDecoder().decode(reqs[0]!.msg.data as ArrayBuffer)).toBe('hi');
    expect(new TextDecoder().decode(reqs[1]!.msg.data as ArrayBuffer)).toBe('名,値');
  });

  it('🔴 親の居ない所(単体の HTML)では <a download> で直に保存し、救済は付けない(回り続けない)', async () => {
    const r = runIo(true);
    expect(r.docListeners, '親の居ない所で救済の見張りを付けた').toHaveLength(0);
    expect(r.anchorProto.click.call({}), 'a.click を差し替えた').toBe('original');
    const clicked: { name: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ name: this.download, href: this.getAttribute('href')! });
    });
    vi.useFakeTimers();
    try {
      const p = r.api.requestDownload({ name: 'a.csv', mime: 'text/csv', data: 'a' });
      await vi.advanceTimersByTimeAsync(0);
      expect(await p).toEqual({ ok: true, action: 'save' });
      expect(clicked).toEqual([{ name: 'a.csv', href: 'blob:fake/1' }]);
      expect(ioSent(r), '親の居ない所で親へ頼んだ').toEqual([]);
      expect(r.urls.revoked).toEqual([]);
      vi.advanceTimersByTime(1000);
      expect(r.urls.revoked).toEqual(['blob:fake/1']);
    } finally {
      vi.useRealTimers();
    }
  });
});
