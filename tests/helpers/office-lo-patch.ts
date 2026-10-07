/**
 * LO の patch(`build/office-wasm/patch-lo-*.py`)の test が共有する道具。
 *
 * ⚠ 錨の字をここへ書き写さない(python の module から取り出す)/ 期待値は各 test が**手で書く**
 * (patch の定数から取ると、patch と期待値が同じ盲点を共有する)。
 *
 * 🔑 `compileAndRun` は、当てた後の C++ の**関数だけ**を取り出し、型を stub に替えた harness で本当に
 * コンパイル(`-Wall -Wextra -Werror`)して走らせる。本物の LO の header ではないので、言えるのは
 * 「書いた式の型・書式指定子・分岐が筋の通った C++ で、期待どおり出入りする」まで。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** python の module から値を取り出す。 */
export function pyJson(script: string, expr: string): unknown {
  const code = [
    'import importlib.util,sys,json',
    'sys.dont_write_bytecode=True',
    `sp=importlib.util.spec_from_file_location("p","${script}")`,
    'm=importlib.util.module_from_spec(sp); sp.loader.exec_module(m)',
    `print(json.dumps(${expr}))`,
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf-8', stdio: 'pipe' }));
}

export interface Tree {
  dir: string;
  read: () => string;
  cleanup: () => void;
}

/** 当て先 1 file だけを置いた作業 dir。 */
export function makeTree(rel: string, prefix: string, body: string): Tree {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body, 'utf-8');
  return {
    dir,
    read: () => readFileSync(join(dir, rel), 'utf-8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function run(script: string, dir: string): { code: number; out: string } {
  const r = spawnSync('python3', [script, dir], { encoding: 'utf-8', stdio: 'pipe' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** 部分文字列の出現数。 */
export const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** 足した行(印を含む行)を取り除く。この系統の patch は**原文の行を 1 行も書き換えない**(足すだけ)。 */
export function restoreWithout(text: string, mark: string): string {
  return text
    .split('\n')
    .filter((l) => !l.includes(mark))
    .join('\n');
}

/** g++ が在るか(無い箱では harness の test を skip する。⚠ skip は「確かめていない」であって合格ではない)。 */
export function haveCxx(): boolean {
  return spawnSync('g++', ['--version'], { stdio: 'pipe' }).status === 0;
}

/** C++ を書いて `-Wall -Wextra -Werror` でコンパイルし、`args` で走らせる。 */
export function compileAndRun(
  source: string,
  args: string[] = [],
): { compile: number; compileOut: string; code: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-lo-harness-'));
  try {
    writeFileSync(join(dir, 'h.cpp'), source, 'utf-8');
    const c = spawnSync('g++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-o', join(dir, 'h'), join(dir, 'h.cpp')], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    if (c.status !== 0) {
      return { compile: c.status ?? -1, compileOut: `${c.stdout}${c.stderr}`, code: -1, stdout: '', stderr: '' };
    }
    const r = spawnSync(join(dir, 'h'), args, { encoding: 'utf-8', stdio: 'pipe' });
    return { compile: 0, compileOut: '', code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `startNeedle` から、最初の `\n}\n` までを取り出す(関数 1 つ)。 */
export function extractFunction(text: string, startNeedle: string): string {
  const at = text.indexOf(startNeedle);
  if (at < 0) throw new Error(`関数が無い: ${startNeedle}`);
  const end = text.indexOf('\n}\n', at);
  if (end < 0) throw new Error(`関数の終わりが無い: ${startNeedle}`);
  return text.slice(at, end + 3);
}
