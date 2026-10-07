/** @vitest-environment node */
/**
 * `build/office-wasm/qtbase-patch-ecmastring-threadsafe.py` を検める(#1394)。
 *
 * ## 何を直すか
 *
 * Office の窓へ外から貼った後に Ctrl+C すると窓が止まる(`invalid handle: N`)。
 * Qt 6.9 `qcore_wasm.cpp` の `fromEcmaString` / `toEcmaString` が持つ **関数内 static の
 * `emscripten::val`** は、emval の handle が作ったスレッドでしか有効でないのに
 * main と pthread の両方から呼ばれる。直しは **static をやめて毎回 `module_property` を取る**。
 *
 * ## ⚠ ここで検められること / 検められないこと
 *
 * 🔴 **compile も実行もできない**(emsdk も Qt ツリーもこの箱に無い)。
 *
 * | 見る | 見ない |
 * |---|---|
 * | 2 か所とも当たり、static の val が 0 件・`module_property` が 2 件 | その C++ がコンパイルできるか |
 * | 2 度当てても壊れない / 錨が 1 つでも無ければ**落ちて file 不変**(片側だけ直さない) | 実機で `invalid handle` が消えるか |
 *
 * 🔑 実機で効いたかは #1394 の検算(焼いて、貼ってから 2 回続けてコピー)で見る。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/qtbase-patch-ecmastring-threadsafe.py';
const REL = 'src/corelib/kernel/qcore_wasm.cpp';
/** 🔴 上流 Qt 6.9(branch 6.9 と v6.9.0 で同じ)の**原文の全文**(要約しない ── 錨は字面で当たる)。 */
const FIXTURE = 'tests/fixtures/qtbase/qcore_wasm.cpp';
const ORIG = readFileSync(FIXTURE, 'utf-8');

const FROM_LINE = 'static const emscripten::val stringToUTF16(emscripten::val::module_property("stringToUTF16"));';
const TO_LINE = 'static const emscripten::val UTF16ToString(emscripten::val::module_property("UTF16ToString"));';

function tree(text: string = ORIG): { dir: string; read(): string } {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-qt-ecma-'));
  const file = join(dir, REL);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf-8');
  return { dir, read: () => readFileSync(file, 'utf-8') };
}

/** patch を回す。⚠ **落ちても投げない**(exit を検めたいので自分で拾う)。 */
function run(dir: string): { code: number; out: string } {
  try {
    const out = execFileSync('python3', [SCRIPT, dir], { encoding: 'utf-8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** `//` のコメント行を落とす(⚠ 直しの解説に書いた字に満たされないため)。 */
function code(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

describe('QString の ECMAScript 変換の static val をやめる patch(#1394)', () => {
  it('🔑 前提:fixture は直す前の形(static 2 件・錨 2 行が 1 件ずつ)', () => {
    expect(count(code(ORIG), 'static const emscripten::val')).toBe(2);
    expect(count(ORIG, FROM_LINE)).toBe(1);
    expect(count(ORIG, TO_LINE)).toBe(1);
  });

  it('🔴 ① 2 か所とも当たり、static の val が 0 件・module_property が 2 件になる', () => {
    const t = tree();
    try {
      const r = run(t.dir);
      expect(r.code, `落ちた: ${r.out}`).toBe(0);
      const out = t.read();
      const c = code(out);
      expect(count(c, 'static const emscripten::val'), 'static が残っている').toBe(0);
      expect(count(c, 'module_property('), 'module_property が 2 件ではない').toBe(2);
      expect(c).toContain(
        'const emscripten::val stringToUTF16 = emscripten::val::module_property("stringToUTF16");',
      );
      expect(c).toContain(
        'const emscripten::val UTF16ToString = emscripten::val::module_property("UTF16ToString");',
      );
      // 周りは 1 字も動かない:直した 2 行と足したコメントを除いた残りは原文と同じ
      const strip = (s: string) =>
        s
          .split('\n')
          .filter((l) => !l.includes('module_property') && !l.includes('PKC3(#1394)') && !/^ {4}\/\/ (main と pthread|\(main の copy|同上)/.test(l))
          .join('\n');
      expect(strip(out), '直した 2 行の周りが動いている').toBe(strip(ORIG));
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('⚠ ② 2 度当てても同じ(冪等)', () => {
    const t = tree();
    try {
      expect(run(t.dir).code).toBe(0);
      const once = t.read();
      const again = run(t.dir);
      expect(again.code, `2 度目で落ちた: ${again.out}`).toBe(0);
      expect(again.out, '2 度目に SKIP と言っていない').toContain('SKIP');
      expect(t.read(), '2 度目で字が変わった').toBe(once);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  /**
   * 🔴 **空振り防止の本体** ── 上流が形を変えたら**落ちる**こと。⚠ 2 か所とも別々に殺す
   * (片方の錨が無くても落ちる = 「片側だけ直す」を許さない)。落ちたとき file は 1 字も変わらない。
   */
  it('🔴 ③ 錨を 1 字変えると落ちる(どちら側でも)・落ちたら file 不変', () => {
    for (const [name, line] of [
      ['fromEcmaString 側', FROM_LINE],
      ['toEcmaString 側', TO_LINE],
    ] as const) {
      const broken = ORIG.replace(line, line.replace('static const', 'static  const'));
      expect(broken, `${name}: 変異が当たっていない`).not.toBe(ORIG);
      const t = tree(broken);
      try {
        const r = run(t.dir);
        expect(r.code, `${name}: 錨が無いのに通った`).not.toBe(0);
        expect(r.out, `${name}: 何が食い違ったか言っていない`).toContain('錨が 0 件');
        expect(t.read(), `${name}: 落ちたのに file を書き換えた(半分だけ直った)`).toBe(broken);
      } finally {
        rmSync(t.dir, { recursive: true, force: true });
      }
    }
  });

  it('🔴 ③b 錨が 2 件になっても落ちる(一意でない錨で黙って直さない)', () => {
    const t = tree(`${ORIG}\n    ${TO_LINE}\n`);
    try {
      const r = run(t.dir);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('錨が 2 件');
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('引数が違えば usage を出して 2 で落ちる(既存の qtbase patch と同じ形)', () => {
    let status = 0;
    let err = '';
    try {
      execFileSync('python3', [SCRIPT], { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e) {
      const x = e as { status?: number; stderr?: string };
      status = x.status ?? -1;
      err = x.stderr ?? '';
    }
    expect(status).toBe(2);
    expect(err).toContain('usage');
  });
});
