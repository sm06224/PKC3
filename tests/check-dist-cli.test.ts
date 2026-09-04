/** @vitest-environment node */
/**
 * 検品 CLI の I/O(P7 段⑧)。規則そのものは `tests/dist-inspect.test.ts` が見る。
 *
 * 🔴 **検品する側も変異の対象**(CLAUDE.md)。段⑧ で「どこを検品するか」を
 * 引数で受けられるようにしたが、**引数を無視する変異が全緑で生き残った** ──
 * Pages は `_site/`(release の zip を展開したもの)を検品するので、引数が
 * 効いていないと **`dist/` を見て「✓ ok」と言いながら、別物を配る**。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** CLI を走らせて `{ code, out }` を返す(落ちても投げない)。 */
function run(args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync('node', ['scripts/check-dist.mjs', ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('検品 CLI', () => {
  it('kind を渡さないと使い方を出して落ちる', () => {
    const r = run([]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('usage:');
  });

  it('🔴 **渡した directory を**検品する(引数を無視しない)', () => {
    // ⚠ 観測点は「その directory の中身を数えているか」。`dist/` を見ていると
    // 件数が合わない ── 「✓ ok と言いながら別物を配る」形を直接見る
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-check-'));
    try {
      mkdirSync(join(dir, 'assets'));
      writeFileSync(join(dir, 'index.html'), '<!doctype html>');
      writeFileSync(join(dir, 'assets', 'x-AAAAAAAA.js'), 'console.log(1)');
      const r = run(['product', dir]);
      // 中身が足りないので落ちるのが正しい ── 見ているのは**件数**
      expect(r.out).toContain('ファイル 2 件');
      expect(r.code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * 🔴 **`--require-manual` が届く**(#648 💭)。観測点は**その門の文言** ── 旗を無視する
   *   変異(位置引数の数え方を戻す等)は、同じ dir で「無い」の文言が出ないことで分かる。
   */
  it('🔴 --require-manual を渡すと、manual.html が無い product で鳴る(旗が届いている)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-check-'));
    try {
      writeFileSync(join(dir, 'index.html'), '<!doctype html>');
      const withFlag = run(['product', dir, '--require-manual']);
      expect(withFlag.code).toBe(1);
      expect(withFlag.out).toContain('焼きたての product なのに dist に manual.html が無い');
      // 対照群 ── 旗が無ければその門は鳴らない(他の理由では落ちるが、この文言は出ない)
      const without = run(['product', dir]);
      expect(without.code).toBe(1);
      expect(without.out).not.toContain('焼きたての product');
      // ⚠ 旗は dir の前に置いても届く(位置引数と混ざらない)
      expect(run(['product', '--require-manual', dir]).out).toContain('焼きたての product');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('🔴 知らない旗は使い方を出して落ちる(綴りを間違えた旗で門が消えない)', () => {
    const r = run(['product', '--require-manaul']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('知らない旗');
    expect(r.out).toContain('usage:');
  });

  it('無い directory を渡したら理由を言って落ちる', () => {
    const r = run(['product', join(tmpdir(), 'pkc3-does-not-exist-xyz')]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('検品対象が無い');
  });

  it('🔴 既定は dist/(**引数ありと同じ結果**になる)', () => {
    // 🔴 かつては `/ファイル \d+ 件|検品対象が無い/` で見ていたが、**どちらの結末も
    // 受ける**ので既定を `node_modules/.bin` に変えても全緑だった(round-3 review L-1)。
    // ⚠ しかも CI は `npm test` を `npm run build` より**前**に走らせるので、
    // この test は常に「無い」側を通っていた ── 状態に依らず弁別する形にする:
    // **引数なし** と **引数 `dist`** の結果が一致すること
    const bare = run(['dev']);
    const explicit = run(['dev', 'dist']);
    expect(bare.code).toBe(explicit.code);
    expect(bare.out).toBe(explicit.out);
  });
});
