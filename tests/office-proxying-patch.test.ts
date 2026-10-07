/** @vitest-environment node */
/**
 * `build/office-wasm/emsdk-patch-proxying.py` を検める(#1408)。
 *
 * ## 何を直すか
 *
 * emscripten 4.0.10 の `emscripten_proxy_finish` は `pthread_mutex_unlock` の**後**に `pthread_cond_signal` する。
 * 待つ側が unlock で先に起きて stack 上の ctx(condvar ごと)を捨て、完了側が**捨てた condvar** を signal しに行って固まる。
 * emscripten 5.0.5 の #26582 と同じく、**signal を unlock の前**にする。直す場所は 2 つ:`emscripten_proxy_finish` と
 * `cancel_ctx`(5.0.5 の実物も 2 つとも「Signal must be first」の順に直している)。
 *
 * ## ⚠ ここで検められること / 検められないこと
 *
 * 🔴 **compile も実行もできない**(emsdk がこの箱に無い)。fixture は 4.0.10 の原文を字のまま切り出した抜粋。
 * 見るのは「当たる / 冪等 / 錨が 1 つでも無ければ落ちる(片側だけ直さない)/ 2 か所とも順序が入れ替わり他は不変」。
 * 効いたか(起動中の固まりが消えるか)は焼いた一式の probe で見る。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/emsdk-patch-proxying.py';
const REL = 'system/lib/pthread/proxying.c';
const MARK = 'PKC3-PROXYFINISH';
/** 🔴 emscripten 4.0.10 の原文の抜粋(emscripten_proxy_finish と cancel_ctx。字のまま)。 */
const FIXTURE = 'tests/fixtures/emscripten/proxying-4.0.10.excerpt.c';
const ORIG = readFileSync(FIXTURE, 'utf-8');

const UNLOCK = '    pthread_mutex_unlock(&ctx->sync.mutex);';
const SIGNAL = '    pthread_cond_signal(&ctx->sync.cond);';

function tree(text: string = ORIG): { dir: string; read(): string } {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-emsdk-proxying-'));
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

/** 関数の本体(`name(` で始まる行から、行頭の `}` まで)。 */
function fnBody(text: string, head: string): string[] {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith(head));
  expect(at, `${head} が見つからない`).toBeGreaterThan(-1);
  const end = lines.findIndex((l, i) => i > at && l === '}');
  return lines.slice(at, end + 1);
}

const PATCHED = (() => {
  const t = tree();
  try {
    const r = run(t.dir);
    if (r.code !== 0) throw new Error(`原文に当たらない: ${r.out}`);
    return t.read();
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
})();

describe('#1408 の直し(emsdk-patch-proxying)', () => {
  it('🔑 前提:fixture は直す前の形(unlock → signal が 2 組 = proxy_finish と cancel_ctx。印は無い。錨は両方 1 件ずつ)', () => {
    expect(count(ORIG, MARK)).toBe(0);
    // 🔴 2 行だけだと 2 件(だから錨は `state = DONE` から始まる 4 行)
    expect(count(ORIG, UNLOCK + '\n' + SIGNAL + '\n')).toBe(2);
    expect(count(ORIG, '    ctx->sync.state = DONE;\n    remove_active_ctx(ctx);\n' + UNLOCK + '\n' + SIGNAL + '\n')).toBe(1);
    expect(count(ORIG, '    ctx->sync.state = CANCELED;\n' + UNLOCK + '\n' + SIGNAL + '\n')).toBe(1);
  });

  it('🔴 ① 当たり、emscripten_proxy_finish の中で signal が unlock の前に来る(足した行は全部印つき)', () => {
    const body = fnBody(PATCHED, 'void emscripten_proxy_finish(');
    const code = body.filter((l) => !l.trimStart().startsWith('//'));
    const iSig = code.findIndex((l) => l.includes('pthread_cond_signal(&ctx->sync.cond)'));
    const iUnl = code.findIndex((l) => l.includes('pthread_mutex_unlock(&ctx->sync.mutex)'));
    const iDone = code.findIndex((l) => l.includes('ctx->sync.state = DONE;'));
    expect(iSig, 'signal が無い').toBeGreaterThan(-1);
    expect(iUnl, 'unlock が無い').toBeGreaterThan(-1);
    expect(iDone, 'state = DONE が無い').toBeGreaterThan(-1);
    expect(iSig, 'signal が unlock の前に来ていない').toBeLessThan(iUnl);
    expect(iDone, 'state の更新は signal より前').toBeLessThan(iSig);
    // 動かした 2 行は印つき(行ごとの等値)
    expect(code).toContain(SIGNAL + ' // ' + MARK);
    expect(code).toContain(UNLOCK + ' // ' + MARK);
    // 足した行は全部印つき:印を持つ行は 7 行(finish: コメント 2 + 動かした 2 / cancel_ctx: コメント 1 + 動かした 2)
    expect(PATCHED.split('\n').filter((l) => l.includes(MARK)).length).toBe(7);
  });

  it('🔴 ④ cancel_ctx 側も signal が unlock の前に入れ替わる(片側だけ当たった形ではない)', () => {
    const body = fnBody(PATCHED, 'static void cancel_ctx(void* arg) {');
    const code = body.filter((l) => !l.trimStart().startsWith('//'));
    const iState = code.indexOf('    ctx->sync.state = CANCELED;');
    const iSig = code.indexOf(SIGNAL + ' // ' + MARK);
    const iUnl = code.indexOf(UNLOCK + ' // ' + MARK);
    expect(iState, 'state = CANCELED が無い').toBeGreaterThan(-1);
    expect(iSig, 'cancel_ctx の signal が印つきで無い').toBeGreaterThan(-1);
    expect(iUnl, 'cancel_ctx の unlock が印つきで無い').toBeGreaterThan(-1);
    expect(iState, 'state の更新は signal より前').toBeLessThan(iSig);
    expect(iSig, 'cancel_ctx も signal が unlock の前').toBeLessThan(iUnl);
    // 関数のほかの部分(else の枝)は原文と同じ
    const tail = (b: string[]): string[] => b.slice(b.findIndex((l) => l.includes('} else {')));
    expect(tail(body), 'cancel_ctx の else の枝が動いた').toEqual(tail(fnBody(ORIG, 'static void cancel_ctx(void* arg) {')));
  });

  it('🔴 ⑤ 順序が入れ替わった後の行が期待どおり・それ以外の行は 1 バイトも変わらない(2 か所)', () => {
    const want =
      [
        '    ctx->sync.state = DONE;',
        '    remove_active_ctx(ctx);',
        '    // PKC3-PROXYFINISH(#1408): signal を unlock の前に(emscripten 5.0.5 の #26582 と同じ)。',
        '    // PKC3-PROXYFINISH: 後だと、待つ側が先に起きて ctx(condvar ごと)を捨て、捨てた condvar を signal しに行って固まる。',
        '    pthread_cond_signal(&ctx->sync.cond); // PKC3-PROXYFINISH',
        '    pthread_mutex_unlock(&ctx->sync.mutex); // PKC3-PROXYFINISH',
      ].join('\n') + '\n';
    expect(PATCHED).toContain(want);
    const wantCancel =
      [
        '    ctx->sync.state = CANCELED;',
        '    // PKC3-PROXYFINISH(#1408): cancel_ctx も同じ順に(5.0.5 の「Signal must be first」)。',
        '    pthread_cond_signal(&ctx->sync.cond); // PKC3-PROXYFINISH',
        '    pthread_mutex_unlock(&ctx->sync.mutex); // PKC3-PROXYFINISH',
      ].join('\n') + '\n';
    expect(PATCHED).toContain(wantCancel);
    // 印の行と、動かした元の 2 行(2 組とも)を除けば、原文と同じ
    const pair = UNLOCK + '\n' + SIGNAL + '\n';
    expect(count(ORIG, pair), '動かした元の組が 2 つ').toBe(2);
    const withoutOrig = ORIG.split(pair).join('');
    const rest = PATCHED.split('\n').filter((l) => !l.includes(MARK)).join('\n');
    expect(rest, '足した行の外が動いている').toBe(withoutOrig);
  });

  it('⚠ ② 2 度当てると SKIP で、file は 1 バイトも変わらない', () => {
    const t = tree(PATCHED);
    try {
      const again = run(t.dir);
      expect(again.code, `2 度目が落ちた: ${again.out}`).toBe(0);
      expect(again.out, 'SKIP と言っていない').toContain('SKIP');
      expect(t.read(), '2 度目で字が変わった').toBe(PATCHED);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('🔴 ③ 錨が無い入力は exit 1 で、file は不変(どちらの錨が欠けても。片側だけは直さない)', () => {
    for (const [name, from, to] of [
      ['emscripten_proxy_finish 側', '    ctx->sync.state = DONE;', '    ctx->sync.state = FINISHED;'],
      ['cancel_ctx 側', '    ctx->sync.state = CANCELED;', '    ctx->sync.state = CANCELLED;'],
    ] as const) {
      const broken = ORIG.replace(from, to);
      expect(broken, `${name}: 変異が当たっていない`).not.toBe(ORIG);
      const t = tree(broken);
      try {
        const r = run(t.dir);
        expect(r.code, `${name}: 錨が無いのに通った`).toBe(1);
        expect(r.out, `${name}: どの錨か言っていない`).toContain('錨が 0 件');
        expect(t.read(), `${name}: 落ちたのに file が動いた(半分だけ直った)`).toBe(broken);
      } finally {
        rmSync(t.dir, { recursive: true, force: true });
      }
    }
  });

  it('🔴 ③b 錨が 2 件になっても落ちる(どちらの錨でも。一意でない錨で黙って直さない)', () => {
    for (const block of [
      '    ctx->sync.state = DONE;\n    remove_active_ctx(ctx);\n' + UNLOCK + '\n' + SIGNAL + '\n',
      '    ctx->sync.state = CANCELED;\n' + UNLOCK + '\n' + SIGNAL + '\n',
    ]) {
      const dup = `${ORIG}\n${block}`;
      const t = tree(dup);
      try {
        const r = run(t.dir);
        expect(r.code).toBe(1);
        expect(r.out).toContain('錨が 2 件');
        expect(t.read(), '落ちたのに file が動いた').toBe(dup);
      } finally {
        rmSync(t.dir, { recursive: true, force: true });
      }
    }
  });

  it('引数が違えば usage を出して 2 で落ちる', () => {
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

  it('⚠ 制御文字・見えない字(BOM / ゼロ幅 / NBSP)が入っていない', () => {
    for (const f of [PATCHED, readFileSync(SCRIPT, 'utf-8')]) {
      const bad = [...f].filter((c) => {
        const n = c.codePointAt(0)!;
        return (
          n <= 0x08 || n === 0x0b || n === 0x0c || (n >= 0x0e && n <= 0x1f) ||
          n === 0xfeff || (n >= 0x200b && n <= 0x200d) || n === 0x2060 || n === 0xa0
        );
      });
      expect(bad).toEqual([]);
    }
  });
});
