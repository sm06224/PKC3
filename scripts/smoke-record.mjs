#!/usr/bin/env node
/**
 * 🔴 **被覆の記録を、spec ごとに確実に取る**(#820)。
 *
 *   npm run build && npm run smoke:record && npm run smoke:map
 *
 * ## ⚠ なぜ「1 回まとめて回す」ではないのか(2026-09-09 に踏んだ)
 *
 * 記録の口(`test.beforeEach` / `afterEach`)は `tests/smoke/helpers.ts` の
 * **module 直下**に置いてある。⚠ playwright の hook は
 * **その時に読み込んでいる spec file** に結び付くが、helpers は 2 本目以降の spec で
 * **module cache から返るので本体が走らない** ── つまり
 * 🔴 **worker ごとに「最初に読んだ 1 本」しか記録が取れない。**
 *
 * 実測: `--workers=4` で全量を回したら、95 test 走った時点で記録は **11 件**
 * (= 4 worker が最初に読んだ 4 本ぶんだけ)。⚠ **落ちないので気づけない** ──
 * 出来上がる表が小さくなるだけで、その表は「引かなすぎ」の側へ効く。
 *
 * 🔑 だから **1 回の起動で spec を worker の数だけ**渡す(1 worker = 1 spec)。
 * ⚠ そして**取れたことを確かめる** ── 取れなかった spec は**単独で**回し直す。
 * それでも取れなければ一覧に出し、`smoke-map.mjs` が `always`(毎回走らせる)へ入れる。
 */
import { readdirSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const DIR = process.env['PKC3_COVERAGE_DIR'] ?? 'coverage-smoke';
const SPEC_DIR = 'tests/smoke';
const LANES = Number(process.env['PKC3_RECORD_LANES'] ?? 4);

const specs = readdirSync(SPEC_DIR)
  .filter((f) => f.endsWith('.smoke.spec.ts'))
  .sort();
if (specs.length === 0) {
  console.error(`🔴 ${SPEC_DIR} に spec が 1 本も無い`);
  process.exit(1);
}
mkdirSync(DIR, { recursive: true });

const recorded = (spec) => readdirSync(DIR).some((f) => f.startsWith(`${spec}--`));

function run(files, workers) {
  const r = spawnSync(
    'npx',
    [
      'playwright',
      'test',
      '--config',
      'tests/smoke/playwright.config.ts',
      `--workers=${workers}`,
      ...files.map((f) => `${SPEC_DIR}/${f}`),
    ],
    // ⚠ **落ちた回の出力を捨てない**(CLAUDE.md §4)── playwright は失敗の中身を
    //   stdout へ書くので、捨てると「赤が N 回あった」しか残らない(実際 1 度やった)
    { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, PKC3_SMOKE_COVERAGE: '1' } },
  );
  return r.status ?? 1;
}

let red = 0;
for (let i = 0; i < specs.length; i += LANES) {
  const batch = specs.slice(i, i + LANES);
  if (run(batch, LANES) !== 0) red += 1;
  for (const spec of batch) {
    // ⚠ 取れなかったら**単独で**回し直す(1 worker = 1 spec なら必ず hook が走る)
    if (!recorded(spec) && run([spec], 1) !== 0) red += 1;
  }
  const done = Math.min(i + LANES, specs.length);
  console.log(`  ${String(done).padStart(3)}/${specs.length} spec ── 記録 ${readdirSync(DIR).length} 件`);
}

const missing = specs.filter((s) => !recorded(s));
console.log(`記録 ${readdirSync(DIR).length} 件 / spec ${specs.length} 本(取れなかった ${missing.length} 本)`);
for (const m of missing) console.log(`  ⚠ 記録なし: ${m} ── always(毎回走らせる)へ入る`);
if (!existsSync(DIR) || readdirSync(DIR).length === 0) {
  console.error('🔴 1 件も記録できていない ── PKC3_SMOKE_COVERAGE が届いているか');
  process.exit(1);
}
if (red > 0) console.error(`⚠ 赤が ${red} 回あった ── 記録は取れているが、内容を疑うこと`);
