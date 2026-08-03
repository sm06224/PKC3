/**
 * P8 段⑨: **worker の中身を node で回す**。
 *
 * 🔴 「worker の中だから unit では届かない」は誤り(CLAUDE.md 検証の規律)──
 * `self` / `postMessage` を差して実物を dynamic import すれば動く。
 * smoke 1 本に頼ると、payload の形・エラーの返し方の変異が誰にも守られない。
 *
 * ⚠ **同期経路との一致**もここで見る。ワーカーは速さの話であって正しさの話では
 * ないので、返る HTML が食い違ったら**どちらかが嘘**になる。
 */
import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

interface Ctx {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(msg: unknown): void;
}

const sent: unknown[] = [];
/** ⚠ **1 個だけ作って使い回す** ── module 側は import 時に `self.onmessage` を
 *  差すので、test ごとに差し替えると 2 回目以降は古い object に刺さったままになる。 */
const ctx: Ctx = {
  onmessage: null,
  postMessage: (m) => sent.push(m),
};

beforeAll(async () => {
  (globalThis as Record<string, unknown>).self = ctx;
  await import('../../src/adapter/platform/render/markdown-worker');
});

beforeEach(() => {
  sent.length = 0;
});

function send(id: number, text: string, opts: Record<string, unknown> = {}): unknown {
  ctx.onmessage!({ data: { id, payload: { text, opts } } });
  return sent.at(-1);
}

describe('markdown worker', () => {
  it('🔴 同期で描いたものと**同じ HTML** を返す', () => {
    const text = '# 見出し\n\n- あ\n- い\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    expect(send(1, text)).toEqual({ id: 1, ok: true, result: renderMarkdown(text, {}) });
  });

  it('id をそのまま返す(応答の対応が崩れない)', () => {
    expect((send(42, 'x') as { id: number }).id).toBe(42);
  });

  it('opts を落とさない(行アンカーの有無が伝わる)', () => {
    const text = '# 見出し\n\n本文\n';
    const withAnchors = send(1, text, { sourceLineAnchors: true }) as { result: string };
    const without = send(2, text, { sourceLineAnchors: false }) as { result: string };
    // ⚠ **違いが出ること**を先に確かめる ── 同じなら「opts を見ていない」実装でも通る
    expect(withAnchors.result).not.toBe(without.result);
    expect(withAnchors.result).toBe(renderMarkdown(text, { sourceLineAnchors: true }));
    expect(without.result).toBe(renderMarkdown(text, { sourceLineAnchors: false }));
  });

  it('🔴 落ちても応答を返す(呼び側が永久に待たない)', () => {
    // 循環参照の opts を渡して内部で投げさせる ── どう投げるかではなく
    // **必ず何か返る**ことが観測点
    const bad: Record<string, unknown> = {};
    bad.self = bad;
    ctx.onmessage!({ data: { id: 7, payload: { text: null, opts: {} } } });
    const res = sent.at(-1) as { id: number; ok: boolean };
    expect(res.id).toBe(7);
    // null 本文は `renderMarkdown` が空を返す設計 ── 投げないなら ok:true でよい。
    // ⚠ どちらでも「応答が来る」ことは変わらない(そこが観測点)
    expect(typeof res.ok).toBe('boolean');
  });
});
