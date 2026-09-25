/** @vitest-environment node */
/**
 * 図案の書体の焼き script(#1054 段①、2026-09-25 に Phosphor Duotone へ全面書き換え)。
 *
 * ⚠ **いまは完全にオフライン**(devDependency `@phosphor-icons/web` を
 * `node_modules` から読むだけ)。#849 の設計(`--check` を夜(nightly)から回す)は
 * 継承するが、判定の中身は「上流 URL と符号位置を突き合わせる」ではなく
 * 「**Phosphor Duotone に、その名前が実在するか**」に変わった(符号位置は
 * こちら側で remap するので、上流の値そのものは内部表現に残らない)。
 *
 * 🔴 **`build-icon-font.mjs` は元々 CLI 実行を前提にした script で、import した
 * だけで①`node_modules` の Phosphor 一式を読み ②`spawnSync` で python を叩き
 * ③`writeFileSync` で書体と CSS を書き換えていた。**
 * この test から安全に呼べるように、実行を
 * `fileURLToPath(import.meta.url) === process.argv[1]` の guard で包み直した ──
 * その guard 自体が壊れていないかも、ここで見る(下の 1 本目)。
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error -- ビルド対象外の CI script(素の .mjs)
import { tableOf, phosphorDuotoneTable, missingFromPhosphor, planCodepoints, runCheck } from '../scripts/build-icon-font.mjs';
import { PKC_SYMBOLS } from '../src/features/icon/symbols';

/**
 * ⚠ **query を付けて読み直す**(module cache を外す。`tests/adapter/asset-worker.test.ts`
 * と同じ手法)。変数経由にするのは、Vite の dynamic import 解析が
 * `${変数}?suffix` のような**静的な変数 + 定数の suffix**しか読めないためである
 * (`Date.now()` のような完全に動的な式は "Unknown variable dynamic import" で落ちる)。
 */
const SCRIPT = '../scripts/build-icon-font.mjs';

describe('build-icon-font.mjs の import 安全性', () => {
  /**
   * 🔴 **危ない副作用を 2 つとも見張る**(#1054 段①)。
   * ⚠ 直す前(Material Symbols)は `fetch` だけ見ていれば足りたが、いまは
   * ①`node_modules` を読む(`readFileSync` は害が無いので見ない)
   * ②`child_process.spawnSync` で python を叩く ③`writeFileSync` で書き換える
   * ── **①以外の副作用がゼロであること**を見る。
   */
  it('🔴 import しただけでは焼かない(CLI guard が壊れたら、ここで検出する)', async () => {
    const spawnCalls: unknown[] = [];
    const writeCalls: unknown[] = [];
    vi.doMock('node:child_process', () => ({
      spawnSync: (...args: unknown[]) => {
        spawnCalls.push(args);
        throw new Error('この import 経路では叩かないはず');
      },
    }));
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        writeFileSync: (...args: unknown[]) => {
          writeCalls.push(args);
          throw new Error('この import 経路では書かないはず');
        },
      };
    });
    try {
      // 上の静的 import で 1 度読まれた後だと、node の module cache に乗って
      // **再実行されない**ので、query を変えて読み直す(guard が壊れていても
      // これをしないと検出できなくなる)。
      await import(`${SCRIPT}?guard-check`);
    } finally {
      vi.doUnmock('node:child_process');
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
    expect(spawnCalls, 'import しただけで python を叩いた ── CLI guard が外れている').toEqual([]);
    expect(writeCalls, 'import しただけで書き込んだ ── CLI guard が外れている').toEqual([]);
  });
});

describe('tableOf() ── symbols.ts から表を読む', () => {
  it('🔴 実物の PKC_SYMBOLS と、件数・中身が一致する(正規表現の読み落としを検める)', () => {
    const rows = tableOf() as Array<{ key: string; icon: string; tone: string }>;
    // 空振り防止 ── 1 件も読めていない状態で「一致した」と言わない
    expect(rows.length, 'symbols.ts から 1 件も読めていない').toBeGreaterThan(10);
    const want = Object.entries(PKC_SYMBOLS);
    expect(rows.length, 'tableOf() が読んだ件数が PKC_SYMBOLS と食い違う').toBe(want.length);
    const got = new Map(rows.map((r) => [r.key, r]));
    for (const [key, w] of want) {
      expect(got.has(key), `${key} を tableOf() が読み落としている`).toBe(true);
      expect(got.get(key)!.icon, `${key} の絵の名前が PKC_SYMBOLS と食い違う`).toBe(w.icon);
      expect(got.get(key)!.tone, `${key} の tone が PKC_SYMBOLS と食い違う`).toBe(w.tone);
    }
  });

  /** ⚠ 並び順も表として意味を持つ(`planCodepoints` が並び順から符号位置を割る)。 */
  it('並び順が PKC_SYMBOLS のキー順と一致する', () => {
    const rows = tableOf() as Array<{ key: string }>;
    expect(rows.map((r) => r.key)).toEqual(Object.keys(PKC_SYMBOLS));
  });
});

describe('phosphorDuotoneTable() ── style.css から下地・線の符号位置を読む', () => {
  const SAMPLE = `
.ph-duotone.ph-gear:before {
  content: "\\e270";
  opacity: 0.2;
}
.ph-duotone.ph-gear:after {
  content: "\\e271";
  margin-left: -1em;
}
.ph-duotone.ph-cell-signal-none:before {
  content: "\\e14a";
  color: #444;
}
`;

  it('下地・線が両方在る名前だけ拾う', () => {
    const got = phosphorDuotoneTable(SAMPLE);
    expect(got.get('gear')).toEqual({ before: 0xe270, after: 0xe271 });
  });

  it('🔴 `:after` を持たない名前(実物: cell-signal-none / wifi-none)は拾わない', () => {
    const got = phosphorDuotoneTable(SAMPLE);
    expect(got.has('cell-signal-none'), '片方しか無いのに拾っている').toBe(false);
  });

  /** ⚠ 実物の Phosphor Duotone の style.css で、いま使う名前が全部読めることを見る */
  it('🔴 実物の node_modules から、PKC_SYMBOLS の全 icon 名を読める', () => {
    const cssText = readFileSync(
      'node_modules/@phosphor-icons/web/src/duotone/style.css',
      'utf8',
    );
    const got = phosphorDuotoneTable(cssText);
    // 空振り防止
    expect(got.size, '実物の style.css から 1 件も読めていない').toBeGreaterThan(100);
    for (const { icon, key } of Object.entries(PKC_SYMBOLS).map(([key, v]) => ({ key, ...v }))) {
      expect(got.has(icon), `${key}(${icon})が Phosphor Duotone に無い`).toBe(true);
    }
  });
});

describe('missingFromPhosphor() ── 集合で突き合わせる', () => {
  it('一致していれば空(緑)', () => {
    const rows = [{ key: 'a', icon: 'gear', tone: 'system' }];
    const phosphor = new Map([['gear', { before: 1, after: 2 }]]);
    expect(missingFromPhosphor(rows, phosphor)).toEqual([]);
  });

  it('🔴 上流にその名前が無ければ 1 件挙げる', () => {
    const rows = [{ key: 'a', icon: 'no_such_icon', tone: 'system' }];
    const phosphor = new Map([['gear', { before: 1, after: 2 }]]);
    const offenders = missingFromPhosphor(rows, phosphor);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain('no_such_icon');
  });

  it('🔴 複数が同時に食い違っていても、全件を挙げる(先頭で打ち切らない)', () => {
    const rows = [
      { key: 'a', icon: 'gear', tone: 'system' },
      { key: 'b', icon: 'missing-1', tone: 'system' },
      { key: 'c', icon: 'missing-2', tone: 'system' },
    ];
    const phosphor = new Map([['gear', { before: 1, after: 2 }]]);
    const offenders = missingFromPhosphor(rows, phosphor);
    expect(offenders).toHaveLength(2);
    expect(offenders.join('\n')).toContain('missing-1');
    expect(offenders.join('\n')).toContain('missing-2');
  });
});

describe('planCodepoints() ── 並び順から私用領域を機械的に割る', () => {
  it('先頭から 0xE000 起点で 2 個ずつ割る(決定的)', () => {
    const rows = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
    const got = planCodepoints(rows);
    expect(got.get('a')).toEqual({ underlay: 0xe000, line: 0xe001 });
    expect(got.get('b')).toEqual({ underlay: 0xe002, line: 0xe003 });
    expect(got.get('c')).toEqual({ underlay: 0xe004, line: 0xe005 });
  });

  it('🔴 同じ表なら 2 回呼んでも同じ値(決定的 ── 手違いで乱数が混ざっていないか)', () => {
    const rows = [{ key: 'x' }, { key: 'y' }];
    expect(planCodepoints(rows)).toEqual(planCodepoints(rows));
  });

  it('私用領域(0xE000–0xF8FF)を使い切ったら例外を投げる', () => {
    // ⚠ ちょうど 3200 件(0xE000..0xF8FF を 2 個ずつ)は収まる境界値 ── 1 件増やして超えさせる
    const fits = Array.from({ length: 3200 }, (_, i) => ({ key: `k${i}` }));
    expect(() => planCodepoints(fits), '境界ちょうど(3200 件)は収まるはず').not.toThrow();
    const overflow = Array.from({ length: 3201 }, (_, i) => ({ key: `k${i}` }));
    expect(() => planCodepoints(overflow)).toThrow();
  });
});

/**
 * `runCheck()` の 3 通りの終わり方(CLAUDE.md §4「判定不能と結果を混ぜない」)。
 *
 * 🔑 **`vi.doMock('node:fs', …)` + 読み直し**(上の「import 安全性」と同じ手法)で
 * `readFileSync` だけを差し替える ── ①一致(実物のまま、mock 無し)
 * ②上流に無い名前(`duotone/style.css` だけ空文字を返す)③ 取得できない
 * (`duotone/style.css` だけ ENOENT を投げる = パッケージ未インストールを模す)。
 * ⚠ **module cache に乗るので、シナリオごとに query を変えて読み直す**。
 */
describe('runCheck() ── 3 通りの終わり方', () => {
  /** テスト中に投げる印。実際の exit code を運ぶ。 */
  class FakeExit extends Error {
    constructor(public code: number | undefined) {
      super(`process.exit(${code})`);
    }
  }

  function withFakeExit<T>(run: () => T): T {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new FakeExit(code);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      return run();
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  }

  it('🟢 一致(実物の node_modules)→ process.exit を呼ばずに終わる(緑)', () => {
    withFakeExit(() => runCheck());
    // ⚠ 上の withFakeExit が投げずに戻ること自体が主張である
  });

  it('🔴 食い違い(空の style.css)→ exit(1) で終わる(赤)', async () => {
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        readFileSync: (path: unknown, ...rest: unknown[]) => {
          if (typeof path === 'string' && path.endsWith('duotone/style.css')) return '';
          return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
        },
      };
    });
    try {
      const mod = await import(`${SCRIPT}?check-empty`);
      let code: number | undefined;
      try {
        withFakeExit(() => mod.runCheck());
      } catch (e) {
        code = (e as FakeExit).code;
      }
      expect(code, '食い違いなのに exit(1) で止まっていない').toBe(1);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('🔴 上流を取得できない(実体が無い)→ exit(2) で終わる(赤ではなく「測れなかった」)', async () => {
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        readFileSync: (path: unknown, ...rest: unknown[]) => {
          if (typeof path === 'string' && path.endsWith('duotone/style.css')) {
            throw new Error('ENOENT: no such file');
          }
          return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
        },
      };
    });
    try {
      const mod = await import(`${SCRIPT}?check-missing`);
      let code: number | undefined;
      try {
        withFakeExit(() => mod.runCheck());
      } catch (e) {
        code = (e as FakeExit).code;
      }
      expect(code, '測れなかったのに exit(2) で止まっていない').toBe(2);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

/**
 * 🔴 **決定性の source pin**(#1054 段①-2、2026-09-25)。
 *
 * ⚠ `scripts/subset-duotone.py` の docstring 自身が実測を記録している ──
 *   「`TTFont(..., recalcTimestamp: false)` を要る ── `Options.recalc_timestamp`
 *   だけでは `head.modified` が焼き直すたびにずれた」。**2 つは別物**で、
 *   片方だけでは非決定的な bytes に戻る(=同じ表を焼き直すたびに woff2 が
 *   1 バイトも変わらない、という保証が崩れる)。
 * 🔑 この test は**両方が実装に残っていること**を pin する ── どちらか片方を
 *   消す変異(リファクタで「同じ意味に見える」片方を削る、等)を捕まえる。
 * ⚠ Python を実際に 2 回走らせて bytes が一致することまでは見ない(重い ──
 *   `npm run icons:font` を焼き直すたびに手元で確かめれば足りる)。ここは
 *   **消し忘れ・削り忘れではなく、意図して消したときに気づける**網である。
 */
describe('subset-duotone.py の決定性(source pin)', () => {
  const RAW = readFileSync('scripts/subset-duotone.py', 'utf8');
  /**
   * 🔴 **モジュールの docstring(先頭の `"""…"""`)を先に落とす**(CLAUDE.md
   *   §1「自分の解説コメントに満たされる」)── この file の docstring 自身が
   *   「`TTFont(..., recalcTimestamp=False)` を要る」と**解説として書いている**
   *   ので、落とさずに正規表現を当てると**実装を消してもこの一致で常に緑**になる
   *   (実際に `font = TTFont(src)` へ変異させて確認 ── SURVIVED だった)。
   *   `#` の行コメントは対象にしていない(この file に該当する行コメントが無い)。
   */
  // ⚠ **`^` で先頭に固定しない** ── 1 行目が shebang(`#!/usr/bin/env python3`)
  //   なので、docstring は先頭ではなく 2 行目から始まる。1 稿目は `^"""` と
  //   書いたため**一致 0 件で置換が丸ごと no-op**になり、下の 2 本とも
  //   SURVIVED だった(実測)。この file には `"""` が 1 組しか無いので、
  //   非固定でも他の文字列へ誤爆しない。
  const CODE = RAW.replace(/"""[\s\S]*?"""\n/, '');

  it('🔴 docstring が剥がれている(空振り防止 ── 剥がなければ以下は無意味)', () => {
    // ⚠ 剥いだら中身が空、では「消えている」を検出できない
    expect(CODE.length, 'docstring を剥いだら空になった(剥ぎ方が壊れている)').toBeGreaterThan(
      200,
    );
    // ⚠ 剥いだ後に docstring の解説文言(`要る`)が残っていないことを見る
    expect(CODE, 'docstring が剥がれていない(前提が崩れている)').not.toContain('要る');
  });

  it('🔴 Options 側(opts.recalc_timestamp = False)が在る', () => {
    expect(CODE, 'opts.recalc_timestamp = False が消えている').toMatch(
      /opts\.recalc_timestamp\s*=\s*False/,
    );
  });

  it('🔴 TTFont 読み込み側(recalcTimestamp=False)が在る ── Options だけでは足りない', () => {
    expect(CODE, 'TTFont(..., recalcTimestamp=False) が消えている').toMatch(
      /TTFont\([^)]*recalcTimestamp\s*=\s*False/,
    );
  });
});
