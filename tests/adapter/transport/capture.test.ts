/** @vitest-environment happy-dom */
/**
 * 🔴 **Bookmarklet から 1 件取り込む**(#194 / C-3)。
 *
 * ⚠ **これは許可リストの外から入る唯一の門**なので、閉じているところを厚く見る。
 * 見るのは 4 つ:
 *
 * 1. **門が開く条件**(断片に `capture` / 開いた相手が居る / 合図が作れる)
 * 2. **合図そのもの**(生きている間だけ / 1 回だけ / 一致しないと通らない)
 * 3. **通ってよい method は 1 つだけ**(読み出しの口にしない)
 * 4. **返事に中身を載せない**(`lid` を返さない)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  accepts,
  GRANTED_METHOD,
  GRANT_TTL_MS,
  isLive,
  mintGrant,
} from '../../../src/adapter/transport/capture-grant';
import { startCapture } from '../../../src/adapter/transport/capture-bridge';
import { startEmbedBridge } from '../../../src/adapter/transport/embed-bridge';
import { RPC } from '../../../src/adapter/transport/protocol';

describe('合図の判定(pure)', () => {
  const g = mintGrant(1000, () => 'n-1');

  it('出していなければ効かない / 期限内だけ効く', () => {
    expect(isLive(null, 1000), '合図が無いのに通した').toBe(false);
    expect(isLive(g, 1000)).toBe(true);
    expect(isLive(g, 1000 + GRANT_TTL_MS - 1)).toBe(true);
    expect(isLive(g, 1000 + GRANT_TTL_MS), '期限で切れていない').toBe(false);
  });

  /**
   * 🔴 **時計が巻き戻った環境で、期限が実質無限にならないこと。**
   * ⚠ `now - issuedAt < TTL` だけだと、`now` が過去になった回は**必ず真**になる。
   */
  it('🔴 発行より前の時刻では効かない(時計が戻っても無期限にしない)', () => {
    expect(isLive(g, 999), '過去の時刻で通した').toBe(false);
  });

  it('🔴 3 つそろわないと通さない(生きている / method / 合図の一致)', () => {
    expect(accepts(g, 1000, GRANTED_METHOD, { grant: 'n-1' })).toBe(true);
    expect(accepts(g, 1000, GRANTED_METHOD, { grant: 'n-2' }), '違う合図で通した').toBe(false);
    expect(accepts(g, 1000, GRANTED_METHOD, {}), '合図なしで通した').toBe(false);
    expect(accepts(g, 1000, 'pkc.hello', { grant: 'n-1' }), '別の method で通した').toBe(false);
    expect(accepts(null, 1000, GRANTED_METHOD, { grant: 'n-1' }), '合図が無いのに通した').toBe(
      false,
    );
    expect(
      accepts(g, 1000 + GRANT_TTL_MS, GRANTED_METHOD, { grant: 'n-1' }),
      '期限切れで通した',
    ).toBe(false);
  });

  it('通してよい method は 1 つだけ(読み出しの口にしない)', () => {
    expect(GRANTED_METHOD).toBe('pkc.createEntry');
  });
});

function fakeOpener(): { win: Window; sent: unknown[]; origins: string[] } {
  const sent: unknown[] = [];
  const origins: string[] = [];
  const win = {
    postMessage: (payload: unknown, targetOrigin: string) => {
      sent.push(payload);
      origins.push(targetOrigin);
    },
  } as unknown as Window;
  return { win, sent, origins };
}

describe('門が開く条件', () => {
  it('🔴 断片に capture が無ければ、合図を 1 つも作らない', () => {
    const o = fakeOpener();
    expect(startCapture({ hash: '', opener: o.win, uuid: () => 'n' })).toBe(null);
    expect(startCapture({ hash: '#pkc?view=filer', opener: o.win, uuid: () => 'n' })).toBe(null);
    expect(o.sent, '門が閉じているのに放送した').toEqual([]);
  });

  it('🔴 開いた相手が居なければ受けない(断片を手で打っても開かない)', () => {
    expect(startCapture({ hash: '#pkc?capture=1', opener: null, uuid: () => 'n' })).toBe(null);
  });

  /**
   * 🔴 **予測できない値が作れないなら、門を開かない。**
   * ⚠ 「弱い乱数で代用する」を書かない ── 代用すると**弱いまま動き続ける**。
   */
  it('🔴 合図が作れない箱では、門を開かない', () => {
    const o = fakeOpener();
    const real = globalThis.crypto;
    // ⚠ 無い箱を作る(`crypto` を持たない古い環境の再現)
    delete (globalThis as { crypto?: unknown }).crypto;
    try {
      expect(startCapture({ hash: '#pkc?capture=1', opener: o.win })).toBe(null);
      expect(o.sent, '合図が作れないのに放送した').toEqual([]);
    } finally {
      (globalThis as { crypto?: unknown }).crypto = real;
    }
  });

  it('🔴 開いたら合図を放送する(載せるのは合図だけ)', () => {
    const o = fakeOpener();
    const c = startCapture({ hash: '#pkc?capture=1', opener: o.win, uuid: () => 'n-9' });
    expect(c, '門が開かなかった').not.toBe(null);
    expect(o.sent).toEqual([{ pkc3: 'capture-ready', grant: 'n-9' }]);
    // ⚠ 相手の origin は分からないので `'*'` ── 載せているのが合図だけだから許される
    expect(o.origins).toEqual(['*']);
    expect(c!.grant()?.nonce).toBe('n-9');
    expect(c!.isOpener(o.win)).toBe(true);
    expect(c!.isOpener(fakeOpener().win), '別の窓を開いた相手と見なした').toBe(false);
  });
});

interface Harness {
  sent: Array<Record<string, unknown>>;
  made: Array<{ title: string; via: string }>;
  post: (params: unknown, method?: string, origin?: string) => void;
  detach: () => void;
}

function harness(nonce = 'n-9'): Harness {
  const o = fakeOpener();
  const capture = startCapture({ hash: '#pkc?capture=1', opener: o.win, uuid: () => nonce })!;
  const sent: Array<Record<string, unknown>> = [];
  const made: Array<{ title: string; via: string }> = [];
  const source = {
    postMessage: (p: Record<string, unknown>) => void sent.push(p),
  } as unknown as Window;
  // ⚠ 送り主は**開いた相手そのもの**でなければ門を通らないので、
  //    返事の宛先も同じ窓にする(`isOpener` が同一性で見る)
  const src = Object.assign(o.win as unknown as Record<string, unknown>, {
    postMessage: (p: Record<string, unknown>) => void sent.push(p),
  }) as unknown as Window;
  void source;
  const detach = startEmbedBridge({
    enabled: true,
    // 🔴 **許可リストは空** ── 通ったなら合図で通っている(空振り防止)
    origins: () => [],
    capture,
    target: window,
    createEntry: (input, _origin, via) => {
      made.push({ title: input.title, via });
      return 'lid-1';
    },
  });
  const post = (params: unknown, method = 'pkc.createEntry', origin = 'https://news.test'): void => {
    const ev = new MessageEvent('message', {
      data: { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) },
      origin,
    });
    Object.defineProperty(ev, 'source', { value: src, configurable: true });
    window.dispatchEvent(ev);
  };
  return { sent, made, post, detach: () => detach?.() };
}

describe('合図で 1 通だけ受ける', () => {
  it('🔴 合図つきなら受ける(対照群)── ただし返事に lid を載せない', async () => {
    const h = harness();
    h.post({ title: '記事', body: '本文', grant: 'n-9' });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.made, '取り込めていない').toEqual([{ title: '記事', via: 'capture' }]);
    // 🔴 **身元を確かめていない相手に id を返さない**(読み出しの口を生やさない)
    expect(h.sent[0]!.result).toEqual({ ok: true });
    expect(JSON.stringify(h.sent[0]), 'lid が漏れている').not.toContain('lid-1');
    h.detach();
  });

  it('🔴 合図が違えば断る(許可リストは空なので、通るのは合図だけ)', async () => {
    const h = harness();
    h.post({ title: '記事', body: '本文', grant: 'n-x' });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]!.error).toMatchObject({ code: RPC.FORBIDDEN_ORIGIN });
    expect(h.made, '合図が違うのに取り込んだ').toEqual([]);
    h.detach();
  });

  it('🔴 2 通目は通らない(1 回だけ)', async () => {
    const h = harness();
    h.post({ title: '1 通目', body: 'a', grant: 'n-9' });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    h.post({ title: '2 通目', body: 'b', grant: 'n-9' });
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    expect(h.sent[1]!.error, '2 通目が通った').toMatchObject({ code: RPC.FORBIDDEN_ORIGIN });
    expect(h.made.map((m) => m.title)).toEqual(['1 通目']);
    h.detach();
  });

  it('🔴 別の method は合図でも通らない(読み出しの口にしない)', async () => {
    const h = harness();
    h.post({ grant: 'n-9' }, 'pkc.hello');
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]!.error, 'hello が合図で通った').toMatchObject({
      code: RPC.FORBIDDEN_ORIGIN,
    });
    // ⚠ 合図は**焼かれていない**(通していないのだから)── 続けて本命が通ること
    h.post({ title: '記事', body: '本文', grant: 'n-9' });
    await vi.waitFor(() => expect(h.sent).toHaveLength(2));
    expect(h.made, '断った拍子に合図まで焼いた').toEqual([{ title: '記事', via: 'capture' }]);
    h.detach();
  });
});
