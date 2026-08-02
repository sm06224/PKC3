/** @vitest-environment node */
/**
 * ビルド設定の性質を pin する(P7 段①)。
 *
 * ⚠ env は **node**。既定の happy-dom は `URL` を差し替えるので、
 * config 内の `fileURLToPath(new URL(…, import.meta.url))` が
 * 「The URL must be of scheme file」で落ちる ── config を読むだけの test に
 * ブラウザ環境は要らない。
 *
 * 🔴 生成物の 2/3(3.2MB)が sourcemap で、Pages の配信量と SW の precache 量に
 * そのまま乗っていた。`sourcemap: true` の 1 行なので、**戻すのも 1 行**である
 * ── だから test で縛る。
 *
 * ⚠ ここは「config がそう書いてあるか」しか見ない。実際の生成物に map が
 * 無いことは `scripts/check-dist.mjs` が build 後に見る(2 段構え)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

/** env を差してから config を**読み直す**(import 時に評価されるため)。 */
async function loadConfig(kind: string | undefined): Promise<{
  build?: { sourcemap?: boolean | 'inline' | 'hidden' };
}> {
  vi.resetModules();
  const prev = process.env.VITE_PKC_KIND;
  if (kind === undefined) delete process.env.VITE_PKC_KIND;
  else process.env.VITE_PKC_KIND = kind;
  try {
    const mod = (await import('../vite.config')) as { default: unknown };
    return mod.default as { build?: { sourcemap?: boolean } };
  } finally {
    if (prev === undefined) delete process.env.VITE_PKC_KIND;
    else process.env.VITE_PKC_KIND = prev;
  }
}

afterEach(() => {
  vi.resetModules();
});

describe('ビルド設定 — product に map を載せない', () => {
  it('🔴 product では sourcemap を出さない', async () => {
    expect((await loadConfig('product')).build?.sourcemap).toBe(false);
  });

  it('dev では sourcemap を出す(調査手段を失わない)', async () => {
    // ⚠ `/dev/` は product と**同じ commit**を map つきで焼いたもの ──
    // ここが false になると本番の調査手段が丸ごと消える。
    // ⚠ 「同じコード」ではない(`BUILD_KIND` の刻印で entry chunk が変わる)ので、
    // product の trace を dev の map で読み替えることはできない ── 再現は dev 版 URL で
    expect((await loadConfig('dev')).build?.sourcemap).toBe(true);
  });

  it('kind の指定が無いとき(ローカル開発)も sourcemap を出す', async () => {
    expect((await loadConfig(undefined)).build?.sourcemap).toBe(true);
  });
});
