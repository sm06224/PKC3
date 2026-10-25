/** @vitest-environment node */
/**
 * `build/office-wasm/qtbase-patch-copy-keep.py` を検める(#121 / #774)。
 *
 * 🔴 直す物: 画像を選んで Ctrl+C すると、外でコピーしていた字が消えて空になる。Qt 6.9 `qwasmclipboard.cpp` の
 * `commonCopyEvent()` は、運べる物(字 / HTML / 空でない他の型)が 1 つも無くても最後に `preventDefault()` するので、
 * ブラウザは空の clipboardData でクリップボードを上書きする。直しは「運べる物が無ければ preventDefault せず返る」。
 *
 * 🔴 compile も実行もできない。見るのは ① 上流の原文(全文)に当たる ② 中身があるときの経路を 1 行も変えない
 * ③ 二重当て / 錨が無いときの扱い ④ workflow が本数を数えている。効いたかは焼いて `clipboard-probe.mjs` の `B3` で見る。
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/qtbase-patch-copy-keep.py';
const REL = 'src/plugins/platforms/wasm/qwasmclipboard.cpp';
const ORIG = readFileSync('tests/fixtures/qtbase/qwasmclipboard.cpp', 'utf-8');

function tree(text: string = ORIG) {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-qt-copykeep-'));
  mkdirSync(dirname(join(dir, REL)), { recursive: true });
  writeFileSync(join(dir, REL), text, 'utf-8');
  return {
    dir,
    read: () => readFileSync(join(dir, REL), 'utf-8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const run = (dir: string) => {
  const r = spawnSync('python3', [SCRIPT, dir], { encoding: 'utf-8', stdio: 'pipe' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};
const fn = (text: string) => {
  const at = text.indexOf('static void commonCopyEvent');
  return text.slice(at, text.indexOf('void QWasmClipboard::cut', at));
};
const PREVENT = 'event.call<void>("preventDefault");';

describe('#121 の直し(copy-keep)', () => {
  it('🔴 上流の原文(全文)に当たり、preventDefault の直前に「運べる物が無ければ返る」門が入る', () => {
    const t = tree();
    try {
      expect(run(t.dir).code).toBe(0);
      const body = fn(t.read());
      const guard = body.indexOf('if (!pkcHasBinary)');
      const prevent = body.indexOf(PREVENT);
      expect(guard).toBeGreaterThan(0);
      expect(guard, '門が preventDefault より後ろ').toBeLessThan(prevent);
      expect(body.slice(guard, guard + 60)).toContain('return;');
      expect(body, '字 / HTML の有無で門を開けていない').toContain('!_mimes->hasText() && !_mimes->hasHtml()');
      expect(t.read().split(PREVENT).length, 'preventDefault の数が変わった').toBe(ORIG.split(PREVENT).length);
    } finally {
      t.cleanup();
    }
  });

  it('🔑 中身があるときの経路は 1 行も変わらない(原文の字のある行が、同じ順で全部残る)', () => {
    const t = tree();
    try {
      run(t.dir);
      const kept = t.read().split('\n').filter((l) => l.trim() !== '');
      const orig = ORIG.split('\n').filter((l) => l.trim() !== '');
      let i = 0;
      for (const l of kept) if (i < orig.length && l === orig[i]) i += 1;
      expect(i, '原文の行が消えた / 並びが変わった').toBe(orig.length);
    } finally {
      t.cleanup();
    }
  });

  it('二重当ては SKIP で file は不変 / 錨が無ければ落ちて file は不変', () => {
    const t = tree();
    try {
      run(t.dir);
      const once = t.read();
      const second = run(t.dir);
      expect(second.code).toBe(0);
      expect(second.out).toContain('SKIP');
      expect(t.read()).toBe(once);
    } finally {
      t.cleanup();
    }
    const broken = ORIG.replace('void QWasmClipboard::cut(val event)', 'void QWasmClipboard::cut2(val event)');
    const u = tree(broken);
    try {
      expect(run(u.dir).code).toBe(1);
      expect(u.read()).toBe(broken);
    } finally {
      u.cleanup();
    }
  });

  it('🔑 workflow が qtbase patch の本数(6 → 7)を数えている', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(yml).toMatch(/6 → 7\(2026-10-25\)/);
    expect(yml).toContain('test "$n" -eq 7');
  });
});
