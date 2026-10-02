/**
 * PDF を PKC の画面で読む窓 ⇄ 本体の**封筒**(#275 段①)── 実物どうしを繋ぐ。
 *
 * 🔴 **両端が相手を模した stub と話していると、綴りの食い違いが両方緑のまま通る**(CLAUDE.md §7、#195)。
 * 窓の側の綴りは `public/pdf/reader-wire.js`(素の JS)、本体の側は `src/adapter/platform/pdf/pdf-window.ts`。
 * ここは**どちらも実物**を走らせ、間に立つ放送は「そのまま流す通り道」(structured clone だけ)にする
 * ── 封筒を test に組ませない(組ませた瞬間、また片端しか見ていない test に戻る)。
 *
 * ⚠ 窓の**残り**(`reader.js` の画面)は実ブラウザの smoke(`tests/smoke/pdf-reader.smoke.spec.ts`)が通る。
 *   ここでは reader.js の**原文**から「送る種類」「待つ種類」を拾い、本体が両方向で扱うと突合する。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ALIVE_TTL_MS,
  HELLO_TIMEOUT_MS,
  PDF_CHANNEL,
  PDF_HOST_PATH,
  PDF_TAG,
  PdfReaderHost,
  type PdfLent,
  type PdfQuoteResult,
  type PdfSession,
} from '../../src/adapter/platform/pdf/pdf-window';
import { PDF_QUOTE_MAX_BYTES, PDF_QUOTE_TOO_LONG } from '../../src/features/pdf/pdf-quote';

// ───────── 窓の側の実物(`reader-wire.js` を原文から走らせる)

interface Wire {
  CHANNEL: string;
  TAG: string;
  QUOTE_MAX_BYTES: number;
  QUOTE_TOO_LONG: string;
  envelope(kind: string, token: string, payload?: object): Record<string, unknown>;
  parse(data: unknown, token: string): { kind: string; payload: Record<string, unknown> } | null;
  checkQuote(text: string): string | null;
}
function loadWire(): Wire {
  const root: { PkcPdfWire?: Wire } = {};
  new Function('self', readFileSync('public/pdf/reader-wire.js', 'utf-8'))(root);
  expect(root.PkcPdfWire, '原文が API を公開していない(空振り)').toBeDefined();
  return root.PkcPdfWire as Wire;
}
const wire = loadWire();

// ───────── 放送の通り道(structured clone で渡すだけ。封筒は 1 バイトも作らない)

class Hub {
  private readonly ends = new Set<End>();
  end(): End {
    const e = new End(this);
    this.ends.add(e);
    return e;
  }
  deliver(from: End, data: unknown): void {
    const copy = structuredClone(data);
    for (const e of this.ends) if (e !== from && e.onmessage) e.onmessage({ data: copy } as MessageEvent);
  }
}
class End {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor(private readonly hub: Hub) {}
  postMessage(data: unknown): void {
    this.hub.deliver(this, data);
  }
  close(): void {
    this.onmessage = null;
  }
}

// ───────── 台

interface Rig {
  host: PdfReaderHost;
  hub: Hub;
  opened: { url: string; features: string }[];
  timers: { fn: () => void; ms: number; live: boolean }[];
  disposed: string[];
  quotes: { session: PdfSession; text: string; page: number }[];
  fellBack: PdfSession[];
  loadFailed: { session: PdfSession; reason: string }[];
  openFailed: PdfSession[];
  clock: { t: number };
  /** 窓の側の端(実物の `reader-wire.js` で組む / 読む)。 */
  win: {
    token: string;
    received: { kind: string; payload: Record<string, unknown> }[];
    send(kind: string, payload?: object): void;
  };
  lent(url: string): PdfLent;
}

function rig(quoteResult: PdfQuoteResult = { ok: true, message: '引きました' }): Rig {
  const hub = new Hub();
  const clock = { t: 1_000_000 };
  const r = {
    hub,
    opened: [] as Rig['opened'],
    timers: [] as Rig['timers'],
    disposed: [] as string[],
    quotes: [] as Rig['quotes'],
    fellBack: [] as PdfSession[],
    loadFailed: [] as Rig['loadFailed'],
    openFailed: [] as PdfSession[],
    clock,
  };
  const host = new PdfReaderHost({
    onQuote: (session, text, page) => {
      r.quotes.push({ session, text, page });
      return quoteResult;
    },
    onFellBack: (s) => r.fellBack.push(s),
    onLoadFailed: (session, reason) => r.loadFailed.push({ session, reason }),
    onOpenFailed: (s) => r.openFailed.push(s),
    makeChannel: (name) => {
      expect(name).toBe(PDF_CHANNEL);
      return hub.end();
    },
    openWindow: (url, features) => r.opened.push({ url, features }),
    baseUrl: 'https://example.test/dev/',
    now: () => clock.t,
    setTimer: (fn, ms) => {
      const t = { fn, ms, live: true };
      r.timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { live: boolean }).live = false;
    },
    newToken: (() => {
      let n = 0;
      return () => `tok${String((n += 1))}`;
    })(),
  });
  const winEnd = hub.end();
  const win = {
    token: '',
    received: [] as { kind: string; payload: Record<string, unknown> }[],
    send(kind: string, payload: object = {}): void {
      winEnd.postMessage(wire.envelope(kind, win.token, payload));
    },
  };
  winEnd.onmessage = (ev): void => {
    const m = wire.parse(ev.data, win.token);
    if (m !== null) win.received.push(m);
  };
  return {
    ...r,
    host,
    win,
    lent: (url) => ({ url, dispose: () => r.disposed.push(url) }),
  };
}

/** 窓を開き、窓が名乗るところまで進める。 */
function openAndHello(g: Rig, assetKey = 'k1', name = '報告書.pdf', lid: string | null = 'att1'): PdfSession {
  const session = g.host.open({ assetKey, name, lid, lent: g.lent(`blob:${assetKey}`) });
  // 窓は自分が開かれた URL の `#token` から token を知る
  const url = g.opened[g.opened.length - 1]?.url ?? '';
  g.win.token = url.split('#')[1] ?? '';
  g.win.send('hello');
  return session;
}

describe('開く', () => {
  it('固定 path の窓を、token つきで、noopener の別窓として開く(handle を握らない)', () => {
    const g = rig();
    const s = g.host.open({ assetKey: 'k1', name: 'a.pdf', lid: 'att1', lent: g.lent('blob:1') });
    expect(g.opened).toHaveLength(1);
    expect(g.opened[0]?.url).toBe(`https://example.test/dev/${PDF_HOST_PATH}#${s.token}`);
    // 🔴 noopener を外すと、閉じても process が還らない(Office で実測 99% → 21%)
    expect(g.opened[0]?.features).toContain('noopener');
    expect(g.opened[0]?.features).toContain('popup');
  });

  it('窓が名乗ると、貸した URL と名前を渡す(bytes は載せない ── 字だけ)', () => {
    const g = rig();
    openAndHello(g);
    const doc = g.win.received.find((m) => m.kind === 'doc');
    expect(doc?.payload).toEqual({ url: 'blob:k1', name: '報告書.pdf' });
  });

  it('封筒の種別の鍵と放送の名前が、窓の側の実物と同じ綴りである(両端が実物)', () => {
    expect(PDF_TAG).toBe(wire.TAG);
    expect(PDF_CHANNEL).toBe(wire.CHANNEL);
    expect(PDF_QUOTE_MAX_BYTES).toBe(wire.QUOTE_MAX_BYTES);
    expect(PDF_QUOTE_TOO_LONG).toBe(wire.QUOTE_TOO_LONG);
  });

  it('🔴 窓が名乗らなければ(ポップアップが止められた等)、貸した URL を捨てて知らせる', () => {
    const g = rig();
    const s = g.host.open({ assetKey: 'k1', name: 'a.pdf', lid: null, lent: g.lent('blob:1') });
    const t = g.timers.find((x) => x.ms === HELLO_TIMEOUT_MS);
    expect(t, 'hello の待ち時間が仕掛けられていない').toBeDefined();
    expect(g.disposed).toEqual([]);
    t?.fn();
    expect(g.disposed).toEqual(['blob:1']);
    expect(g.openFailed).toEqual([s]);
  });

  it('対照群: 名乗ったら待ち時間は外れ、時間が来ても何も捨てない', () => {
    const g = rig();
    openAndHello(g);
    const t = g.timers.find((x) => x.ms === HELLO_TIMEOUT_MS);
    expect(t?.live).toBe(false);
    expect(g.openFailed).toEqual([]);
    expect(g.disposed).toEqual([]);
  });

  it('開く途中で落ちても、貸した URL を漏らさない', () => {
    const g = rig();
    const bad = new PdfReaderHost({
      onQuote: () => ({ ok: true, message: '' }),
      onFellBack: () => undefined,
      onLoadFailed: () => undefined,
      onOpenFailed: () => undefined,
      makeChannel: () => g.hub.end(),
      openWindow: () => {
        throw new Error('blocked');
      },
      baseUrl: 'https://example.test/',
    });
    expect(() => bad.open({ assetKey: 'k', name: 'a', lid: null, lent: g.lent('blob:x') })).toThrow('blocked');
    expect(g.disposed).toEqual(['blob:x']);
  });
});

describe('貸した URL の寿命 ── 窓が Blob を握った瞬間が終端', () => {
  it('loaded で返す(窓の寿命まで握らない)/ その後 closed が来ても二重に返さない', () => {
    const g = rig();
    openAndHello(g);
    expect(g.disposed).toEqual([]);
    g.win.send('loaded');
    expect(g.disposed).toEqual(['blob:k1']);
    g.win.send('closed');
    expect(g.disposed).toEqual(['blob:k1']);
  });

  it('握らないまま閉じられたら、閉じた時点で返す', () => {
    const g = rig();
    openAndHello(g);
    g.win.send('closed');
    expect(g.disposed).toEqual(['blob:k1']);
  });

  it('退避(fell-back)・取れなかった(load-failed)でも返し、本体へ知らせる', () => {
    const a = rig();
    const sa = openAndHello(a);
    a.win.send('loaded');
    a.win.send('fell-back');
    expect(a.fellBack).toEqual([sa]);
    expect(a.disposed).toEqual(['blob:k1']);

    const b = rig();
    const sb = openAndHello(b);
    b.win.send('load-failed', { reason: 'status 404' });
    expect(b.loadFailed).toEqual([{ session: sb, reason: 'status 404' }]);
    expect(b.disposed).toEqual(['blob:k1']);
  });

  it('返した後に窓が名乗り直しても、無い URL を渡さない(null で答える)', () => {
    const g = rig();
    openAndHello(g);
    g.win.send('loaded');
    g.win.received.length = 0;
    g.win.send('hello');
    expect(g.win.received.find((m) => m.kind === 'doc')?.payload).toEqual({ url: null, name: '報告書.pdf' });
  });
});

describe('ノートへ引く', () => {
  it('窓が選んだ字と頁番号を送ると、本体が受け、結果を窓へ返す', () => {
    const g = rig({ ok: true, message: '「メモ」の末尾へ引きました(3 頁)' });
    const s = openAndHello(g);
    g.win.send('quote', { text: '結論', page: 3 });
    expect(g.quotes).toEqual([{ session: s, text: '結論', page: 3 }]);
    const res = g.win.received.find((m) => m.kind === 'quote-result');
    expect(res?.payload).toEqual({ ok: true, message: '「メモ」の末尾へ引きました(3 頁)' });
  });

  it('🔴 64KB を超える字は、本体が受けない(窓の検めに頼らない最後の門)', () => {
    const g = rig();
    openAndHello(g);
    g.win.send('quote', { text: 'a'.repeat(PDF_QUOTE_MAX_BYTES + 1), page: 1 });
    expect(g.quotes).toEqual([]);
    expect(g.win.received.find((m) => m.kind === 'quote-result')?.payload).toEqual({
      ok: false,
      message: PDF_QUOTE_TOO_LONG,
    });
  });

  it('対照群: ちょうど 64KB は通る(門は上限の 1 byte 上から)', () => {
    const g = rig();
    openAndHello(g);
    g.win.send('quote', { text: 'a'.repeat(PDF_QUOTE_MAX_BYTES), page: 1 });
    expect(g.quotes).toHaveLength(1);
  });

  it('日本語は 3 byte で数える(字数ではなく byte の門)', () => {
    const g = rig();
    openAndHello(g);
    g.win.send('quote', { text: 'あ'.repeat(21846), page: 1 }); // 65538 byte
    expect(g.quotes).toEqual([]);
    g.win.send('quote', { text: 'あ'.repeat(21845), page: 1 }); // 65535 byte
    expect(g.quotes).toHaveLength(1);
  });

  it('窓側の検め(checkQuote)も同じ境目で断る', () => {
    expect(wire.checkQuote('a'.repeat(PDF_QUOTE_MAX_BYTES))).toBeNull();
    expect(wire.checkQuote('a'.repeat(PDF_QUOTE_MAX_BYTES + 1))).toBe(PDF_QUOTE_TOO_LONG);
  });

  it('型の違う字・頁は無視する(窓は同一 origin の別 realm)', () => {
    const g = rig();
    openAndHello(g);
    g.win.send('quote', { text: 5, page: 1 });
    g.win.send('quote', { text: 'a', page: '1' });
    g.win.send('quote', {});
    expect(g.quotes).toEqual([]);
  });
});

describe('窓の側も、自分宛ての封筒だけ読む(実物の parse)', () => {
  it('自分の token の封筒は読み、他の窓宛て・封筒でないものは null', () => {
    const own = wire.envelope('doc', 'mine', { url: 'blob:x' });
    expect(wire.parse(own, 'mine')).toEqual({ kind: 'doc', payload: { url: 'blob:x' } });
    // 🔴 token の検めを外すと、他の窓宛ての「文書を渡す」を自分のものとして読んでしまう
    expect(wire.parse(own, 'someone-else')).toBeNull();
    expect(wire.parse(null, 'mine')).toBeNull();
    expect(wire.parse('str', 'mine')).toBeNull();
    expect(wire.parse({ token: 'mine' }, 'mine')).toBeNull();
    expect(wire.parse({ [PDF_TAG]: 5, token: 'mine' }, 'mine')).toBeNull();
  });
});

describe('放送は全タブに届く ── 自分が開いた窓だけ受ける', () => {
  it('知らない token の合図(他のタブの窓)には、何も起きない', () => {
    const g = rig();
    openAndHello(g);
    const other = g.hub.end();
    other.postMessage(wire.envelope('quote', 'someone-else', { text: 'x', page: 1 }));
    other.postMessage(wire.envelope('closed', 'someone-else', {}));
    expect(g.quotes).toEqual([]);
    expect(g.disposed).toEqual([]);
  });

  it('封筒でないものは捨てる', () => {
    const g = rig();
    openAndHello(g);
    const other = g.hub.end();
    other.postMessage(null);
    other.postMessage('str');
    other.postMessage({ token: g.win.token });
    other.postMessage({ [PDF_TAG]: 5, token: g.win.token });
    expect(g.quotes).toEqual([]);
  });
});

describe('同じ添付の窓が生きているか(2 枚目を開かない)', () => {
  it('開いた直後から生きている扱い / 合図が途絶えて猶予を過ぎたら死んだ扱い', () => {
    const g = rig();
    const s = openAndHello(g, 'k1');
    expect(g.host.openTokenFor('k1')).toBe(s.token);
    expect(g.host.openTokenFor('other')).toBeNull();
    g.clock.t += ALIVE_TTL_MS + 1;
    expect(g.host.openTokenFor('k1')).toBeNull();
    g.win.send('alive');
    expect(g.host.openTokenFor('k1')).toBe(s.token);
  });

  it('閉じたと言われたら、もう開いていない', () => {
    const g = rig();
    openAndHello(g, 'k1');
    g.win.send('closed');
    expect(g.host.openTokenFor('k1')).toBeNull();
  });

  it('focus は窓へ「前へ」を頼む', () => {
    const g = rig();
    const s = openAndHello(g);
    g.win.received.length = 0;
    g.host.focus(s.token);
    expect(g.win.received.map((m) => m.kind)).toEqual(['focus-request']);
  });
});

describe('種類の突合 ── reader.js の原文が送る / 待つ種類を、本体が両方向で扱う', () => {
  const src = readFileSync('public/pdf/reader.js', 'utf-8');
  const sent = [...src.matchAll(/\bsend\('([a-z-]+)'/g)].map((m) => m[1] as string);
  const awaited = [...src.matchAll(/m\.kind === '([a-z-]+)'/g)].map((m) => m[1] as string);

  it('⚠ 前提: 窓が送る種類・待つ種類を実際に拾えている(空振り防止)', () => {
    expect(new Set(sent).size).toBeGreaterThanOrEqual(7);
    expect(new Set(awaited).size).toBe(3);
  });

  it('窓が送る種類は、ちょうどこの 7 つ(増えたら本体の受け口と対で足す)', () => {
    expect([...new Set(sent)].sort()).toEqual(
      ['alive', 'closed', 'fell-back', 'hello', 'load-failed', 'loaded', 'quote'].sort(),
    );
  });

  it('窓が待つ種類は、本体が送る 3 つと同じ(doc / focus-request / quote-result)', () => {
    expect([...new Set(awaited)].sort()).toEqual(['doc', 'focus-request', 'quote-result']);
    const g = rig();
    const s = openAndHello(g);
    g.host.focus(s.token);
    g.win.send('quote', { text: 'a', page: 1 });
    expect(new Set(g.win.received.map((m) => m.kind))).toEqual(new Set(awaited));
  });

  it('窓が送る 7 種を 1 つずつ本体へ通し、どれも「無視」されない(受け口が在る)', () => {
    const effects: Record<string, (g: Rig) => unknown> = {
      hello: (g) => g.win.received.some((m) => m.kind === 'doc'),
      alive: (g) => g.host.openTokenFor('k1') !== null,
      loaded: (g) => g.disposed.length === 1,
      'load-failed': (g) => g.loadFailed.length === 1,
      'fell-back': (g) => g.fellBack.length === 1,
      quote: (g) => g.quotes.length === 1,
      closed: (g) => g.host.openTokenFor('k1') === null,
    };
    for (const kind of new Set(sent)) {
      const g = rig();
      if (kind === 'hello') {
        g.host.open({ assetKey: 'k1', name: 'n', lid: null, lent: g.lent('blob:k1') });
        g.win.token = (g.opened[0]?.url ?? '').split('#')[1] ?? '';
        g.win.send('hello');
      } else {
        openAndHello(g);
        g.win.received.length = 0;
        // 生きている扱いの猶予を過ぎさせてから送る(alive が効いたことだけを見る)
        if (kind === 'alive') g.clock.t += ALIVE_TTL_MS + 1;
        g.win.send(kind, kind === 'quote' ? { text: 'a', page: 1 } : kind === 'load-failed' ? { reason: 'r' } : {});
      }
      expect(effects[kind]?.(g), `${kind} が本体で何も起こさない(受け口が無い)`).toBe(true);
    }
  });
});
