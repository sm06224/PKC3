/** @vitest-environment happy-dom */
/**
 * PKC-Message の受け口を検める(#189 / C-4 段①)。
 *
 * 🔴 **これは「外から書き込ませる口」なので、断る側を厚く見る。**
 * ⚠ 通す test だけ書くと、**誰でも書ける口**を緑のまま出荷できる。
 */
import { describe, expect, it, vi } from 'vitest';
import { attachMessageBridge } from '../../../src/adapter/transport/message-bridge';
import { MAX_PER_MINUTE, MAX_ROUGH_SIZE, RPC } from '../../../src/adapter/transport/protocol';

interface Sent {
  payload: Record<string, unknown>;
  targetOrigin: string;
}

function harness(opts: Partial<Parameters<typeof attachMessageBridge>[0]> = {}) {
  const sent: Sent[] = [];
  const rejected: { why: string; origin: string }[] = [];
  const source = {
    postMessage: (payload: Record<string, unknown>, targetOrigin: string) => {
      sent.push({ payload, targetOrigin });
    },
  } as unknown as Window;
  let clock = 1_000_000;
  const detach = attachMessageBridge({
    allowedOrigins: ['https://example.test'],
    handlers: {
      'pkc.ping': () => ({ pong: true }),
      'pkc.hello': () => ({ methods: ['pkc.ping'] }),
    },
    onReject: (why, origin) => rejected.push({ why, origin }),
    now: () => clock,
    target: window,
    ...opts,
  });
  const post = (data: unknown, origin = 'https://example.test', src: Window | null = source): void => {
    const ev = new MessageEvent('message', { data, origin });
    // ⚠ happy-dom は `source` を読み取り専用にするので、定義し直す
    Object.defineProperty(ev, 'source', { value: src, configurable: true });
    window.dispatchEvent(ev);
  };
  return { sent, rejected, post, detach, tick: (ms: number) => (clock += ms) };
}

const req = (method: string, id: string | number = 1, params?: unknown): unknown => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

describe('PKC-Message の受け口', () => {
  it('許した origin の依頼には結果を返す(対照群)', async () => {
    const h = harness();
    h.post(req('pkc.ping'));
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]!.payload).toEqual({ jsonrpc: '2.0', id: 1, result: { pong: true } });
    // 🔑 返事は **来た origin へ名指し**(`'*'` で撒かない)
    expect(h.sent[0]!.targetOrigin).toBe('https://example.test');
    h.detach();
  });

  it('🔴 許していない origin は、中身を見る前に断る', () => {
    const h = harness();
    h.post(req('pkc.ping'), 'https://evil.test');
    expect(h.sent[0]!.payload.error).toMatchObject({ code: RPC.FORBIDDEN_ORIGIN });
    expect(h.rejected[0]!.why).toBe('許していない origin');
    h.detach();
  });

  it('🔴 一覧が空なら全部拒否する(fail-closed)', () => {
    const h = harness({ allowedOrigins: [] });
    h.post(req('pkc.ping'));
    expect(h.sent[0]!.payload.error).toMatchObject({ code: RPC.FORBIDDEN_ORIGIN });
    h.detach();
  });

  it("🔴 `'*'` は `\"null\"` origin を含まない(素性の無い相手は名指しのときだけ)", () => {
    const h = harness({ allowedOrigins: ['*'] });
    h.post(req('pkc.ping'), 'null');
    // ⚠ `"null"` へは返事も送れないので、断ったことは onReject にしか残らない
    expect(h.sent).toHaveLength(0);
    expect(h.rejected.map((r) => r.why)).toContain('許していない origin');
    h.detach();
  });

  it('🔴 返事の宛先が無いものは、数えて捨てる(無言にしない)', () => {
    const h = harness();
    h.post(req('pkc.ping'), 'https://example.test', null);
    expect(h.sent).toHaveLength(0);
    expect(h.rejected[0]!.why).toBe('返事の宛先が無い');
    h.detach();
  });

  it('🔴 大きすぎる封筒は断る', () => {
    const h = harness();
    h.post({ jsonrpc: '2.0', id: 1, method: 'pkc.ping', params: { x: 'a'.repeat(MAX_ROUGH_SIZE + 1) } });
    expect(h.sent[0]!.payload.error).toMatchObject({ code: RPC.TOO_BIG });
    h.detach();
  });

  it('🔴 1 分あたりの上限を超えたら断り、窓が明けたらまた通す', async () => {
    const h = harness();
    for (let i = 0; i < MAX_PER_MINUTE; i += 1) h.post(req('pkc.ping', i));
    await vi.waitFor(() => expect(h.sent).toHaveLength(MAX_PER_MINUTE));
    h.post(req('pkc.ping', 'over'));
    expect(h.sent.at(-1)!.payload.error).toMatchObject({ code: RPC.TOO_MANY });
    // ⚠ 窓が明けたら通ること(= 一度断ったら永久に締め出す、になっていない)
    h.tick(60_001);
    h.post(req('pkc.ping', 'after'));
    await vi.waitFor(() => expect(h.sent.at(-1)!.payload).toHaveProperty('result'));
    h.detach();
  });

  it('🔴 上限は origin ごと(1 つの相手が全体を止められない)', async () => {
    const h = harness({ allowedOrigins: ['https://a.test', 'https://b.test'] });
    for (let i = 0; i < MAX_PER_MINUTE + 1; i += 1) h.post(req('pkc.ping', i), 'https://a.test');
    expect(h.sent.at(-1)!.payload.error).toMatchObject({ code: RPC.TOO_MANY });
    h.post(req('pkc.ping', 'b'), 'https://b.test');
    await vi.waitFor(() => expect(h.sent.at(-1)!.payload).toHaveProperty('result'));
    h.detach();
  });

  /**
   * 🔴 **「約束に無い method」と「この版が持っていない method」は別の事情である。**
   * ⚠ 符号だけ見ると同じ(`METHOD_NOT_FOUND`)なので、**片方の門を壊しても
   * もう片方が同じ符号で断ってしまう** ── 変異試験 M10 が SURVIVED で教えた
   * (CLAUDE.md §7「同じ問いに答える口が 2 つある」)。
   * 🔑 だから**文言で見分ける**。送り手にとっても、
   * 「綴りが違う」と「この版では未対応」は次の一手が変わる。
   */
  it('🔴 約束に無い method は「知らない」と断る', () => {
    const h = harness();
    h.post(req('pkc.deleteEverything'));
    expect(h.sent[0]!.payload.error).toMatchObject({ code: RPC.METHOD_NOT_FOUND });
    expect((h.sent[0]!.payload.error as { message: string }).message).toContain('知らない method');
    h.detach();
  });

  it('🔴 約束には在るが捌き手が居ない method は「この版では扱えません」と断る', () => {
    const h = harness({ handlers: { 'pkc.ping': () => ({ pong: true }) } });
    h.post(req('pkc.createEntry'));
    expect(h.sent[0]!.payload.error).toMatchObject({ code: RPC.METHOD_NOT_FOUND });
    expect((h.sent[0]!.payload.error as { message: string }).message).toContain('この版では扱えません');
    h.detach();
  });

  it('🔴 返事の要らない依頼(id 無し)は受けない', () => {
    const h = harness();
    h.post({ jsonrpc: '2.0', method: 'pkc.ping' });
    expect(h.sent[0]!.payload).toMatchObject({ id: null, error: { code: RPC.INVALID_REQUEST } });
    h.detach();
  });

  it('捌き手が投げても、内部の誤りとして返す(黙って落ちない)', async () => {
    const h = harness({
      handlers: {
        'pkc.ping': () => {
          throw new Error('わざと');
        },
      },
    });
    h.post(req('pkc.ping'));
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]!.payload.error).toMatchObject({ code: RPC.INTERNAL_ERROR, message: 'わざと' });
    h.detach();
  });

  it('外したら、もう受けない', () => {
    const h = harness();
    h.detach();
    h.post(req('pkc.ping'));
    expect(h.sent).toHaveLength(0);
    expect(h.rejected).toHaveLength(0);
  });
});
