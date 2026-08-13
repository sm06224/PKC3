/** @vitest-environment happy-dom */
/**
 * O2: Office の**別窓**(#88)。
 *
 * 🔴 **`noopener` で開くことが主張の中心**である。実測(2026-08-11):
 *
 * | 開き方 | 増えた | 閉じた後に残った | 回収 |
 * |---|---|---|---|
 * | opener 付き | 608.9MB | 482.7MB | **21%** |
 * | **noopener** | 743.9MB | **5.8MB** | **99%** |
 *
 * 守りたい主張:
 *  ① **必ず `noopener` で開く**(外すと回収 21% に落ちる)
 *  ② **窓は 1 つだけ** ── 生きていれば開かずに放送で頼む
 *  ③ 文書は「準備できた」と言われてから渡す(user gesture を切らない)
 *  ④ **空の保存で添付を上書きしない**
 *  ⑤ 生存通知が絶えたら「開いていない」に戻る
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALIVE_TTL_MS,
  OFFICE_CHANNEL,
  OfficeWindow,
  type OfficeWindowEvent,
} from '../../src/adapter/platform/office/office-window';

interface FakeChannel {
  make: (name: string) => {
    postMessage: (d: unknown) => void;
    close: () => void;
    onmessage: ((ev: MessageEvent) => void) | null;
  };
  sent: { type: string; payload: Record<string, unknown> }[];
  names: string[];
  deliver: (type: string, payload?: Record<string, unknown>) => void;
  readonly closed: number;
}

/** 放送を模す ── 送った物を控え、受け側へ差し込める。 */
function fakeChannel(): FakeChannel {
  const sent: { type: string; payload: Record<string, unknown> }[] = [];
  const names: string[] = [];
  const state = { closed: 0 };
  let handler: ((ev: MessageEvent) => void) | null = null;
  const ch = {
    postMessage(d: unknown) {
      const m = d as { pkc3Office: string; payload?: Record<string, unknown> };
      sent.push({ type: m.pkc3Office, payload: m.payload ?? {} });
    },
    close() { state.closed += 1; },
    get onmessage() { return handler; },
    set onmessage(fn: ((ev: MessageEvent) => void) | null) { handler = fn; },
  };
  return {
    make: (name: string) => { names.push(name); return ch; },
    sent,
    names,
    deliver: (type, payload = {}) => {
      handler?.({ data: { pkc3Office: type, payload } } as MessageEvent);
    },
    get closed() { return state.closed; },
  };
}

interface Harness {
  ow: OfficeWindow;
  opened: string[];
  ch: FakeChannel;
  seen: OfficeWindowEvent[];
  tick: (ms: number) => void;
}

function harness(): Harness {
  const opened: string[] = [];
  const ch = fakeChannel();
  const clock = { t: 100_000 };
  const seen: OfficeWindowEvent[] = [];
  const ow = new OfficeWindow({
    openWindow: (url) => { opened.push(url); },
    makeChannel: ch.make,
    now: () => clock.t,
    baseUrl: 'https://app.example/pkc3/',
  });
  ow.onEvent((e) => seen.push(e));
  return { ow, opened, ch, seen, tick: (ms) => { clock.t += ms; } };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('OfficeWindow', () => {
  it('🔴 既定の開き方は noopener(外すと回収が 99% → 21% に落ちる)', () => {
    const open = vi.fn<(url: string, target: string, features?: string) => null>(() => null);
    vi.stubGlobal('open', open);
    // 既定の openWindow を使う(差し替えない)
    new OfficeWindow({ makeChannel: fakeChannel().make, baseUrl: 'https://x/' }).open();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![1], '名前つきの窓にしない').toBe('_blank');
    expect(open.mock.calls[0]![2] ?? '', 'noopener が要る').toContain('noopener');
  });

  it('放送の名前は 1 つに閉じている', () => {
    const h = harness();
    expect(h.ch.names).toEqual([OFFICE_CHANNEL]);
  });

  it('host.html を、名前つきで開く', () => {
    const h = harness();
    h.ow.open({ name: '資料.docx' });
    const url = new URL(h.opened[0]!);
    expect(url.pathname).toBe('/pkc3/office/host.html');
    expect(url.searchParams.get('name')).toBe('資料.docx');
    // ⚠ 文書を渡さないときは `await-doc` を付けない ── 付けると窓が無駄に待つ
    expect(url.searchParams.has('await-doc')).toBe(false);
  });

  it('🔴 窓は 1 つだけ ── 生きていれば開かずに頼む', () => {
    const h = harness();
    h.ch.deliver('alive');
    const out = h.ow.open({ name: 'a.docx' });
    expect(out.kind).toBe('already-open');
    expect(h.opened, '2 つ目を開いていない').toEqual([]);
    expect(h.ch.sent.map((s) => s.type)).toContain('focus-request');
  });

  it('生きている窓に別の文書を渡すときは、読み直しを頼む', () => {
    const h = harness();
    h.ch.deliver('alive');
    h.ow.open({ name: 'b.docx', bytes: new Uint8Array([1, 2]) });
    const reload = h.ch.sent.find((s) => s.type === 'reload-request');
    expect(reload?.payload.name).toBe('b.docx');
    expect(reload?.payload.awaitDoc).toBe(true);
  });

  it('🔴 生存通知が絶えたら「開いていない」に戻り、新しく開く', () => {
    const h = harness();
    h.ch.deliver('alive');
    expect(h.ow.isProbablyOpen()).toBe(true);
    h.tick(ALIVE_TTL_MS + 1);
    expect(h.ow.isProbablyOpen(), '猶予を過ぎたら生きていないと見る').toBe(false);
    expect(h.ow.open().kind).toBe('opened');
    expect(h.opened.length).toBe(1);
  });

  it('窓が閉じたと言ってきたら、即座に「開いていない」に戻る', () => {
    const h = harness();
    h.ch.deliver('alive');
    h.ch.deliver('closed');
    expect(h.ow.isProbablyOpen(), '猶予を待たずに戻る').toBe(false);
  });

  /**
   * 🔴 **生存通知が「窓が表に居たか」を運ぶ**(#135)。
   * ⚠ 落とすと `office-hang-watch` が**保守側の物差し(70 秒)へ黙って倒れる** ──
   * ハングに気づくのが 17 倍遅くなるのに、誰も落ちない。
   */
  it('🔴 生存通知の visible を、そのまま購読者へ渡す', () => {
    const h = harness();
    h.ch.deliver('alive', { visible: true });
    h.ch.deliver('alive', { visible: false });
    expect(h.seen.filter((e) => e.type === 'alive')).toEqual([
      { type: 'alive', visible: true },
      { type: 'alive', visible: false },
    ]);
  });

  it('⚠ 古い host は visible を送らない ── false(絞られている側)に倒す', () => {
    // 🔑 未知を「表」と読むと、背面の窓を固まったと**誤検知**する
    const h = harness();
    h.ch.deliver('alive');
    expect(h.seen).toContainEqual({ type: 'alive', visible: false });
  });

  /** 🔴 **停止は放送されている**のに、以前は本体が捨てていた(#135 で拾うようにした)。 */
  it('🔴 窓の停止(crashed)を理由つきで受ける', () => {
    const h = harness();
    h.ch.deliver('crashed', { reason: 'memory access out of bounds' });
    expect(h.seen).toContainEqual({
      type: 'crashed',
      reason: 'memory access out of bounds',
    });
  });

  it('🔴 文書は「準備できた」と言われてから渡す(二重送信しない)', () => {
    const h = harness();
    h.ow.open({ name: 'x.docx', bytes: new Uint8Array([9, 8, 7]) });
    expect(h.ch.sent.filter((s) => s.type === 'document').length, 'まだ送っていない').toBe(0);
    h.ch.deliver('ready-for-document');
    const docs = h.ch.sent.filter((s) => s.type === 'document');
    expect(docs.length).toBe(1);
    expect(docs[0]!.payload.bytes).toEqual(new Uint8Array([9, 8, 7]));
    h.ch.deliver('ready-for-document');
    expect(h.ch.sent.filter((s) => s.type === 'document').length, '2 度目は送らない').toBe(1);
  });

  it('文書を渡していないときは、準備完了と言われても何も送らない', () => {
    const h = harness();
    h.ow.open();
    h.ch.deliver('ready-for-document');
    expect(h.ch.sent.filter((s) => s.type === 'document')).toEqual([]);
  });

  it('🔴 空の保存は通さない(添付を空で上書きしない)', () => {
    const h = harness();
    h.ch.deliver('saved', { name: 'a.docx', bytes: new Uint8Array(0) });
    h.ch.deliver('saved', { name: 'a.docx', bytes: 'not bytes' });
    expect(h.seen.filter((e) => e.type === 'saved'), '空も別型も通さない').toEqual([]);
    h.ch.deliver('saved', { name: 'a.docx', bytes: new Uint8Array([1]) });
    expect(h.seen.filter((e) => e.type === 'saved').length).toBe(1);
  });

  it('対応外・未配備・描画完了は、そのまま呼び出し側へ伝える', () => {
    const h = harness();
    h.ch.deliver('unsupported', { missing: ['JSPI'] });
    h.ch.deliver('not-installed');
    h.ch.deliver('painted', { ms: 1234 });
    expect(h.seen).toEqual([
      { type: 'unsupported', missing: ['JSPI'] },
      { type: 'not-installed' },
      { type: 'painted', ms: 1234 },
    ]);
  });

  it('知らない種別は無視する', () => {
    const h = harness();
    h.ch.deliver('whatever');
    expect(h.seen).toEqual([]);
  });

  it('🔴 expectDocument だけでも await-doc を付ける(後渡しの宣言)', () => {
    const h = harness();
    h.ow.open({ name: 'a.docx', expectDocument: true });
    expect(new URL(h.opened[0]!).searchParams.get('await-doc'), '窓に待つよう伝える').toBe('1');
  });

  it('🔴 後渡し: 窓が先に「ちょうだい」と言っても取りこぼさない', () => {
    const h = harness();
    h.ow.open({ name: 'a.docx', expectDocument: true });
    // 窓が先に要求 ── この時点で bytes はまだ無い
    h.ch.deliver('ready-for-document');
    expect(h.ch.sent.filter((x) => x.type === 'document').length, 'まだ無いので送らない').toBe(0);
    // 後から届いたら、その場で送る
    h.ow.provideDocument('a.docx', new Uint8Array([4, 5]));
    const docs = h.ch.sent.filter((x) => x.type === 'document');
    expect(docs.length, '覚えていて送る').toBe(1);
    expect(docs[0]!.payload.bytes).toEqual(new Uint8Array([4, 5]));
  });

  it('後渡し: bytes が先に届いても、要求が来たときに送る', () => {
    const h = harness();
    h.ow.open({ name: 'a.docx', expectDocument: true });
    h.ow.provideDocument('a.docx', new Uint8Array([7]));
    expect(h.ch.sent.filter((x) => x.type === 'document').length, '要求前は送らない').toBe(0);
    h.ch.deliver('ready-for-document');
    expect(h.ch.sent.filter((x) => x.type === 'document').length).toBe(1);
  });

  it('🔴 空の文書は渡さない(Start Center を空で上書きしない)', () => {
    const h = harness();
    h.ow.open({ name: 'a.docx', expectDocument: true });
    h.ch.deliver('ready-for-document');
    h.ow.provideDocument('a.docx', new Uint8Array(0));
    expect(h.ch.sent.filter((x) => x.type === 'document')).toEqual([]);
  });

  it('開き直したら、前の「ちょうだい」は無効になる(古い bytes を送らない)', () => {
    const h = harness();
    h.ow.open({ name: 'a.docx', expectDocument: true });
    h.ch.deliver('ready-for-document');
    h.ow.open({ name: 'b.docx', expectDocument: true });   // 別の文書で開き直す
    h.ow.provideDocument('b.docx', new Uint8Array([9]));
    expect(h.ch.sent.filter((x) => x.type === 'document').length, 'まだ要求されていない').toBe(0);
  });

  it('requestClose は頼むだけ(握っていないので強制しない)', () => {
    const h = harness();
    h.ow.requestClose();
    expect(h.ch.sent.map((s) => s.type)).toEqual(['close-request']);
  });

  it('dispose すると放送を閉じ、以後の通知を配らない', () => {
    const h = harness();
    h.ow.dispose();
    expect(h.ch.closed).toBe(1);
    h.ch.deliver('painted', { ms: 1 });
    expect(h.seen).toEqual([]);
  });
});
