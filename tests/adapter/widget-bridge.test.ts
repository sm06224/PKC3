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
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hydrateWidgets,
  installWidgetBridge,
  keepWidgetSeedFresh,
  remountStaleWidgets,
  WIDGET_LID_ATTR,
  widgetFrameCount,
} from '../../src/adapter/ui/render/widget-bridge';
import {
  applyWidgetStorageOp,
  clearEntryWidgetStorage,
  hasWidgetStorage,
  readWidgetStorage,
} from '../../src/adapter/platform/widget-storage';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { buildHtmlSandboxIframe } from '../../src/features/markdown/html-sandbox';
import {
  WIDGET_READY_MSG_TYPE,
  WIDGET_STORAGE_LIMIT,
  WIDGET_TOTAL_STORAGE_LIMIT,
  WIDGET_STORAGE_MESSAGE,
  WIDGET_THEME_MSG_TYPE,
  widgetStoragePrefix,
} from '../../src/features/markdown/widget-bridge';
import { resetAppDialogForTest, DIALOG_REGION } from '../../src/adapter/ui/render/app-dialog';
import { hydrateReact, setReactRuntimeLoader } from '../../src/adapter/ui/render/react-sandbox';

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
  vi.unstubAllGlobals();
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
