#!/usr/bin/env node
/**
 * PKC3: PR 向け高速 unit テスト実行スクリプト(#1390)。
 *
 * 1. 変更差分に関係するテスト(vitest list --changed。import グラフ追跡)と、静的 import に出ない全体走査・規律系のガードを合わせる
 * 2. 合わせた集合を 1 回の vitest で実行する(集合が全体の大半なら全量を 1 回で。#1845)
 * 3. 全量にフォールバックした場合、理由をログ出力
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

/** 全部の unit テストの数(tests/smoke は除く)── 選んだ範囲が大半なら全量を 1 回で回すための分母 */
export function countAllTests(rootDir = process.cwd()) {
  const testsDir = join(rootDir, 'tests');
  if (!existsSync(testsDir)) return 0;
  let n = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(rootDir, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (rel === 'tests/smoke' || rel.startsWith('tests/smoke/')) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.test.ts')) n += 1;
    }
  };
  walk(testsDir);
  return n;
}

/**
 * 🔴 **1 回の vitest で回す**(#1845)。⚠ 直す前は「差分に関係するテスト」と「ガード」を**別々の 2 回**で回していた ──
 *   起動が 2 回かかり、両方に入る 158 本は 2 度走った。共有 file(binder.ts など)を触る PR では選ぶ範囲がほぼ全量になり、
 *   全量を 1 回で回すより遅くなって、10 分の上限で打ち切られた(#1844 で 2 回)。
 * 🔑 差分とガードを合わせた集合を 1 回で回す。⚠ 集合が全体の `FULL_RATIO` 以上なら、選ばずに全量を 1 回で回す
 *   (選ぶ手間と取りこぼしの危険だけ残って、速さは変わらないため)。
 * @returns { mode: 'full' } か { mode: 'list', files }
 */
export const FULL_RATIO = 0.6;
export function planPrRun(changed, guards, total) {
  if (changed === null) return { mode: 'full' };
  const files = [...new Set([...changed, ...guards])].sort();
  if (total > 0 && files.length >= total * FULL_RATIO) return { mode: 'full' };
  return { mode: 'list', files };
}

/** `vitest list --changed` で、差分に関係するテストの file を引く(引けなければ null = 全量へ倒す) */
export function listChangedTests(baseRef, rootDir = process.cwd()) {
  const res = spawnSync('npx', ['vitest', 'list', '--changed', baseRef, '--filesOnly'], {
    cwd: rootDir,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) return null;
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.endsWith('.test.ts'))
    .map((s) => relative(rootDir, s.startsWith('/') ? s : join(rootDir, s)).replace(/\\/g, '/'));
}

/**
 * 🔑 CI は unit を複数 job に割って並列に回す(`--shard=i/n`)。割り方は vitest 本体に任せる ──
 *   ここは受け取った `--shard=i/n` を、全量でも選んだ集合でも**そのまま vitest へ渡す**だけである
 *   (全 shard の和 = 1 回で回した集合、になる)。
 */
export function parseShardArg(argv) {
  const hit = argv.find((a) => /^--shard=\d+\/\d+$/.test(a));
  return hit ? [hit] : [];
}

export function runPrTests(baseRef, rootDir = process.cwd(), extraArgs = []) {
  const fallbackReason = detectFallbackReason(baseRef, rootDir);
  let plan;
  if (fallbackReason) {
    console.log(`全量にフォールバックしました(理由: ${fallbackReason})`);
    plan = { mode: 'full' };
  } else {
    const changed = listChangedTests(baseRef, rootDir);
    if (changed === null) console.log('全量にフォールバックしました(理由: 差分に関係するテストを引けなかった)');
    plan = planPrRun(changed, collectGuardTests(rootDir), countAllTests(rootDir));
  }
  if (plan.mode === 'full') {
    console.log('[test:pr] 全量の unit テストを 1 回で実行中...');
    const res = spawnSync('npx', ['vitest', 'run', ...extraArgs], { cwd: rootDir, stdio: 'inherit' });
    return res.status ?? 1;
  }
  console.log(`[test:pr] 差分に関係するテスト + ガード: ${plan.files.length} 件を 1 回で実行中 (base: ${baseRef})...`);
  const res = spawnSync('npx', ['vitest', 'run', '--passWithNoTests', ...extraArgs, ...plan.files], {
    cwd: rootDir,
    stdio: 'inherit',
  });
  return res.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--guards')) {
    const code = runGuards();
    process.exit(code);
  } else {
    const baseArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
    const base = resolveBase(baseArg, process.env.GITHUB_BASE_REF);
    const code = runPrTests(base, process.cwd(), parseShardArg(process.argv));
    process.exit(code);
  }
}
