/**
 * 🔴 **配る HTML に焼くウィジェットの親**(`portable-widget-bridge.ts`、#2097 / #2098)。
 *
 * 生成した字を happy-dom の window で実際に走らせ、箱(偽の contentWindow)からの合図に対して
 * 本体(`widget-bridge.ts` / `widget-io-bar.ts`)と同じ契約で答えるかを見る。
 * 🔑 別の実行系へ書き写した判定(ファイル名の無害化・`accept`・大きさの字)は、正本の関数と入力の束で突き合わせる。
 */
/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPortableWidgetBridgeScript,
  portableWidgetBridgeCss,
} from '../../src/features/export/portable-widget-bridge';
import {
  checkWidgetPickedFiles,
  isRiskyWidgetDownloadExt,
  normalizeWidgetAccept,
  normalizeWidgetMime,
  sanitizeWidgetFileName,
  widgetAcceptMatches,
  WIDGET_DL_REQ_MSG_TYPE,
  WIDGET_DL_RES_MSG_TYPE,
  WIDGET_FILE_REQ_MSG_TYPE,
  WIDGET_FILE_RES_MSG_TYPE,
  WIDGET_IO_MAX_BYTES,
  WIDGET_IO_PRESS_GUARD_MS,
  WIDGET_IO_REASONS,
  WIDGET_IO_RISK_NOTICE,
  WIDGET_IO_TIMEOUT_MS,
} from '../../src/features/markdown/widget-io';
import {
  safeTokenValue,
  WIDGET_CONTEXT_REQ_MSG_TYPE,
  WIDGET_CONTEXT_RES_MSG_TYPE,
  WIDGET_READY_MSG_TYPE,
  WIDGET_THEME_MSG_TYPE,
} from '../../src/features/markdown/widget-bridge';
import { HTML_SANDBOX_RESIZE_MSG_TYPE } from '../../src/features/markdown/html-sandbox';
import { humanBytes } from '../../src/features/human-bytes';

interface Bridge {
  reset(): number;
  sweep(): number;
  broadcastTheme(): number;
  pending(): number;
  _t: {
    /** 保留の記録(片付けた後も持ち続けて、bytes を手放したかを見る)。 */
    pendOf(f: HTMLIFrameElement): { bytes: Uint8Array | null; settled: boolean } | null;
    sanitize(n: unknown, m: unknown): string;
    isRisky(n: string): boolean;
    normAccept(a: unknown): string | null;
    accMatch(a: string, n: string, m: string): boolean;
    normMime(m: unknown): string;
    humanBytes(n: number): string;
    safeTok(v: string): string | null;
    checkPicked(f: { size: number }[], r: { multiple: boolean; maxBytes: number }): string | null;
  };
}

type Posted = { msg: Record<string, unknown>; transfer: unknown[] };
type FakeWin = { posted: Posted[]; postMessage: (m: unknown, o: string, t?: unknown[]) => void };

function fakeWin(): FakeWin {
  const w: FakeWin = {
    posted: [],
    postMessage: (m, _o, t) => w.posted.push({ msg: m as Record<string, unknown>, transfer: t ?? [] }),
  };
  return w;
}

/** 箱 1 つ(器 `data-pkc-ei` の中)。 */
function frame(box: HTMLElement, id: string): { f: HTMLIFrameElement; w: FakeWin } {
  const f = document.createElement('iframe');
  f.setAttribute('data-pkc-html-render-id', id);
  f.setAttribute('data-pkc-widget-frame', '');
  f.setAttribute('sandbox', 'allow-scripts');
  box.append(f);
  const w = fakeWin();
  Object.defineProperty(f, 'contentWindow', { value: w, configurable: true });
  return { f, w };
}

function post(data: unknown, source: object | null): void {
  const ev = new MessageEvent('message', { data });
  Object.defineProperty(ev, 'source', { value: source, configurable: true });
  window.dispatchEvent(ev);
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** ノートごとの答え(ホストの口)。 */
const NOTES: Record<string, { ctx: unknown; assets: { key: string; name: string; mime: string; bytes: string }[] }> = {
  A: {
    ctx: { frontmatter: { title: 'A' }, tables: [{ index: 0, kind: 'markdown', headers: ['x'], rows: [['1']] }] },
    assets: [
      { key: 'ka1', name: 'a.csv', mime: 'text/csv', bytes: 'x,y\n1,2\n' },
      { key: 'ka2', name: 'pic.png', mime: 'image/png', bytes: 'PNG' },
    ],
  },
  B: { ctx: { frontmatter: { title: 'B' }, tables: [] }, assets: [{ key: 'kb1', name: 'b.csv', mime: 'text/csv', bytes: 'secret' }] },
};

let bridge: Bridge;
let boxA: HTMLElement;
let boxB: HTMLElement;
const reads: string[] = [];
let installed: ((ev: MessageEvent) => void)[] = [];

function install(guardMs = 0, hooks = true): Bridge {
  // 🔑 受け口を数えて片付ける(test をまたいで listener を積まない)
  const orig = window.addEventListener.bind(window);
  const spy = vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, fn: EventListener, o?: unknown) => {
    if (type === 'message') installed.push(fn as (ev: MessageEvent) => void);
    orig(type, fn, o as AddEventListenerOptions);
  }) as typeof window.addEventListener);
  (window as unknown as { __H: unknown }).__H = {
    getFrameContext: (f: HTMLIFrameElement) => NOTES[f.closest('[data-pkc-ei]')!.getAttribute('data-pkc-ei')!]!.ctx,
    getFrameAssets: (f: HTMLIFrameElement) =>
      NOTES[f.closest('[data-pkc-ei]')!.getAttribute('data-pkc-ei')!]!.assets.map((a) => ({
        key: a.key,
        name: a.name,
        mime: a.mime,
        size: a.bytes.length,
      })),
    readAssetBytes: (k: string) => {
      reads.push(k);
      for (const n of Object.values(NOTES)) {
        const a = n.assets.find((x) => x.key === k);
        if (a) return Promise.resolve(new TextEncoder().encode(a.bytes).buffer);
      }
      return Promise.resolve(null);
    },
  };
  const src = buildPortableWidgetBridgeScript({ hooks: hooks ? 'window.__H' : undefined, pressGuardMs: guardMs });
  const b = new Function(`return ${src};`)() as Bridge;
  spy.mockRestore();
  return b;
}

const bar = (): HTMLElement | null => document.querySelector('[data-pkc-field="widget-io-bar"]');
const press = (field: string): void => {
  const b = document.querySelector<HTMLButtonElement>(`[data-pkc-field="${field}"]`);
  expect(b, `${field} が無い`).not.toBeNull();
  b!.click();
};
const dlReq = (id: string, reqId: number, name: string, data: unknown, mime = 'text/csv'): Record<string, unknown> => ({
  type: WIDGET_DL_REQ_MSG_TYPE,
  id,
  reqId,
  name,
  mime,
  data,
});
const fReq = (id: string, reqId: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: WIDGET_FILE_REQ_MSG_TYPE,
  id,
  reqId,
  ...extra,
});

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-pkc-tone');
  document.documentElement.removeAttribute('style');
  boxA = document.createElement('div');
  boxA.setAttribute('data-pkc-ei', 'A');
  boxB = document.createElement('div');
  boxB.setAttribute('data-pkc-ei', 'B');
  document.body.append(boxA, boxB);
  reads.length = 0;
});
afterEach(() => {
  bridge?.reset();
  for (const fn of installed) window.removeEventListener('message', fn as EventListener);
  installed = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('生成した字', () => {
  it('構文エラーが無く、`</script` / `<!--` / バックティックを含まない(配る HTML の script を壊さない)', () => {
    const src = buildPortableWidgetBridgeScript({ hooks: '{getFrameContext:function(){return null}}' });
    expect(() => new Function(`return ${src};`)).not.toThrow();
    expect(src).not.toMatch(/<\/script/i);
    expect(src).not.toContain('<!--');
    expect(src).not.toContain('`');
    // 🔑 正本の定数を焼いている(書き写していない)
    expect(src).toContain(JSON.stringify(WIDGET_IO_RISK_NOTICE));
    expect(src).toContain(`"to":${String(WIDGET_IO_TIMEOUT_MS)}`);
  });
  it('確認バーの CSS は紙に出さない', () => {
    expect(portableWidgetBridgeCss()).toMatch(/@media print\{\.pkc-widget-io-bar\{display:none!important\}\}/);
  });
});

describe('🔑 書き写した判定は正本と同じ答え', () => {
  beforeEach(() => {
    bridge = install();
  });
  const NAMES = [
    'a.csv', '../../evil.csv', 'C:\\x\\y.TXT', 'con.csv', 'CON', 'lpt1.txt', '', '   ', '...', '.hidden', 'a b:c*d?.json',
    'x'.repeat(100) + '.csv', '日本語の名前.csv', '絵文字😀'.repeat(20) + '.png', 'tab\tname.txt', 'noext', 'weird.ex$e',
    'a.verylongextension', 'report.HTML', '-lead.csv', 'trail-.csv',
  ];
  const MIMES = ['text/csv', 'TEXT/CSV; charset=utf-8', '', 'bogus', 'application/x-unknown', 'image/png', 'text/html'];
  it('ファイル名の無害化', () => {
    for (const n of NAMES) for (const m of MIMES) expect(bridge._t.sanitize(n, m), `${n} / ${m}`).toBe(sanitizeWidgetFileName(n, m));
    expect(bridge._t.sanitize(42, 'text/csv')).toBe(sanitizeWidgetFileName(42, 'text/csv'));
  });
  it('MIME・要注意の拡張子・accept・大きさの字・テーマの値', () => {
    for (const m of [...MIMES, 42, null]) expect(bridge._t.normMime(m)).toBe(normalizeWidgetMime(m));
    for (const n of ['a.exe', 'a.HTML', 'a.csv', 'noext', 'a.svg', 'a.']) expect(bridge._t.isRisky(n)).toBe(isRiskyWidgetDownloadExt(n));
    const ACC = ['', '.csv', '.csv, text/plain', 'image/*', 'text/csv\n', '<x>', 'a'.repeat(301), Array(21).fill('.a').join(','), null, 7];
    for (const a of ACC) expect(bridge._t.normAccept(a), String(a)).toBe(normalizeWidgetAccept(a));
    const pairs: [string, string, string][] = [
      ['', 'x.bin', ''], ['.csv', 'A.CSV', ''], ['.csv', 'a.txt', 'text/csv'], ['text/csv', 'x', 'text/csv; charset=utf-8'],
      ['image/*', 'p', 'image/png'], ['image/*', 'p', 'text/plain'], ['.csv,image/*', 'q.png', 'image/png'],
    ];
    for (const [a, n, m] of pairs) expect(bridge._t.accMatch(a, n, m), `${a}|${n}|${m}`).toBe(widgetAcceptMatches(a, n, m));
    for (const n of [0, 1, 1023, 1024, 1048524, 1048525, 5e7, 4.9e9]) expect(bridge._t.humanBytes(n)).toBe(humanBytes(n));
    for (const v of ['#fff', ' 3px ', 'a;b', 'x'.repeat(301), '', 'url(\\x)']) expect(bridge._t.safeTok(v)).toBe(safeTokenValue(v));
    const reqs = [
      { multiple: false, maxBytes: 10 },
      { multiple: true, maxBytes: 100 },
    ];
    const lists = [[], [{ size: 5 }], [{ size: 50 }], [{ size: 5 }, { size: 6 }], Array(21).fill({ size: 1 })];
    for (const r of reqs) for (const l of lists) expect(bridge._t.checkPicked(l, r)).toBe(checkWidgetPickedFiles(l, r));
  });
});

describe('高さ追従・テーマ・同じノートの参照', () => {
  it('高さは送り主の箱だけに当て、上限 5000px で止める ── 名乗りと実体が違えば何もしない', () => {
    bridge = install();
    const a = frame(boxA, 'fa');
    const b = frame(boxB, 'fb');
    post({ type: HTML_SANDBOX_RESIZE_MSG_TYPE, id: 'fa', height: 99999 }, a.w);
    expect(a.f.style.height).toBe('5000px');
    // 🔴 なりすまし: A の箱が B の id を名乗る
    post({ type: HTML_SANDBOX_RESIZE_MSG_TYPE, id: 'fb', height: 0 }, a.w);
    expect(b.f.style.height).toBe('');
    // 送り主が箱でない
    post({ type: HTML_SANDBOX_RESIZE_MSG_TYPE, id: 'fb', height: 1 }, fakeWin());
    expect(b.f.style.height).toBe('');
  });

  it('準備の合図にテーマで答え、OS の明暗の切り替えと親の属性の変化で配り直す', async () => {
    let dark = false;
    let onChange: (() => void) | null = null;
    vi.stubGlobal('matchMedia', (q: string) => ({
      get matches() {
        return q.includes('dark') && dark;
      },
      addEventListener: (_t: string, fn: () => void) => {
        onChange = fn;
      },
    }));
    // ⚠ happy-dom は style の値を ; で切るので、計算済みスタイルを直に返す
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      () => ({ getPropertyValue: (n: string) => ({ '--fg': ' #123456 ', '--surface': 'red}body{x:y' })[n] ?? '' }) as unknown as CSSStyleDeclaration,
    );
    bridge = install();
    const a = frame(boxA, 'fa');
    post({ type: WIDGET_READY_MSG_TYPE, id: 'fa' }, a.w);
    const t1 = a.w.posted.at(-1)!.msg;
    expect(t1.type).toBe(WIDGET_THEME_MSG_TYPE);
    expect(t1.tone).toBe('light');
    expect((t1.tokens as Record<string, string>)['--pkc-fg']).toBe('#123456');
    // 🔴 危ない値は渡さない(本体と同じ受け入れ条件)
    expect((t1.tokens as Record<string, string>)['--pkc-surface']).toBeUndefined();
    // OS がダークへ
    dark = true;
    expect(onChange).not.toBeNull();
    onChange!();
    expect(a.w.posted.at(-1)!.msg.tone).toBe('dark');
    // 親の属性(data-pkc-tone)が優先
    const before = a.w.posted.length;
    document.documentElement.setAttribute('data-pkc-tone', 'light');
    await flush();
    expect(a.w.posted.length).toBeGreaterThan(before);
    expect(a.w.posted.at(-1)!.msg.tone).toBe('light');
    // なりすましの準備の合図には答えない
    const n = a.w.posted.length;
    post({ type: WIDGET_READY_MSG_TYPE, id: 'other' }, a.w);
    expect(a.w.posted.length).toBe(n);
  });

  it('🔴 同じノートの参照は、その箱のノートだけ(他のノートへ越境しない)', () => {
    bridge = install();
    const a = frame(boxA, 'fa');
    const b = frame(boxB, 'fb');
    post({ type: WIDGET_CONTEXT_REQ_MSG_TYPE, id: 'fa', reqId: 1 }, a.w);
    post({ type: WIDGET_CONTEXT_REQ_MSG_TYPE, id: 'fb', reqId: 2 }, b.w);
    const ra = a.w.posted.at(-1)!.msg;
    const rb = b.w.posted.at(-1)!.msg;
    expect(ra).toEqual({ type: WIDGET_CONTEXT_RES_MSG_TYPE, reqId: 1, context: NOTES.A!.ctx });
    expect(rb).toEqual({ type: WIDGET_CONTEXT_RES_MSG_TYPE, reqId: 2, context: NOTES.B!.ctx });
    // 🔴 A の箱が B を名乗っても答えない(B の表を渡さない)
    const n = a.w.posted.length;
    post({ type: WIDGET_CONTEXT_REQ_MSG_TYPE, id: 'fb', reqId: 3 }, a.w);
    expect(a.w.posted.length).toBe(n);
    expect(b.w.posted.some((p) => p.msg.reqId === 3)).toBe(false);
  });

  it('ホストの口が無ければ空の答え', () => {
    bridge = install(0, false);
    const a = frame(boxA, 'fa');
    post({ type: WIDGET_CONTEXT_REQ_MSG_TYPE, id: 'fa', reqId: 1 }, a.w);
    expect(a.w.posted.at(-1)!.msg.context).toEqual({ frontmatter: {}, tables: [] });
  });
});

describe('🔴 保存(確認バーを押したときだけ)', () => {
  function catchDl(): { files: { name: string; blob: Blob }[]; revoked: string[] } {
    const files: { name: string; blob: Blob }[] = [];
    const revoked: string[] = [];
    const made = new Map<string, Blob>();
    let n = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      n += 1;
      const u = `blob:pw/${String(n)}`;
      made.set(u, b as Blob);
      return u;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => {
      revoked.push(u);
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      files.push({ name: this.download, blob: made.get(this.href)! });
    });
    return { files, revoked };
  }

  it('自動では保存しない ── 確認バーの「PC へ保存」で保存し、答えを返し、1 秒後に URL を捨てる', async () => {
    vi.useFakeTimers();
    const dl = catchDl();
    bridge = install();
    const a = frame(boxA, 'fa');
    post(dlReq('fa', 1, '../../out.csv', 'a,b\n'), a.w);
    expect(dl.files, '確認なしで保存した').toHaveLength(0);
    expect(bar()).not.toBeNull();
    expect(bar()!.nextElementSibling).toBe(a.f);
    expect(bar()!.textContent).toContain('「out.csv」');
    // 閲覧用 HTML は読むだけ ── 「このノートへ添付」は出さない
    expect(document.querySelector('[data-pkc-field="widget-io-attach"]')).toBeNull();
    press('widget-io-save');
    expect(dl.files.map((f) => f.name)).toEqual(['out.csv']);
    expect(await dl.files[0]!.blob.text()).toBe('a,b\n');
    expect(a.w.posted.at(-1)!.msg).toEqual({ type: WIDGET_DL_RES_MSG_TYPE, reqId: 1, ok: true, action: 'save' });
    expect(bar()).toBeNull();
    expect(dl.revoked).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(dl.revoked).toEqual(['blob:pw/1']);
  });

  it('「やめる」で保存せずに答える', () => {
    const dl = catchDl();
    bridge = install();
    const a = frame(boxA, 'fa');
    post(dlReq('fa', 1, 'x.csv', 'x'), a.w);
    press('widget-io-cancel');
    expect(dl.files).toHaveLength(0);
    expect(a.w.posted.at(-1)!.msg).toEqual({ type: WIDGET_DL_RES_MSG_TYPE, reqId: 1, ok: false, action: 'cancel' });
  });

  it('🔴 出した直後・差し替えた直後は 400ms 押せない', () => {
    vi.useFakeTimers();
    bridge = install(WIDGET_IO_PRESS_GUARD_MS);
    const a = frame(boxA, 'fa');
    post(dlReq('fa', 1, 'safe.csv', 'x'), a.w);
    const s1 = document.querySelector<HTMLButtonElement>('[data-pkc-field="widget-io-save"]')!;
    expect(s1.disabled).toBe(true);
    vi.advanceTimersByTime(WIDGET_IO_PRESS_GUARD_MS - 50);
    post(dlReq('fa', 2, 'evil.html', 'x', 'text/html'), a.w);
    // 前の要求は「置き換わりました」で閉じる
    expect(a.w.posted.find((p) => p.msg.reqId === 1)!.msg.reason).toBe(WIDGET_IO_REASONS.replaced);
    const s2 = document.querySelector<HTMLButtonElement>('[data-pkc-field="widget-io-save"]')!;
    vi.advanceTimersByTime(100);
    expect(s2.disabled, '前の要求の時間で押せるようになった').toBe(true);
    vi.advanceTimersByTime(WIDGET_IO_PRESS_GUARD_MS);
    expect(s2.disabled).toBe(false);
    expect(document.querySelectorAll('[data-pkc-field="widget-io-bar"]')).toHaveLength(1);
  });

  it('要注意の拡張子には注意の文、そうでなければ出さない', () => {
    bridge = install();
    const a = frame(boxA, 'fa');
    post(dlReq('fa', 1, 'run.exe', 'x', 'application/octet-stream'), a.w);
    expect(document.querySelector('[data-pkc-field="widget-io-risk"]')!.textContent).toBe(WIDGET_IO_RISK_NOTICE);
    post(dlReq('fa', 2, 'ok.csv', 'x'), a.w);
    expect(document.querySelector('[data-pkc-field="widget-io-risk"]')).toBeNull();
  });

  it('🔴 流量の上限(1 秒に 3 回)── 4 回目は確認バーを出さずに断る', () => {
    vi.useFakeTimers();
    bridge = install();
    const a = frame(boxA, 'fa');
    for (let i = 1; i <= 4; i++) post(dlReq('fa', i, `${String(i)}.csv`, 'x'), a.w);
    const r4 = a.w.posted.find((p) => p.msg.reqId === 4)!.msg;
    expect(r4).toEqual({ type: WIDGET_DL_RES_MSG_TYPE, reqId: 4, ok: false, action: 'rejected', reason: WIDGET_IO_REASONS.rateLimited });
    expect(bar()!.textContent).toContain('3.csv');
    vi.advanceTimersByTime(1000);
    post(dlReq('fa', 5, '5.csv', 'x'), a.w);
    expect(bar()!.textContent).toContain('5.csv');
  });

  it('🔴 50 MB を超える物・壊れた data は確認バーを出さずに断る', () => {
    bridge = install();
    const a = frame(boxA, 'fa');
    post(dlReq('fa', 1, 'big.bin', new ArrayBuffer(WIDGET_IO_MAX_BYTES + 1)), a.w);
    expect(a.w.posted.at(-1)!.msg.reason).toBe(WIDGET_IO_REASONS.tooLarge);
    post(dlReq('fa', 2, 'bad.bin', { not: 'data' }), a.w);
    expect(a.w.posted.at(-1)!.msg.reason).toBe(WIDGET_IO_REASONS.badData);
    expect(bar()).toBeNull();
  });

  it('🔴 なりすまし(別の送り主・食い違う名乗り)には何もしない', () => {
    bridge = install();
    const a = frame(boxA, 'fa');
    const b = frame(boxB, 'fb');
    post(dlReq('fb', 1, 'x.csv', 'x'), a.w);
    post(dlReq('fa', 2, 'x.csv', 'x'), fakeWin());
    post(dlReq('fa', 3, 'x.csv', 'x'), null);
    expect(bar()).toBeNull();
    expect(a.w.posted).toHaveLength(0);
    expect(b.w.posted).toHaveLength(0);
  });

  it('🔴 ノートを切り替える(reset)と、確認バーを閉じて預かった bytes を手放す', () => {
    bridge = install();
    const a = frame(boxA, 'fa');
    post(dlReq('fa', 1, 'x.csv', 'x'), a.w);
    expect(bridge.pending()).toBe(1);
    const rec = bridge._t.pendOf(a.f)!;
    expect(rec.bytes?.byteLength).toBe(1);
    expect(bridge.reset()).toBe(1);
    expect(rec.bytes, '片付けたのに bytes を握り続けた').toBeNull();
    expect(bridge.pending()).toBe(0);
    expect(bar()).toBeNull();
    expect(a.w.posted.at(-1)!.msg).toEqual({ type: WIDGET_DL_RES_MSG_TYPE, reqId: 1, ok: false, action: 'cancel', reason: WIDGET_IO_REASONS.closed });
    // 公開の片付けの口も同じ物
    expect((window as unknown as { __pkcWidgetBridgeSweep: unknown }).__pkcWidgetBridgeSweep).toBe(bridge.reset);
  });

  it('箱が外れたら確認バーを片付ける(見張りは確認バーが在る間だけ)', async () => {
    bridge = install();
    const a = frame(boxA, 'fa');
    post(dlReq('fa', 1, 'x.csv', 'x'), a.w);
    a.f.remove();
    await flush();
    expect(bridge.pending()).toBe(0);
    expect(a.w.posted.at(-1)!.msg.reason).toBe(WIDGET_IO_REASONS.closed);
  });

  it('箱が諦める時間で親も閉じる', () => {
    vi.useFakeTimers();
    bridge = install();
    const a = frame(boxA, 'fa');
    post(dlReq('fa', 1, 'x.csv', 'x'), a.w);
    const rec = bridge._t.pendOf(a.f)!;
    vi.advanceTimersByTime(WIDGET_IO_TIMEOUT_MS + 1);
    expect(rec.bytes, '時間切れで bytes を握り続けた').toBeNull();
    expect(bar()).toBeNull();
    expect(a.w.posted.at(-1)!.msg.reason).toBe(WIDGET_IO_REASONS.timeout);
  });
});

describe('🔴 読み込み(確認バーを押したときだけ)', () => {
  it('「このノートの添付から選ぶ」は、その箱のノートの添付だけ(accept で絞る)── 選んだ物を Transferable で渡す', async () => {
    bridge = install();
    const a = frame(boxA, 'fa');
    post(fReq('fa', 1, { accept: '.csv' }), a.w);
    expect(bar()!.textContent).toContain('(対象: .csv)');
    press('widget-io-pick-note');
    const keys = [...document.querySelectorAll('[data-pkc-field="widget-io-note-asset"]')].map((x) => x.getAttribute('data-pkc-asset-key'));
    // 🔴 B の添付(kb1)は出ない・accept に合わない png も出ない
    expect(keys).toEqual(['ka1']);
    const give = document.querySelector<HTMLButtonElement>('[data-pkc-field="widget-io-note-give"]')!;
    expect(give.disabled).toBe(true);
    const radio = document.querySelector<HTMLInputElement>('[data-pkc-field="widget-io-note-asset"]')!;
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    expect(give.disabled).toBe(false);
    give.click();
    await flush();
    expect(reads).toEqual(['ka1']);
    const res = a.w.posted.at(-1)!;
    expect(res.msg.type).toBe(WIDGET_FILE_RES_MSG_TYPE);
    expect(res.msg.ok).toBe(true);
    const files = res.msg.files as { name: string; mime: string; size: number; data: ArrayBuffer }[];
    expect(files.map((f) => [f.name, f.mime, f.size])).toEqual([['a.csv', 'text/csv', 8]]);
    expect(new TextDecoder().decode(files[0]!.data)).toBe('x,y\n1,2\n');
    expect(res.transfer).toEqual([files[0]!.data]);
    expect(bar()).toBeNull();
  });

  it('合う添付が無ければ「このノートの添付から選ぶ」を出さない', () => {
    bridge = install();
    const b = frame(boxB, 'fb');
    post(fReq('fb', 1, { accept: 'image/*' }), b.w);
    expect(bar()).not.toBeNull();
    expect(document.querySelector('[data-pkc-field="widget-io-pick-note"]')).toBeNull();
    // 大きさの上限でも絞る
    post(fReq('fb', 2, { accept: '.csv', maxBytes: 3 }), b.w);
    expect(document.querySelector('[data-pkc-field="widget-io-pick-note"]')).toBeNull();
  });

  it('「PC から選ぶ」は押したときだけ開き、accept を選んだ後に検め直す', async () => {
    bridge = install();
    const a = frame(boxA, 'fa');
    const opened: HTMLInputElement[] = [];
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      opened.push(this);
    });
    post(fReq('fa', 1, { accept: '.csv' }), a.w);
    expect(opened, '確認なしでファイルを選ぶ画面を開いた').toHaveLength(0);
    press('widget-io-pick-pc');
    expect(opened).toHaveLength(1);
    expect(opened[0]!.accept).toBe('.csv');
    // 「すべてのファイル」へ切り替えて別の種類を選んだ
    Object.defineProperty(opened[0]!, 'files', { value: [new File(['x'], 'evil.html', { type: 'text/html' })], configurable: true });
    opened[0]!.dispatchEvent(new Event('change'));
    await flush();
    expect(a.w.posted.at(-1)!.msg).toEqual({ type: WIDGET_FILE_RES_MSG_TYPE, reqId: 1, ok: false, files: [], reason: WIDGET_IO_REASONS.wrongType });
    // 合う物はそのまま渡す
    post(fReq('fa', 2, { accept: '.csv' }), a.w);
    press('widget-io-pick-pc');
    Object.defineProperty(opened[1]!, 'files', { value: [new File(['1,2'], 'ok.csv', { type: 'text/csv' })], configurable: true });
    opened[1]!.dispatchEvent(new Event('change'));
    await flush();
    const r = a.w.posted.at(-1)!.msg;
    expect(r.ok).toBe(true);
    expect((r.files as { name: string }[])[0]!.name).toBe('ok.csv');
  });

  it('壊れた accept は確認バーを出さずに断る', () => {
    bridge = install();
    const a = frame(boxA, 'fa');
    post(fReq('fa', 1, { accept: 'text/csv\nx' }), a.w);
    expect(bar()).toBeNull();
    expect(a.w.posted.at(-1)!.msg.reason).toBe(WIDGET_IO_REASONS.badAccept);
  });

  it('🔴 読み込みの最中は新しい要求で置き換えない(busy で断る)', async () => {
    bridge = install();
    const a = frame(boxA, 'fa');
    let resolve: ((b: ArrayBuffer) => void) | null = null;
    (window as unknown as { __H: { readAssetBytes: unknown } }).__H.readAssetBytes = () =>
      new Promise<ArrayBuffer>((r) => {
        resolve = r;
      });
    post(fReq('fa', 1, { accept: '.csv' }), a.w);
    press('widget-io-pick-note');
    const radio = document.querySelector<HTMLInputElement>('[data-pkc-field="widget-io-note-asset"]')!;
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    press('widget-io-note-give');
    post(dlReq('fa', 2, 'x.csv', 'x'), a.w);
    expect(a.w.posted.at(-1)!.msg).toEqual({ type: WIDGET_DL_RES_MSG_TYPE, reqId: 2, ok: false, action: 'rejected', reason: WIDGET_IO_REASONS.busy });
    resolve!(new TextEncoder().encode('z').buffer);
    await flush();
    expect(a.w.posted.at(-1)!.msg.reqId).toBe(1);
    expect(a.w.posted.at(-1)!.msg.ok).toBe(true);
  });
});
