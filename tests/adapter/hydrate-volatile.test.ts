/** @vitest-environment happy-dom */
/**
 * 編集プレビューの図(途中の原文)は `volatile` で焼く(#1087)。
 * 静穏 tick ごとに増える途中の絵を最古扱いでキャッシュへ置き、他のノートの図を押し出さない。
 * ここでは「器を埋める口が、鍵へ `volatile` を渡す / 渡さない」を見る(置き方は diagram-cache-idb.test.ts)。
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateDiagrams, type DiagramKind } from '../../src/adapter/ui/render/mermaid-hydrate';
import type { RasterKey } from '../../src/adapter/ui/render/mermaid-raster';

describe('hydrate が鍵へ volatile を渡す', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private readonly cb: (e: unknown[]) => void) {}
        observe(el: Element): void {
          this.cb([{ isIntersecting: true, target: el }]);
        }
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function keysFor(opts?: { volatile?: boolean }): Promise<RasterKey[]> {
    const keys: RasterKey[] = [];
    const kind: DiagramKind = {
      attr: 'data-pkc-x-src',
      name: 'x',
      imgField: 'x-image',
      alt: () => 'x',
      render: async (key) => {
        keys.push(key);
        return { png: new Blob([new Uint8Array(3)]), cssWidth: 100 };
      },
      savable: false,
    };
    const host = document.createElement('div');
    host.setAttribute('data-pkc-x-src', 'src');
    document.body.append(host);
    const scope = hydrateDiagrams([host], kind, opts);
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
    scope.dispose();
    return keys;
  }

  it('🔴 volatile を立てた口は、鍵に volatile: true を渡す', async () => {
    const keys = await keysFor({ volatile: true });
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0]!.volatile).toBe(true);
  });

  it('対照群: 立てない口(読む面)は volatile を渡さない', async () => {
    const keys = await keysFor();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0]!.volatile).toBeUndefined();
  });

  /**
   * 編集プレビューの口(detail.ts)が volatile を立てていること。
   * ⚠ 原文の字面を見る弱い pin ── 面の組み立て(RowSwap + 本文の面)は重く、unit では通せない。
   *   注釈を落として、実行する行だけを見る。
   */
  it('編集プレビューの hydrateFigures 呼びは volatile を立てている', () => {
    const src = readFileSync('src/adapter/ui/render/detail.ts', 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    expect(src).toContain('hydrateFigures(r.inserted, { volatile: true })');
  });
});
