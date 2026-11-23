/**
 * 🔴 **`title` を直接消す / 読む経路の全数検査**(#1982 A3)。
 *
 * ツールチップは hover 中だけ要素の `title` を退避する(属性を外して `data-pkc-tip-title` に持つ)。
 * 退避中に `removeAttribute('title')` で消そうとしても属性が無いので**空振りし、離れたとき古い字が戻る**。
 * 読む側(`getAttribute('title')`)も退避中は `null` を返す。だから **hover 中に走りうる経路は
 * `setTipTitle` / `getTipTitle`(`render/tooltip.ts`)を使う**。ここは直接呼びの数を allowlist で固定する。
 *
 * - 増えて落ちた: hover 中に走りうるなら口へ寄せる。走らない(再描画で要素ごと作り直す等)なら、理由を 1 行書いて足す。
 * - 減って落ちた: allowlist の数を直す。
 * - `.title = '…'`(代入)は対象外: 退避中の代入は `MutationObserver` が拾って退避を置き換える
 *   (`tests/adapter/tooltip.test.ts`「退避中に title を書き換えたら」)ので、消える・古い字が戻ることは起きない。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../../src/adapter');

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** コメント行(`*` / `//` / `/*` 始まり)を除いた行だけ数える。 */
function count(re: RegExp): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of walk(ROOT)) {
    let n = 0;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue;
      if (re.test(t)) n += 1;
    }
    if (n > 0) m.set(relative(ROOT, f), n);
  }
  return m;
}

function expectExactly(actual: Map<string, number>, allow: Record<string, { n: number; why: string }>): void {
  const got = Object.fromEntries(actual);
  const want = Object.fromEntries(Object.entries(allow).map(([k, v]) => [k, v.n]));
  expect(got, '直接呼びの場所・数が allowlist と違う(hover 中に走りうるなら setTipTitle / getTipTitle へ)').toEqual(want);
}

describe("title の直接操作は allowlist だけ", () => {
  it("removeAttribute('title')", () => {
    const hit = count(/removeAttribute\(\s*['"]title['"]/);
    expect(hit.size, '前提: tooltip.ts 自身は数えられている(空振り防止)').toBeGreaterThan(0);
    expectExactly(hit, {
      'ui/render/tooltip.ts': { n: 4, why: '退避の口そのもの(setTipTitle / hide 復元 / resync / begin)' },
    });
  });
  it("getAttribute('title')", () => {
    const hit = count(/getAttribute\(\s*['"]title['"]/);
    expect(hit.size).toBeGreaterThan(0);
    expectExactly(hit, {
      'ui/render/tooltip.ts': { n: 3, why: 'getTipTitle / resync / begin(退避の口そのもの)' },
      'ui/render/link-preview.ts': {
        n: 1,
        why: '押した直後に読む ── pointerdown でツールチップは隠れ退避は戻っている',
      },
      'ui/render/external-link.ts': {
        n: 1,
        why: '本文の描画直後に走る(要素を新しく作った直後で、hover されていない)',
      },
    });
  });
  it("hasAttribute('title')", () => {
    expectExactly(count(/hasAttribute\(\s*['"]title['"]/), {
      'ui/render/tooltip.ts': { n: 1, why: 'hide の復元(書き直されていたら新しい方を残す)' },
    });
  });
});
