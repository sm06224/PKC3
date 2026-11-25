/** @vitest-environment node */
/**
 * 🔴 **計測(`@perf`)はフル smoke の並列から切り離して、最後に 1 人で回す**(2026-11-25)。
 *
 * ⚠ `neon-perf.smoke.spec.ts` の 600 コマ計測(CLAUDE.md §2-10「コマ落ちが 1 以下」の正本の計器)は、
 *   ほかの worker の Chromium と CPU を取り合うと発光側の 1 回にだけ負荷が乗って赤くなる
 *   (PR #2073 の着地前のフル smoke で「発光 1,7 / 対照 0,0」。単独では 3 回とも緑)。
 * 🔑 ここが pin するのは「並列の外で走る」形そのもの ── 計測を本体へ戻すと、また並列の揺れを拾う。
 *   設定は文字列ではなく**読み込んだ実物**で見る(コメント内の字で満たされない)。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config, { perfTeardownWanted } from './smoke/playwright.config';

type Project = { name?: string; grep?: RegExp | RegExp[]; grepInvert?: RegExp | RegExp[]; teardown?: string; dependencies?: string[] };
const projects = (config.projects ?? []) as Project[];
const byName = (n: string): Project | undefined => projects.find((p) => p.name === n);
const asList = (g: RegExp | RegExp[] | undefined): RegExp[] => (g === undefined ? [] : Array.isArray(g) ? g : [g]);
const PERF_TITLE = '600 コマ計測 (… @perf)';

describe('🔴 @perf は並列の外・最後に 1 人で走る', () => {
  it('全量の実行(vitest から読んだ設定 = 絞り込み無し)では、本体(smoke)は @perf を外し、その teardown が perf project である', () => {
    const smoke = byName('smoke');
    expect(smoke, 'smoke project が無い').toBeDefined();
    expect(asList(smoke!.grepInvert).some((r) => r.test(PERF_TITLE)), '本体が @perf を外していない(並列の中で測ってしまう)').toBe(true);
    expect(asList(smoke!.grepInvert).some((r) => r.test('ふつうの smoke の題')), '本体が @perf 以外まで外している').toBe(false);
    expect(smoke!.teardown, '@perf が本体の後に回っていない').toBe('perf');
  });

  it('perf project は @perf だけを拾い、本体の赤で skip されない(dependencies にしない)', () => {
    const perf = byName('perf');
    expect(perf, 'perf project が無い').toBeDefined();
    expect(asList(perf!.grep).some((r) => r.test(PERF_TITLE))).toBe(true);
    expect(asList(perf!.grep).some((r) => r.test('ふつうの smoke の題'))).toBe(false);
    expect(perf!.dependencies ?? [], 'dependencies だと本体の赤 1 件で計測が skip される').toEqual([]);
    expect(projects.map((p) => p.name).sort(), 'project を足すなら、ここと並列の切り離しを見直す').toEqual(['perf', 'smoke']);
  });

  it('@perf の題を持つ smoke は neon-perf だけで、その題は perf の grep に当たる', () => {
    const files = readdirSync('tests/smoke').filter((f) => f.endsWith('.smoke.spec.ts'));
    const withPerf = files.filter((f) => /^\s*test\(\s*['"`][^\n]*@perf/m.test(readFileSync(`tests/smoke/${f}`, 'utf-8')));
    expect(withPerf).toEqual(['neon-perf.smoke.spec.ts']);
  });

  it('neon-perf は --shard のとき shard 1 だけで測り、ABBA の順で測る', () => {
    const src = readFileSync('tests/smoke/neon-perf.smoke.spec.ts', 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).toMatch(/test\.skip\(shard !== null && shard\.current !== 1,/);
    const order = [...src.matchAll(/\['((?:control|glow)-\d)', (true|false)\]/g)].map((m) => m[1]);
    expect(order, '対照 → 発光 → 発光 → 対照(時間の傾きを打ち消す)').toEqual(['control-1', 'glow-1', 'glow-2', 'control-2']);
  });
});

/**
 * 🔴 **teardown はファイル指定も `-g` も効かない**(playwright 1.65 で実測)── 付けっぱなしだと、別の spec を 1 本回すたびに計測(1.8 分)が乗る。
 * 🔑 付けるのは「全量」「絞り込みが @perf に当たる」「何が選ばれるか読めない」のときだけ。
 */
describe('🔴 perfTeardownWanted: 計測を最後に回す形を付けるのは、計測が選ばれうるときだけ', () => {
  const pw = (...a: string[]): string[] => ['/usr/bin/node', '/x/node_modules/.bin/playwright', 'test', '--config', 'tests/smoke/playwright.config.ts', ...a];
  it.each([
    ['全量', pw()],
    ['全量 + -u の値(値を file と取り違えると「絞り込み」に見える)', pw('-u', 'all')],
    ['全量を shard で割る(npm run test:smoke -- --shard=2/3)', pw('--shard=2/3')],
    ['全量を shard で割る(値を次の語で渡す)', pw('--shard', '2/3', '--workers', '2')],
    ['neon-perf を名指し', pw('tests/smoke/neon-perf.smoke.spec.ts')],
    ['neon-perf を行つきで名指し', pw('tests/smoke/alarm.smoke.spec.ts', 'tests/smoke/neon-perf.smoke.spec.ts:286')],
    ['部分の正規表現が neon-perf に当たる', pw('neon')],
    ['-g が @perf に当たる', pw('-g', '@perf')],
    ['--grep= が計測の題に当たる', pw('--grep=600 コマ')],
    ['何が選ばれるか読めない(--last-failed)', pw('--last-failed')],
    ['何が選ばれるか読めない(--only-changed)', pw('--only-changed', 'origin/main')],
    ['test の語が無い(vitest などから設定を読んだ)', ['/usr/bin/node', 'vitest', 'run']],
  ])('付ける: %s', (_n, argv) => {
    expect(perfTeardownWanted(argv)).toBe(true);
  });
  it.each([
    ['別の spec を 1 本(pick-smoke の形)', pw('tests/smoke/alarm.smoke.spec.ts')],
    ['別の spec を行つきで', pw('tests/smoke/builtin-apps.smoke.spec.ts:798')],
    ['別の spec を複数 + 旗の値(smoke-record の形)', pw('--workers=4', 'tests/smoke/attach.smoke.spec.ts', 'tests/smoke/layout.smoke.spec.ts')],
    ['-g が別の題だけに当たる', pw('-g', '添付の HTML')],
    ['-u の値を file と取り違えない', pw('-u', 'all', 'tests/smoke/alarm.smoke.spec.ts')],
    ['neon-perf の file でも -g が外す', pw('tests/smoke/neon-perf.smoke.spec.ts', '-g', '添付の HTML')],
  ])('付けない: %s', (_n, argv) => {
    expect(perfTeardownWanted(argv)).toBe(false);
  });
});
