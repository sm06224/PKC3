/** @vitest-environment node */
/**
 * P8 段㉗: **焼く大きさの上限**と、**キャッシュが正しさを道連れにしないこと**。
 *
 * 🔴 実測(headless Chromium。`docs/development/p8-raster-cache-limits-2026-08.md`)
 * ── 直す前の `rasterize` は
 * canvas の大きさを一切 clamp していなかった:
 *
 * | 図(`graph TD` の縦 chain) | dpr | PNG 実寸 | canvas の裏バッファ | 画面での幅 |
 * |---|---|---|---|---|
 * | 120 節 | 3 | 369 × **35,402** px | **49.8 MB** | **123 px** |
 * | 40 節 | 3 | 342 × 11,916 px | 15.5 MB | 114 px |
 *
 * ── **123px 幅で見せる図のために 50MB 確保していた**。`cssWidth` は
 * `min(器幅, 図の実寸)` で頭打ちになるが、**縦横比は頭打ちにならない**。
 * さらに面積上限を越えると `canvas.toBlob` が **null を渡す**ので、その図は
 * その端末で永久に出なくなる(鍵が同じなので再訪しても同じ経路)。
 *
 * ⚠ node / happy-dom に canvas は無いので `rasterize` は呼べない ──
 * **倍率の判定を純関数へ寄せて**、ここで見る(この file の既存の流儀と同じ)。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  MAX_RASTER_DIM,
  MAX_RASTER_PX,
  rasterScale,
  rasterSize,
  shouldTouch,
} from '../../src/adapter/ui/render/mermaid-raster';

/**
 * 焼いたときの実寸。⚠ **実装と同じ関数**を通す ── ここで丸め方を書き写すと
 * 「test 側だけ正しい」になる(実際に踏んだ: 呼び側で round していて
 * 面積が上限を 1,176px 超えた)。
 */
function sized(w: number, h: number, dpr: number): { w: number; h: number; px: number } {
  const r = rasterSize(w, h, dpr);
  return { ...r, px: r.w * r.h };
}

describe('焼く大きさの上限', () => {
  it('⚠ 普通の図は dpr のまま焼く(空振り防止 ── 常に 1 に潰す実装でも下は通る)', () => {
    expect(rasterScale(640, 400, 2)).toBe(2);
    expect(rasterScale(112, 82, 3)).toBe(3);
  });

  /**
   * 🔴 **実測で出た当の形**。120 節の縦 chain(実寸 123 × 11,801)を dpr 3 で。
   * 直す前は 369 × 35,402 = 13.06M px(裏バッファ 49.8MB)になっていた。
   */
  it('🔴 縦に伸びる図 + 高 dpr でも面積の上限を越えない', () => {
    const r = sized(123, 11801, 3);
    expect(r.px, `面積が上限超え: ${r.w}×${r.h}`).toBeLessThanOrEqual(MAX_RASTER_PX);
    // 前提: clamp が無ければ本当に越えていた(= この fixture は上限に触れている)
    expect(123 * 3 * 11801 * 3, 'fixture が上限に触れていない').toBeGreaterThan(MAX_RASTER_PX);
  });

  /**
   * 🔴 **面積の上限が単独で効くこと**を見る(変異試験で判明)。
   * ⚠ 上の縦長 fixture は**辺の上限のほうが先に効く**ので、面積の項を
   * `Infinity` にしても素通りしていた ── 「面積を見ている」という主張を、
   * 辺の上限が代わりに満たしていた(代替物で満たせる条件を置かない)。
   * ここは**辺は余裕・面積だけが効く**大きさにする(実測: 辺 2.73 / 面積 1.00)。
   */
  it('🔴 面積の上限は辺の上限と独立に効く', () => {
    const r = sized(3000, 2800, 3);
    expect(r.px, `面積が上限超え: ${r.w}×${r.h}`).toBeLessThanOrEqual(MAX_RASTER_PX);
    expect(r.w, 'この fixture は辺では止まらないはず').toBeLessThan(MAX_RASTER_DIM);
    expect(r.h, 'この fixture は辺では止まらないはず').toBeLessThan(MAX_RASTER_DIM);
  });

  /**
   * 🔴 **dpr 1 の縦長は縮めない**(段㉗ の再測で足した)。
   * ⚠ 最初は辺の上限を 8,192 にしていて、実測の 120 節の図(123 × 11,801)が
   * dpr 1 でも倍率 0.69 に縮み、**表示幅より小さく焼いて拡大 = ぼける**という
   * 別の壊れ方を作っていた。効かせたいのはメモリで、それは**面積**で決まる ──
   * 辺は「canvas がそもそも作れない」を避ける帯であって画質の数字ではない。
   */
  it('🔴 等倍なら、実測の縦長の図(123 × 11,801)は縮まない', () => {
    expect(rasterScale(123, 11801, 1), 'dpr 1 なのに縮めている').toBe(1);
  });

  /**
   * 🔴 **辺の上限が単独で効くこと**。⚠ 面積の上限のほうは効かない大きさにする
   * (細く長い)── そうしないと「辺を見ている」の主張を面積が代わりに満たす。
   */
  it('🔴 辺の上限は面積の上限と独立に効く(canvas が作れなくなる)', () => {
    const r = sized(40, 60000, 3);
    expect(r.h, '高さが上限超え').toBeLessThanOrEqual(MAX_RASTER_DIM);
    expect(r.w).toBeLessThanOrEqual(MAX_RASTER_DIM);
    // 前提: 面積の項では止まらない(= 辺の項を見ている)
    expect(Math.sqrt(MAX_RASTER_PX / (40 * 60000)), '面積で止まってしまう fixture').toBeGreaterThan(
      MAX_RASTER_DIM / 60000,
    );
  });

  /**
   * 🔴 **横に伸びる図でも辺の上限が効く**(変異試験で判明 ── `MAX_RASTER_DIM / w`
   * を落としても、それまでの fixture は縦か面積のほうが先に効くので素通りしていた)。
   * ⚠ いまの呼び側では `cssWidth ≤ 器の幅` なので横で詰まるのは稀だが、
   * **辺の上限は縦横で対称に効くべき**である ── 片側だけ守るのは、
   * 「どちらが効いたか」を読む人に嘘をつく。
   */
  it('🔴 横に伸びる図でも辺の上限が効く', () => {
    const r = sized(50000, 100, 1);
    expect(r.w, '幅が上限超え').toBeLessThanOrEqual(MAX_RASTER_DIM);
    // 前提: 面積でも高さでも止まらない(= 幅の項を見ている)
    expect(Math.sqrt(MAX_RASTER_PX / (50000 * 100))).toBeGreaterThan(MAX_RASTER_DIM / 50000);
    expect(MAX_RASTER_DIM / 100).toBeGreaterThan(MAX_RASTER_DIM / 50000);
  });

  it('🔴 極端な図では**等倍すら許さない**(倍率が 1 を下回る)', () => {
    expect(rasterScale(4000, 40000, 1)).toBeLessThan(1);
  });

  /**
   * 🔴 **上限は「どの大きさでも」越えない**(変異試験で判明)。
   *
   * ⚠ 個別の fixture だけだと**片側の丸め**を見逃す ── `Math.floor` を
   * `Math.round` に変えても、余裕のある fixture では 1px 増えるだけで
   * 上限に届かず素通りした(両辺を同時に変えたときだけ落ちた)。
   * 上限は**不変条件**なので、fixture ではなく**掃く**ことで守る。
   * ⚠ 乱数は使わない(再現性)── 決定的な列で掃く。
   */
  it('🔴 どの大きさでも上限を越えない(掃いて確かめる)', () => {
    let s = 12345;
    const rnd = (n: number): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return (s % n) + 1;
    };
    let worstPx = 0;
    for (let i = 0; i < 3000; i++) {
      const w = rnd(6000);
      const h = rnd(60000);
      const dpr = [1, 1.5, 2, 3][i % 4]!;
      const r = sized(w, h, dpr);
      worstPx = Math.max(worstPx, r.w * r.h);
      expect(r.w * r.h, `面積が上限超え: ${w}×${h} @${dpr} → ${r.w}×${r.h}`).toBeLessThanOrEqual(
        MAX_RASTER_PX,
      );
      expect(r.w, `幅が上限超え: ${w}×${h} @${dpr}`).toBeLessThanOrEqual(MAX_RASTER_DIM);
      expect(r.h, `高さが上限超え: ${w}×${h} @${dpr}`).toBeLessThanOrEqual(MAX_RASTER_DIM);
    }
    // 前提: 掃いた中に**上限すれすれ**が居た(居なければ何も試していない)
    expect(worstPx, '上限に近づく大きさを 1 つも掃いていない').toBeGreaterThan(MAX_RASTER_PX * 0.99);
  });

  it('⚠ 0 / 負 / NaN でも壊れない(1 枚も焼けなくならない)', () => {
    for (const [w, h, d] of [
      [0, 0, 1],
      [-5, -5, 2],
      [640, 400, 0],
      [640, 400, Number.NaN],
    ] as const) {
      const s = rasterScale(w, h, d);
      expect(Number.isFinite(s), `倍率が数でない: ${w},${h},${d}`).toBe(true);
      expect(s).toBeGreaterThan(0);
    }
  });
});

describe('最後に使った時刻の書き直し', () => {
  /**
   * 🔴 直す前は cache hit のたびに行ごと `put` していた ── 時刻 1 個のために
   * PNG 全体(平均 181KB / 大きい図は 1MB 級)を書き戻していた。
   */
  it('🔴 直後にもう一度使っても書き直さない(書込増幅を作らない)', () => {
    const now = 1_000_000_000_000;
    expect(shouldTouch(now - 1000, now)).toBe(false);
  });

  it('⚠ 十分に間が空いたら書き直す(空振り防止 ── 常に false の実装を落とす)', () => {
    const now = 1_000_000_000_000;
    expect(shouldTouch(now - 60 * 60 * 1000, now)).toBe(true);
  });

  /**
   * ⚠ 壊れた行は**書き直す側**に倒す ── 放置すると、その行が永久に
   * 「最近使った」ままになって追い出されない(上限が実効的に効かなくなる)。
   */
  it('🔴 時刻が壊れている行は書き直す(追い出せない行を作らない)', () => {
    const now = 1_000_000_000_000;
    expect(shouldTouch(undefined, now), 'undefined を素通ししている').toBe(true);
    expect(shouldTouch('x', now)).toBe(true);
    expect(shouldTouch(Number.NaN, now)).toBe(true);
    expect(shouldTouch(now + 10 * 60 * 1000, now), '未来の時刻を素通ししている').toBe(true);
  });
});

describe('キャッシュは正しさを道連れにしない', () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * ⚠ **module ごと読み直す**。`db()` は `dbPromise ??= …` で memo するので、
   * 同じ module を使い回すと 2 件目以降は 1 件目の memo(= 既に null)を
   * 拾ってしまい、**実装が何であっても通る**(空振り)。
   */
  const fresh = async (): Promise<typeof import('../../src/adapter/ui/render/mermaid-raster')> => {
    vi.resetModules();
    return import('../../src/adapter/ui/render/mermaid-raster');
  };

  /**
   * 🔴 直す前は `tx(await db(), …).catch(…)` と書いていた ── `await db()` は
   * **引数の位置**なので後ろの `.catch()` が掛からず、IDB を開けない環境では
   * `renderToPng` ごと reject し、**mermaid の描画を一度も試さないまま**
   * 全部の図が原文のまま残った。さらに `dbPromise ??= openDb()` が reject 済みの
   * promise を保持するので、一度失敗するとその session では回復しなかった。
   *
   * ⚠ 観測点は「例外が出ないこと」ではなく「**fallback が返ること**」
   * ── 例外だけ見ると、握り潰して undefined を返す実装でも通る。
   */
  it('🔴 IDB を開けなくても reject せず fallback を返す', async () => {
    let opened = 0;
    vi.stubGlobal('indexedDB', {
      open: () => {
        opened += 1;
        const req: Record<string, unknown> = {
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null,
        };
        queueMicrotask(() => (req['onerror'] as (() => void) | null)?.());
        return req;
      },
    });
    const m = await fresh();
    await expect(m.withCache(async () => 'つかえた', 'つかえない')).resolves.toBe('つかえない');
    // 前提: open を本当に試していた(= 失敗の状況を再現できている)
    expect(opened, 'open を 1 度も試していない').toBeGreaterThan(0);
  });

  /**
   * 🔴 **失敗を memo しない**(変異試験で判明)。`dbPromise ??= openDb()` のままだと
   * reject 済みの promise を抱え込み、**一度失敗したらその session では二度と
   * 開き直さない** ── 他タブの version change 待ちのような一時的な失敗でも、
   * 以後ずっとキャッシュ無しで動き続ける。
   * ⚠ 観測点は「1 度目が fallback になること」ではなく「**2 度目が通ること**」。
   */
  it('🔴 一度失敗しても、次の機会には開き直す', async () => {
    let attempt = 0;
    vi.stubGlobal('indexedDB', {
      open: () => {
        attempt += 1;
        const ok = attempt > 1;
        const req: Record<string, unknown> = {
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null,
          result: { objectStoreNames: { contains: () => true } },
        };
        queueMicrotask(() =>
          ((ok ? req['onsuccess'] : req['onerror']) as (() => void) | null)?.(),
        );
        return req;
      },
    });
    const m = await fresh();
    await expect(m.withCache(async () => 'ひらけた', 'だめ')).resolves.toBe('だめ');
    await expect(
      m.withCache(async () => 'ひらけた', 'だめ'),
      '失敗を memo していて開き直さない',
    ).resolves.toBe('ひらけた');
    expect(attempt, 'open を 2 度試していない').toBe(2);
  });

  it('🔴 `indexedDB` がそもそも無くても reject しない', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const m = await fresh();
    await expect(m.withCache(async () => 1, 0)).resolves.toBe(0);
    // 掃除口も追い出しも、開けないときは黙って何もしない(呼び側を壊さない)
    await expect(m.clearDiagramCache()).resolves.toBeUndefined();
    await expect(m.evictDiagramCache()).resolves.toBe(0);
  });

  it('🔴 中の処理が投げても fallback を返す(呼び側の描画を止めない)', async () => {
    // ⚠ 開ける状態にしておく ── 開けないと `run` に届かず、
    //   「中で投げても平気」を**確かめずに**通ってしまう
    vi.stubGlobal('indexedDB', {
      open: () => {
        const req: Record<string, unknown> = {
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null,
          result: { objectStoreNames: { contains: () => true } },
        };
        queueMicrotask(() => (req['onsuccess'] as (() => void) | null)?.());
        return req;
      },
    });
    const m = await fresh();
    let reached = false;
    await expect(
      m.withCache(() => {
        reached = true;
        throw new Error('こわれた');
      }, 'ふぉーるばっく'),
    ).resolves.toBe('ふぉーるばっく');
    expect(reached, '中の処理まで届いていない(この test は何も見ていない)').toBe(true);
  });
});
