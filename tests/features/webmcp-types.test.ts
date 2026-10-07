/**
 * WebMCP の入口の探し方(#1407 段①)。
 *
 * 守る主張:
 * 1. `document.modelContext` を先に見る / 無ければ `navigator.modelContext`(旧名)
 * 2. 両方在るときは document が勝つ(旧名へ登録しない)
 * 3. 両方無い・`registerTool` が関数でない入口は `null`(登録しにいかない)
 */
import { describe, expect, it } from 'vitest';
import { resolveModelContext } from '@features/agent/webmcp-types';

const fake = (tag: string) => ({ tag, registerTool: () => undefined });

describe('resolveModelContext', () => {
  it('document.modelContext を返す', () => {
    const mc = fake('doc');
    expect(resolveModelContext({ document: { modelContext: mc }, navigator: {} })).toBe(mc);
  });

  it('document に無ければ navigator.modelContext(旧名)を返す', () => {
    const mc = fake('nav');
    expect(resolveModelContext({ document: {}, navigator: { modelContext: mc } })).toBe(mc);
  });

  it('🔴 両方在るときは document が勝つ(対照群:旧名だけのときは旧名が返る ── 上の it)', () => {
    const doc = fake('doc');
    const nav = fake('nav');
    expect(
      resolveModelContext({ document: { modelContext: doc }, navigator: { modelContext: nav } }),
    ).toBe(doc);
  });

  it('どちらも無ければ null(エラーも出さない)', () => {
    expect(resolveModelContext({ document: {}, navigator: {} })).toBeNull();
    expect(resolveModelContext({})).toBeNull();
    expect(resolveModelContext({ document: undefined, navigator: null })).toBeNull();
  });

  it('registerTool が関数でない入口は使わない(名前だけ在る入口に登録しにいかない)', () => {
    expect(resolveModelContext({ document: { modelContext: {} } })).toBeNull();
    expect(resolveModelContext({ document: { modelContext: { registerTool: 1 } } })).toBeNull();
    // document が壊れていて navigator が使えるなら、旧名へ落ちる
    const nav = fake('nav');
    expect(
      resolveModelContext({ document: { modelContext: {} }, navigator: { modelContext: nav } }),
    ).toBe(nav);
  });
});
