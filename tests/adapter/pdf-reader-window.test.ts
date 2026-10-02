/** @vitest-environment happy-dom */
/**
 * PDF を読む窓の本体(`public/pdf/reader.js`)の**返事待ち**(#275 段① 着地後レビュー)。
 *
 * 🔴 守るもの:本体(別のタブ)は、リロード / 閉じ / token の忘却のどれでも**返事をしなくなる**。放送は片道で、
 * 届かなかったと知る手段が無い ── 上限が無いと窓は「読み込んでいます…」「ノートへ引いています…」のまま
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

  it('断りの字は、画面の字として「PKC の画面から、もう一度開いてください」を言う(内部語なし)', () => {
    boot();
    expect(wire.DOC_FAILED).toBe('文書を受け取れませんでした。PKC の画面から、もう一度開いてください');
    expect(wire.QUOTE_NO_REPLY).toContain('PKC の画面から、もう一度開いてください');
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

describe('🔴 ノートへ引く返事が来ないとき ── 「ノートへ引いています…」のまま固まらない', () => {
  it('上限(QUOTE_TIMEOUT_MS)の 1 ms 前までは「引いています…」、上限で断る', () => {
    boot();
    selectText('結論', 3);
    expect(($('quote') as HTMLButtonElement).disabled).toBe(false);
    $('quote').click();
    expect($('status').textContent).toBe('ノートへ引いています…');
    expect(sentKinds()).toContain('quote');
    vi.advanceTimersByTime(wire.QUOTE_TIMEOUT_MS - 1);
    expect($('status').textContent).toBe('ノートへ引いています…');
    vi.advanceTimersByTime(1);
    expect($('status').textContent).toBe(wire.QUOTE_NO_REPLY);
  });

  it('対照群: 返事(quote-result)が来たら、その字を出し、時計は外れる(上限を過ぎても上書きしない)', () => {
    boot();
    selectText('結論', 3);
    $('quote').click();
    fromHost('quote-result', { ok: true, message: '「メモ」の末尾へ引きました(3 頁)' });
    expect($('status').textContent).toBe('「メモ」の末尾へ引きました(3 頁)');
    vi.advanceTimersByTime(wire.QUOTE_TIMEOUT_MS * 3);
    expect($('status').textContent, '返事が来たのに時間切れの字で上書きしている').toBe(
      '「メモ」の末尾へ引きました(3 頁)',
    );
  });

  it('押し直したら時計は 1 本(古い押しの時計が、新しい押しの返事待ちを早く切らない)', () => {
    boot();
    selectText('結論', 3);
    $('quote').click();
    vi.advanceTimersByTime(wire.QUOTE_TIMEOUT_MS - 1000);
    $('quote').click();
    // 最初の押しから見れば上限を過ぎるが、2 度目の押しから見ればまだ待っている
    vi.advanceTimersByTime(2000);
    expect($('status').textContent).toBe('ノートへ引いています…');
    vi.advanceTimersByTime(wire.QUOTE_TIMEOUT_MS);
    expect($('status').textContent).toBe(wire.QUOTE_NO_REPLY);
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
