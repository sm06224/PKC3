/** @vitest-environment node */
/**
 * PR 向け高速 unit テスト実行スクリプト・CI 設定のテスト(#1390)。
 *
 * 守る主張:
 * 1. ci.yml の PR 時は scripts/test-pr.mjs を呼び、push 時は npm test を呼ぶ
 * 2. collectGuardTests は 100 本以上のガードテストを収集し、7 本の錨をすべて含む
 * 3. 収集されたすべてのガードテストファイルがリポジトリ内に実在する
 * 4. package.json の scripts に test:pr と test:guards が定義されている
 * 5. detectFallbackReasonFromFiles は package.json や config の変更を検出し、通常ファイルは null
 * 6. resolveBase の引数・環境変数・git 探索のフォールバック動作
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
// @ts-expect-error -- CI scripts are .mjs
import { resolveBase, collectGuardTests, ANCHOR_GUARD_TESTS, detectFallbackReasonFromFiles, planPrRun, countAllTests, FULL_RATIO, parseShardArg } from '../scripts/test-pr.mjs';

describe('PR 高速 unit テスト (#1390)', () => {
  it('ci.yml で PR 時は test-pr.mjs、push 時は npm test を呼ぶ', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf-8');
    expect(ci).toContain('run: node scripts/test-pr.mjs origin/${{ github.base_ref }}');
    expect(ci).toContain('run: npm test');
  });

  it('collectGuardTests は 100 本以上のガードテストを収集し、7 本の錨をすべて含む', () => {
    const guards = collectGuardTests();
    expect(guards.length).toBeGreaterThanOrEqual(100);
    for (const anchor of ANCHOR_GUARD_TESTS) {
      expect(guards, `${anchor} がガードテストに含まれていません`).toContain(anchor);
    }
  });

  it('collectGuardTests で収集されたすべてのテストファイルが実在する', () => {
    const guards = collectGuardTests();
    for (const file of guards) {
      expect(existsSync(file), `${file} が存在しません`).toBe(true);
    }
  });

  it('package.json の scripts に test:pr と test:guards が定義されている', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test:pr']).toBe('node scripts/test-pr.mjs');
    expect(pkg.scripts['test:guards']).toBe('node scripts/test-pr.mjs --guards');
  });

  it('detectFallbackReasonFromFiles は package.json や config の変更を検出する', () => {
    expect(detectFallbackReasonFromFiles(['package.json'])).toContain('package.json');
    expect(detectFallbackReasonFromFiles(['vite.config.ts'])).toContain('vite.config.ts');
    expect(detectFallbackReasonFromFiles(['src/foo.ts', 'tests/foo.test.ts'])).toBeNull();
    expect(detectFallbackReasonFromFiles(null)).toBe('git diff 取得失敗');
  });

  it('resolveBase は明示引数、環境変数、git 探索の順で解決する', () => {
    // 1. 明示的な引数
    expect(resolveBase('feature-branch', 'main', () => true)).toBe('feature-branch');
    // 2. GITHUB_BASE_REF
    expect(resolveBase(undefined, 'main', () => true)).toBe('origin/main');
    // 3. git に origin/main が存在する場合
    expect(resolveBase(undefined, undefined, (ref: string) => ref === 'origin/main')).toBe('origin/main');
    // 4. フォールバック
    expect(resolveBase(undefined, undefined, () => false)).toBe('main');
  });

  /**
   * 🔴 #1845: 差分とガードを**1 回の vitest** で回す。⚠ 2 回に分けると、両方に入る file が 2 度走り、起動も 2 回かかる
   *   ── 共有 file を触る PR で 10 分の上限に当たった。
   */
  it('planPrRun は差分とガードの和を重複なしの 1 つの一覧にし、大半なら全量 1 回に倒す', () => {
    const plan = planPrRun(['tests/a.test.ts', 'tests/b.test.ts'], ['tests/b.test.ts', 'tests/c.test.ts'], 100);
    expect(plan).toEqual({ mode: 'list', files: ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts'] });
    // 和が全体の FULL_RATIO 以上 ── 選ばずに全量を 1 回
    const many = Array.from({ length: Math.ceil(100 * FULL_RATIO) }, (_, i) => `tests/t${i}.test.ts`);
    expect(planPrRun(many, [], 100)).toEqual({ mode: 'full' });
    // 差分を引けなかった ── 全量へ倒す(取りこぼさない側)
    expect(planPrRun(null, ['tests/c.test.ts'], 100)).toEqual({ mode: 'full' });
  });

  it('countAllTests は smoke を除いた unit テストを数える(分母が 0 だと倒す判定が空振りする)', () => {
    expect(countAllTests()).toBeGreaterThan(500);
  });

  it('runPrTests は vitest を 2 回に分けて呼ばない(差分とガードを別々に回す形へ戻さない)', () => {
    const src = readFileSync('scripts/test-pr.mjs', 'utf-8');
    const body = src.slice(src.indexOf('export function runPrTests('), src.indexOf('if (process.argv[1]'));
    expect(body, 'runPrTests を取り出せていない(前提が崩れている)').toContain('planPrRun(');
    expect(body.match(/'vitest', 'run'/g)?.length, '全量と一覧の 2 つの枝だけ').toBe(2);
    expect(body).not.toContain('--changed');
  });

  it('parseShardArg は --shard=i/n だけを拾う(base や他の旗を巻き込まない / 不正な綴りは捨てる)', () => {
    expect(parseShardArg(['origin/main', '--shard=2/3'])).toEqual(['--shard=2/3']);
    expect(parseShardArg(['origin/main'])).toEqual([]);
    expect(parseShardArg(['--shard=x/3', '--shard=1'])).toEqual([]);
  });

  it('runPrTests は渡された --shard を全量・一覧の両方の vitest へ渡す', () => {
    const src = readFileSync('scripts/test-pr.mjs', 'utf-8');
    const body = src.slice(src.indexOf('export function runPrTests('), src.indexOf('if (process.argv[1]'));
    expect(body.match(/\.\.\.extraArgs/g)?.length, '2 つの枝の両方に shard を渡す').toBe(2);
  });
});
