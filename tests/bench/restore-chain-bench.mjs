/**
 * 復元チェーン: TS 参照実装 vs Rust/wasm の対照計測(rust-wasm-strategy §10.5)。
 *
 * ⚠ この harness を **repo に置く**理由(review M3): 最初の R2 判定は scratchpad の
 * 揮発ハーネスで測ったため第三者が再現できず、実際に再測すると結論が動いた。
 * 「数字を出す前に手法を固める」規律に従い、fixture と手順をここに固定する。
 *
 * 手法:
 * - 同一 fixture / 交互 5 run の中央値 / **先に出力一致を確認**(違うものを比べない)
 * - ja と ascii の両方、段数 5 / 20 / 50(20 が実運用の想定動作点)
 * - 実行順の影響を見るため `--order=wasm-first` で逆順にもできる
 * - Node 実測であり**ブラウザ実測ではない**。信頼するのは向きと構成比
 *
 * 使い方: npx vite-node tests/bench/restore-chain-bench.mjs [--order=wasm-first]
 */
import { readFileSync } from 'node:fs';
import { diffLines } from '../../src/features/revision/line-patch.ts';
import { restoreChain } from '../../src/features/revision/restore-chain.ts';
import {
  initPkcCore,
  restoreChainWasm,
  wasmStatus,
} from '../../src/adapter/platform/wasm/pkc-core-bridge.ts';

const wasmFirst = process.argv.includes('--order=wasm-first');
await initPkcCore(readFileSync('src/adapter/platform/wasm/pkc_core.wasm'));
if (!wasmStatus().ready) {
  console.error('wasm を読めない:', wasmStatus());
  process.exit(1);
}

const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const bench = (fn, iters) => {
  const runs = [];
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) fn();
    runs.push((performance.now() - t0) / iters);
  }
  return median(runs);
};

/** 1 世代 = 1 行だけ書き換えた版(実運用の編集に近い形)。 */
function buildChain(mkLine, lines, depth) {
  const gens = [];
  for (let g = 0; g <= depth; g++) {
    gens.push(
      Array.from({ length: lines }, (_, i) =>
        i === g % lines ? `${mkLine(i)}改 ${g}\n` : mkLine(i),
      ).join(''),
    );
  }
  const tip = gens[gens.length - 1];
  const steps = [];
  for (let i = gens.length - 1; i > 0; i--) {
    steps.push({ kind: 'patch', ops: diffLines(gens[i], gens[i - 1]).ops });
  }
  return { tip, steps };
}

const FIXTURES = [
  ['ascii 2500 行(約 30KB)', (i) => `line ${i} of the document\n`, 2500],
  ['ja 2500 行(約 100KB)', (i) => `行 ${i} 日本語の本文がここに入ります。\n`, 2500],
];

console.log(`# 復元チェーン TS vs wasm(順序: ${wasmFirst ? 'wasm 先' : 'TS 先'})`);
console.log('fixture / 段数 | TS | wasm | 判定(分母 = TS)');
for (const [label, mkLine, lines] of FIXTURES) {
  for (const depth of [5, 20, 50]) {
    const { tip, steps } = buildChain(mkLine, lines, depth);
    const a = restoreChain(tip, steps);
    const b = restoreChainWasm(tip, steps);
    if (a !== b) {
      console.log(`${label} / ${depth} 段: ✗ 出力不一致 ── 計測しない`);
      continue;
    }
    const ts = wasmFirst ? null : bench(() => restoreChain(tip, steps), 20);
    const ws = bench(() => restoreChainWasm(tip, steps), 20);
    const ts2 = wasmFirst ? bench(() => restoreChain(tip, steps), 20) : ts;
    const pct = ((1 - ws / ts2) * 100).toFixed(0);
    console.log(
      `${label} / ${String(depth).padStart(2)} 段 | ${ts2.toFixed(2)}ms | ${ws.toFixed(2)}ms | ` +
        `${pct >= 0 ? `${pct}% 短縮` : `${-pct}% 悪化`}`,
    );
  }
}
