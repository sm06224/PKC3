#!/usr/bin/env node
/**
 * PKC3: PR 向け高速 unit テスト実行スクリプト(#1390)。
 *
 * 1. 変更差分に関係するテストを vitest --changed で実行 (import グラフ追跡)
 * 2. 静的 import に出ない全体走査・規律系のテスト (ui-terms, repo-hygiene 等) を常時監視ガードとして実行
 *
 * 使い方:
 *   node scripts/test-pr.mjs [base-ref]
 *   npm run test:pr
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const GUARD_TESTS = [
  'tests/features/ui-terms.test.ts',
  'tests/features/ui-terms-doc.test.ts',
  'tests/features/manual-glossary.test.ts',
  'tests/repo-hygiene.test.ts',
  'tests/docs-parity.test.ts',
  'tests/workflow-steps.test.ts',
  'tests/workflow-shell.test.ts',
];

function hasOriginMain(ref) {
  try {
    const res = spawnSync('git', ['rev-parse', '--verify', ref], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

export function resolveBase(arg, envBaseRef, gitChecker = hasOriginMain) {
  if (arg) return arg;
  if (envBaseRef) return `origin/${envBaseRef}`;
  if (gitChecker('origin/main')) return 'origin/main';
  return 'main';
}

export function runPrTests(baseRef) {
  console.log(`[test:pr] 1/2: 変更差分に関連するテストを実行中 (base: ${baseRef})...`);
  const changedRes = spawnSync('npx', ['vitest', 'run', '--changed', baseRef, '--passWithNoTests'], {
    stdio: 'inherit',
  });

  if (changedRes.status !== 0) {
    return changedRes.status ?? 1;
  }

  console.log('[test:pr] 2/2: 全体走査・規律系の常時監視ガードテストを実行中...');
  const guardsRes = spawnSync('npm', ['run', 'test:guards'], {
    stdio: 'inherit',
  });

  if (guardsRes.status !== 0) {
    return guardsRes.status ?? 1;
  }

  console.log('[test:pr] 完了: 差分テストおよび常時監視ガードテストに合格しました。');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const base = resolveBase(process.argv[2], process.env.GITHUB_BASE_REF);
  const code = runPrTests(base);
  process.exit(code);
}
