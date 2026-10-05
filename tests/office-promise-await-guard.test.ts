/** @vitest-environment node */
/**
 * `build/office-wasm/patch-soffice-js-promise-await.mjs` を検める(#1344 ── `emscripten_promise_await` の起こしの門)。
 *
 * ## 何を直すか
 *
 * LO の main thread は `ProcessEvent` を handler thread へ proxy し `emscripten_promise_await` で待つ。その間に来た
 * DOM event が別の promising な計算としてメニューの loop を Qt の wait で止めると、proxy の戻りで main が
 * **門なしで起こされ、生きているメニューの frame の上を走る**(2026-10-05 の trace: `pa-mismatch dir=above` →
 * `js-inverted` → trap)。この patch は promise が解決したとき `stackSave()` が await 時の sp へ戻るまで起こさない。
 *
 * | 見る | 見ない |
 * |---|---|
 * | 錨(Emscripten 4.0.10 の字)に 1 度だけ当たる / 二重当て・錨無しは落ちて file 不変 | 焼きで本当に置換されるか(workflow の step。`tests/workflow-steps.test.ts` が pin) |
 * | 🔑 置換後の JS を偽の `stackSave` / timer で実走(sp が同じ → すぐ起きる / 上に frame → 待つ / 戻れば起きる / 250 周で診断と間引き / `stackSave` 無しは門なし) | 実ブラウザで trap が消えるか(probe。scratchpad 121q) |
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANCHOR, MARK, REPLACEMENT, patchText } from '../build/office-wasm/patch-soffice-js-promise-await.mjs';

const SCRIPT = 'build/office-wasm/patch-soffice-js-promise-await.mjs';
const FIXTURE = 'tests/fixtures/emscripten/promise-await-4.0.10.excerpt.txt';
const ORIG = readFileSync(FIXTURE, 'utf-8');

function run(path: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', [SCRIPT, path], { encoding: 'utf-8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('promise_await の門 ── 当て方', () => {
  it('🔴 fixture(Emscripten 4.0.10 の字)に錨が 1 件在り、当てると印が 1 度入って錨が消える', () => {
    expect(ORIG.split(ANCHOR).length - 1, 'fixture に錨が 1 件でない(fixture を手で触った?)').toBe(1);
    const out = patchText(ORIG);
    expect(out.split(MARK).length - 1).toBe(1);
    expect(out).not.toContain(ANCHOR);
    expect(out).toContain('_emscripten_promise_await.isAsync=true;');
    // 構文(裸の識別子は引数で渡す)
    expect(() => new Function('Asyncify', 'getPromise', 'setPromiseResult', 'stackSave', 'setTimeout', 'Module', REPLACEMENT)).not.toThrow();
  });

  it('⚠ CLI: 2 度当てると落ち、file は 1 バイトも変わらない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-pa-'));
    const f = join(dir, 'soffice.js');
    try {
      writeFileSync(f, ORIG);
      expect(run(f).code).toBe(0);
      const once = readFileSync(f, 'utf-8');
      expect(once).toContain(MARK);
      const again = run(f);
      expect(again.code).toBe(1);
      expect(again.out).toContain('既に当たっている');
      expect(readFileSync(f, 'utf-8')).toBe(once);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('🔴 錨が無ければ(Emscripten の版が変わって字が変わったら)落ちて、file は不変 ── 黙って素通りしない', () => {
    const broken = ORIG.replace('returnValuePtr>>>=0;id>>>=0;', 'returnValuePtr>>>=0;id>>>=0;/*x*/');
    expect(broken).not.toBe(ORIG);
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-pa-'));
    const f = join(dir, 'soffice.js');
    try {
      writeFileSync(f, broken);
      const r = run(f);
      expect(r.code).toBe(1);
      expect(r.out).toContain('錨が 0 件');
      expect(readFileSync(f, 'utf-8')).toBe(broken);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 🔑 置換後の JS を **node で実走**する。偽物:
 * - `Asyncify.handleAsync(f)` = `f()`(JSPI では import の promise がそのまま計算の起こしになる)
 * - `getPromise(id)` = 外から resolve できる promise(proxy の結果)
 * - `stackSave()` = 台の `sp`(shadow stack の模型。上に frame が生きている = 低い値)
 * - `setTimeout` = 手で回す timer(第 2 引数も採る)
 */
describe('promise_await の門 ── 実走', () => {
  function harness(src: string, opt: { stackSave?: boolean } = {}) {
    let sp = 65536;
    const timers: (() => void)[] = [];
    const delays: number[] = [];
    const errs: string[] = [];
    const results: unknown[] = [];
    let resolveInner: ((v: unknown) => void) | null = null;
    const Module: Record<string, unknown> = {};
    const fn = new Function(
      'Asyncify',
      'getPromise',
      'setPromiseResult',
      'stackSave',
      'setTimeout',
      'Module',
      'console',
      `${src}\nreturn _emscripten_promise_await;`,
    )(
      { handleAsync: (f: () => Promise<unknown>) => f() },
      () => new Promise((res) => { resolveInner = res; }),
      (_p: number, ok: boolean, v: unknown) => { results.push([ok, v]); },
      opt.stackSave === false ? undefined : () => sp,
      (f: () => void, ms = 0) => { delays.push(ms); timers.push(f); },
      Module,
      { error: (...a: unknown[]) => errs.push(a.map(String).join(' ')) },
    ) as (p: number, id: number) => Promise<unknown>;
    let woke = 0;
    return {
      Module,
      timers,
      delays,
      errs,
      results,
      sp: (v?: number) => (v === undefined ? sp : (sp = v)),
      /** main が await に入る(呼んだ瞬間の sp を控える)。起きたら `woke` が増える。 */
      await(): void {
        void fn(16, 1).then(() => { woke += 1; });
      },
      /** proxy の結果が返る。 */
      settle(): void {
        resolveInner!('ok');
      },
      fire(): void {
        for (const t of timers.splice(0)) t();
      },
      async flush(): Promise<void> {
        for (let i = 0; i < 12; i++) await Promise.resolve();
      },
      woke: () => woke,
    };
  }

  /** 場面 A: sp が同じ(上に誰も居ない)→ timer 無しで起きる。 */
  async function sceneA(src: string): Promise<{ woke: number; timers: number; errs: number }> {
    const h = harness(src);
    h.await();
    await h.flush();
    h.settle();
    await h.flush();
    return { woke: h.woke(), timers: h.timers.length, errs: h.errs.length };
  }
  /** 場面 B: 上に frame が生きている(sp が低い)→ 待つ。戻った次の tick で起きる。診断は入った 1 回。 */
  async function sceneB(src: string): Promise<{ wokeWhileAbove: number; timersWhileAbove: number; wokeAfter: number; errs: string[]; resultsBeforeWake: number }> {
    const h = harness(src);
    h.await();
    await h.flush();
    h.sp(65536 - 48); // 別の計算が上に積んだ
    h.settle();
    await h.flush();
    const resultsBeforeWake = h.results.length;
    for (let i = 0; i < 5; i++) {
      h.fire();
      await h.flush();
    }
    const wokeWhileAbove = h.woke();
    const timersWhileAbove = h.timers.length;
    h.sp(65536); // 上の frame が返った
    h.fire();
    await h.flush();
    return { wokeWhileAbove, timersWhileAbove, wokeAfter: h.woke(), errs: h.errs, resultsBeforeWake };
  }
  /** 場面 C: 250 周戻らない → 249 で診断 1(入った印)、250 で 2、以後の再予約は 100 ms。戻れば起きる。 */
  async function sceneC(src: string): Promise<{ at249: number; at250: number; delay250: number; delayBefore: number; wokeEnd: number }> {
    const h = harness(src);
    h.await();
    await h.flush();
    h.sp(65536 - 48);
    h.settle();
    await h.flush();
    for (let i = 0; i < 249; i++) {
      h.fire();
      await h.flush();
    }
    const at249 = h.errs.length;
    const delayBefore = h.delays[h.delays.length - 1]!;
    h.fire();
    await h.flush();
    const at250 = h.errs.length;
    const delay250 = h.delays[h.delays.length - 1]!;
    h.sp(65536);
    h.fire();
    await h.flush();
    return { at249, at250, delay250, delayBefore, wokeEnd: h.woke() };
  }
  const ABOVE = 'B1: 上に frame が生きているのに起こした(踏む)';
  function claims(a: Awaited<ReturnType<typeof sceneA>>, b: Awaited<ReturnType<typeof sceneB>>, c: Awaited<ReturnType<typeof sceneC>>): string[] {
    const bad: string[] = [];
    if (a.woke !== 1) bad.push('A1: 上に誰も居ないのに起きない');
    if (a.timers !== 0) bad.push('A2: 上に誰も居ないのに timer を置いた');
    if (a.errs !== 0) bad.push('A3: 上に誰も居ないのに診断が出た');
    if (b.wokeWhileAbove !== 0) bad.push(ABOVE);
    if (b.timersWhileAbove !== 1) bad.push(`B2: 待っている間の timer が ${b.timersWhileAbove} 本(1 本でない)`);
    if (b.wokeAfter !== 1) bad.push('B3: 上の frame が返った後の tick で起きていない');
    if (b.resultsBeforeWake !== 1) bad.push('B4: 結果の書き込みが起こす前に済んでいない');
    if (b.errs.filter((e) => /pa-defer n=1 /.test(e)).length !== 1) bad.push(`B5: 待ちに入った印が 1 件でない: ${b.errs.join(' | ')}`);
    if (b.errs.filter((e) => /pa-defer end/.test(e)).length !== 1) bad.push('B6: 戻った印が 1 件でない');
    if (!/dir=above/.test(b.errs[0] ?? '')) bad.push(`B7: 向きが above でない: ${b.errs[0]}`);
    if (c.at249 !== 1) bad.push(`C1: 249 周で診断が ${c.at249} 件(入った 1 件だけでない)`);
    if (c.at250 !== 2) bad.push(`C2: 250 周で診断が ${c.at250} 件(2 でない)`);
    if (c.delayBefore !== 0) bad.push(`C3: 250 周より前の再予約が ${c.delayBefore} ms(0 でない)`);
    if (c.delay250 !== 100) bad.push(`C4: 250 周目の再予約が ${c.delay250} ms(100 でない)`);
    if (c.wokeEnd !== 1) bad.push('C5: 戻った後に起きていない');
    return bad;
  }

  it('🔴 置換後: 上に誰も居なければすぐ起き、上に frame が生きていれば戻るまで待ち、250 周で診断と間引き', async () => {
    expect(claims(await sceneA(REPLACEMENT), await sceneB(REPLACEMENT), await sceneC(REPLACEMENT))).toEqual([]);
  });

  it('⚠ `stackSave` が無い一式では門なし(= 従来どおり。上に frame が居ても起きる)', async () => {
    const h = harness(REPLACEMENT, { stackSave: false });
    h.await();
    await h.flush();
    h.sp(65536 - 48);
    h.settle();
    await h.flush();
    expect(h.woke()).toBe(1);
    expect(h.timers.length).toBe(0);
  });

  it('🔴 対照・原文(Emscripten 4.0.10): 上に frame が生きていても起こす(= 踏む形。この patch が無いと戻る動き)', async () => {
    const orig = ANCHOR;
    const b = await sceneB(orig);
    expect(b.wokeWhileAbove, '原文でも待っている ── 対照群が踏みを再現していない').toBe(1);
  });

  const MUTANTS: { name: string; from: string; to: string; claim: string }[] = [
    { name: '① 門を外す(sp が違っても起こす)', from: 'if(sp===null||typeof stackSave!=="function"||stackSave()===sp)return r;', to: 'return r;', claim: 'B1' },
    { name: '② 戻ったのを見ずに起こす(tick で無条件に res)', from: 'if(stackSave()===sp){console.error("PKC3-UEV pa-defer end n="+n);res(r);return}', to: 'console.error("PKC3-UEV pa-defer end n="+n);res(r);return;', claim: 'B1' },
    { name: '③ 再予約を外す(戻ったのを誰も見ない)', from: 'setTimeout(tick,n>=250?100:0)};setTimeout(tick)', to: '};setTimeout(tick)', claim: 'B3' },
    { name: '④ 診断の閾値を 2 周にする', from: 'if(n===1||n===250)', to: 'if(n===1||n===2)', claim: 'C1' },
    { name: '⑤ 間引かない', from: 'setTimeout(tick,n>=250?100:0)', to: 'setTimeout(tick,0)', claim: 'C4' },
  ];
  it.each(MUTANTS)('🔴 変異 $name → KILLED', async ({ from, to, claim }) => {
    const hits = REPLACEMENT.split(from).length - 1;
    expect(hits, `NOT-APPLIED: 元の字が ${hits} 件`).toBe(1);
    const mutated = REPLACEMENT.replace(from, () => to);
    let bad: string[];
    try {
      bad = claims(await sceneA(mutated), await sceneB(mutated), await sceneC(mutated));
    } catch (e) {
      bad = [`threw: ${String(e)}`];
    }
    expect(bad.length, 'SURVIVED').toBeGreaterThan(0);
    expect(bad.some((c) => c.startsWith(claim)), `KILLED だが別の主張で: ${bad.join(' / ')}`).toBe(true);
  });
});
