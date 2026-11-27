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
    // バーは 3 つ(保存・初期化・HTML で保存)
    const fields = [...body.querySelectorAll('[data-pkc-field="widget-bar"] button')].map((b) => b.getAttribute('data-pkc-field'));
    expect(fields).toEqual(['widget-save', 'widget-reset', 'widget-download']);
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
    expect(fields).toEqual(['widget-download']);
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
