/** @vitest-environment happy-dom */
/**
 * 外から 1 件作らせる口を検める(#189 / C-4 段②)。
 *
 * 🔴 **これは「外から書かせる」唯一の口**なので、受け取り方を厚く見る。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_TITLE,
  MAX_BODY,
  MAX_TITLE,
  parseCreateEntryParams,
  titleFromBody,
} from '../../../src/adapter/transport/create-entry-params';
import { served, startEmbedBridge } from '../../../src/adapter/transport/embed-bridge';
import { RPC } from '../../../src/adapter/transport/protocol';
import type { AgentGate, AgentTarget } from '../../../src/features/agent/agent-gate';

describe('引数の受け取り方', () => {
  it('題名が在ればそれを使う(1 行へ畳み、上限で切る)', () => {
    const r = parseCreateEntryParams({ title: '  あ\nい  ', body: 'x' });
    expect(r).toEqual({ ok: true, input: { title: 'あ い', body: 'x' } });
    const long = parseCreateEntryParams({ title: 'あ'.repeat(MAX_TITLE + 50) });
    expect((long as { input: { title: string } }).input.title).toHaveLength(MAX_TITLE);
  });

  it('🔴 題名が無ければ本文の 1 行目から作る(「無題」を並べない)', () => {
    expect(titleFromBody('# 見出し\n本文')).toBe('見出し');
    expect(titleFromBody('\n\n  最初の行  \n次')).toBe('最初の行');
    expect(titleFromBody('')).toBe(FALLBACK_TITLE);
    expect(titleFromBody('   \n\n')).toBe(FALLBACK_TITLE);
  });

  /**
   * 🔴 **部品だけでなく繋ぎを見る。**
   * ⚠ `titleFromBody()` を単体で見ていただけのときは、
   * 「題名が無ければ本文から作る」という**繋ぎを外しても緑**だった
   * (変異試験 N3 が SURVIVED)── 部品が正しくても、呼ばれなければ意味が無い。
   */
  it('🔴 題名を渡されなければ、本文から作った題名が入る', () => {
    expect(parseCreateEntryParams({ body: '# 見出し\n本文' })).toEqual({
      ok: true,
      input: { title: '見出し', body: '# 見出し\n本文' },
    });
    expect(parseCreateEntryParams({ title: '   ', body: '' })).toEqual({
      ok: true,
      input: { title: FALLBACK_TITLE, body: '' },
    });
  });

  it('🔴 本文だけの上限を持つ(封筒の上限とは別)', () => {
    const r = parseCreateEntryParams({ body: 'a'.repeat(MAX_BODY + 1) });
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toContain('長すぎます');
  });

  it('型が違えば断る', () => {
    expect(parseCreateEntryParams({ body: 1 }).ok).toBe(false);
    expect(parseCreateEntryParams({ title: [] }).ok).toBe(false);
  });

  it('🔴 制御文字は題名に持ち込まない', () => {
    // ⚠ 生バイトで書かない(CLAUDE.md「制御文字をソースに生バイトで埋めない」)
    const raw = `あ${String.fromCharCode(1)}い${String.fromCharCode(127)}う`;
    const r = parseCreateEntryParams({ title: raw });
    expect((r as { input: { title: string } }).input.title).toBe('あ い う');
  });
});

interface Sent {
  payload: Record<string, unknown>;
}

function harness(
  createEntry?: (i: { title: string; body: string }, o: string) => string | null,
  gate: AgentGate = async () => true,
) {
  const sent: Sent[] = [];
  const source = {
    postMessage: (payload: Record<string, unknown>) => void sent.push({ payload }),
  } as unknown as Window;
  const detach = startEmbedBridge({
    enabled: true,
    origins: () => ['https://a.test'],
    gate,
    target: window,
    ...(createEntry === undefined ? {} : { createEntry }),
  });
  const post = (params?: unknown): void => {
    const ev = new MessageEvent('message', {
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'pkc.createEntry',
        ...(params === undefined ? {} : { params }),
      },
      origin: 'https://a.test',
    });
    Object.defineProperty(ev, 'source', { value: source, configurable: true });
    window.dispatchEvent(ev);
  };
  return { sent, post, detach: () => detach?.() };
}

describe('🔴 A6: NUL は題名にも本文にも残さない(書き足しと同じ扱い)', () => {
  it('title / body の NUL を落とす。題名が NUL だけなら本文の先頭行から作る。対照群: NUL の無い字は変わらない', () => {
    const r = parseCreateEntryParams({ title: 'あ\u0000い', body: '本\u0000文\u0000' });
    expect(r).toEqual({ ok: true, input: { title: 'あい', body: '本文' } });
    const onlyNul = parseCreateEntryParams({ title: '\u0000\u0000', body: '# 見出し\n中身' });
    expect(onlyNul).toEqual({ ok: true, input: { title: '見出し', body: '# 見出し\n中身' } });
    expect(parseCreateEntryParams({ title: 't', body: 'b' })).toEqual({ ok: true, input: { title: 't', body: 'b' } });
  });
});

describe('外から 1 件作らせる', () => {
  it('作れたら lid と題名を返す(対照群)', async () => {
    const made: { title: string; body: string; origin: string }[] = [];
    const h = harness((i, o) => {
      made.push({ ...i, origin: o });
      return 'lid-1';
    });
    h.post({ title: '外から', body: '本文' });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]!.payload).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { lid: 'lid-1', title: '外から' },
    });
    // 🔑 **どの origin から来たか**を捌き手へ渡す(帯に出すために要る)
    expect(made[0]).toEqual({ title: '外から', body: '本文', origin: 'https://a.test' });
    h.detach();
  });

  it('🔴 引数の誤りは INVALID_PARAMS で返す(こちらのせいにしない)', async () => {
    const h = harness(() => 'lid-1');
    h.post({ body: 1 });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]!.payload.error).toMatchObject({ code: RPC.INVALID_PARAMS });
    h.detach();
  });

  it('🔴 作れなかったら(null)成功を返さない ── 相手が「入った」と思って先へ進まない', async () => {
    const h = harness(() => null);
    h.post({ title: '外から', body: '本文' });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const payload = h.sent[0]!.payload;
    expect(payload).not.toHaveProperty('result');
    expect(payload.error).toMatchObject({ code: RPC.INTERNAL_ERROR });
    expect((payload.error as { message: string }).message).toContain('作れませんでした');
    h.detach();
  });

  it('🔴 捌き手を渡していない器では、申告もしないし答えもしない', async () => {
    expect(served({})).toEqual(['pkc.hello', 'pkc.ping']);
    expect(served({ createEntry: () => '' })).toContain('pkc.createEntry');
    const h = harness();
    h.post({ title: 'x' });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]!.payload.error).toMatchObject({ code: RPC.METHOD_NOT_FOUND });
    h.detach();
  });
});

describe('🔴 依頼 364: pkc.createEntry も「ノートを作る」の許可を同じ門で見る', () => {
  it('門が通せば作る。門へは「作る」+ 相手の origin + 題名が渡る(対照群)', async () => {
    const asked: AgentTarget[] = [];
    const made: string[] = [];
    const h = harness(
      (i) => {
        made.push(i.title);
        return 'lid-1';
      },
      async (t) => {
        asked.push(t);
        return true;
      },
    );
    h.post({ title: '外から', body: '本文' });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]!.payload.result).toEqual({ lid: 'lid-1', title: '外から' });
    expect(asked).toEqual([{ action: 'create', title: '外から', from: 'https://a.test' }]);
    expect(made).toEqual(['外から']);
    h.detach();
  });

  it('門が断れば(許可を取り消した / この相手は断る)作らず、理由を相手へ返す', async () => {
    const made: string[] = [];
    const h = harness(
      (i) => {
        made.push(i.title);
        return 'lid-1';
      },
      async () => false,
    );
    h.post({ title: '外から', body: '本文' });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const payload = h.sent[0]!.payload;
    expect(payload).not.toHaveProperty('result');
    expect((payload.error as { message: string }).message).toContain('許可しませんでした');
    expect(made).toEqual([]);
    h.detach();
  });
});
