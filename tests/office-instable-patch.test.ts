/**
 * `patch-lo-instable.py`(#135)── 上流が自分で直した日に焼きを止めない(2026-10-07)。
 *
 * 🔴 run 37586026030 は、上流 `libreoffice-26-8` が `7f96a38c` → `d6226c1a` へ動き、
 *   `SelFormatHdl` / `OKHdl` が `styleIdx == -1` を自分で扱うようになったので、錨 0 件で
 *   **焼きが丸ごと止まった**(Qt の焼き直し 27 分の後)。目的(#135)は上流で満たされているのに
 *   落ちるのは、門の主張(「空の一覧で -1 を読まない」)ではなく錨の字面を守っていたからである。
 *
 * 見る物(fixture は上流の実物の全文 2 版):
 * - 古い形(7f96a38c)には当たる(従来どおり)
 * - 新しい形(d6226c1a)は SKIP(exit 0)で file は 1 字も変わらない
 * - 片方だけ新しい形(= 上流が別の変え方をした)は exit 1 で file 不変 ── 黙って通さない
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-instable.py';
const REL = 'sw/source/ui/table/instable.cxx';
const OLD = readFileSync('tests/fixtures/office-lo/instable.7f96a38c.cxx', 'utf8');
const NEW = readFileSync('tests/fixtures/office-lo/instable.d6226c1a.cxx', 'utf8');

function tree(src: string) {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-instable-'));
  mkdirSync(join(dir, 'sw/source/ui/table'), { recursive: true });
  const file = join(dir, REL);
  writeFileSync(file, src);
  return { dir, file, read: () => readFileSync(file, 'utf8') };
}
function run(dir: string) {
  const r = spawnSync('python3', ['-I', SCRIPT, dir], { encoding: 'utf8', stdio: 'pipe' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('patch-lo-instable.py: 上流が直した形', () => {
  // 前提(fixture が主張どおりの形か ── 空振り防止)
  it('fixture: 古い形は assert を持ち、新しい形は -1 を両方の handler で扱う', () => {
    expect(OLD.split('assert(styleIdx != -1').length - 1).toBe(2);
    expect(NEW.includes('assert(styleIdx != -1')).toBe(false);
    expect(NEW.split('if (styleIdx == -1)').length - 1).toBe(1);
    expect(NEW.split('if (styleIdx != -1)').length - 1).toBe(1);
    expect(OLD).not.toBe(NEW);
  });

  it('古い形(7f96a38c)には従来どおり当たる', () => {
    const t = tree(OLD);
    try {
      const r = run(t.dir);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('patched');
      const c = t.read();
      expect(c).not.toContain('assert(styleIdx != -1');
      expect(c.split('styleIdx < 0').length - 1).toBe(1);
      expect(c.split('styleIdx >= 0').length - 1).toBe(1);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('新しい形(d6226c1a)は SKIP で通し、file は 1 字も変わらない', () => {
    const t = tree(NEW);
    try {
      const r = run(t.dir);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('SKIP');
      expect(t.read()).toBe(NEW);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('片方だけ新しい形(上流が別の変え方をした)は落ちて、file は不変', () => {
    // 新しい形から OKHdl 側の `if (styleIdx != -1)` を古い assert に戻した混ぜ物
    const hybrid = NEW.replace('    if (styleIdx != -1)\n', '    assert(styleIdx != -1 && "nothing selected");\n    if (true)\n');
    expect(hybrid, '混ぜ物が作れていない(fixture の形が変わった)').not.toBe(NEW);
    const t = tree(hybrid);
    try {
      const r = run(t.dir);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('錨が 0 件');
      expect(t.read()).toBe(hybrid);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});
