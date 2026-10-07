/** @vitest-environment node */
/**
 * #1402 の計装 3 本(`patch-lo-surface-trace.py` / `patch-lo-sdpr-trace.py` / `patch-lo-gfxdata-trace.py`)の**時計が同じ**であることを検める。
 *
 * 🔴 **何のための検査か**: 3 本の印の `t=` は、別々のスレッド・別々の file の印を**時刻で突き合わせる**ために出す
 * (`PKC3-SURFACE: resize destroy old=X` の `t=` と、`PKC3-SDPR: enter` / `PKC3-GFXDATA: surface=X` の `t=`)。
 * どれか 1 本だけ単位(`microseconds`)や時計(`system_clock`)が違うと、突き合わせが**桁か基準ごと**ずれる ── しかも印は出るので
 * 気づけない(焼いて、ログを読んで初めて分かる)。3 本の `pPkc3Ms` の lambda の本体が **MARK を除いて完全に一致**することを見る。
 *
 * ⚠ 期待値は**手で書いた文字列**(patch の定数を import しない ── 同じ盲点を共有しない)。字の前後の空白と行末の MARK は落として比べる。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const SCRIPTS: ReadonlyArray<readonly [string, string]> = [
  ['build/office-wasm/patch-lo-surface-trace.py', 'PKC3-SURFACE'],
  ['build/office-wasm/patch-lo-sdpr-trace.py', 'PKC3-SDPR'],
  ['build/office-wasm/patch-lo-gfxdata-trace.py', 'PKC3-GFXDATA'],
];

/** lambda の 6 行(MARK と前後の空白を落とす)。 */
const WANT = [
  'auto const pPkc3Ms = []() -> long long',
  '{',
  'return std::chrono::duration_cast<std::chrono::milliseconds>(',
  'std::chrono::steady_clock::now().time_since_epoch())',
  '.count();',
  '};',
];

function lambdaOf(script: string, mark: string): string[] {
  const lines = readFileSync(script, 'utf-8').split('\n');
  const starts = lines.map((l, i) => (l.includes('auto const pPkc3Ms = []() -> long long') ? i : -1)).filter((i) => i >= 0);
  expect(starts.length, `${script}: lambda が 1 つでない`).toBe(1);
  return lines.slice(starts[0]!, starts[0]! + WANT.length).map((l) => {
    expect(l, `${script}: lambda の行に MARK が無い`).toContain(` // ${mark}`);
    return l.replace(` // ${mark}`, '').trim();
  });
}

describe('#1402 計装 3 本の時計', () => {
  it('🔑 空振り防止: 3 本とも読めている', () => {
    expect(SCRIPTS.length).toBe(3);
    for (const [s] of SCRIPTS) expect(readFileSync(s, 'utf-8')).toContain('PKC3-');
  });

  it('🔴 `pPkc3Ms` の lambda の本体が、3 本とも MARK を除いて手書きの期待値と完全に一致する(steady_clock の ms)', () => {
    for (const [script, mark] of SCRIPTS) {
      expect(lambdaOf(script, mark), script).toEqual(WANT);
    }
  });

  it('🔴 時計は 3 本とも `steady_clock` だけ(`system_clock` / `high_resolution_clock` / `microseconds` が混じらない ── 時計の種類と単位を C++ の行から全部拾って突き合わせる)', () => {
    for (const [script] of SCRIPTS) {
      const src = readFileSync(script, 'utf-8');
      // docstring の説明文は数えない: C++ の行(MARK で終わる行)だけを見る
      const cxx = src.split('\n').filter((l) => /\/\/ PKC3-[A-Z]+$/.test(l)).join('\n');
      expect(cxx, script).toContain('std::chrono::steady_clock::now()');
      expect(cxx.match(/std::chrono::\w+_clock/g), script).toEqual(['std::chrono::steady_clock']);
      expect(cxx.match(/std::chrono::\w*seconds/g), script).toEqual(['std::chrono::milliseconds']);
    }
  });
});
