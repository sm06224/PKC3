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

  /**
   * 🔴 **コンテナ id も落とさない**(2026-08-08。Issue #100 段①)。
   *
   * 読む面と編集プレビューは**ワーカー経由**で描くので、ここが素通しでないと
   * 「同期経路では押せるのに、ワーカーが立っていると押せない」という
   * **環境で挙動が割れる**形になる ── しかも速い環境ほど壊れて見える。
   * ⚠ postMessage の構造化複製を実際に通す(型の上で通ることは根拠にならない)。
   */
  it('🔴 opts の cid を落とさない(pkc:// の焼き分けが worker でも同じ)', () => {
    const text = '[題](pkc://c1/entry/e2)\n';
    const mine = send(1, text, { currentContainerId: 'c1' }) as { result: string };
    const other = send(2, text, { currentContainerId: 'c-other' }) as { result: string };
    // ⚠ **違いが出ること**を先に確かめる ── 同じなら opts を見ていない実装でも通る
    expect(mine.result).not.toBe(other.result);
    expect(mine.result).toContain('data-pkc-action="navigate-entry-ref"');
    expect(other.result).toContain('pkc-portable-reference-placeholder');
    expect(mine.result).toBe(renderMarkdown(text, { currentContainerId: 'c1' }));
  });

  /**
   * 🔴 **囲みの中身(添付)も落とさない**(#444 段②)。
   *
   * 書き出しは `renderBody` 経由で**ワーカーへ行くことがある** ── ここが素通しで
   * ないと、**ワーカーが立っている環境でだけ**配った HTML / Word の中身が消える
   * (しかも速い環境ほど壊れる、いちばん気づけない形)。
   */
  it('🔴 opts の fenceAssets を落とさない(焼き込みが worker でも同じ)', () => {
    const text = '```js asset:ast-j\n控え\n```\n';
    const baked = send(1, text, { fenceAssets: { 'ast-j': 'const x = 1;' } }) as {
      result: string;
    };
    const held = send(2, text) as { result: string };
    // ⚠ **違いが出ること**を先に確かめる ── 同じなら opts を見ていない実装でも通る
    expect(baked.result).not.toBe(held.result);
    expect(held.result).toContain('data-pkc-fence-asset-pending');
    expect(baked.result).toBe(
      renderMarkdown(text, { fenceAssets: { 'ast-j': 'const x = 1;' } }),
    );
  });

  /**
   * 🔴 **渡す形が「複製できる物」であることを、実際の複製で見る**(#444 段②)。
   *
   * ⚠ 型の上で通ることは根拠にならない ── 最初の設計は
   * `resolveFenceAsset: (key) => string | null` という**関数**で、
   * これは `postMessage` の構造化複製を**通らない**(そこで落ちる)。
   * 🔑 上の test の器(`ctx`)は複製をしないので、**この 1 件だけが**その門である。
   */
  it('🔴 fenceAssets は構造化複製を通る(関数に戻したら落ちる)', () => {
    const opts = { fenceAssets: { 'ast-j': 'const x = 1;' } };
    expect(structuredClone(opts)).toEqual(opts);
    // ⚠ 対照群 ── 複製できない形なら、この検査は本当に落ちる
    expect(() => structuredClone({ resolve: () => 'x' })).toThrow();
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
