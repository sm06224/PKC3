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
import { resolveBase, collectGuardTests, ANCHOR_GUARD_TESTS, detectFallbackReasonFromFiles } from '../scripts/test-pr.mjs';

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
});
