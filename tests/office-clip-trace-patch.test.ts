/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-clip-trace.py` を検める(#121 の**計装**)。
 *
 * 🔴 **これは直しではなく、数える計装である。** Office の窓の `Ctrl+C` / 右クリックの「コピー」が、
 * どの層で外へ届かなくなるかを割る(メニュー経由で `QtClipboard::setContents` が呼ばれるか /
 * Qt が何の型で中身を求めるか)。焼きは 15〜30 分かかる。
 *
 * ⚠ 見るのは 5 つ:
 *   ① **既定(`PKC3_CLIP_TRACE!=1`)は 1 バイトも書かない**。⚠ 錨の検査は毎回する
 *   ② **挙動を変えていない** ── 足した行(行末が `// PKC3-CLIP`)と helper の塊を除くと原文と一致
 *   ③ **錨が 1 つでも外れたら落ちる**(上流の変形を黙って通さない)/ 二重当ては落ちて不変
 *   ④ **`patch-lo-clipboard-png.py` と同じ行を触らない**(両方当てても、どちらの順でも出力が同一)
 *   ⑤ **型検査と走らせる**: 当てた後の C++ が模型の型で通り、**意図した印が出る**
 *
 * 🔴 **言えないこと**: 本物の Qt / LO の header で通ること(焼かないと分からない)。
 */
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  EXCERPT_CB,
  EXCERPT_TR,
  HARNESS,
  HARNESS_CB,
  REL_CB,
  REL_TR,
  build,
  compile,
  makeRoot,
  runPatch,
  stripAdded,
} from './helpers/office-lo-clip';

const SCRIPT = 'build/office-wasm/patch-lo-clip-trace.py';
const PNG_SCRIPT = 'build/office-wasm/patch-lo-clipboard-png.py';
const MARK = '// PKC3-CLIP';
const ON = { PKC3_CLIP_TRACE: '1' };
// g++ を何度も回す test の枠(既定の 5 秒では足りない)
const COMPILE_MS = 120_000;
vi.setConfig({ testTimeout: COMPILE_MS });
const OFF = { PKC3_CLIP_TRACE: '0' };

/** patch の module から、錨・helper・印を取り出す(⚠ 錨の字をここへ書き写さない)。 */
function loadPatch(script: string): {
  helper: string;
  targets: { src: string; anchor: string; replace: string }[];
  helperTargets: { src: string; anchor: string }[];
  adds: number;
} {
  const code = [
    'import importlib.util,sys,json',
    'sys.dont_write_bytecode=True',
    `sp=importlib.util.spec_from_file_location("p","${script}")`,
    'm=importlib.util.module_from_spec(sp); sp.loader.exec_module(m)',
    'print(json.dumps({"helper":m.HELPER,' +
      '"targets":[{"src":s,"anchor":a,"replace":r} for s,a,r in m.TARGETS],' +
      '"helperTargets":[{"src":s,"anchor":a} for s,a,_h in m.HELPER_TARGETS],' +
      '"adds":sum(r.count(m.MARK) for _s,_a,r in m.TARGETS)}))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf-8', stdio: 'pipe' }));
}
const PATCH = loadPatch(SCRIPT);

/** png patch の錨(重なりを見る)。 */
function pngAnchors(): string[] {
  const code = [
    'import importlib.util,sys,json',
    'sys.dont_write_bytecode=True',
    `sp=importlib.util.spec_from_file_location("p","${PNG_SCRIPT}")`,
    'm=importlib.util.module_from_spec(sp); sp.loader.exec_module(m)',
    'print(json.dumps([a for a,_ in m.PARTS]))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf-8', stdio: 'pipe' }));
}

const strip = (t: string): string => stripAdded(t, MARK, 'PKC3-CLIP');
const ORIG: Record<string, string> = { [REL_TR]: EXCERPT_TR, [REL_CB]: EXCERPT_CB };

describe('#121 の計装(clip-trace)── 当て方', () => {
  it('🔑 空振り防止: 錨・ヘルパーの当て先を拾えている', () => {
    expect(PATCH.targets.length, '錨を 1 つも拾えていない').toBeGreaterThanOrEqual(6);
    expect(PATCH.helperTargets.length, 'ヘルパーの当て先を 1 つも拾えていない').toBe(2);
    expect(new Set(PATCH.targets.map((t) => t.anchor)).size, '同じ錨が 2 つ在る').toBe(PATCH.targets.length);
    // 足した行の数 ≥ 錨の数(各置換が最低 1 行は足している)
    expect(PATCH.adds).toBeGreaterThanOrEqual(PATCH.targets.length);
  });

  it('🔴 錨は、原文から抜いた抜粋に**ちょうど 1 件**ずつ当たる', () => {
    for (const t of PATCH.targets) {
      const hits = ORIG[t.src]!.split(t.anchor).length - 1;
      expect(hits, `${t.src} の錨が 1 件でない:\n${t.anchor}`).toBe(1);
    }
    for (const t of PATCH.helperTargets) {
      expect(ORIG[t.src]!.split(t.anchor).length - 1, `${t.src} のヘルパーの錨が 1 件でない`).toBe(1);
    }
  });

  it('🔴 既定(PKC3_CLIP_TRACE!=1)は 1 バイトも書き換えない。錨の検査はする', () => {
    for (const env of [OFF, {}]) {
      const t = makeRoot();
      try {
        const r = runPatch(SCRIPT, t.dir, env);
        expect(r.code, r.out).toBe(0);
        expect(r.out).toContain('skip');
        expect(t.read(REL_TR), '既定なのに書き換えている').toBe(EXCERPT_TR);
        expect(t.read(REL_CB), '既定なのに書き換えている').toBe(EXCERPT_CB);
      } finally {
        t.cleanup();
      }
    }
  });

  it('🔴 当てると helper が 1 file に 1 つずつ入り、足した行は全部、行末が印で終わる', () => {
    const t = makeRoot();
    try {
      const r = runPatch(SCRIPT, t.dir, ON);
      expect(r.code, r.out).toBe(0);
      for (const rel of [REL_TR, REL_CB]) {
        const after = t.read(rel);
        expect(after.match(/PKC3-CLIP-HELPER-BEGIN/g)?.length, `${rel}: helper が 1 つでない`).toBe(1);
        expect(after.match(/^void pkc3_clip_trace\(/gm)?.length, `${rel}: 入口が 1 つでない`).toBe(1);
      }
      // msg 版は使う TU(QtTransferable.cxx)にだけ ── 呼ばない file で未使用の警告を踏む
      expect(t.read(REL_TR)).toContain('void pkc3_clip_msg(');
      expect(t.read(REL_CB)).not.toContain('pkc3_clip_msg');
      const marks = [REL_TR, REL_CB]
        .map((rel) =>
          t
            .read(rel)
            .replace(/\/\/ PKC3-CLIP-HELPER-BEGIN\n[\s\S]*?\/\/ PKC3-CLIP-HELPER-END\n\n/, '')
            .split('\n')
            .filter((l) => l.trimEnd().endsWith(MARK)).length,
        )
        .reduce((a, b) => a + b, 0);
      expect(marks, '足した行の数が、定義の数と違う').toBe(PATCH.adds);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 挙動を変えていない ── 足した行と helper を除くと原文と一致する', () => {
    const t = makeRoot();
    try {
      expect(runPatch(SCRIPT, t.dir, ON).code).toBe(0);
      for (const rel of [REL_TR, REL_CB]) {
        // ⚠ 対照群: 当たった後が原文と違うこと(違わなければ、何も足していない)
        expect(t.read(rel)).not.toBe(ORIG[rel]);
        expect(strip(t.read(rel)), `${rel}: 足した以外のことをしている`).toBe(ORIG[rel]);
      }
    } finally {
      t.cleanup();
    }
  });

  it('🔴 二重当ては落ち(exit 1)、file は 1 バイトも変わらない', () => {
    const t = makeRoot();
    try {
      expect(runPatch(SCRIPT, t.dir, ON).code).toBe(0);
      const once = [t.read(REL_TR), t.read(REL_CB)];
      const r = runPatch(SCRIPT, t.dir, ON);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('二重当て');
      expect([t.read(REL_TR), t.read(REL_CB)]).toEqual(once);
    } finally {
      t.cleanup();
    }
  });

  /**
   * 🔴 **錨を 1 つずつ外して、毎回落ちること**(1 つ外しても他が救って緑、を許さない)。
   * ⚠ 既定(計装を入れない回)でも落ちる ── 上流の変形は、計装を入れない焼きでも**先に**気づきたい。
   * ⚠ 落ちたとき**もう片方の file も書き換えていない**こと(「半分だけ当たる」を作らない)。
   */
  it('🔴 錨 / ヘルパーの錨が 1 つでも無ければ落ちる(全数 ── 既定の回でも)。何も書かない', () => {
    const all = [
      ...PATCH.targets.map((t) => ({ ...t, kind: '錨' })),
      ...PATCH.helperTargets.map((t) => ({ ...t, replace: '', kind: 'ヘルパーの錨' })),
    ];
    for (let i = 0; i < all.length; i++) {
      const { src, anchor, kind } = all[i]!;
      const broken = ORIG[src]!.replace(anchor, '// 上流が形を変えた\n');
      expect(broken, `${kind} ${i} を外せていない`).not.toBe(ORIG[src]);
      for (const env of [OFF, ON]) {
        const t = makeRoot({ [src]: broken });
        try {
          const other = src === REL_TR ? REL_CB : REL_TR;
          const r = runPatch(SCRIPT, t.dir, env);
          expect(r.code, `${kind} ${i}(${src} / ${JSON.stringify(env)})を外しても落ちない:\n${r.out}`).toBe(1);
          expect(r.out, `${kind} ${i} の落ち方が「錨の欠落」でない`).toMatch(/(錨|ヘルパーの錨)が 0 件/);
          expect(t.read(src), '落ちたのに書き換えている').toBe(broken);
          expect(t.read(other), '落ちたのにもう片方を書き換えている').toBe(ORIG[other]);
        } finally {
          t.cleanup();
        }
      }
    }
  });
});

describe('#121 の計装(clip-trace)── 直し(clipboard-png)と同じ行を触らない', () => {
  it('🔑 空振り防止: 直しの錨を拾えている', () => {
    expect(pngAnchors().length).toBeGreaterThanOrEqual(3);
  });

  it('🔴 錨の範囲が重ならない(原文の上で、どの錨も別の錨の字を含まない)', () => {
    const spans = [
      ...pngAnchors().map((a) => ({ who: 'png', a })),
      ...PATCH.targets.filter((t) => t.src === REL_TR).map((t) => ({ who: 'trace', a: t.anchor })),
      ...PATCH.helperTargets.filter((t) => t.src === REL_TR).map((t) => ({ who: 'trace-h', a: t.anchor })),
    ].map(({ who, a }) => ({ who, from: EXCERPT_TR.indexOf(a), to: EXCERPT_TR.indexOf(a) + a.length }));
    for (const s of spans) expect(s.from, `${s.who} の錨が原文に無い`).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) {
        const a = spans[i]!;
        const b = spans[j]!;
        expect(a.to <= b.from || b.to <= a.from, `錨が重なっている: ${a.who} と ${b.who}`).toBe(true);
      }
    }
  });

  it('🔴 両方当てても、どちらの順でも出力が 1 バイトも違わない(2 file とも)', () => {
    const ab = makeRoot();
    const ba = makeRoot();
    try {
      expect(runPatch(PNG_SCRIPT, ab.dir).code).toBe(0);
      expect(runPatch(SCRIPT, ab.dir, ON).code).toBe(0);
      expect(runPatch(SCRIPT, ba.dir, ON).code).toBe(0);
      expect(runPatch(PNG_SCRIPT, ba.dir).code).toBe(0);
      for (const rel of [REL_TR, REL_CB]) {
        expect(ab.read(rel), `${rel}: 当てる順で出力が違う`).toBe(ba.read(rel));
      }
      // 対照群: 両方入っている(片方が当たっていないだけの「一致」を許さない)
      expect(ab.read(REL_TR)).toContain('PKC3-PNG');
      expect(ab.read(REL_TR)).toContain('pkc3_clip_trace');
    } finally {
      ab.cleanup();
      ba.cleanup();
    }
  });
});

describe('#121 の計装(clip-trace)── 型検査(g++)', () => {
  it('🔴 計装だけ / 直しと両方 のどちらも、-fsyntax-only と -c(-Wall -Wextra -Werror)に通る。wasm の枝が有る / 無い', () => {
    for (const both of [false, true]) {
      const t = makeRoot();
      try {
        if (both) expect(runPatch(PNG_SCRIPT, t.dir).code).toBe(0);
        expect(runPatch(SCRIPT, t.dir, ON).code).toBe(0);
        for (const rel of [REL_TR, REL_CB]) {
          for (const emscripten of [true, false]) {
            for (const mode of ['-fsyntax-only', '-c'] as const) {
              const r = compile(t, rel, { emscripten, mode });
              expect(r.code, `通らない(${rel} both=${both} emscripten=${emscripten} ${mode}):\n${r.out}`).toBe(0);
            }
          }
        }
      } finally {
        t.cleanup();
      }
    }
  });

  it('🔑 対照群: 呼び出しの引数を壊すと落ちる(通る検査になっていない)', () => {
    const t = makeRoot();
    try {
      expect(runPatch(SCRIPT, t.dir, ON).code).toBe(0);
      const good = t.read(REL_TR);
      const bad = good.replace('pkc3_clip_msg("formats:list", toOUString(rPkc3Listed))', 'pkc3_clip_msg("formats:list", 42)');
      expect(bad).not.toBe(good);
      t.write(REL_TR, bad);
      expect(compile(t, REL_TR, { emscripten: true, mode: '-fsyntax-only' }).code).not.toBe(0);
    } finally {
      t.cleanup();
    }
  });
});

describe('#121 の計装(clip-trace)── 走らせて、意図した印が出る', () => {
  const rows = (err: string): string[] => err.split('\n').filter((l) => l.startsWith('PKC3-CLIP '));

  it('🔴 formats / retrieve の印: LO の flavor の全部と、一覧に入れた物、求められた型が出る。挙動は変わらない', () => {
    const plain = makeRoot();
    const traced = makeRoot();
    try {
      const a = build(plain, HARNESS, { emscripten: true });
      expect(runPatch(SCRIPT, traced.dir, ON).code).toBe(0);
      const b = build(traced, HARNESS, { emscripten: true });
      expect(a.code, a.err).toBe(0);
      expect(b.code, b.err).toBe(0);
      // 🔑 挙動を変えていない ── 計装を入れても harness の出力(一覧と中身)は同じ
      expect(b.out).toBe(a.out);
      expect(rows(a.err), '計装なしなのに印が出ている').toEqual([]);

      const r = rows(b.err).join('\n');
      // ① LO の flavor の全部(場面 A は 5 つ)── どれが在って何が捨てられたかが読める
      expect(r).toMatch(/msg formats:flavor \[image\/bmp\]/);
      expect(r).toMatch(/msg formats:flavor \[application\/x-openoffice-gdimetafile;/);
      // ② 一覧に入れた物(原文は先頭の SVXB だけ)
      expect(r).toMatch(/msg formats:list \[application\/x-openoffice-svxb;/);
      // 件数: 場面 A は flavor 5 件・一覧 1 件
      expect(r).toMatch(/formats:done a=5 b=1 c=0/);
      // ③ Qt が求めた型 ── 画像として読まれる要求(`application/x-qt-image`)も出る
      expect(r).toMatch(/msg retrieve:request \[application\/x-qt-image\]/);
      // ④ 取り出しに失敗して黙って空を返した(host の 0 byte の部品の出どころ)
      expect(r).toMatch(/retrieve:catch a=1/);
      // ⑤ 返した bytes
      expect(r).toMatch(/retrieve:return a=0 /);
      // 通し番号は 1 から増える(上限つきの counter が動いている)
      // (⚠ 文字の印 `msg` には通し番号が無い ── 数の印の最初が 1)
      expect(rows(b.err).find((l) => !l.includes(' msg '))).toMatch(/^PKC3-CLIP 1 /);
    } finally {
      plain.cleanup();
      traced.cleanup();
    }
  });

  it('🔴 直しと両方入れても、直しの結果(PNG 1 つ)と、計装の印の両方が出る', () => {
    const t = makeRoot();
    try {
      expect(runPatch(PNG_SCRIPT, t.dir).code).toBe(0);
      expect(runPatch(SCRIPT, t.dir, ON).code).toBe(0);
      const b = build(t, HARNESS, { emscripten: true });
      expect(b.code, b.err).toBe(0);
      expect(b.out).toContain('A: [image/png]');
      const r = rows(b.err).join('\n');
      // 一覧に入れた物は PNG(直しが効いた結果を、計装が見ている)
      expect(r).toMatch(/msg formats:list \[image\/png\]/);
      // 画像として読まれて、PNG の型で読み直した(再入の要求が、一覧の PNG の型で出る)
      expect(r).toMatch(/msg retrieve:request \[application\/x-qt-image\]/);
      expect(r).toMatch(/msg retrieve:request \[image\/png\]/);
      expect(r).toMatch(/retrieve:return a=10 /);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 setContents の入口: 呼ばれた事実 / どのスレッドか / flavor の数 / owner の有無(= メニュー経由の裏取り)', () => {
    const t = makeRoot();
    try {
      expect(runPatch(SCRIPT, t.dir, ON).code).toBe(0);
      const wasm = build(t, HARNESS_CB, { emscripten: true, rel: REL_CB });
      expect(wasm.code, wasm.err).toBe(0);
      const w = rows(wasm.err);
      // 1 回目: flavor 5 件・owner 無し / 2 回目: transferable 無し(= クリア。flavor は -1)
      expect(w[0]).toBe('PKC3-CLIP 1 setContents:enter a=1 b=5 c=0');
      expect(w[1]).toBe('PKC3-CLIP 2 setContents:enter a=1 b=-1 c=0');
      // wasm でない build では、スレッドの判定は「分からない」(-1)
      const native = build(t, HARNESS_CB, { emscripten: false, rel: REL_CB });
      expect(native.code, native.err).toBe(0);
      expect(rows(native.err)[0]).toBe('PKC3-CLIP 1 setContents:enter a=-1 b=5 c=0');
    } finally {
      t.cleanup();
    }
  });
});

describe('#121 の計装(clip-trace)── 台帳(スコープ検査 / workflow)に載っている', () => {
  it('🔑 helper の当て先が、スコープ検査(check-patch-scope.py)にも載っている', () => {
    // ⚠ SPECS は手書きの一覧 ── 足し忘れると、この 2 file だけ検査の外になる
    const scope = readFileSync('build/office-wasm/check-patch-scope.py', 'utf-8');
    const at = scope.indexOf('"PKC3_CLIP_TRACE"');
    expect(at, 'SPECS に PKC3_CLIP_TRACE が無い').toBeGreaterThan(-1);
    const block = scope.slice(at, scope.indexOf('"PKC3_IME_TRACE"', at));
    expect(block).toContain('"patch-lo-clip-trace.py"');
    expect(block).toContain('"pkc3_clip_trace"');
    // 当て先と、その直前の関数の頭は、patch の HELPER_TARGETS から引く(手で書き写さない)
    for (const t of PATCH.helperTargets) {
      expect(block, `${t.src} が SPECS に無い`).toContain(`"${t.src}"`);
      expect(block, `${t.src} の関数の頭が SPECS に無い`).toContain(t.anchor.trim().replace(/\($/, '('));
    }
  });

  /**
   * workflow の入力は 4 か所(入力 / 環境変数の export / 別 tag の接尾辞 / build-info.json)で効く。
   * ⚠ 1 か所でも落ちると「入力を渡したのに計装が入らない」か「入ったのに別 tag に出ない」になる。
   * 🔑 見るのは**実行する行**(コメントを落としてから)── 解説文に満たされない。
   */
  it('🔴 workflow の 4 か所(入力 / export / 接尾辞 / build-info)と、ref 検査の既定(=0)が揃っている', () => {
    const code = (p: string): string =>
      readFileSync(p, 'utf-8')
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
    const yml = code('.github/workflows/office-wasm-build.yml');
    expect(yml, '入力が無い').toMatch(/^ {6}clip_trace:\n[\s\S]*?default: false/m);
    expect(yml, '環境変数の export が無い').toContain('export PKC3_CLIP_TRACE=1');
    expect(yml, '既定(=0)の export が無い').toContain('export PKC3_CLIP_TRACE=0');
    expect(yml, '別 tag の接尾辞が無い').toContain('SAFE_SUFFIX="${SAFE_SUFFIX}-cliptrace"');
    expect(yml, 'build-info.json に入っていない').toContain('\\"clip_trace\\": \\"${{ inputs.clip_trace }}\\"');
    expect(yml.match(/inputs\.clip_trace/g)?.length, '入力を読む所が 3 か所でない').toBe(3);
    expect(code('build/office-wasm/check-patches-on-ref.sh')).toContain('PKC3_CLIP_TRACE=0');
  });
});
