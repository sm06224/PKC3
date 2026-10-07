#!/usr/bin/env node
/**
 * PKC3: PR 向け高速 unit テスト実行スクリプト(#1390)。
 *
 * 1. 変更差分に関係するテストを vitest --changed で実行 (import グラフ追跡)
 * 2. 静的 import に出ない全体走査・規律系のテスト (ui-terms, repo-hygiene 等) を常時監視ガードとして実行
 * 3. vitest --changed が全量にフォールバックした場合、理由をログ出力
 *
 * 使い方:
 *   node scripts/test-pr.mjs [base-ref]
 *   node scripts/test-pr.mjs --guards
 *   npm run test:pr
 *   npm run test:guards
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 規律の錨となる 7 本の常時監視テスト */
export const ANCHOR_GUARD_TESTS = [
  'tests/features/ui-terms.test.ts',
  'tests/features/ui-terms-doc.test.ts',
  'tests/features/manual-glossary.test.ts',
  'tests/repo-hygiene.test.ts',
  'tests/docs-parity.test.ts',
  'tests/workflow-steps.test.ts',
  'tests/workflow-shell.test.ts',
];

export const GUARD_SCAN_PATTERN = /readFileSync|readdirSync|globSync|fast-glob|readdir\(/;

/**
 * tests/ 以下の test.ts から fs / glob で repo を走査するテストを動的に収集する
 * (tests/smoke は除く)
 */
export function collectGuardTests(rootDir = process.cwd()) {
  const testsDir = join(rootDir, 'tests');
  if (!existsSync(testsDir)) return [];
  const results = [];

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const rel = relative(rootDir, full).replace(/\\/g, '/');
        if (rel === 'tests/smoke' || rel.startsWith('tests/smoke/')) {
          continue;
        }
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
        const content = readFileSync(full, 'utf-8');
        if (GUARD_SCAN_PATTERN.test(content)) {
          const rel = relative(rootDir, full).replace(/\\/g, '/');
          results.push(rel);
        }
      }
    }
  }

  walk(testsDir);
  return results.sort();
}

/** 互換性のためのエイリアス */
export const GUARD_TESTS = ANCHOR_GUARD_TESTS;

function hasGitRef(ref, cwd = process.cwd()) {
  try {
    const res = spawnSync('git', ['rev-parse', '--verify', ref], { cwd, stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

export function resolveBase(arg, envBaseRef, gitChecker = hasGitRef) {
  if (arg && !arg.startsWith('--')) return arg;
  if (envBaseRef) return `origin/${envBaseRef}`;
  if (gitChecker('origin/main')) return 'origin/main';
  return 'main';
}

export function getChangedFiles(baseRef, cwd = process.cwd()) {
  try {
    const res = spawnSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
      cwd,
      encoding: 'utf-8',
    });
    if (res.status !== 0) return null;
    return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

export function detectFallbackReasonFromFiles(files) {
  if (!files) return 'git diff 取得失敗';
  const triggers = files.filter(
    (f) =>
      f === 'package.json' ||
      f.endsWith('/package.json') ||
      /(^|\/)(vitest|vite)\.config\.[a-z]+$/.test(f),
  );
  if (triggers.length > 0) {
    return `${triggers.join(', ')} の変更`;
  }
  return null;
}

export function detectFallbackReason(baseRef, cwd = process.cwd()) {
  const files = getChangedFiles(baseRef, cwd);
  return detectFallbackReasonFromFiles(files);
}

export function runGuards(rootDir = process.cwd()) {
  const guardTests = collectGuardTests(rootDir);
  console.log(`[test:guards] ガードテスト対象: ${guardTests.length} 件`);
  const guardsRes = spawnSync('npx', ['vitest', 'run', ...guardTests], {
    cwd: rootDir,
    stdio: 'inherit',
  });
  return guardsRes.status ?? 0;
}

export function runPrTests(baseRef, rootDir = process.cwd()) {
  const fallbackReason = detectFallbackReason(baseRef, rootDir);
  if (fallbackReason) {
    console.log(`全量にフォールバックしました(理由: ${fallbackReason})`);
  }

  console.log(`[test:pr] 1/2: 変更差分に関連するテストを実行中 (base: ${baseRef})...`);
  const changedRes = spawnSync('npx', ['vitest', 'run', '--changed', baseRef, '--passWithNoTests'], {
    cwd: rootDir,
    stdio: 'inherit',
  });

  if (changedRes.status !== 0) {
    return changedRes.status ?? 1;
  }

  if (fallbackReason) {
    console.log('[test:pr] 2/2: 全量テストが実行されたため、ガードテストの重複実行を省略します。');
    console.log('[test:pr] 完了: 全量テストに合格しました。');
    return 0;
  }

  console.log('[test:pr] 2/2: 全体走査・規律系の常時監視ガードテストを実行中...');
  const guardTests = collectGuardTests(rootDir);
  console.log(`[test:pr] ガードテスト対象: ${guardTests.length} 件`);
  const guardsRes = spawnSync('npx', ['vitest', 'run', ...guardTests], {
    cwd: rootDir,
    stdio: 'inherit',
  });

  if (guardsRes.status !== 0) {
    return guardsRes.status ?? 1;
  }

  console.log('[test:pr] 完了: 差分テストおよび常時監視ガードテストに合格しました。');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--guards')) {
    const code = runGuards();
    process.exit(code);
  } else {
    const baseArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
    const base = resolveBase(baseArg, process.env.GITHUB_BASE_REF);
    const code = runPrTests(base);
    process.exit(code);
  }
}
