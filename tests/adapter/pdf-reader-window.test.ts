/** @vitest-environment happy-dom */
/**
 * PDF を読む窓の本体(`public/pdf/reader.js`)の**返事待ち**(#275 段① 着地後レビュー)。
 *
 * 🔴 守るもの:本体(別のタブ)は、リロード / 閉じ / token の忘却のどれでも**返事をしなくなる**。放送は片道で、
 * 届かなかったと知る手段が無い ── 上限が無いと窓は「読み込んでいます…」「ノートへ引用しています…」のまま
 * **永久に固まる**。ここは **reader.js の原文を実物として走らせ**(画面は `host.html` の実物の骨組み)、
 * 時間を進めて「上限が来たら断る / 返事が来たら断らない」の**両方向**を見る。
 *
 * ⚠ 走らせないもの:pdf.js(`import('./lib/pdf.min.mjs')` は文書が届いてからの話で、ここでは触れない)。
 *   頁の絵・拡大縮小は実ブラウザの smoke(`tests/smoke/pdf-reader.smoke.spec.ts`)が通る。
 * ⚠ `import.meta.url` は classic script の `new Function` では書けないので、**その 1 語だけ**差し替える
 *   (それ以外の原文は 1 字も変えない)。
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUOTE_SETTLE_TIMEOUT_MS } from '../../src/adapter/platform/pdf/quote-into-note';

interface Wire {
  DOC_TIMEOUT_MS: number;
  QUOTE_TIMEOUT_MS: number;
  DOC_FAILED: string;
  QUOTE_NO_REPLY: string;
  envelope(kind: string, token: string, payload?: object): Record<string, unknown>;
}

/** 放送の台。窓が送ったものを控え、こちらから窓へ「本体の返事」を届けられる。 */
class FakeChannel {
  static all: FakeChannel[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];
  constructor(readonly name: string) {
    FakeChannel.all.push(this);
  }
  postMessage(data: Record<string, unknown>): void {
    this.sent.push(data);
  }
  close(): void {
    this.onmessage = null;
  }
}

const TOKEN = 'ptesttoken';
const hostHtml = readFileSync('public/pdf/host.html', 'utf-8');
const bodyHtml = hostHtml
  .slice(hostHtml.indexOf('<body>') + '<body>'.length, hostHtml.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');

function evalScript(path: string, g: unknown): void {
  const src = readFileSync(path, 'utf-8').replaceAll('import.meta.url', JSON.stringify('https://example.test/pdf/reader.js'));
  new Function('self', src).call(g, g);
}

let wire: Wire;
let ch: FakeChannel;
const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const sentKinds = (): string[] => ch.sent.map((m) => m['pkc3Pdf'] as string);

function boot(): void {
  document.body.innerHTML = bodyHtml;
  document.body.removeAttribute('data-pkc-pdf-state'); // 前の test の状態を持ち越さない
  FakeChannel.all = [];
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(
    `https://example.test/pdf/host.html#${TOKEN}`,
  );
  const g = globalThis as unknown as Record<string, unknown>;
  evalScript('public/pdf/reader-wire.js', g);
  evalScript('public/pdf/page-cache.js', g);
  evalScript('public/pdf/doc-lease.js', g);
  evalScript('public/pdf/text-hits.js', g);
  evalScript('public/pdf/page-list.js', g);
  evalScript('public/pdf/page-edit.js', g);
  evalScript('public/pdf/highlight.js', g);
  evalScript('public/pdf/notes.js', g);
  evalScript('public/pdf/edit-stage.js', g);
  wire = g['PkcPdfWire'] as Wire;
  evalScript('public/pdf/reader.js', g);
  const found = FakeChannel.all[FakeChannel.all.length - 1];
  expect(found, '窓が放送を開いていない(空振り)').toBeDefined();
  ch = found as FakeChannel;
}

/** 本体の返事(窓から見れば受信)を届ける。⚠ 封筒は窓の実物の `envelope` で組む(綴りを test に持たせない)。 */
function fromHost(kind: string, payload: object): void {
  const env = wire.envelope(kind, TOKEN, payload);
  ch.onmessage?.({ data: env });
}

/** 字を選んだ状態にする(`selectionchange` が頁の中の字を指す)。 */
function selectText(text: string, page: number): void {
  const box = document.createElement('div');
  box.setAttribute('data-page', String(page));
  const node = document.createTextNode(text);
  box.append(node);
  $('pages').append(box);
  vi.spyOn(window, 'getSelection').mockReturnValue({
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => ({ startContainer: node }),
  } as unknown as Selection);
  document.dispatchEvent(new Event('selectionchange'));
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('🔴 本体が文書を渡してこないとき ── 「読み込んでいます…」のまま固まらない', () => {
  it('上限(DOC_TIMEOUT_MS)の 1 ms 前までは待ち、上限で「もう一度開いてください」と断る', () => {
    boot();
    expect(sentKinds()).toContain('hello');
    const initial = $('msg').textContent;
    expect(initial).toContain('読み込んでいます');
    vi.advanceTimersByTime(wire.DOC_TIMEOUT_MS - 1);
    expect($('msg').textContent).toBe(initial);
    vi.advanceTimersByTime(1);
    expect($('msg').textContent).toBe(wire.DOC_FAILED);
    expect(document.body.getAttribute('data-pkc-pdf-state')).toBe('failed');
  });

  it('断りの字は、画面の字として「PKC3 のウィンドウから、もう一度開いてください」を言う(内部語なし)', () => {
    boot();
    expect(wire.DOC_FAILED).toBe('文書を受け取れませんでした。PKC3 のウィンドウから、もう一度開いてください');
    expect(wire.QUOTE_NO_REPLY).toContain('PKC3 のウィンドウから、もう一度開いてください');
    for (const t of [wire.DOC_FAILED, wire.QUOTE_NO_REPLY]) {
      expect(t, '内部の語が画面に出ている').not.toMatch(/pdf\.js|worker|token|BroadcastChannel/i);
    }
  });

  it('対照群: 文書(doc)が来たら時計は外れ、上限を過ぎても断らない', () => {
    // 取りに行く fetch は返らない(= 受け取りの途中で止まっている窓)
    vi.stubGlobal('fetch', () => new Promise(() => undefined));
    boot();
    const initial = $('msg').textContent;
    fromHost('doc', { url: 'blob:x', name: 'a.pdf' });
    vi.advanceTimersByTime(wire.DOC_TIMEOUT_MS * 3);
    expect($('msg').textContent, '文書が来たのに時間切れの断りを出している').toBe(initial);
    expect(document.body.getAttribute('data-pkc-pdf-state')).toBeNull();
  });

  it('本体が「無い」と答えたとき(url が null = 捨てた token の名乗り直し)は、待たずにすぐ断る', () => {
    boot();
    fromHost('doc', { url: null, name: 'a.pdf' });
    expect($('msg').textContent).toBe(wire.DOC_FAILED);
    expect(document.body.getAttribute('data-pkc-pdf-state')).toBe('failed');
  });
});

describe('🔴 ノートへ引く返事が来ないとき ── 「ノートへ引用しています…」のまま固まらない', () => {
  it('上限(QUOTE_TIMEOUT_MS)の 1 ms 前までは「引いています…」、上限で断る', () => {
    boot();
    selectText('結論', 3);
    expect(($('quote') as HTMLButtonElement).disabled).toBe(false);
    $('quote').click();
    expect($('status').textContent).toBe('ノートへ引用しています…');
    expect(sentKinds()).toContain('quote');
    vi.advanceTimersByTime(wire.QUOTE_TIMEOUT_MS - 1);
    expect($('status').textContent).toBe('ノートへ引用しています…');
    vi.advanceTimersByTime(1);
    expect($('status').textContent).toBe(wire.QUOTE_NO_REPLY);
  });

  it('対照群: 返事(quote-result)が来たら、その字を出し、時計は外れる(上限を過ぎても上書きしない)', () => {
    boot();
    selectText('結論', 3);
    $('quote').click();
    fromHost('quote-result', { ok: true, message: '「メモ」の末尾へ引用しました(3 頁)' });
    expect($('status').textContent).toBe('「メモ」の末尾へ引用しました(3 頁)');
    vi.advanceTimersByTime(4999);
    expect($('status').textContent, '返事が来たのに時間切れの字で上書きしている').toBe(
      '「メモ」の末尾へ引用しました(3 頁)',
    );
    vi.advanceTimersByTime(wire.QUOTE_TIMEOUT_MS * 3);
    expect($('status').textContent, '返事が来たのに時間切れの字で上書きしている').not.toBe(wire.QUOTE_NO_REPLY);
  });

  it('押し直したら時計は 1 本(古い押しの時計が、新しい押しの返事待ちを早く切らない)', () => {
    boot();
    selectText('結論', 3);
    $('quote').click();
    vi.advanceTimersByTime(wire.QUOTE_TIMEOUT_MS - 1000);
    $('quote').click();
    // 最初の押しから見れば上限を過ぎるが、2 度目の押しから見ればまだ待っている
    vi.advanceTimersByTime(2000);
    expect($('status').textContent).toBe('ノートへ引用しています…');
    vi.advanceTimersByTime(wire.QUOTE_TIMEOUT_MS);
    expect($('status').textContent).toBe(wire.QUOTE_NO_REPLY);
  });
});

describe('窓の下の一言は、終わった知らせなら 5 秒ほどで消える(#1663 依頼 49-2)', () => {
  it('終わった知らせは 4999 ms まで出て、5000 ms で消える', () => {
    boot();
    fromHost('quote-result', { ok: true, message: '「メモ」の末尾へ引用しました(3 頁)' });
    vi.advanceTimersByTime(4999);
    expect($('status').textContent).toBe('「メモ」の末尾へ引用しました(3 頁)');
    vi.advanceTimersByTime(1);
    expect($('status').textContent).toBe('');
  });
  it('次の知らせが出たら数え直す(古い時計が新しい知らせを早く消さない)', () => {
    boot();
    fromHost('quote-result', { ok: true, message: '一つ目' });
    vi.advanceTimersByTime(3000);
    fromHost('quote-result', { ok: true, message: '二つ目' });
    vi.advanceTimersByTime(3000);
    expect($('status').textContent).toBe('二つ目');
    vi.advanceTimersByTime(2000);
    expect($('status').textContent).toBe('');
  });
  it('対照群: 途中の一言(…で終わる)は、終わりの知らせに替わるまで消えない', () => {
    boot();
    selectText('結論', 3);
    $('quote').click();
    vi.advanceTimersByTime(9000);
    expect($('status').textContent).toBe('ノートへ引用しています…');
  });
  it('一言の下の字も選べる・押せる(一言は pointer-events を受けない)', () => {
    const rule = /#status \{[^}]*\}/.exec(hostHtml);
    expect(rule, '#status の規則が無い').not.toBeNull();
    expect((rule as RegExpExecArray)[0]).toContain('pointer-events: none');
  });
});

describe('検索で、いま見ている一致だけ濃い橙(#1663 依頼 49-4)', () => {
  it('mark.hit.cur は mark.hit の黄色と別の色で塗り、reader.js が cur を付け外しする', () => {
    const plain = /mark\.hit \{[^}]*background: ([^;}]+)/.exec(hostHtml);
    const cur = /mark\.hit\.cur \{[^}]*background: ([^;}]+)/.exec(hostHtml);
    expect(plain && cur, '規則が無い').toBeTruthy();
    expect((cur as RegExpExecArray)[1]).not.toBe((plain as RegExpExecArray)[1]);
    expect((cur as RegExpExecArray)[1]).toContain('255, 120, 0');
    const src = readFileSync('public/pdf/reader.js', 'utf-8');
    expect(src).toContain("m.classList.add('cur')");
    expect(src).toContain("classList.remove('cur')");
    expect(src).toContain('paintCurrentHit();');
  });
});

describe('上限の値(本体との順番を pin する)', () => {
  it('🔴 本体が結末を待つ上限(8 秒)は、窓が返事を待つ上限(10 秒)より短い ── 本体が先に理由つきで断れる', () => {
    boot();
    expect(wire.DOC_TIMEOUT_MS).toBe(8000);
    expect(wire.QUOTE_TIMEOUT_MS).toBe(10000);
    expect(QUOTE_SETTLE_TIMEOUT_MS).toBeLessThan(wire.QUOTE_TIMEOUT_MS);
  });
});

describe('ハイライトのボタン(#275 段②-2b)── 上のバーの「ノートへ引用する」の隣', () => {
  const swatchEls = (): HTMLButtonElement[] =>
    [...document.querySelectorAll<HTMLButtonElement>('#bar button.swatch')];

  it('「ハイライト」と色 4 つが「ノートへ引用する」の手前に並び、字を選ぶまでは全部押せない(同じ選びから引用もハイライトもできる)', () => {
    boot();
    const bar = [...$('bar').children].map((el) => el.id || el.className);
    const iq = bar.indexOf('quote');
    expect(bar.slice(iq - 5, iq + 1), '「ハイライト」→ 色 4 つ → 「ノートへ引用する」の順').toEqual([
      'hl-apply',
      'swatch',
      'swatch',
      'swatch',
      'swatch',
      'quote',
    ]);
    expect(swatchEls().map((b) => b.getAttribute('data-hl-color'))).toEqual(['yellow', 'green', 'blue', 'pink']);
    for (const b of [$('hl-apply'), $('quote'), ...swatchEls()]) expect((b as HTMLButtonElement).disabled).toBe(true);
    selectText('結論', 3);
    for (const b of [$('hl-apply'), $('quote'), ...swatchEls()]) expect((b as HTMLButtonElement).disabled).toBe(false);
    // 選びが消えたら、全部また押せない
    vi.spyOn(window, 'getSelection').mockReturnValue({ rangeCount: 0, toString: () => '' } as unknown as Selection);
    document.dispatchEvent(new Event('selectionchange'));
    for (const b of [$('hl-apply'), $('quote'), ...swatchEls()]) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it('色は黄が既定。押した色だけが「押されている」になり、押し直すまで覚える(色の見た目は窓の表から付く)', () => {
    boot();
    const pressed = (): string[] =>
      swatchEls()
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
        .map((b) => b.getAttribute('data-hl-color') ?? '');
    expect(pressed()).toEqual(['yellow']);
    selectText('結論', 3);
    (swatchEls()[2] as HTMLButtonElement).click();
    expect(pressed()).toEqual(['blue']);
    (swatchEls()[3] as HTMLButtonElement).click();
    expect(pressed()).toEqual(['pink']);
    // 窓の表(highlight.js)の色がそのまま背景になっている(CSS に色を二重に持たない)
    const g = globalThis as unknown as { PkcPdfHighlight: { COLORS: { id: string; rgb: number[] }[] } };
    expect(g.PkcPdfHighlight.COLORS).toHaveLength(4);
    for (const c of g.PkcPdfHighlight.COLORS) {
      const el = swatchEls().find((b) => b.getAttribute('data-hl-color') === c.id) as HTMLButtonElement;
      const want = c.rgb.map((v) => String(Math.round(v * 255))).join(',');
      expect(el.style.backgroundColor.replaceAll(' ', '')).toBe(`rgb(${want})`);
    }
  });

  it('文書が読めていない間は、押しても何も起きない(状態の行も動かない)', () => {
    boot();
    selectText('結論', 3);
    ($('hl-apply') as HTMLButtonElement).click();
    expect($('status').textContent).toBe('');
    expect(sentKinds().filter((k) => k !== 'hello')).toEqual([]);
  });
});

describe('付箋とペンのボタン(#275)── 「ハイライト」の手前に並ぶ', () => {
  it('「付箋」「ペン」が「ハイライト」の手前に並び、文書が読めるまでは押せず、押しても道具は選ばれない', () => {
    boot();
    const bar = [...$('bar').children].map((el) => el.id);
    expect(bar.slice(bar.indexOf('note-tool'), bar.indexOf('hl-apply') + 1)).toEqual(['note-tool', 'pen-tool', 'hl-apply']);
    for (const id of ['note-tool', 'pen-tool']) {
      expect(($(id) as HTMLButtonElement).disabled, `${id} は文書が読めるまで押せない`).toBe(true);
      ($(id) as HTMLButtonElement).click();
      expect($(id).getAttribute('aria-pressed')).toBe('false');
    }
    expect(document.body.getAttribute('data-pkc-pdf-tool'), '道具の印は付かない').toBeNull();
    expect($('status').textContent).toBe('');
  });
});
