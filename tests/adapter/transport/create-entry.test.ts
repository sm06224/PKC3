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

function harness(createEntry?: (i: { title: string; body: string }, o: string) => string) {
  const sent: Sent[] = [];
  const source = {
    postMessage: (payload: Record<string, unknown>) => void sent.push({ payload }),
  } as unknown as Window;
  const detach = startEmbedBridge({
    enabled: true,
    origins: () => ['https://a.test'],
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
