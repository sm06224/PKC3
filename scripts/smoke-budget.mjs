#!/usr/bin/env node
/**
 * 🔴 **smoke の「起動の数」に予算を置く**(#820。user 指摘 2026-09-09
 * 「**改修一件で増えるテストが毎ターンの負荷に積み上がる**」)。
 *
 *   node scripts/smoke-budget.mjs        # いまの数と内訳を出す
 *
 * ## なぜ「起動」を数えるのか(実測)
 *
 * smoke は `workers: 1` の直列なので、所要はほぼ**起動の数に比例する**:
 *
 * | 実測(2026-09-09) | 値 |
 * |---|---|
 * | フル smoke(手元・headless_shell) | **13.2 分 = 792 秒** |
 * | そのときの起動の数 | **487** |
 * | 1 起動あたり | **約 1.63 秒** |
 *
 * 🔑 つまり**新しい `gotoApp` を 1 つ足すと、以後すべての回に 1.6 秒が積まれる**。
 * ⚠ assert を 1 つ足すのは**ほぼ 0 秒** ── だから増やす向きを変える:
 * **新しく起動する test を足すのではなく、既に在る道中に assert を足す。**
 *
 * ## ⚠ これは「test を減らせ」ではない
 *
 * 減らすことは目的ではない(CLAUDE.md「test は使い所を選ぶ」)。予算が言うのは
 * **「その 1 件は、本当に**もう 1 回起動しないと**書けないか」**だけである。
 * 🔑 書けないなら**上げてよい** ── ただし**なぜ既存の道中に載せられないかを
 * 1 行書く**(下の `BOOT_BUDGET` の隣)。⚠ 黙って上げると、この予算は
 * 「毎回上げる数字」になって何も守らなくなる。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 🔴 **起動の上限**。実測 1 起動 ≒ 1.63 秒 なので、**約 14 分**が上限にあたる。
 *
 * 経緯(足したら 1 行足す ── 数字だけ動かさない):
 * - 2026-09-09: **500**(そのときの実数 487)。#820 で置いた最初の値。
 */
export const BOOT_BUDGET = 500;

/** 実測の 1 起動あたり秒(手元・headless_shell・`workers: 1`)。 */
export const SECONDS_PER_BOOT = 1.63;

/** 🔴 下限 ── 数え方が壊れて 0 になったら「予算内」に見える(CLAUDE.md §1)。 */
export const BOOT_FLOOR = 300;

/** TS のコメントを落とす(`tests/helpers/code-only.ts` と同じ規則)。 */
export function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * spec 1 本の「起動の数」と「test の数」を数える。
 *
 * ⚠ 起動の口は 2 つある ── `gotoApp(page)`(共通 helper)と、`page.goto(...)` を
 *   自分で書くもの(prefix 配信 / plain 配信 / 別窓)。**両方数える**。
 */
export function countSpec(text) {
  const s = codeOnly(text);
  return {
    boots: (s.match(/\bgotoApp\s*\(/g) ?? []).length + (s.match(/\.goto\s*\(/g) ?? []).length,
    tests: (s.match(/^\s*test\s*\(/gm) ?? []).length,
  };
}

/** `tests/smoke` を全数走査する。 */
export function countSmoke(dir = 'tests/smoke') {
  const per = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.smoke.spec.ts')) continue;
    per.push({ spec: f, ...countSpec(readFileSync(join(dir, f), 'utf-8')) });
  }
  return {
    boots: per.reduce((a, b) => a + b.boots, 0),
    tests: per.reduce((a, b) => a + b.tests, 0),
    per,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = countSmoke(process.argv[2] ?? 'tests/smoke');
  const mins = ((r.boots * SECONDS_PER_BOOT) / 60).toFixed(1);
  for (const p of [...r.per].sort((a, b) => b.boots - a.boots).slice(0, 10)) {
    console.log(`  ${String(p.boots).padStart(3)} 起動 / ${String(p.tests).padStart(3)} test  ${p.spec}`);
  }
  console.log(
    `起動 ${r.boots} / 予算 ${BOOT_BUDGET}(残り ${BOOT_BUDGET - r.boots})` +
      ` ── 実測 ${SECONDS_PER_BOOT} 秒/起動 なので約 ${mins} 分`,
  );
  if (r.boots > BOOT_BUDGET) {
    console.error('🔴 予算を超えた ── 新しい起動ではなく、既に在る道中に assert を足せないか');
    process.exit(1);
  }
}
