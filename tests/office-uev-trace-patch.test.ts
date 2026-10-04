/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-uev-trace.py` を検める(#121 の**計装**、3 本目)。
 *
 * 🔴 **これは直しではなく、「どの user event が落ちるか・誰が積んだか」を言う計装である。** popup の「コピー」を
 * マウスで選んだ回だけ、約 10.2 秒後に `DispatchUserEvents` の `noexcept` lambda から JS 例外で terminate する。
 * 焼きは 15〜30 分かかる。
 *
 * ⚠ 見るのは 7 つ:
 *   ① **既定(`PKC3_UEV_TRACE!=1`)は 1 バイトも書かない**。⚠ 錨の検査は毎回する
 *   ② **挙動を変えていない** ── 足した行(行末が `// PKC3-UEV`)と helper の塊を除くと原文と一致する
 *      (**原文の行は 1 行も置き換えない**。menu-trace と違い、戻す手順は要らない)
 *   ③ **錨が 1 つでも外れたら落ちる**(上流の変形を黙って通さない)/ 二重当ては落ちて不変
 *   ④ **印が全部在り、決まった順に並ぶ**(`post` / `dispatch` / `done` / 2 つの stack)
 *   ⑤ 🔴 **C stack の出す条件(12 秒 + 回数)が効く** ── g++ で実際に走らせ、時計を偽って確かめる
 *   ⑥ 🔴 **`patch-lo-idles-trace.py` と同じ 2 file を触るが、錨が重ならない**(両順で出力が同一)
 *   ⑦ 台帳(スコープ検査 / workflow / probe の filter と上限)に載っている
 *
 * 🔴 **言えないこと**: 本物の Emscripten / LO の header で通ること(焼かないと分からない)。
 *   とくに **`emscripten_log(EM_LOG_C_STACK)` が実際に stack を出すか**は焼きで見る。
 *   ここで g++ に通すのは **helper の単体**で、`emscripten_log` は**偽の header** に差し替えて呼び方
 *   (flags の 3 つ・書式)だけ見ている。呼び側の行(`ImplSVEvent` の参照など)は通していない。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-uev-trace.py';
const IDLES_SCRIPT = 'build/office-wasm/patch-lo-idles-trace.py';
const REL_APP = 'vcl/source/app/svapp.cxx';
const REL_EVL = 'vcl/source/app/salusereventlist.cxx';
const EXCERPT_APP = readFileSync('tests/fixtures/office-lo/svapp.excerpt.cxx', 'utf-8');
const EXCERPT_EVL = readFileSync('tests/fixtures/office-lo/salusereventlist.excerpt.cxx', 'utf-8');
const ORIG: Record<string, string> = { [REL_APP]: EXCERPT_APP, [REL_EVL]: EXCERPT_EVL };
const MARK = '// PKC3-UEV';
const ON = { PKC3_UEV_TRACE: '1' };
const OFF = { PKC3_UEV_TRACE: '0' };

interface Root {
  dir: string;
  read: (rel: string) => string;
  cleanup: () => void;
}

/** LO の root の形(`vcl/source/app/…`)を一時 dir に作る。既定は 2 file とも原文の抜粋。 */
function makeRoot(files: Record<string, string> = {}): Root {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-uev-'));
  const put = (rel: string, body: string): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body, 'utf-8');
  };
  put(REL_APP, EXCERPT_APP);
  put(REL_EVL, EXCERPT_EVL);
  for (const [rel, body] of Object.entries(files)) put(rel, body);
  return {
    dir,
    read: (rel) => readFileSync(join(dir, rel), 'utf-8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runScript(script: string, dir: string, env: Record<string, string> = {}): { code: number; out: string } {
  const r = spawnSync('python3', ['-B', script, dir], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    stdio: 'pipe',
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}
const runPatch = (dir: string, env: Record<string, string> = {}) => runScript(SCRIPT, dir, env);

/** patch の module から、錨・helper を取り出す(⚠ 錨の字をここへ書き写さない)。 */
function loadPatch(script: string): {
  helper: string;
  targets: { src: string; anchor: string }[];
  helperTargets: { src: string; anchor: string }[];
} {
  const code = [
    'import importlib.util,sys,json',
    'sys.dont_write_bytecode=True',
    `sp=importlib.util.spec_from_file_location("p","${script}")`,
    'm=importlib.util.module_from_spec(sp); sp.loader.exec_module(m)',
    'ht=[{"src":t[0],"anchor":t[1]} for t in m.HELPER_TARGETS]',
    'print(json.dumps({"helper":getattr(m,"HELPER",""),' +
      '"targets":[{"src":t[0],"anchor":t[1]} for t in m.TARGETS],"helperTargets":ht}))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf-8', stdio: 'pipe' }));
}
const PATCH = loadPatch(SCRIPT);
const IDLES = loadPatch(IDLES_SCRIPT);

/** helper の塊を除く(1 file に 1 つ)。 */
function dropHelper(t: string): string {
  return t.replace(/\/\/ PKC3-UEV-HELPER-BEGIN\n[\s\S]*?\/\/ PKC3-UEV-HELPER-END\n\n/g, '');
}

/** 足した行(行末が印)を除く。 */
function dropMarked(t: string): string {
  return t
    .split('\n')
    .filter((l) => !l.includes(MARK))
    .join('\n');
}

describe('#121 の計装(uev-trace)── 当て方', () => {
  it('🔑 空振り防止: 錨・ヘルパーの当て先を拾えている', () => {
    expect(PATCH.targets.length, '錨を拾えていない').toBe(3);
    expect(PATCH.helperTargets.length, 'ヘルパーの当て先を拾えていない').toBe(2);
    expect(new Set(PATCH.targets.map((t) => t.anchor)).size, '同じ錨が 2 つ在る').toBe(PATCH.targets.length);
    expect(PATCH.targets.filter((t) => t.src === REL_APP).length).toBe(1);
    expect(PATCH.targets.filter((t) => t.src === REL_EVL).length).toBe(2);
    expect(PATCH.helperTargets.map((t) => t.src).sort()).toEqual([REL_EVL, REL_APP].sort());
  });

  it('🔴 錨は、原文から抜いた抜粋に**ちょうど 1 件**ずつ当たる', () => {
    for (const t of [...PATCH.targets, ...PATCH.helperTargets]) {
      const hits = ORIG[t.src]!.split(t.anchor).length - 1;
      expect(hits, `${t.src} の錨が 1 件でない:\n${t.anchor}`).toBe(1);
    }
  });

  it('🔴 既定(PKC3_UEV_TRACE!=1)は 1 バイトも書き換えない。錨の検査はする', () => {
    for (const env of [OFF, {}]) {
      const t = makeRoot();
      try {
        const r = runPatch(t.dir, env);
        expect(r.code, r.out).toBe(0);
        expect(r.out).toContain('skip');
        expect(t.read(REL_APP), '既定なのに書き換えている').toBe(EXCERPT_APP);
        expect(t.read(REL_EVL), '既定なのに書き換えている').toBe(EXCERPT_EVL);
      } finally {
        t.cleanup();
      }
    }
  });

  it('🔴 当てると helper が 1 file に 1 つずつ入る(入口の関数も 1 つ)', () => {
    const t = makeRoot();
    try {
      const r = runPatch(t.dir, ON);
      expect(r.code, r.out).toBe(0);
      for (const rel of [REL_APP, REL_EVL]) {
        const after = t.read(rel);
        expect(after.match(/PKC3-UEV-HELPER-BEGIN/g)?.length, `${rel}: helper が 1 つでない`).toBe(1);
        expect(after.match(/^void pkc3_uev_trace\(/gm)?.length, `${rel}: 入口が 1 つでない`).toBe(1);
        // check-patch-scope.py が探す形(入口の関数が `namespace {` の直後)
        expect(after, `${rel}: namespace の直後に入口が無い`).toContain('namespace\n{\nvoid pkc3_uev_trace(');
        expect(after, `${rel}: 当たっていない`).not.toBe(ORIG[rel]);
      }
    } finally {
      t.cleanup();
    }
  });

  it('🔴 挙動を変えていない ── helper と足した行を除くと原文と**そのまま**一致する(置き換えた行は 1 行も無い)', () => {
    const t = makeRoot();
    try {
      expect(runPatch(t.dir, ON).code).toBe(0);
      for (const rel of [REL_APP, REL_EVL]) {
        const after = dropHelper(t.read(rel));
        expect(dropMarked(after), `${rel}: 足した以外のことをしている`).toBe(ORIG[rel]);
        // 🔑 対照群: 除く前は原文でない(= 足した行が実在する。無ければ上の一致は何も見ていない)
        expect(after === ORIG[rel], `${rel}: 足した行が無い(対照群が成り立たない)`).toBe(false);
      }
    } finally {
      t.cleanup();
    }
  });

  it('🔴 足した行は全部、行末が印で終わる(印の無い行は 1 行も足していない)', () => {
    const t = makeRoot();
    try {
      expect(runPatch(t.dir, ON).code).toBe(0);
      for (const rel of [REL_APP, REL_EVL]) {
        const orig = new Set(ORIG[rel]!.split('\n'));
        let added = 0;
        for (const line of dropHelper(t.read(rel)).split('\n')) {
          if (orig.has(line)) continue;
          added++;
          expect(line.trimEnd().endsWith(MARK), `${rel}: 印の無い足し行: ${line}`).toBe(true);
        }
        expect(added, `${rel}: 足した行が無い`).toBeGreaterThan(0);
      }
    } finally {
      t.cleanup();
    }
  });

  it('🔴 二重当ては落ち(exit 1)、file は 1 バイトも変わらない', () => {
    const t = makeRoot();
    try {
      expect(runPatch(t.dir, ON).code).toBe(0);
      const once = [t.read(REL_APP), t.read(REL_EVL)];
      const r = runPatch(t.dir, ON);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('二重当て');
      expect([t.read(REL_APP), t.read(REL_EVL)]).toEqual(once);
    } finally {
      t.cleanup();
    }
  });

  /**
   * 🔴 **錨を 1 つずつ外して、毎回落ちること**(1 つ外しても他が救って緑、を許さない)。
   * ⚠ 既定(計装を入れない回)でも落ちる ── 上流の変形は、計装を入れない焼きでも**先に**気づきたい。
   * ⚠ 落ちたとき**もう片方の file も書き換えていない**こと。
   */
  it('🔴 錨 / ヘルパーの錨が 1 つでも無ければ落ちる(全数 ── 既定の回でも)。何も書かない', () => {
    const all = [
      ...PATCH.targets.map((t) => ({ ...t, kind: '錨' })),
      ...PATCH.helperTargets.map((t) => ({ ...t, kind: 'ヘルパーの錨' })),
    ];
    for (let i = 0; i < all.length; i++) {
      const { src, anchor, kind } = all[i]!;
      const broken = ORIG[src]!.replace(anchor, '// 上流が形を変えた\n');
      expect(broken, `${kind} ${i} を外せていない`).not.toBe(ORIG[src]);
      for (const env of [OFF, ON]) {
        const t = makeRoot({ [src]: broken });
        try {
          const other = src === REL_APP ? REL_EVL : REL_APP;
          const r = runPatch(t.dir, env);
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

describe('#121 の計装(uev-trace)── 印が全部在り、決まった順に並ぶ', () => {
  it('🔴 where が 3 つ(post / dispatch / done)+ stack 2 つ、それぞれ決まった file に 1 度だけ入る', () => {
    const t = makeRoot();
    try {
      expect(runPatch(t.dir, ON).code).toBe(0);
      const app = dropHelper(t.read(REL_APP));
      const evl = dropHelper(t.read(REL_EVL));
      // ⚠ 手書き(patch から引かない ── 引くと where を 1 つ落とした変異が「引く側も一緒に縮む」)
      const count = (body: string, needle: string): number => body.split(needle).length - 1;
      expect(count(app, 'pkc3_uev_line("post"'), 'svapp に post が 1 つでない').toBe(1);
      expect(count(app, 'pkc3_uev_stack("post-stack"'), 'svapp に post-stack が 1 つでない').toBe(1);
      expect(count(evl, 'pkc3_uev_line("dispatch"'), 'salusereventlist に dispatch が 1 つでない').toBe(1);
      expect(count(evl, 'pkc3_uev_line("done"'), 'salusereventlist に done が 1 つでない').toBe(1);
      expect(count(evl, 'pkc3_uev_stack("dispatch-stack"'), 'salusereventlist に dispatch-stack が 1 つでない').toBe(1);
      // 取り違え(別の file に撃っている)を許さない
      for (const w of ['pkc3_uev_line("dispatch"', 'pkc3_uev_line("done"', 'pkc3_uev_stack("dispatch-stack"']) {
        expect(app, `svapp に ${w}`).not.toContain(w);
      }
      for (const w of ['pkc3_uev_line("post"', 'pkc3_uev_stack("post-stack"']) {
        expect(evl, `salusereventlist に ${w}`).not.toContain(w);
      }
    } finally {
      t.cleanup();
    }
  });

  it('🔑 順番: post は PostEvent の前 / dispatch は process の前 / done は process と #endif の後・lock の前', () => {
    const t = makeRoot();
    try {
      expect(runPatch(t.dir, ON).code).toBe(0);
      const app = dropHelper(t.read(REL_APP));
      const evl = dropHelper(t.read(REL_EVL));
      // post は `auto pTmpEvent` の後、`PostEvent(` の前(`std::move` の後は pSVEvent を触れない)
      const a = app.indexOf('auto pTmpEvent = pSVEvent.get();');
      const p = app.indexOf('pkc3_uev_line("post"');
      const ps = app.indexOf('pkc3_uev_stack("post-stack"');
      const pe = app.indexOf('PostEvent( std::move(pSVEvent) )');
      expect(a > -1 && a < p && p < ps && ps < pe, 'post の位置が違う').toBe(true);
      // dispatch は `auto process` の前
      const ds = evl.indexOf('pkc3_uev_stack("dispatch-stack"');
      const d = evl.indexOf('pkc3_uev_line("dispatch"');
      const ap = evl.indexOf('auto process =');
      const pr = evl.indexOf('process();');
      const en = evl.indexOf('#endif');
      const dn = evl.indexOf('pkc3_uev_line("done"');
      const lk = evl.indexOf('aResettableListGuard.lock();\n            if (!bHandleAllCurrentEvents)');
      expect(ds > -1 && ds < d && d < ap, 'dispatch が process の前でない').toBe(true);
      expect(ap < pr && pr < en && en < dn && dn < lk, 'done が process / #endif の後・lock の前でない').toBe(true);
      // 🔑 `#ifdef IOS` の枝は触らない: 足した行は #ifdef と #endif の**間に入っていない**
      const ifdef = evl.indexOf('#ifdef IOS');
      expect(ifdef > -1 && d < ifdef, 'dispatch が #ifdef IOS の中に入っている').toBe(true);
      expect(dn > en, 'done が #ifdef IOS の中に入っている').toBe(true);
    } finally {
      t.cleanup();
    }
  });

  it('🔑 dispatch の d は UserEvent のとき mbCall、他は -1。a は m_pData(post の a と同じ値)', () => {
    const t = makeRoot();
    try {
      expect(runPatch(t.dir, ON).code).toBe(0);
      const evl = dropHelper(t.read(REL_EVL));
      const call = /pkc3_uev_line\("dispatch"[\s\S]*?: -1\);/.exec(evl)?.[0] ?? '';
      expect(call, 'dispatch の呼び出しを拾えていない').not.toBe('');
      expect(call).toContain('pkc3_uev_ptr(aEvent.m_pData)');
      expect(call).toContain('static_cast<int>(aEvent.m_nEvent)');
      expect(call).toContain('aEvent.m_nEvent == SalEvent::UserEvent && aEvent.m_pData');
      expect(call).toContain('static_cast<ImplSVEvent*>(aEvent.m_pData)->mbCall ? 1 : 0');
      const app = dropHelper(t.read(REL_APP));
      expect(app).toContain('pkc3_uev_line("post", pkc3_uev_ptr(pTmpEvent), 0, 0);');
      // stack の上限(post 600 / dispatch 300)は呼び出しの引数
      expect(app).toContain('pkc3_uev_stack("post-stack", pkc3_uev_ptr(pTmpEvent), 600);');
      expect(evl).toContain('pkc3_uev_stack("dispatch-stack", pkc3_uev_ptr(aEvent.m_pData), 300);');
      // dispatch-stack は UserEvent の回だけ
      expect(evl).toMatch(/if \(aEvent\.m_nEvent == SalEvent::UserEvent\) \/\/ PKC3-UEV\n\s+pkc3_uev_stack\("dispatch-stack"/);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 emscripten_log は #ifdef __EMSCRIPTEN__ の中だけ(include も)。flags は 3 つ OR する', () => {
    const h = PATCH.helper;
    // include は ifdef の中
    const inc = h.indexOf('#include <emscripten.h>');
    expect(inc, 'emscripten.h を include していない').toBeGreaterThan(-1);
    expect(h.lastIndexOf('#ifdef __EMSCRIPTEN__', inc), 'include が ifdef の外').toBeGreaterThan(h.lastIndexOf('#endif', inc));
    // 呼び出しは ifdef { … } の中
    const call = h.indexOf('emscripten_log(');
    expect(call).toBeGreaterThan(-1);
    const open = h.lastIndexOf('#ifdef __EMSCRIPTEN__', call);
    const close = h.indexOf('#endif', call);
    expect(open > h.lastIndexOf('#endif', call) && close > call, 'emscripten_log が ifdef の外').toBe(true);
    expect(h).toContain('emscripten_log(EM_LOG_CONSOLE | EM_LOG_C_STACK | EM_LOG_NO_PATHS, "PKC3-UEV %s a=%p"');
    // ifdef の外に emscripten_log の字が無い(2 つ目の呼び出しを足したら気づく)
    expect(h.split('emscripten_log(').length - 1, 'emscripten_log が 1 か所でない').toBe(1);
  });

  it('🔴 12 秒の門: stack は「時間が先、回数が後」/ 1 行の印(line)も同じ門を通る', () => {
    const h = PATCH.helper;
    const time = h.indexOf('if (!pkc3_uev_late())\n        return;\n    if (__atomic_fetch_add');
    expect(time, '12 秒の条件が回数の前に無い(回数を先に数えている / 条件が無い)').toBeGreaterThan(-1);
    // 門の定義は 12 秒。⚠ 1 行の印(pkc3_uev_line)も同じ門を通る
    expect(h).toContain('return pkc3_uev_elapsed_ms() >= 12000;');
    expect(h).toMatch(/void pkc3_uev_line\([^)]*\)\n\{\n {4}if \(!pkc3_uev_late\(\)\)\n {8}return;\n {4}pkc3_uev_trace\(/);
  });
});

describe('#121 の計装(uev-trace)── idles-trace と同じ 2 file を触るが、錨が重ならない', () => {
  it('🔴 svapp.cxx / salusereventlist.cxx を触る patch は、この 1 本と idles-trace の 2 本だけ', () => {
    const dir = 'build/office-wasm';
    const files = readdirSync(dir).filter((f) => /^(qtbase-)?patch-.*\.py$/.test(f));
    expect(files.length, 'patch を 1 本も拾えていない').toBeGreaterThanOrEqual(20);
    expect(files).toContain('patch-lo-uev-trace.py');
    const touching = files.filter((f) => {
      // 🔑 注釈ではなく**コード**の中の path 文字列(引用符つき)だけを見る
      const code = readFileSync(join(dir, f), 'utf-8')
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
      return /["']vcl\/source\/app\/(svapp|salusereventlist)\.cxx["']/.test(code);
    });
    // 増えたら、錨が重ならないことと両順同一を下の it に足す
    expect(touching, 'svapp.cxx / salusereventlist.cxx を触る patch').toEqual(['patch-lo-idles-trace.py', 'patch-lo-uev-trace.py']);
  });

  /**
   * idles-trace は 4 file(+ QtInstance.cxx / winproc.cxx)に当たるので、**自分の錨を並べただけの**
   * 2 file を足して回す(本物の上流 file は repo に無い)。⚠ 見るのは**この 2 file の両順同一**。
   * 🔑 idles-trace の `salusereventlist.cxx` の錨(`auto process …; process();` の 2 行が隣り合う)は、
   * こちらの `dispatch` / `done` が**その間に割り込むと**壊れる ── それが起きないこと。
   */
  it('🔴 どちらの順で当てても出力が同一で、両方の計装が入っている', () => {
    // 🔑 錨どうしが入れ子になる(helper の錨が、本体の錨の一部)ことがある ── 長い順に足し、
    //    すでに含まれている錨は足さない(足すと 2 件に当たる)
    const synth = (src: string): string => {
      const anchors = IDLES.helperTargets
        .filter((t) => t.src === src)
        .map((t) => t.anchor)
        .concat(IDLES.targets.filter((t) => t.src === src).map((t) => t.anchor))
        .sort((x, y) => y.length - x.length);
      let text = '';
      for (const a of anchors) if (!text.includes(a)) text += a + '\n';
      return text;
    };
    const extra: Record<string, string> = {};
    for (const src of new Set([...IDLES.helperTargets, ...IDLES.targets].map((t) => t.src))) {
      if (src === REL_APP || src === REL_EVL) continue;
      extra[src] = synth(src);
    }
    const idlesEnv = { PKC3_IDLES_TRACE: '1', PKC3_UEV_TRACE: '1' };
    // idles が当たる file は、上流の抜粋ではなく**錨を並べた版**を使う(抜粋に idles の錨が無い部分があるため)
    const base: Record<string, string> = {
      ...extra,
      [REL_APP]: EXCERPT_APP + '\n' + synth(REL_APP),
      [REL_EVL]: EXCERPT_EVL,
    };
    const a = makeRoot(base);
    const b = makeRoot(base);
    try {
      // 🔑 空振り防止: 錨を並べた版に、idles / uev 両方の錨が **1 件ずつ**ある
      for (const t of [...PATCH.targets, ...PATCH.helperTargets, ...IDLES.targets, ...IDLES.helperTargets]) {
        const text = base[t.src];
        if (text === undefined) continue;
        expect(text.split(t.anchor).length - 1, `${t.src} の錨が 1 件でない:\n${t.anchor}`).toBe(1);
      }
      for (const [root, order] of [
        [a, [IDLES_SCRIPT, SCRIPT]],
        [b, [SCRIPT, IDLES_SCRIPT]],
      ] as const) {
        for (const s of order) {
          const r = runScript(s, root.dir, idlesEnv);
          expect(r.code, `${s}\n${r.out}`).toBe(0);
        }
      }
      for (const rel of [REL_APP, REL_EVL]) {
        expect(a.read(rel), `${rel}: 当てる順で出力が違う`).toBe(b.read(rel));
      }
      // 両方の計装が実際に入っている(どちらかが空振りで「同一」になっていない)
      const evl = a.read(REL_EVL);
      expect(evl).toContain('pkc3_idles_trace("disp:ev"');
      expect(evl).toContain('pkc3_uev_line("dispatch"');
      expect(evl).toContain('pkc3_uev_line("done"');
      expect(a.read(REL_APP)).toContain('pkc3_idles_trace("execute:call"');
      expect(a.read(REL_APP)).toContain('pkc3_uev_line("post"');
    } finally {
      a.cleanup();
      b.cleanup();
    }
  }, 60_000);
});

describe('#121 の計装(uev-trace)── helper は g++ で通り、決めた形の 1 行を出す', () => {
  const FAKE_EM = `#pragma once
#include <cstdarg>
#include <cstdio>
#define EM_LOG_CONSOLE 1
#define EM_LOG_C_STACK 8
#define EM_LOG_NO_PATHS 64
inline void emscripten_log(int flags, const char* fmt, ...) __attribute__((format(printf, 2, 3)));
inline void emscripten_log(int flags, const char* fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    std::fprintf(stderr, "EMLOG flags=%d ", flags);
    std::vfprintf(stderr, fmt, ap);
    std::fputc('\\n', stderr);
    va_end(ap);
}
`;

  it('🔴 -Wall -Wextra -Werror で通り、a=%p b=%llu c=%d d=%d の形で出る。非 Emscripten では stack は何も出さない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-uev-h-'));
    try {
      const src = `${PATCH.helper}
int main()
{
    int nObj = 0;
    pkc3_uev_trace("w:probe", pkc3_uev_ptr(&nObj), 1, 2);
    pkc3_uev_stack("w:stack", pkc3_uev_ptr(&nObj), 5);
    return 0;
}
`;
      writeFileSync(join(dir, 't.cxx'), src, 'utf-8');
      const cc = spawnSync('g++', ['-std=c++20', '-Wall', '-Wextra', '-Werror', join(dir, 't.cxx'), '-o', join(dir, 't')], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      expect(cc.status, cc.stderr).toBe(0);
      const run = spawnSync(join(dir, 't'), [], { encoding: 'utf-8', cwd: dir, stdio: 'pipe' });
      expect(run.status, run.stderr).toBe(0);
      const rows = run.stderr.split('\n').filter((l) => l.length > 0);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatch(/^PKC3-UEV w:probe a=0x[0-9a-f]+ b=\d+ c=1 d=2$/);
    } finally {
      // ⚠ 計装は固定の path(/tmp/pkc3-uev.log)へも書く ── 走らせた後に残さない
      rmSync('/tmp/pkc3-uev.log', { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  /**
   * 🔴 **条件(12 秒 + 回数)が実際に効くこと**(1 行の印 `pkc3_uev_line` も同じ 12 秒の門)。⚠ `__EMSCRIPTEN__` を立て、`emscripten.h` を**偽物**に差し替え、
   * `clock_gettime` を**自前の時計**へ名前替えして、時間を進めて呼ぶ。
   *   - 最初の呼び出しの 11.999 秒後 → 1 行の印も stack も出ない(条件①)
   *   - 12 秒後 → 1 行の印が出る / stack は 3 回呼んで上限 2 なので **2 回だけ**出る(条件②)
   *   - flags は 3 つとも OR されている(偽 header の定数は別々の bit)
   */
  it('🔴 1 行の印と stack は「最初の呼び出しから 12 秒以上」のときだけ出る。stack は更に上限回数未満(偽の時計と偽の emscripten.h)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-uev-e-'));
    try {
      writeFileSync(join(dir, 'emscripten.h'), FAKE_EM, 'utf-8');
      const src = `${PATCH.helper}
static long long g_ms = 1000000;
extern "C" int pkc3_fake_clock_gettime(clockid_t, struct timespec* pTs) noexcept
{
    pTs->tv_sec = g_ms / 1000;
    pTs->tv_nsec = (g_ms % 1000) * 1000000;
    return 0;
}
int main()
{
    int nObj = 0;
    const unsigned long long a = pkc3_uev_ptr(&nObj);
    pkc3_uev_line("l:first", a, 0, 0);           // 起点(経過 0)→ 1 行の印も出ない
    pkc3_uev_stack("s:early", a, 2);             // 経過 0 → 出ない
    g_ms += 11999;
    pkc3_uev_line("l:early", a, 0, 0);           // 経過 11.999 秒 → 出ない
    pkc3_uev_stack("s:early2", a, 2);            // 経過 11.999 秒 → 出ない
    g_ms += 1;
    pkc3_uev_line("l:late", a, 3, 4);            // 経過 12 秒 → 出る
    pkc3_uev_stack("s:1", a, 2);                 // 経過 12 秒 → 出る(1 回目)
    pkc3_uev_stack("s:2", a, 2);                 // 2 回目
    pkc3_uev_stack("s:3", a, 2);                 // 上限 2 → 出ない
    return 0;
}
`;
      writeFileSync(join(dir, 't.cxx'), src, 'utf-8');
      const cc = spawnSync(
        'g++',
        ['-std=c++20', '-Wall', '-Wextra', '-Werror', '-D__EMSCRIPTEN__', '-Dclock_gettime=pkc3_fake_clock_gettime', `-I${dir}`, join(dir, 't.cxx'), '-o', join(dir, 't')],
        { encoding: 'utf-8', stdio: 'pipe' },
      );
      expect(cc.status, cc.stderr).toBe(0);
      const run = spawnSync(join(dir, 't'), [], { encoding: 'utf-8', cwd: dir, stdio: 'pipe' });
      expect(run.status, run.stderr).toBe(0);
      const rows = run.stderr.split('\n').filter((l) => l.length > 0);
      const em = rows.filter((l) => l.startsWith('EMLOG '));
      // 1 行の印は 12 秒後の 1 本だけ(`l:first` / `l:early` は出ない)、あとは stack の 2 回だけ
      expect(rows.filter((l) => l.startsWith('PKC3-UEV ')), '12 秒前に 1 行の印を出している / 12 秒後に出ていない').toHaveLength(1);
      expect(rows[0]).toMatch(/^PKC3-UEV l:late a=0x[0-9a-f]+ b=\d+ c=3 d=4$/);
      expect(em, '12 秒前に出している / 上限を超えて出している / 出ていない').toHaveLength(2);
      // flags: 偽 header の定数(1 | 8 | 64)が全部 OR されている
      expect(em[0]).toMatch(/^EMLOG flags=73 PKC3-UEV s:1 a=0x[0-9a-f]+$/);
      expect(em[1]).toMatch(/^EMLOG flags=73 PKC3-UEV s:2 a=0x[0-9a-f]+$/);
    } finally {
      rmSync('/tmp/pkc3-uev.log', { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('#121 の計装(uev-trace)── probe の filter と上限', () => {
  const PROBE = readFileSync('build/office-wasm/clipboard-probe.mjs', 'utf-8');
  /** 注釈の行を落とす(解説文に満たされない)。 */
  const code = PROBE.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  it('🔑 filter に PKC3-UEV が入り、clipTrace は直近 3000 行の ring(400 でも頭取りでもない)', () => {
    expect(code).toContain('/PKC3-(CLIP|MENU|UEV)/.test(m.text())');
    expect(code).toContain('pushRing(row.clipTrace, `[+${Date.now() - t0}ms]${tu}`, 3000)');
    expect(code, '旧い頭取りの上限が残っている').not.toMatch(/row\.clipTrace\.length < \d+/);
  });

  it('🔴 pushRing は溢れたら古い行を落とす(直近を残す)。頭取りに戻すと落ちる', () => {
    const m = /const pushRing = (\(arr, item, max\) => \{[\s\S]*?\n\});/.exec(code);
    expect(m, 'pushRing を取り出せない').not.toBeNull();
    const pushRing = new Function(`return ${m![1]!}`)() as (a: string[], i: string, max: number) => void;
    const arr: string[] = [];
    for (let i = 0; i < 3005; i++) pushRing(arr, `L${i}`, 3000);
    expect(arr).toHaveLength(3000);
    // 古い 5 行が落ち、直近が残る(頭取りなら先頭は L0、末尾は L2999)
    expect(arr[0]).toBe('L5');
    expect(arr[2999]).toBe('L3004');
    // 溢れる前は 1 行も落とさない
    const few: string[] = [];
    for (let i = 0; i < 10; i++) pushRing(few, `L${i}`, 3000);
    expect(few).toHaveLength(10);
  });

  it('🔴 PKC3-UEV の行は safeUevLine を通る(160 字で切らず 4000 字まで・改行を残す・非 ASCII の行だけ捨てる)', () => {
    expect(code).toContain("m.text().includes('PKC3-UEV') ? safeUevLine(");
    const m = /const safeUevLine = (\(s\) => \{[\s\S]*?\n\});/.exec(code);
    expect(m, 'safeUevLine を取り出せない').not.toBeNull();
    const safeUevLine = new Function(`return ${m![1]!}`)() as (s: string) => string | null;
    const sl = new Function(`return ${/const safeLine = (\(s\) => [^\n]+);/.exec(code)![1]!}`)() as (s: string) => string | null;
    // 改行入りの stack は残る(safeLine は改行で丸ごと捨てる ── それが safeUevLine の存在理由)
    const stack = '[log] PKC3-UEV post-stack a=0x1234\n    at foo (bar)\n    at baz (qux)';
    expect(sl(stack), '対照群: safeLine は改行入りを捨てる').toBeNull();
    expect(safeUevLine(stack)).toBe(stack);
    // 非 ASCII の行は、その行だけ捨てる(他の行は残る)
    expect(safeUevLine('[log] PKC3-UEV x a=0x1\n日本語の行\n    at ok (here)')).toBe('[log] PKC3-UEV x a=0x1\n    at ok (here)');
    // 長さ: 160 字を超えて残り、4000 字で切る
    const long = `[log] PKC3-UEV x ${'a'.repeat(5000)}`;
    expect(sl(long)!.length, '対照群: safeLine は 160').toBe(160);
    expect(safeUevLine(long)!.length).toBe(4000);
    // 何も残らなければ null
    expect(safeUevLine('日本語だけ')).toBeNull();
  });
});

describe('#121 の計装(uev-trace)── 台帳(スコープ検査 / workflow)に載っている', () => {
  it('🔑 helper の当て先が、スコープ検査(check-patch-scope.py)にも載っている', () => {
    // ⚠ SPECS は手書きの一覧 ── 足し忘れると、この 2 file だけ検査の外になる
    const scope = readFileSync('build/office-wasm/check-patch-scope.py', 'utf-8');
    const at = scope.indexOf('"PKC3_UEV_TRACE"');
    expect(at, 'SPECS に PKC3_UEV_TRACE が無い').toBeGreaterThan(-1);
    const block = scope.slice(at, scope.indexOf('# 🔑 #117', at));
    expect(block).toContain('"patch-lo-uev-trace.py"');
    expect(block).toContain('"pkc3_uev_trace"');
    expect(block).toContain('"vcl/source/app/svapp.cxx"');
    expect(block).toContain('"vcl/source/app/salusereventlist.cxx"');
    // 当て先の file は、patch の HELPER_TARGETS と**集合で**一致する(件数ではなく集合)
    const files = [...block.matchAll(/"(vcl\/[^"]+\.cxx)"/g)].map((m) => m[1]!).sort();
    expect(files).toEqual(PATCH.helperTargets.map((t) => t.src).sort());
  });

  /**
   * workflow の入力は 4 か所(入力 / 環境変数の export / 別 tag の接尾辞 / build-info.json)で効く。
   * 🔑 見るのは**実行する行**(コメントを落としてから)── 解説文に満たされない。
   */
  it('🔴 workflow の 4 か所(入力 / export / 接尾辞 / build-info)と、ref 検査の既定(=0)と、本数 23 が揃っている', () => {
    const strip = (p: string): string =>
      readFileSync(p, 'utf-8')
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
    const yml = strip('.github/workflows/office-wasm-build.yml');
    expect(yml, '入力が無い').toMatch(/^ {6}uev_trace:\n[\s\S]*?default: false/m);
    expect(yml, '環境変数の export が無い').toContain('export PKC3_UEV_TRACE=1');
    expect(yml, '既定(=0)の export が無い').toContain('export PKC3_UEV_TRACE=0');
    expect(yml, '別 tag の接尾辞が無い').toContain('SAFE_SUFFIX="${SAFE_SUFFIX}-uevtrace"');
    expect(yml, 'build-info.json に入っていない').toContain('\\"uev_trace\\": \\"${{ inputs.uev_trace }}\\"');
    expect(yml.match(/inputs\.uev_trace/g)?.length, '入力を読む所が 3 か所でない').toBe(3);
    expect(strip('build/office-wasm/check-patches-on-ref.sh')).toContain('PKC3_UEV_TRACE=0');
    // 本数: 22 → 23(この 1 本)。注記も足してある(コメントなので strip しない版で見る)。
    // いまの `-eq` は 24 ── 後から `patch-lo-yield-proxy-guard.py` が 1 本足した(「22 → 23」の注記は残っている)。
    const raw = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(raw).toMatch(/22 → 23\(2026-10-04\)/);
    expect(raw).toContain('patch-lo-uev-trace.py');
    expect(yml).toContain('test "$n" -eq 24');
  });
});
