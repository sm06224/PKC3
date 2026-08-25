/** @vitest-environment node */
/**
 * 計装のヘルパーが**本当にコンパイルできる**ことを、焼く前に確かめる。
 *
 * 🔴 **これは 1 本の焼きを落として学んだ検査である**(2026-08-24、run 32786136716)。
 * `patch-lo-idles-trace.py` に「どの行にも `pthread_self()` を出す」を足したとき、
 * `static_cast<void*>(pthread_self())` と書いた ── ⚠ **`pthread_t` を pointer だと
 * 決めつけていた**。emscripten では `unsigned long` で、15 分の焼きが `make` で落ちた:
 *
 *     error: cannot cast from type 'pthread_t' (aka 'unsigned long')
 *            to pointer type 'void *'
 *
 * 🔑 ヘルパーは **libc だけで書く規律**なので、手元の `g++` でそのまま通せる ──
 * LO を建てなくても、書式・型・警告はここで落ちる。焼きは 15〜30 分、これは 1 秒。
 *
 * ⚠ **「1 度手で確かめた」で終わらせない** ── 次の巡でまた同じ形を書く。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

const SCRIPT = 'build/office-wasm/check-trace-helpers-compile.py';

function run(): { code: number; out: string } {
  try {
    return {
      code: 0,
      out: execFileSync('python3', [SCRIPT], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }),
    };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/**
 * 🔴 **当てる file を増やしたら、スコープ検査(`check-patch-scope.py`)にも足す。**
 * ⚠ `SPECS` は手書きの一覧なので、⚠ **足し忘れると新しい file だけ検査の外**になる
 * (7 巡目で `salusereventlist.cxx` を足したとき、実際に一度そうなった)。
 * 🔑 patch 側の `HELPER_TARGETS` と `SPECS` を**集合で**突き合わせる ── 件数ではなく集合。
 */
describe('ヘルパーの当て先は、スコープ検査にも全部載っている', () => {
  it('🔴 patch の HELPER_TARGETS と check-patch-scope の SPECS が一致する', () => {
    const out = execFileSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util,sys,re,json',
          'sys.dont_write_bytecode=True',
          "sp=importlib.util.spec_from_file_location('p','build/office-wasm/patch-lo-idles-trace.py')",
          'm=importlib.util.module_from_spec(sp); sp.loader.exec_module(m)',
          "s=open('build/office-wasm/check-patch-scope.py').read()",
          'b=s[s.index(chr(34)+"PKC3_IDLES_TRACE"+chr(34)):s.index(chr(34)+"PKC3_SAVE_TRACE"+chr(34))]',
          'print(json.dumps({"patch":sorted(t[0] for t in m.HELPER_TARGETS),'
            + '"specs":sorted(set(re.findall(chr(34)+"(vcl/[^"+chr(34)+"]+[.]cxx)"+chr(34), b)))}))',
        ].join('\n'),
      ],
      { encoding: 'utf-8' },
    );
    const { patch, specs } = JSON.parse(out) as { patch: string[]; specs: string[] };
    // ⚠ 空振り防止 ── 0 対 0 でも「一致」は真になる
    expect(patch.length, 'HELPER_TARGETS を読めていない').toBeGreaterThanOrEqual(3);
    expect(specs).toEqual(patch);
  });
});

describe('計装のヘルパーは g++ で通る', () => {
  it('🔴 3 本とも、pthread_t が「整数」でも「pointer」でも通り、走らせて 1 行出る', () => {
    const r = run();
    // ⚠ 空振り防止 ── 拾えた本数を主張として読む(0 本でも「全部通った」は真になる)
    expect(r.out, '計装のヘルパーを 1 本も拾えていない').toMatch(/計装のヘルパー: [3-9]\d* 本/);
    // 🔑 事故そのものの形(整数)が、名指しで通っていること
    expect(r.out).toContain('patch-lo-idles-trace.py / 整数');
    expect(r.out).toContain('patch-lo-idles-trace.py / pointer');
    expect(r.code, r.out).toBe(0);
  });

  /**
   * 🔴 **2 つの形が「本当に別物」であることを、値で見る。**
   * ⚠ ラベルだけ pin していたときは、**片方をもう片方の複製にしても緑**だった
   * (変異試験 M3 / M4 が SURVIVED)── 「両方で試した」という主張が、
   * **同じものを 2 回試しても**成立してしまう。
   * 🔑 stub が返す値(整数 4321 / pointer 0x1234 = 4660)がそのまま `t=` に出るので、
   * **等値で pin する**と、複製も・値が流れていないことも同時に落ちる。
   */
  it('🔴 「整数」と「pointer」で別の値が出る(同じものを 2 回試していない)', () => {
    const r = run();
    const got = [...r.out.matchAll(/patch-lo-idles-trace\.py \/ (整数|pointer)[^\n]*t=(\d+)/g)].map(
      (m) => [m[1], m[2]] as const,
    );
    expect(got, `2 つの形の t= を拾えていない:\n${r.out}`).toHaveLength(2);
    expect(Object.fromEntries(got)).toEqual({ 整数: '4321', pointer: '4660' });
  });

  /**
   * 🔴 **門が本当に鳴ることを、対照群で見る。**
   * ⚠ いまの 3 本はどれも警告を出さず、どれも 1 行出すので、門を外しても落ちない
   * (変異試験 M5 / M6 が SURVIVED で教えた)── だから検査自身が
   * 「その門だけが鳴る形」を自前で用意して落としている。
   */
  it('🔴 検査自身の対照群 ── 警告の出る形と、1 行も出さない形を落とす', () => {
    const r = run();
    expect(r.out, '`-Werror` の門が鳴っていない').toContain('(対照群)警告の出る形: ✅ ちゃんと落ちる');
    expect(r.out, '走らせて見る門が鳴っていない').toContain(
      '(対照群)1 行も出さない形: ✅ ちゃんと落ちる',
    );
    // ⚠ 逆側も要る ── 良い形まで落としていたら「厳しすぎる」であって検査ではない
    expect(r.out, '良い形を落としている').toContain('(対照群)良い形 / 整数');
  });
});
