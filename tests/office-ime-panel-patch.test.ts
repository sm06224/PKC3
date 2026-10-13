/** @vitest-environment node */
/**
 * `build/office-wasm/qtbase-patch-ime-panel.py` を検める(#156 / #1438)。
 *
 * ## 何を直すか
 *
 * Qt 6.9 wasm の IME 用 `<input>` に焦点が一度も移らない。`updateInputElement()` は
 * `m_inputMethodAccepted` が true でないと焦点を当てないが、LO は `WA_InputMethodEnabled` を
 * `setFocusObject()` の**後**に立てる。#1438 では `update(Qt::ImEnabled)` でそれを拾う hunk を、
 * **メイン thread へ `QMetaObject::invokeMethod(..., Qt::QueuedConnection)` で渡す形**で戻した
 * (直接 `updateInputElement()` を呼ぶと LO の thread から emval を触って `invalid handle` で固まった)。
 *
 * ## ⚠ ここで検められること / 検められないこと
 *
 * 🔴 **compile も実行もできない**(emsdk も Qt ツリーもこの箱に無い。焼きで見る)。
 *
 * | 見る | 見ない |
 * |---|---|
 * | 上流 6.9 の**原文の全文**に当たる / 足した行は全部印つき / 2 度目は SKIP / 錨が無ければ exit 1 | その C++ がコンパイルできるか |
 * | 🔑 `update()` の**実行する行**で emval(`m_inputElement` / `updateInputElement`)と再評価に触れるのは、渡した functor の中だけ | 実機で焦点が `<input>` に移るか(焼いた一式の `ime-compose-probe.mjs`) |
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = 'build/office-wasm/qtbase-patch-ime-panel.py';
const INPUTCTX = 'build/office-wasm/qtbase-patch-inputcontext.py';
const DIR = 'src/plugins/platforms/wasm';
const MARK = 'PKC3-IMEUPDATE';
/** 🔴 上流 Qt 6.9 の**原文の全文**(要約しない ── 錨は字面で当たる)。 */
const CPP = readFileSync('tests/fixtures/qtbase/qwasminputcontext.cpp', 'utf-8');
const HDR = readFileSync('tests/fixtures/qtbase/qwasminputcontext.h', 'utf-8');

const UPDATE_ORIG =
  '{\n    qCDebug(qLcQpaWasmInputContext) << Q_FUNC_INFO << queries;\n\n    QPlatformInputContext::update(queries);\n}';

function tree(cpp: string = CPP, h: string = HDR): { dir: string; read(f: 'cpp' | 'h'): string } {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-qt-imepanel-'));
  mkdirSync(join(dir, DIR), { recursive: true });
  writeFileSync(join(dir, DIR, 'qwasminputcontext.cpp'), cpp, 'utf-8');
  writeFileSync(join(dir, DIR, 'qwasminputcontext.h'), h, 'utf-8');
  return {
    dir,
    read: (f) => readFileSync(join(dir, DIR, f === 'cpp' ? 'qwasminputcontext.cpp' : 'qwasminputcontext.h'), 'utf-8'),
  };
}

/** patch を回す。⚠ **落ちても投げない**(exit を検めたいので自分で拾う)。 */
function run(script: string, dir: string): { code: number; out: string } {
  try {
    const out = execFileSync('python3', [script, dir], { encoding: 'utf-8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** `QWasmInputContext::update(` の関数本体(波括弧が閉じるまで)。 */
function updateBody(text: string): string[] {
  const lines = text.split('\n');
  const fn = lines.findIndex((l) => l.startsWith('void QWasmInputContext::update(Qt::InputMethodQueries'));
  expect(fn, 'update() が見つからない').toBeGreaterThan(-1);
  const end = lines.findIndex((l, i) => i > fn && l === '}');
  return lines.slice(fn, end + 1);
}

const { PATCHED, HPATCHED } = (() => {
  const t = tree();
  try {
    const r = run(SCRIPT, t.dir);
    if (r.code !== 0) throw new Error(`ime-panel が上流の原文に当たらない: ${r.out}`);
    return { PATCHED: t.read('cpp'), HPATCHED: t.read('h') };
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
})();

describe('#1438 の直し(ime-panel の update() → main thread)', () => {
  it('🔑 前提:原文に印は無く、update() は基底を呼ぶだけ・m_inputElement は emscripten::val である', () => {
    expect(count(CPP, MARK)).toBe(0);
    expect(count(CPP, UPDATE_ORIG), 'update() の本体が原文と違う').toBe(1);
    expect(HDR).toContain('emscripten::val m_inputElement');
  });

  it('🔴 ① update() が ImEnabled を拾い、再評価と updateInputElement() を Qt::QueuedConnection の functor の中でだけ行う', () => {
    // 🔑 コメントを落として、実行する行だけで見る(解説の字に満たされない)
    const code = updateBody(PATCHED)
      .map((l) => l.replace(/\s*\/\/.*$/, ''))
      .filter((l) => l.trim() !== '');
    const at = (needle: string): number => code.findIndex((l) => l.includes(needle));
    const iGate = at('queries.testFlag(Qt::ImEnabled)');
    const iInvoke = at('QMetaObject::invokeMethod(this, [this]()');
    const iRead = at('inputMethodAccepted() != m_inputMethodAccepted');
    const iUpdate = at('updateInputElement();');
    const iQueued = at('}, Qt::QueuedConnection);');
    const iBase = at('QPlatformInputContext::update(queries);');
    // 並び:ImEnabled の門 → invokeMethod → 再評価 → updateInputElement → QueuedConnection → 基底
    const order = [iGate, iInvoke, iRead, iUpdate, iQueued, iBase];
    expect(order.every((x, k) => x > -1 && (k === 0 || x > order[k - 1]!)), `並びが違う: ${order}`).toBe(true);
    // 🔴 emval に触れる物と再評価は、functor の中(invokeMethod と QueuedConnection の間)にしか無い
    const outside = code.filter((_, i) => i < iInvoke || i > iQueued);
    expect(
      outside.filter((l) => /updateInputElement|m_inputElement|inputMethodAccepted\(\)/.test(l)),
      'functor の外(= 呼んだ thread)で emval / 再評価に触れている',
    ).toEqual([]);
    expect(count(code.join('\n'), 'updateInputElement'), 'updateInputElement の呼びは 1 件').toBe(1);
    // 同期の接続(Direct / BlockingQueued / Auto)ではない
    expect(code.join('\n')).not.toMatch(/Qt::(Direct|BlockingQueued|Auto)Connection/);
  });

  it('🔴 ⑤ 足した行は全部印つきで、update() の外の変更は別の hunk(再取得+診断)だけ', () => {
    const marked = PATCHED.split('\n').filter((l) => l.includes(MARK));
    expect(marked.length, '印つきの行が 10 行(コメント 4 + 実行 6)ではない').toBe(10);
    // 印の行を落としたら update() は原文の枠に戻る
    const rest = PATCHED.split('\n')
      .filter((l) => !l.includes(MARK))
      .join('\n');
    expect(count(rest, UPDATE_ORIG), '印の行を落としても update() が原文に戻らない').toBe(1);
    // update() より前(include / static 関数 / ctor)は 1 バイトも動かない
    const head = (t: string): string => t.split('void QWasmInputContext::update(')[0]!;
    expect(head(PATCHED), 'update() より前が動いている').toBe(head(CPP));
  });

  it('② 既存の hunk(m_inputMethodAccepted の再取得・診断・panel の門の無効化)も同じ回で当たる', () => {
    expect(PATCHED).toContain('m_inputMethodAccepted = inputMethodAccepted();');
    expect(PATCHED).toContain('data-pkc-ime');
    expect(HPATCHED).toContain('bool m_visibleInputPanel = true;');
  });

  it('⚠ 2 度当てると何も変わらない(冪等)', () => {
    const t = tree(PATCHED, HPATCHED);
    try {
      const again = run(SCRIPT, t.dir);
      expect(again.code, `2 度目が落ちた: ${again.out}`).toBe(0);
      expect(again.out).toContain('update-marshal: already patched');
      expect(t.read('cpp'), '2 度目で字が変わった').toBe(PATCHED);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('🔴 ③ update() の錨が無い入力は exit 1(「目印が 0 件」)で言う', () => {
    const broken = CPP.replace(
      'void QWasmInputContext::update(Qt::InputMethodQueries queries)',
      'void QWasmInputContext::updateX(Qt::InputMethodQueries queries)',
    );
    expect(broken, '変異が当たっていない').not.toBe(CPP);
    const t = tree(broken);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, '錨が無いのに通った').toBe(1);
      expect(r.out).toContain('update-marshal');
      expect(r.out).toContain('目印が 0 件');
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('🔑 他の qtbase patch(inputcontext #134)と同じ file に重ねて当てても両方当たる', () => {
    const t = tree();
    try {
      expect(run(SCRIPT, t.dir).code).toBe(0);
      const r = run(INPUTCTX, t.dir);
      expect(r.code, `inputcontext が重ならない: ${r.out}`).toBe(0);
      const text = t.read('cpp');
      expect(count(text, MARK)).toBe(10);
      expect(text).toContain('hintQuery');
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});
