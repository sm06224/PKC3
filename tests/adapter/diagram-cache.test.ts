/** @vitest-environment node */
/**
 * P8 段⑰: 図の PNG キャッシュに**上限と追い出し**を置く(レビュー H-6)。
 *
 * 🔴 直す前は上限も追い出しも無く、唯一の掃除口(`clearDiagramCache`)は
 * **呼び出し元が 0 件**だった。鍵は 図の原文 + テーマ + 幅 + dpr なので、
 * 編集プレビューで図を打つと**静穏 tick ごとに「途中の原文」が別鍵**になり、
 * そのすべてが永久に残る。ノートを消しても対応する PNG は残っていた。
 * 同一 origin を食い潰すと添付(`pkc3-assets`)と OPFS の sqlite も道連れになる。
 *
 * ⚠ 既存の unit は `renderToPng` を丸ごと mock していたので、**IDB への put が
 * 1 度も走らず**、この次元は無検査だった。
 * ⚠ happy-dom / node に `indexedDB` は無いので、**判定を純関数へ寄せて**ここで見る
 * (依存を増やさない)。IDB を実際に舐める端は
 * `tests/smoke/mermaid.smoke.spec.ts` が実ブラウザで見る。
 */
import { describe, expect, it } from 'vitest';
import {
  cacheKey,
  DIAGRAM_CACHE_MAX_BYTES,
  planEviction,
  type DiagramPalette,
} from '../../src/adapter/ui/render/mermaid-raster';

const PALETTE: DiagramPalette = {
  bg: '#fff',
  alt: '#eee',
  fg: '#000',
  line: '#666',
  border: '#ccc',
  accent: '#080',
  dark: false,
};

describe('鍵の作り方', () => {
  const base = { source: 'graph TD\n A-->B', theme: 'light', palette: PALETTE, width: 640, dpr: 1 };

  /**
   * 🔴 4 次元それぞれを**1 つだけ**変えたら鍵が変わる(レビュー M)。
   * 直す前は `cacheKey` に test が 1 件も無く、幅や dpr を鍵から落としても
   * 誰も気づかなかった ── 落とすと「テーマを変えたのに前の色のまま」
   * 「Retina でボケる」が静かに戻る。
   */
  it('🔴 原文 / テーマ / 幅 / dpr のどれを変えても別の鍵になる', () => {
    const k = cacheKey(base);
    expect(cacheKey({ ...base, source: 'graph TD\n A-->C' })).not.toBe(k);
    expect(cacheKey({ ...base, theme: 'dark' })).not.toBe(k);
    expect(cacheKey({ ...base, width: 656 })).not.toBe(k);
    expect(cacheKey({ ...base, dpr: 2 })).not.toBe(k);
    // ⚠ 同じ 4 次元なら同じ鍵(色の実体は鍵に混ぜない ── テーマ名で足りる)
    expect(cacheKey({ ...base, palette: { ...PALETTE, fg: '#111' } })).toBe(k);
  });
});

describe('上限と追い出し', () => {
  const rows = (n: number, size = 10_000): Array<{ key: string; at: number; size: number }> =>
    Array.from({ length: n }, (_, i) => ({ key: `k${i}`, at: 1000 + i, size }));

  it('🔴 上限を超えたら**古い順に**落ちる', () => {
    // 10 件 × 10KB = 100KB。上限 50KB なら 40KB(= 上限の 80%)まで落とす
    const drop = planEviction(rows(10), 50_000);
    expect(drop.length, '1 件も落ちていない').toBeGreaterThan(0);
    // ⚠ **古いものから**(`k0` が残って `k9` が消えたら順が逆)
    expect(drop, '新しいものから落としている').toContain('k0');
    expect(drop).not.toContain('k9');
    const left = 10 - drop.length;
    expect(left * 10_000, '上限まで落ちていない').toBeLessThanOrEqual(50_000 * 0.8);
  });

  it('⚠ 上限内なら 1 件も落とさない(よく使う図を毎回焼き直させない)', () => {
    expect(planEviction(rows(3), 50_000)).toEqual([]);
    // ちょうど上限も落とさない(境界で毎回全消しにしない)
    expect(planEviction(rows(5), 50_000)).toEqual([]);
  });

  it('⚠ 大きい 1 枚が居ても、落とす順は**時刻**で決まる(大きさで選ばない)', () => {
    const items = [
      { key: 'old-small', at: 1, size: 1_000 },
      { key: 'new-huge', at: 9, size: 90_000 },
      { key: 'mid', at: 5, size: 20_000 },
    ];
    const drop = planEviction(items, 50_000);
    expect(drop[0], '大きさで選んでいる').toBe('old-small');
  });

  it('⚠ 既定の上限が置かれている(無制限に戻していない)', () => {
    expect(DIAGRAM_CACHE_MAX_BYTES).toBeGreaterThan(0);
    expect(DIAGRAM_CACHE_MAX_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});
