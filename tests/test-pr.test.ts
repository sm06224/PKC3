/** @vitest-environment node */
/**
 * PR 向け高速 unit テスト実行スクリプト・CI 設定のテスト(#1390)。
 *
 * 守る主張:
 * 1. ci.yml の PR 時は scripts/test-pr.mjs を呼び、push 時は npm test を呼ぶ
 * 2. GUARD_TESTS の対象テストファイルがすべてリポジトリ内に実在する
 * 3. package.json の test:guards が GUARD_TESTS を過不足なく網羅している
 * 4. resolveBase の引数・環境変数・git 探索のフォールバック動作
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
// @ts-expect-error -- CI scripts are .mjs
import { resolveBase, GUARD_TESTS } from '../scripts/test-pr.mjs';

describe('PR 高速 unit テスト (#1390)', () => {
  it('ci.yml で PR 時は test-pr.mjs、push 時は npm test を呼ぶ', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf-8');
    expect(ci).toContain('run: node scripts/test-pr.mjs origin/${{ github.base_ref }}');
    expect(ci).toContain('run: npm test');
  });

  it('GUARD_TESTS に指定されたすべてのテストファイルが実在する', () => {
    expect(GUARD_TESTS.length).toBeGreaterThan(0);
    for (const file of GUARD_TESTS) {
      expect(existsSync(file), `${file} が存在しません`).toBe(true);
    }
  });

  it('package.json の test:guards に GUARD_TESTS がすべて含まれる', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test:pr']).toBe('node scripts/test-pr.mjs');
    const guardsScript = pkg.scripts['test:guards'];
    expect(guardsScript).toBeDefined();
    for (const file of GUARD_TESTS) {
      expect(guardsScript).toContain(file);
    }
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
