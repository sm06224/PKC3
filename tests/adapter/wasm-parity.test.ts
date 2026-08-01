/**
 * Rust core(wasm)と TS 参照実装の **等価性**(R1/R2。rust-wasm-strategy §7)。
 *
 * 順序規律: **TS が正、wasm が従**。ここが落ちたら wasm を疑う。
 * 出荷される `.wasm`(リポジトリに commit 済み)を**そのまま**読んで検証するので、
 * 「ビルドし直し忘れ」も「JS 橋の marshalling バグ」もここで捕まる。
 *
 * ⚠ 非 ASCII / CRLF / 末尾改行なし を**必須の次元**として含める
 * (ゼロ件の次元は「測っていない次元」── 計測規律)。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffLines } from '../../src/features/revision/line-patch';
import { restoreChain, type ChainStep } from '../../src/features/revision/restore-chain';
import {
  initPkcCore,
  resetPkcCore,
  restoreChainWasm,
  wasmMemoryBytes,
  wasmStatus,
} from '../../src/adapter/platform/wasm/pkc-core-bridge';

// vitest は repo root を cwd に走る(import.meta.url は変換後に file: でなくなる)
const WASM_PATH = resolve(process.cwd(), 'src/adapter/platform/wasm/pkc_core.wasm');

/** parity が必ず覆う入力の種類(review L6 ── 網が狭まったら test が落ちる)。 */
const REQUIRED_VARIANTS: Array<[string, (i: number) => string]> = [
  ['ascii', (i) => `line ${i}\n`],
  ['ja', (i) => `行 ${i} 日本語の本文です。\n`],
  ['CRLF', (i) => `行 ${i}\r\n`],
  ['絵文字', (i) => `🎌 ${i} テスト\n`],
];

/** TS 側の checkpoint と同じ形で「1 つ新しい状態から遡る」段を作る。 */
function stepFrom(newer: string, older: string): ChainStep {
  return { kind: 'patch', ops: diffLines(newer, older).ops };
}

beforeAll(async () => {
  const ok = await initPkcCore(readFileSync(WASM_PATH));
  expect(ok, `wasm を読めていない: ${JSON.stringify(wasmStatus())}`).toBe(true);
});

afterAll(() => resetPkcCore());

describe('wasm ↔ TS parity (R1/R2)', () => {
  it('出荷 .wasm が読め、ABI 版が一致し、外部 import を持たない', () => {
    const bytes = readFileSync(WASM_PATH);
    const mod = new WebAssembly.Module(bytes);
    // imports 0 = glue も WASI shim も要らない(境界を自分で握れている証拠)
    expect(WebAssembly.Module.imports(mod)).toEqual([]);
    expect(wasmStatus().ready).toBe(true);
    expect(wasmStatus().poisoned).toBe(false);
  });

  it('多世代の鎖で TS と byte 一致(ja / ascii / CRLF / 末尾改行なし)', () => {
    for (const [name, mk] of REQUIRED_VARIANTS) {
      const gens: string[] = [];
      for (let g = 0; g < 12; g++) {
        gens.push(
          Array.from({ length: 120 }, (_, i) => (i === g ? `${mk(i)}改${g}\n` : mk(i))).join(''),
        );
      }
      // 末尾改行なしの世代も混ぜる(縁が最も壊れやすい)
      gens.push(gens[gens.length - 1]!.replace(/\n$/, ''));
      const tip = gens[gens.length - 1]!;
      const steps: ChainStep[] = [];
      for (let i = gens.length - 1; i > 0; i--) steps.push(stepFrom(gens[i]!, gens[i - 1]!));
      for (let n = 1; n <= steps.length; n++) {
        const slice = steps.slice(0, n);
        const ts = restoreChain(tip, slice);
        expect(restoreChainWasm(tip, slice), `${name} / ${n} 段`).toBe(ts);
      }
    }
  });

  it('full 行が混ざる鎖(delete → 復元で作られる形)でも一致', () => {
    const tip = '# いま\n本文\n';
    const steps: ChainStep[] = [
      stepFrom(tip, '# ひとつ前\n本文\n'),
      { kind: 'full', body: '# 全文で保存された版\nもっと前\n' },
      stepFrom('# 全文で保存された版\nもっと前\n', '# さらに前\nもっと前\n'),
    ];
    for (let n = 1; n <= steps.length; n++) {
      const slice = steps.slice(0, n);
      expect(restoreChainWasm(tip, slice)).toBe(restoreChain(tip, slice));
    }
  });

  it('空・空段・全消し・全入替などの縁でも一致', () => {
    const edges: Array<[string, string]> = [
      ['', ''],
      ['', '新しく生えた\n'],
      ['消える\n', ''],
      ['a\n', 'a\n'],
      ['a\nb\nc\n', 'c\nb\na\n'],
      ['末尾改行なし', '末尾改行なし\n'],
      ['x'.repeat(5000), 'y'.repeat(5000)],
    ];
    for (const [newer, older] of edges) {
      const steps = [stepFrom(newer, older)];
      expect(restoreChainWasm(newer, steps), JSON.stringify([newer, older]).slice(0, 40)).toBe(
        restoreChain(newer, steps),
      );
    }
  });

  it('ランダム 300 本の鎖で一致(決定的 PRNG ── 落ちたら同じ入力で再現する)', () => {
    let seed = 20260801;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const genBody = (): string => {
      const n = Math.floor(rnd() * 40);
      return Array.from({ length: n }, () => {
        const r = rnd();
        const text = r < 0.25 ? '' : r < 0.6 ? `行 ${Math.floor(r * 50)}` : `line ${Math.floor(r * 50)}`;
        return rnd() < 0.12 ? `${text}\r\n` : `${text}\n`;
      }).join('');
    };
    for (let t = 0; t < 300; t++) {
      const gens = [genBody()];
      const depth = 1 + Math.floor(rnd() * 6);
      for (let g = 0; g < depth; g++) {
        const b = rnd() < 0.15 ? '' : genBody();
        gens.push(rnd() < 0.2 ? b.replace(/\n$/, '') : b);
      }
      const tip = gens[gens.length - 1]!;
      const steps: ChainStep[] = [];
      for (let i = gens.length - 1; i > 0; i--) {
        steps.push(
          rnd() < 0.15
            ? { kind: 'full', body: gens[i - 1]! } // full 行の混在
            : stepFrom(gens[i]!, gens[i - 1]!),
        );
      }
      expect(restoreChainWasm(tip, steps), `seed step ${t}`).toBe(restoreChain(tip, steps));
    }
  });

  it('必須次元(ja / CRLF / 絵文字)を落とさない ── 宣言的に pin', () => {
    // review L6: 「ja 次元を消す」変異が検出されないのを防ぐ。ここが落ちたら
    // parity の網が狭まっている(ゼロ件の次元は「測っていない次元」)
    const required = ['ascii', 'ja', 'CRLF', '絵文字'];
    const covered = REQUIRED_VARIANTS.map(([name]) => name);
    expect(covered).toEqual(required);
  });

  it('値域外の ops は wasm に渡さず TS へ委譲する(解釈の分岐を作らない)', () => {
    // review M1: putU32 は mod 2^32 に潰れ・小数を切り捨てるので、渡すと
    // 「TS は throw、wasm はそれらしい本文」という分岐ができる
    expect(restoreChainWasm('a\nb\n', [{ kind: 'patch', ops: [-4294967296, 1] }])).toBeNull();
    expect(restoreChainWasm('a\nb\n', [{ kind: 'patch', ops: [1.5] }])).toBeNull();
    // 巨大 count(Rust 側の境界検査を wrap で抜けようとする形)も渡さない
    expect(restoreChainWasm('a\n', [{ kind: 'patch', ops: [1, 4294967295] }])).toBeNull();
    expect(wasmStatus().poisoned).toBe(false); // 毒化させずに機能継続
  });

  it('大きな入力の後で linear memory を回収する(高水位を worker に残さない)', () => {
    // review H2 / doc F4: wasm の memory は縮まないので、閾値超過で instance ごと
    // 作り直す。これが無いと 34MB の本文 1 回で数百 MB が居座る(実測 206MB)
    const before = wasmMemoryBytes();
    const small = 'x\n'.repeat(50);
    expect(restoreChainWasm(small, [{ kind: 'patch', ops: [50] }])).toBe(small);
    const big = ('あ'.repeat(200) + '\n').repeat(20000); // UTF-8 で約 36MB
    expect(restoreChainWasm(big, [{ kind: 'full', body: big }])).toBe(big);
    const after = wasmMemoryBytes();
    expect(after).toBeLessThanOrEqual(Math.max(before, 4 * 1024 * 1024));
    // 回収後も普通に使える(捨てて作り直しただけ)
    expect(restoreChainWasm(small, [{ kind: 'patch', ops: [50] }])).toBe(small);
    expect(wasmStatus().ready).toBe(true);
  });

  it('壊れたパッチは TS と同じ文言で失敗する(可視エラーの互換)', () => {
    const bad: ChainStep[] = [{ kind: 'patch', ops: [99] }]; // 行数を超える copy
    expect(() => restoreChainWasm('a\n', bad)).toThrow(/copy overruns source/);
    expect(() => restoreChain('a\n', bad)).toThrow(/copy overruns source/);
    const notConsumed: ChainStep[] = [{ kind: 'patch', ops: [1] }];
    expect(() => restoreChainWasm('a\nb\n', notConsumed)).toThrow(/not fully consumed/);
    expect(() => restoreChain('a\nb\n', notConsumed)).toThrow(/not fully consumed/);
  });

  it('未 init / reset 後は null を返し、caller が TS へ落ちられる', async () => {
    resetPkcCore();
    expect(restoreChainWasm('a\n', [])).toBeNull();
    expect(wasmStatus().ready).toBe(false);
    // 復帰できる(毒ではないので再 init 可能)
    expect(await initPkcCore(readFileSync(WASM_PATH))).toBe(true);
    expect(restoreChainWasm('a\n', [])).toBe('a\n');
  });
});
