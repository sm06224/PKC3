/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-idles-deadlock.py` を検める(#199 の**直し**)。
 *
 * 🔴 **これは配る一式に入る直しである**(計装ではない)。9 巡分の焼きで輪が確定した:
 * メインは proxy した user event の Link の戻りを待ち、その Link(docx の取込)は
 * `IdlesLockGuard` でメインが `Application::Execute` へ戻るのを待つ ──
 * **互いに相手の前進を待っていた**。
 *
 * ⚠ **錨は上流の実物と一字一句同じ**でなければならない。上流が形を変えたら
 * **黙って当たらない**のではなく**落ちる**こと ── それがこの検査の主眼である。
 *
 * ⚠ 見るのは 4 つ:①当たる ②当たった結果に**両方の直し**が入る
 * ③二重当ては落ちる ④**錨が無ければ落ちる**(上流の変形に気づける)。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-idles-deadlock.py';
const REL = 'vcl/source/app/scheduler.cxx';

/**
 * 🔴 **上流の実物と同じ字**(`3ccbe525` / `b5e9a38e` の両方で一致を確認済み)。
 * ⚠ ここを「だいたい同じ」で書くと、**patch が本物に当たらないのに test は緑**になる。
 */
const UPSTREAM = `Scheduler::IdlesLockGuard::IdlesLockGuard()
{
    ImplSVData* pSVData = ImplGetSVData();
    ImplSchedulerContext& rSchedCtx = pSVData->maSchedCtx;
    osl_atomic_increment(&rSchedCtx.mnIdlesLockCount);
    if (!Application::IsMainThread())
    {
        // Make sure that main thread has reached the main message loop, so no idles are executing.
        // It is important to ensure this, because e.g. ProcessEventsToIdle could be executed in a
        // nested event loop, while an active processed idle in the main thread is waiting for some
        // condition to proceed. Only main thread returning to Application::Execute guarantees that
        // the flag really took effect.
        pSVData->m_inExecuteCondtion.reset();
        // Put an empty event to the application's queue, to make sure that it loops through the
        // code that sets the condition, even when there's no other events in the queue
        Application::PostUserEvent({});
        SolarMutexReleaser releaser;
        pSVData->m_inExecuteCondtion.wait();
    }
}
`;

interface Tree {
  dir: string;
  read: () => string;
  run: () => { code: number; out: string };
}

function tree(body: string): Tree {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-idles-'));
  mkdirSync(join(dir, 'vcl/source/app'), { recursive: true });
  writeFileSync(join(dir, REL), body, 'utf-8');
  return {
    dir,
    read: () => readFileSync(join(dir, REL), 'utf-8'),
    run: () => {
      try {
        return { code: 0, out: execFileSync('python3', [SCRIPT, dir], { encoding: 'utf-8' }) };
      } catch (e) {
        const err = e as { status?: number; stderr?: string; stdout?: string };
        return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    },
  };
}

describe('#199 の直し(IdlesLockGuard)', () => {
  it('🔴 当たると、直しが 2 つとも入る', () => {
    const t = tree(UPSTREAM);
    try {
      const r = t.run();
      expect(r.code, r.out).toBe(0);
      const after = t.read();
      // ① 走っているタスクが無ければ待たない
      expect(after, '述語が入っていない').toContain('rSchedCtx.mpSchedulerStack != nullptr');
      // ② 待つ場合も時限を切る(100ms)
      expect(after, '時限が入っていない').toContain('aPkc3Timeout.Nanosec = 100 * 1000 * 1000');
      expect(after, '時限つきの wait を呼んでいない').toContain('wait(&aPkc3Timeout)');
      // ⚠ 時限で抜けたことが**log に残る**(こちらの printf は入れない)
      expect(after, '諦めたことを黙っている').toContain('SAL_WARN');
      // 🔑 **元の待ちは残す**(条件が立てば今までどおり抜ける)
      expect(after, '待ちごと消してしまった').toContain('m_inExecuteCondtion.reset()');
      expect(after, '起こす放送を消してしまった').toContain('Application::PostUserEvent({})');
      // ⚠ **無条件の wait は消えている**(残っていると時限が効かない経路が生きる)
      expect(after, '時限の無い wait が残っている').not.toContain(
        'm_inExecuteCondtion.wait();',
      );
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('🔴 二重当ては落ちる(黙って 2 回入れない)', () => {
    const t = tree(UPSTREAM);
    try {
      expect(t.run().code).toBe(0);
      const second = t.run();
      expect(second.code, '2 回目が通った').toBe(1);
      expect(second.out).toContain('二重当て');
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  /**
   * 🔴 **上流が形を変えたら落ちること**(この検査の主眼)。
   * ⚠ 「当たらなかったので何もしなかった」で通すと、**直しが消えたまま配られる**。
   */
  it('🔴 錨が無ければ落ちる(上流の変形に気づける)', () => {
    // ⚠ 1 行だけ変える ── 「まるで別の file」にすると空振りの検出にならない
    const drifted = UPSTREAM.replace(
      '        pSVData->m_inExecuteCondtion.wait();',
      '        pSVData->m_inExecuteCondtion.wait(nullptr);',
    );
    expect(drifted, 'fixture が変わっていない(空振り)').not.toBe(UPSTREAM);
    const t = tree(drifted);
    try {
      const r = t.run();
      expect(r.code, '上流が変わったのに黙って通った').toBe(1);
      expect(r.out).toContain('錨が');
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('file が無ければ落ちる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-idles-empty-'));
    try {
      let code = 0;
      try {
        execFileSync('python3', [SCRIPT, dir], { encoding: 'utf-8' });
      } catch (e) {
        code = (e as { status?: number }).status ?? 1;
      }
      expect(code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * 🔴 **計装(`patch-lo-idles-trace.py`)と同じ行を触っていないこと**。
   * ⚠ 触ると当てる順で錨が壊れ、「どちらが効いたか」も読めなくなる
   * (1 度の実験で 2 つを主張しない、の構造版)。
   */
  it('🔴 計装は scheduler.cxx を触らない(同じ行を 2 つの patch が持たない)', () => {
    const trace = readFileSync('build/office-wasm/patch-lo-idles-trace.py', 'utf-8');
    /**
     * ⚠ **散文で数えない**(CLAUDE.md §1「範囲が広すぎて無関係な散文に満たされる」)──
     * この file の docstring は `IdlesLockGuard` を何度も**説明**しており、
     * 語だけを見ると当てていなくても落ちる(1 稿目で実際に落ちた)。
     * 🔑 見るのは **当てる先として書いた path** と、**その錨の変数**だけである。
     */
    expect(trace, '計装が scheduler.cxx を当てる先に持っている').not.toContain(
      'vcl/source/app/scheduler.cxx',
    );
    expect(trace, '計装に scheduler.cxx 用の錨が残っている').not.toContain('SCHED_ANCHOR');
    // 空振り防止 ── この file が計装であること自体は変わっていない
    expect(trace, 'file を取り違えている').toContain('PKC3_IDLES_TRACE');
  });
});
