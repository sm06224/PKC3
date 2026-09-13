/** @vitest-environment node */
/**
 * 図案の符号位置を上流と突き合わせる `--check`(#849、2026-09-13)。
 *
 * ⚠ ここまでは焼くとき(`npm run icons:font`。手で回す・CI では回さない)にしか
 * 突き合わせていなかった ── 上流が符号位置を動かしても、焼き直すまで気づけない。
 * `--check` はその突き合わせだけを取り出し、夜(nightly)から回す。
 *
 * 🔴 **`build-icon-font.mjs` は元々 CLI 実行を前提にした script で、import した
 * だけで①外の網へ取りに行き ②`writeFileSync` で書体と CSS を書き換えていた。**
 * この test から安全に呼べるように、実行を
 * `fileURLToPath(import.meta.url) === process.argv[1]` の guard で包み直した ──
 * その guard 自体が壊れていないかも、ここで見る(下の 1 本目)。
 */
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- ビルド対象外の CI script(素の .mjs)
import { tableOf, diffAgainstUpstream, runCheck } from '../scripts/build-icon-font.mjs';
import { PKC_SYMBOLS } from '../src/features/icon/symbols';

/**
 * ⚠ **query を付けて読み直す**(module cache を外す。`tests/adapter/asset-worker.test.ts`
 * と同じ手法)。変数経由にするのは、Vite の dynamic import 解析が
 * `${変数}?suffix` のような**静的な変数 + 定数の suffix**しか読めないためである
 * (`Date.now()` のような完全に動的な式は "Unknown variable dynamic import" で落ちる)。
 */
const SCRIPT = '../scripts/build-icon-font.mjs';

describe('build-icon-font.mjs の import 安全性(#849)', () => {
  it('🔴 import しただけでは網を叩かない(CLI guard が壊れたら、ここで検出する)', async () => {
    const calls: unknown[] = [];
    const stub = (async (...args: unknown[]) => {
      calls.push(args[0]);
      throw new Error('この import 経路では叩かないはず');
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', stub);
    try {
      // 上の静的 import で 1 度読まれた後だと、node の module cache に乗って
      // **再実行されない**ので、query を変えて読み直す(guard が壊れていても
      // これをしないと検出できなくなる)。
      await import(`${SCRIPT}?guard-check`);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls, 'import しただけで fetch が呼ばれた ── CLI guard が外れている').toEqual([]);
  });
});

describe('tableOf() ── symbols.ts から表を読む(#849)', () => {
  it('🔴 実物の PKC_SYMBOLS と、件数・中身が一致する(正規表現の読み落としを検める)', () => {
    const rows = tableOf() as Array<{ icon: string; cp: number }>;
    // 空振り防止 ── 1 件も読めていない状態で「一致した」と言わない
    expect(rows.length, 'symbols.ts から 1 件も読めていない').toBeGreaterThan(10);
    const want = Object.values(PKC_SYMBOLS) as Array<{ icon: string; cp: number }>;
    expect(rows.length, 'tableOf() が読んだ件数が PKC_SYMBOLS と食い違う').toBe(want.length);
    const got = new Map(rows.map((r) => [r.icon, r.cp]));
    for (const w of want) {
      expect(got.has(w.icon), `${w.icon} を tableOf() が読み落としている`).toBe(true);
      expect(got.get(w.icon), `${w.icon} の符号位置が PKC_SYMBOLS と食い違う`).toBe(w.cp);
    }
  });
});

describe('diffAgainstUpstream() ── 集合で突き合わせる(#849)', () => {
  it('一致していれば空(緑)', () => {
    const rows = [{ icon: 'print', cp: 0xe8ad }];
    const upstream = new Map([['print', 0xe8ad]]);
    expect(diffAgainstUpstream(rows, upstream)).toEqual([]);
  });

  it('🔴 上流で符号位置が動いていたら、両方の値を含めて 1 件挙げる', () => {
    const rows = [{ icon: 'print', cp: 0xe8ad }];
    const upstream = new Map([['print', 0x1234]]);
    const offenders = diffAgainstUpstream(rows, upstream);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain('e8ad');
    expect(offenders[0]).toContain('1234');
  });

  it('🔴 上流にその名前が無い(消えた / こちらにしか無い)場合も 1 件挙げる', () => {
    const rows = [{ icon: 'no_such_icon', cp: 0xe8ad }];
    const upstream = new Map([['print', 0xe8ad]]);
    const offenders = diffAgainstUpstream(rows, upstream);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain('no_such_icon');
  });

  it('🔴 件数だけの比較では通ってしまう取り違えを、集合で見分ける', () => {
    // ⚠ CLAUDE.md §8「入力を守る検査は集合で突き合わせる ── 件数ではなく」の
    //   実地検証。rows と upstream は**同じ件数**だが中身が入れ替わっている。
    const rows = [
      { icon: 'a', cp: 1 },
      { icon: 'b', cp: 2 },
    ];
    const upstream = new Map([
      ['a', 2],
      ['b', 1],
    ]);
    expect(rows.length).toBe(upstream.size); // 件数は合っている
    expect(diffAgainstUpstream(rows, upstream)).toHaveLength(2); // が、両方とも食い違う
  });

  it('🔴 複数の絵が同時に食い違っていても、全件を挙げる(先頭で打ち切らない)', () => {
    const rows = [
      { icon: 'a', cp: 1 },
      { icon: 'b', cp: 2 },
      { icon: 'c', cp: 3 },
    ];
    const upstream = new Map([
      ['a', 1], // 一致
      ['b', 99], // 食い違い
      // 'c' は上流に無い
    ]);
    const offenders = diffAgainstUpstream(rows, upstream);
    expect(offenders).toHaveLength(2);
    expect(offenders.join('\n')).toContain('b');
    expect(offenders.join('\n')).toContain('c');
    expect(offenders.join('\n')).not.toContain('a:');
  });
});

/**
 * `runCheck()` の 3 通りの終わり方(CLAUDE.md §4「判定不能と結果を混ぜない」)。
 *
 * ⚠ 実物の網へは行かない ── `globalThis.fetch` を差し替えて、
 *   ①一致 ②食い違い ③取得できない の 3 通りを**決定的に**再現する。
 * ⚠ `process.exit` は実プロセスを終わらせてしまうので、投げる形に差し替えて
 *   `runCheck()` の Promise が reject することで代用する。
 */
describe('runCheck() ── 3 通りの終わり方(#849)', () => {
  /** テスト中に投げる印。実際の exit code を運ぶ。 */
  class FakeExit extends Error {
    constructor(public code: number | undefined) {
      super(`process.exit(${code})`);
    }
  }

  function withFakeFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new FakeExit(code);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', impl);
    return run().finally(() => {
      exitSpy.mockRestore();
      errSpy.mockRestore();
      logSpy.mockRestore();
      vi.unstubAllGlobals();
    });
  }

  /** 実物の `PKC_SYMBOLS` を、そのまま「上流の答え」として返す偽 fetch(= 一致)。 */
  function fakeUpstreamMatchingReality(): typeof fetch {
    const text = (tableOf() as Array<{ icon: string; cp: number }>)
      .map((r) => `${r.icon} ${r.cp.toString(16)}`)
      .join('\n');
    return (async () => ({ ok: true, status: 200, text: async () => text })) as unknown as typeof fetch;
  }

  it('🟢 一致 → process.exit を呼ばずに終わる(緑)', async () => {
    await withFakeFetch(fakeUpstreamMatchingReality(), () => runCheck());
    // ⚠ 上の withFakeFetch が reject せずに解決すること自体が主張である
    //   (exit が呼ばれていたら FakeExit が投げられ、この it は落ちる)
  });

  it('🔴 食い違い → exit(1) で終わる(赤。上流が空 = 全件が「無い」判定になる)', async () => {
    const emptyUpstream = (async () => ({
      ok: true,
      status: 200,
      text: async () => '',
    })) as unknown as typeof fetch;
    await expect(withFakeFetch(emptyUpstream, () => runCheck())).rejects.toMatchObject({
      code: 1,
    });
  });

  it('🔴 上流を取得できない → exit(2) で終わる(赤ではなく「測れなかった」)', async () => {
    const brokenFetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(withFakeFetch(brokenFetch, () => runCheck())).rejects.toMatchObject({
      code: 2,
    });
  });
});
