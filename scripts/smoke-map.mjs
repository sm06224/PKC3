#!/usr/bin/env node
/**
 * 🔴 **どの spec が、どの `src` を動かしたか**の対応表を作る(#820)。
 *
 *   PKC3_SMOKE_COVERAGE=1 npm run test:smoke   # 記録を取る(coverage-smoke/ に 1 test 1 file)
 *   node scripts/smoke-map.mjs                 # 束ねる(tests/smoke/smoke-map.json)
 *
 * ## なぜ要るか(user 指摘 2026-09-09「最近、フルスモークが多すぎる」)
 *
 * playwright の `--only-changed` は **spec の import グラフ**しか追わない。smoke は
 * `dist/` を配って動くので、**spec と `src` の間に辺が無い** ── 実測すると
 * `src` を 1 file 触ったとき **0 本**しか選ばれない(spec を触ったときは 11 本)。
 * ⚠ **製品を直したときだけ何も走らない**という、いちばん質の悪い外し方である。
 *
 * 🔑 だから**実行の記録から辺を作る**。V8 の被覆を生成物の sourcemap で `src/**` へ
 * 引き戻したものを `tests/smoke/helpers.ts` が 1 test ずつ書き、ここで束ねる。
 *
 * ## ⚠ この表が言えること・言えないこと
 *
 * - 言える: 「その spec は、**あの日の版で**この `src` を動かした」
 * - 🔴 言えない: 「**これから**動かしうる」── 新しく到達するようになった経路は
 *   記録に無い。だから **着地の 1 回はフルのまま**にする(TIA の定石)。
 *   引く側(`pick-smoke.mjs`)は、**表に無い物を見たら必ずフル**へ倒す。
 *
 * ## 形(索引で持つ)
 *
 * `src` の名前を 1 度だけ並べ、spec は**その添字**を持つ。⚠ 名前をそのまま
 * 95 本ぶん書くと 600 KB になり、repo に置ける大きさではない。
 *
 *   { builtAt, src: [...], specs: { "<spec>": [i, j, ...] }, always: [...] }
 *
 * - `src` ── **束に入っている `src` 全部**(生成物の sourcemap から採る)。
 *   ⚠ 「動いた物」ではない ── **表に無い = この版に存在しない**を判定するために要る。
 * - `always` ── 被覆を**取れなかった** test を含む spec。⚠ 「何も動かしていない」
 *   ではなく「**分からない**」なので、引く側は**必ず走らせる**。
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { countSmoke } from './smoke-budget.mjs';

const COV = process.argv[2] ?? 'coverage-smoke';
const OUT = process.argv[3] ?? 'tests/smoke/smoke-map.json';
const DIST = process.argv[4] ?? 'dist/assets';

if (!existsSync(COV)) {
  console.error(`${COV} が無い ── 先に PKC3_SMOKE_COVERAGE=1 npm run test:smoke で記録を取る`);
  process.exit(1);
}
if (!existsSync(DIST)) {
  console.error(`${DIST} が無い ── 先に npm run build`);
  process.exit(1);
}

/** 束に入っている `src` を全部数える(sourcemap の `sources`)。 */
function bundledSources(distDir) {
  const all = new Set();
  for (const f of readdirSync(distDir)) {
    if (!f.endsWith('.js.map')) continue;
    const m = JSON.parse(readFileSync(join(distDir, f), 'utf-8'));
    for (const s of m.sources ?? []) {
      const n = String(s).replace(/^(\.\.\/)+/, '');
      if (n.startsWith('src/')) all.add(n);
    }
  }
  return all;
}

const known = bundledSources(DIST);
if (known.size === 0) {
  console.error('🔴 束の中に src が 1 file も無い ── sourcemap が出ていない');
  process.exit(1);
}

const bySpec = new Map();
const always = new Set();
let records = 0;
for (const f of readdirSync(COV)) {
  if (!f.endsWith('.json')) continue;
  const rec = JSON.parse(readFileSync(join(COV, f), 'utf-8'));
  const spec = String(rec.spec ?? '');
  if (spec === '') continue;
  records += 1;
  const set = bySpec.get(spec) ?? new Set();
  bySpec.set(spec, set);
  // ⚠ 取れなかった test は「0 件」ではなく「**分からない**」── spec ごと always へ
  if (rec.ok !== true) always.add(spec);
  for (const s of rec.src ?? []) if (known.has(s)) set.add(String(s));
}

/**
 * 🔴 **記録が落ちていないかを、別の数え方で検算する**(2026-09-09 に踏んだ)。
 *
 * ⚠ 1 稿目は file 名を「題名から `[^\w]+` を潰して」作っていたが、題名はほぼ
 *   日本語なので **`_` だけに潰れて同じ spec の test が上書きし合った** ──
 *   95 test 走って記録は **7 件**だった。
 * 🔴 これは**引かなすぎ**の側へ効く(表が小さくなる)ので、
 *   出来上がった表を見ても「そういうものか」としか見えない。
 * 🔑 だから**静的に数えた test の数**(`smoke-budget.mjs`。実行時はこれ以上になる)
 *   を下限として突き合わせる ── 下回ったら、記録が落ちている。
 */
const onDisk = countSmoke();
if (records < onDisk.tests) {
  console.error(
    `🔴 記録 ${records} 件 < spec に書かれた test ${onDisk.tests} 件 ── 記録が落ちている` +
      '(file 名が衝突していないか / 途中で止めていないか)',
  );
  process.exit(1);
}

/**
 * ⚠ **記録が 1 件も無い spec は「何も動かしていない」ではない。**
 * 表に載らないと `pick-smoke` は**その spec を二度と引かない** ── だから
 * `always`(毎回走らせる)へ入れる。安全側は常に「走らせる」である。
 */
for (const p of onDisk.per) if (!bySpec.has(p.spec)) always.add(p.spec);

const src = [...known].sort();
const at = new Map(src.map((s, i) => [s, i]));
const specs = {};
for (const [spec, set] of [...bySpec].sort()) {
  specs[spec] = [...set].map((s) => at.get(s)).sort((a, b) => a - b);
}

writeFileSync(
  OUT,
  `${JSON.stringify({ builtAt: new Date().toISOString(), src, specs, always: [...always].sort() }, null, 0)}\n`,
);

const covered = new Set(Object.values(specs).flat()).size;
console.log(
  `spec ${Object.keys(specs).length} 本 / 記録 ${records} 件 / 束の src ${src.length} file ` +
    `(うち smoke が動かした ${covered} file) / 取れなかった spec ${always.size} 本 → ${OUT}`,
);
