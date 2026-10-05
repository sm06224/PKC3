/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-uev-trace.py` を検める(#121 の**計装**、3 本目)。
 *
 * 🔴 **これは直しではなく、「どの user event が落ちるか・誰が積んだか」を言う計装である。** popup の「コピー」を
 * マウスで選んだ回だけ、約 10.2 秒後に `DispatchUserEvents` の `noexcept` lambda から JS 例外で terminate する。
 * 焼きは 15〜30 分かかる。
 *
 * 🔴 **2026-10-05(#1344)に 5 種を足した**(`wake` / `yield-in` / `yield-out` / `wait-out` / `proxy-out` / `exec-ret`)。
 *   ⚠ 新しい patch ではなく**この 1 本の拡張**で、`QtInstance.cxx` / `QtMenu.cxx` が当て先に増えた。
 *   見るのは下の「#1344 の判別用」の節(位置 / 門を g++ で実走 / idles-trace・menu-trace との両順同一 / probe の `B2w`)。
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
// 🔴 #1344: 当て先は 4 file(svapp / salusereventlist / QtInstance / QtMenu)。
const REL_QTI = 'vcl/qt5/QtInstance.cxx';
const REL_QTM = 'vcl/qt5/QtMenu.cxx';
const REL_MENU = 'vcl/source/window/menu.cxx';
const MENU_SCRIPT = 'build/office-wasm/patch-lo-menu-trace.py';
const EXCERPT_QTI = readFileSync('tests/fixtures/office-lo/QtInstance.excerpt.cxx', 'utf-8');
const EXCERPT_QTM = readFileSync('tests/fixtures/office-lo/QtMenu.excerpt.cxx', 'utf-8');
const EXCERPT_MENU = readFileSync('tests/fixtures/office-lo/menu.excerpt.cxx', 'utf-8');
const ORIG: Record<string, string> = {
  [REL_APP]: EXCERPT_APP,
  [REL_EVL]: EXCERPT_EVL,
  [REL_QTI]: EXCERPT_QTI,
  [REL_QTM]: EXCERPT_QTM,
};
const FILES = [REL_APP, REL_EVL, REL_QTI, REL_QTM];
const MARK = '// PKC3-UEV';
const ON = { PKC3_UEV_TRACE: '1' };
const OFF = { PKC3_UEV_TRACE: '0' };

interface Root {
  dir: string;
  read: (rel: string) => string;
  cleanup: () => void;
}

/** LO の root の形(`vcl/source/app/…` / `vcl/qt5/…`)を一時 dir に作る。既定は 4 file とも原文の抜粋。 */
function makeRoot(files: Record<string, string> = {}): Root {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-uev-'));
  const put = (rel: string, body: string): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body, 'utf-8');
  };
  put(REL_APP, EXCERPT_APP);
  put(REL_EVL, EXCERPT_EVL);
  put(REL_QTI, EXCERPT_QTI);
  put(REL_QTM, EXCERPT_QTM);
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
    // 3(post / dispatch / done)+ 6(#1344: wake / yield / wait / proxy 前 / proxy 後 / exec-ret)
    expect(PATCH.targets.length, '錨を拾えていない').toBe(9);
    expect(PATCH.helperTargets.length, 'ヘルパーの当て先を拾えていない').toBe(4);
    expect(new Set(PATCH.targets.map((t) => t.anchor)).size, '同じ錨が 2 つ在る').toBe(PATCH.targets.length);
    expect(PATCH.targets.filter((t) => t.src === REL_APP).length).toBe(1);
    expect(PATCH.targets.filter((t) => t.src === REL_EVL).length).toBe(2);
    expect(PATCH.targets.filter((t) => t.src === REL_QTI).length, 'QtInstance の錨は 5 つ').toBe(5);
    expect(PATCH.targets.filter((t) => t.src === REL_QTM).length, 'QtMenu の錨は 1 つ').toBe(1);
    expect(PATCH.helperTargets.map((t) => t.src).sort()).toEqual([...FILES].sort());
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
        for (const rel of FILES) expect(t.read(rel), `${rel}: 既定なのに書き換えている`).toBe(ORIG[rel]);
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
      for (const rel of FILES) {
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
      for (const rel of FILES) {
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
      for (const rel of FILES) {
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
      const once = FILES.map((f) => t.read(f));
      const r = runPatch(t.dir, ON);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('二重当て');
      expect(FILES.map((f) => t.read(f))).toEqual(once);
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
          const r = runPatch(t.dir, env);
          expect(r.code, `${kind} ${i}(${src} / ${JSON.stringify(env)})を外しても落ちない:\n${r.out}`).toBe(1);
          expect(r.out, `${kind} ${i} の落ち方が「錨の欠落」でない`).toMatch(/(錨|ヘルパーの錨)が 0 件/);
          expect(t.read(src), '落ちたのに書き換えている').toBe(broken);
          // ⚠ 落ちたとき**他の 3 file も**書き換えていない
          for (const other of FILES.filter((f) => f !== src))
            expect(t.read(other), `落ちたのに ${other} を書き換えている`).toBe(ORIG[other]);
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
    // 🔴 #1344: QtInstance.cxx は**上流の抜粋そのもの**で当てる(idles の 5 つの錨も、こちらの 5 つの錨も実在する)
    extra[REL_QTI] = EXCERPT_QTI;
    const idlesEnv = { PKC3_IDLES_TRACE: '1', PKC3_UEV_TRACE: '1' };
    // idles が当たる file は、上流の抜粋ではなく**錨を並べた版**を使う(抜粋に idles の錨が無い部分があるため)
    const base: Record<string, string> = {
      ...extra,
      [REL_APP]: EXCERPT_APP + '\n' + synth(REL_APP),
      [REL_EVL]: EXCERPT_EVL,
      [REL_QTM]: EXCERPT_QTM,
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
      for (const rel of [...FILES, ...Object.keys(extra)]) {
        expect(a.read(rel), `${rel}: 当てる順で出力が違う`).toBe(b.read(rel));
      }
      // 両方の計装が実際に入っている(どちらかが空振りで「同一」になっていない)
      const evl = a.read(REL_EVL);
      expect(evl).toContain('pkc3_idles_trace("disp:ev"');
      expect(evl).toContain('pkc3_uev_line("dispatch"');
      expect(evl).toContain('pkc3_uev_line("done"');
      expect(a.read(REL_APP)).toContain('pkc3_idles_trace("execute:call"');
      expect(a.read(REL_APP)).toContain('pkc3_uev_line("post"');
      // 🔴 #1344: QtInstance.cxx は 2 本とも入っている(ヘルパーも 1 つずつ)
      const qti = a.read(REL_QTI);
      expect(qti).toContain('pkc3_idles_trace("yield:impl"');
      expect(qti).toContain('pkc3_idles_trace("yield:proxy"');
      expect(qti).toContain('Pkc3UevYieldScope aPkc3UevYield');
      expect(qti).toContain('pkc3_uev_proxy_out(nPkc3UevProxyIn);');
      expect(qti.match(/PKC3-UEV-HELPER-BEGIN/g)?.length).toBe(1);
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

/**
 * 🔴 #1344(2026-10-05)の判別用 5 種(`wake` / `yield-in` / `yield-out` / `wait-out` / `proxy-out` / `exec-ret`)。
 *
 * マウスで popup を選んだ後、user event の処理が 10〜12 秒止まる。仮説 3 本:
 *   ① 起こしが食われ、外側の `processEvents(WaitForMoreEvents)` が起きない ② main の `ImplYield` は動くが drain する caller が別物
 *   ③ LO thread 側の `DoYield` 枝 B の `emscripten_promise_await` が resume しない
 *
 * ⚠ **言えないこと**: 本物の LO / Qt の header で通ること(焼かないと分からない)。ここで g++ に通すのは**ヘルパーの単体**で、
 *   呼び側の行(`QtInstance` の member / `wasEvent` / `bWasEvent` など)は**上流の抜粋に当てて字面と順序を見る**だけ。
 */
describe('#1344 の判別用 ── 印の位置(上流の抜粋に当てた結果)', () => {
  const applied = (): { qti: string; qtm: string; cleanup: () => void } => {
    const t = makeRoot();
    expect(runPatch(t.dir, ON).code).toBe(0);
    return { qti: dropHelper(t.read(REL_QTI)), qtm: dropHelper(t.read(REL_QTM)), cleanup: t.cleanup };
  };
  const count = (body: string, needle: string): number => body.split(needle).length - 1;

  it('🔑 wake は TriggerUserEventProcessing の中、`wakeUp()` の**直前の行**(1 度だけ)', () => {
    const { qti, cleanup } = applied();
    try {
      expect(count(qti, 'pkc3_uev_wake();')).toBe(1);
      expect(qti).toContain('    pkc3_uev_wake(); // PKC3-UEV\n    dispatcher->wakeUp();\n');
      const fn = qti.indexOf('void QtInstance::TriggerUserEventProcessing()');
      expect(fn, 'TriggerUserEventProcessing を拾えていない').toBeGreaterThan(-1);
      expect(qti.indexOf('pkc3_uev_wake();'), 'wake が TriggerUserEventProcessing の外').toBeGreaterThan(fn);
    } finally {
      cleanup();
    }
  });

  it('🔑 yield の RAII は DispatchUserEvents の後・**early return の前**(早期 return でも出口が出る)', () => {
    const { qti, cleanup } = applied();
    try {
      expect(count(qti, 'Pkc3UevYieldScope aPkc3UevYield(bWait, bHandleAllCurrentEvents);')).toBe(1);
      expect(qti).toContain(
        'bool wasEvent = DispatchUserEvents(bHandleAllCurrentEvents);\n' +
          '    Pkc3UevYieldScope aPkc3UevYield(bWait, bHandleAllCurrentEvents); // PKC3-UEV\n' +
          '    if (!bHandleAllCurrentEvents && wasEvent)\n        return true;\n',
      );
    } finally {
      cleanup();
    }
  });

  it('🔑 wait は「入る前の時刻 → 原文の 4 行(そのまま)→ 出口 → return」の順。入る前の条件は原文の `if` と同じ', () => {
    const { qti, cleanup } = applied();
    try {
      expect(count(qti, 'pkc3_uev_wait_out(')).toBe(1);
      expect(qti).toContain(
        '    const long long nPkc3UevWaitIn = (bWait && !wasEvent) ? pkc3_uev_elapsed_ms() : -1; // PKC3-UEV\n' +
          '    if (bWait && !wasEvent)\n' +
          '        wasEvent = dispatcher->processEvents(QEventLoop::WaitForMoreEvents);\n' +
          '    else\n' +
          '        wasEvent = dispatcher->processEvents(QEventLoop::AllEvents) || wasEvent;\n' +
          '    if (nPkc3UevWaitIn >= 0) // PKC3-UEV\n' +
          '        pkc3_uev_wait_out(nPkc3UevWaitIn, bHandleAllCurrentEvents ? 1 : 0, wasEvent ? 1 : 0); // PKC3-UEV\n' +
          '    return wasEvent;\n',
      );
    } finally {
      cleanup();
    }
  });

  it('🔑 proxy は DoYield 枝 B の `emscripten_promise_await` の前後(JSPI の #if の中・1 度ずつ)', () => {
    const { qti, cleanup } = applied();
    try {
      expect(count(qti, 'pkc3_uev_elapsed_ms(); // PKC3-UEV\n        (void)emscripten_promise_await(')).toBe(1);
      expect(qti).toContain(
        '        const long long nPkc3UevProxyIn = pkc3_uev_elapsed_ms(); // PKC3-UEV\n' +
          '        (void)emscripten_promise_await(emscripten_proxy_promise(\n',
      );
      expect(qti).toContain(
        'bWasEvent })));\n        pkc3_uev_proxy_out(nPkc3UevProxyIn); // PKC3-UEV\n    }\n#endif\n',
      );
      const ifd = qti.indexOf('#if defined __EMSCRIPTEN__ && ENABLE_QT6 && HAVE_EMSCRIPTEN_JSPI');
      const inn = qti.indexOf('nPkc3UevProxyIn = ');
      const out = qti.indexOf('pkc3_uev_proxy_out(nPkc3UevProxyIn);');
      expect(ifd > -1 && ifd < inn && inn < out, 'proxy の印が JSPI の #if の中に順に入っていない').toBe(true);
    } finally {
      cleanup();
    }
  });

  it('🔑 exec-ret は `mpQMenu->exec(...)` の**直後の行**(戻り値は取らない = menu-trace の錨と交わらない)', () => {
    const { qtm, cleanup } = applied();
    try {
      expect(count(qtm, 'pkc3_uev_exec_ret();')).toBe(1);
      expect(qtm).toContain('    mpQMenu->exec(aRect.bottomLeft());\n    pkc3_uev_exec_ret(); // PKC3-UEV\n\n    return true;\n}\n');
      // 戻り値を受けるように exec の行を書き換えていない(それをやると menu-trace の錨と重なる)
      expect(qtm).not.toContain('= mpQMenu->exec(');
    } finally {
      cleanup();
    }
  });

  it('🔑 helper に kind ごとの上限が入っている(wake 2000 / yield 3000 ×2 / wait-out 600 / proxy-out 600 / exec-ret 200)', () => {
    const h = PATCH.helper;
    for (const [kind, max] of [
      ['wake', 2000],
      ['yield-in', 3000],
      ['yield-out', 3000],
      ['wait-out', 600],
      ['proxy-out', 600],
      ['exec-ret', 200],
    ] as const) {
      expect(h, `${kind} の上限が ${max} でない`).toContain(`pkc3_uev_mark("${kind}", &nShown, ${max},`);
    }
    // 書式: tid は %p
    expect(h).toContain('"PKC3-UEV %s tid=%p x=%d y=%d z=%d ms=%lld in=%lld');
  });
});

/**
 * 🔴 **錨の区間が交わらない**(= 当てる順で結果が変わらない理由そのもの)。
 * ⚠ 「両順で同一」だけだと、**どちらかの錨が空振りしても同一**になる(両方とも当たっていない)── 区間も直に見る。
 * idles-trace の 2 つの錨(ヘルパーと本体)は**自分どうしで重なる**(ヘルパーの錨は本体の先頭)ので、**こちらの錨 × 相手の錨**だけを見る。
 */
describe('#1344 の判別用 ── idles-trace / menu-trace の錨と区間が交わらない', () => {
  const spans = (text: string, anchors: string[]): [number, number][] =>
    anchors.map((a) => {
      expect(text.split(a).length - 1, `錨が 1 件でない:\n${a}`).toBe(1);
      const i = text.indexOf(a);
      return [i, i + a.length];
    });
  const overlaps = (a: [number, number][], b: [number, number][]): string[] =>
    a.flatMap((x, i) => b.flatMap((y, j) => (x[0] < y[1] && y[0] < x[1] ? [`${i}×${j}`] : [])));

  it('🔴 QtInstance.cxx: こちらの 6 つの錨(ヘルパー + 5)は idles-trace の錨と 1 バイトも重ならない', () => {
    const mine = [...PATCH.targets, ...PATCH.helperTargets].filter((t) => t.src === REL_QTI).map((t) => t.anchor);
    const theirs = [...IDLES.targets, ...IDLES.helperTargets].filter((t) => t.src === REL_QTI).map((t) => t.anchor);
    expect(mine.length, '空振り防止: こちらの錨').toBe(6);
    expect(theirs.length, '空振り防止: idles の錨(本体 5 + ヘルパー 1)').toBe(6);
    expect(overlaps(spans(EXCERPT_QTI, mine), spans(EXCERPT_QTI, theirs)), '錨が重なっている').toEqual([]);
  });

  it('🔴 QtMenu.cxx: こちらの 2 つの錨(ヘルパー + exec-ret)は menu-trace の錨と 1 バイトも重ならない', () => {
    const menu = loadPatch(MENU_SCRIPT);
    const mine = [...PATCH.targets, ...PATCH.helperTargets].filter((t) => t.src === REL_QTM).map((t) => t.anchor);
    const theirs = [...menu.targets, ...menu.helperTargets].filter((t) => t.src === REL_QTM).map((t) => t.anchor);
    expect(mine.length, '空振り防止: こちらの錨').toBe(2);
    expect(theirs.length, '空振り防止: menu-trace の錨(本体 4 + ヘルパー 1)').toBe(5);
    expect(overlaps(spans(EXCERPT_QTM, mine), spans(EXCERPT_QTM, theirs)), '錨が重なっている').toEqual([]);
  });

  it('🔴 menu-trace と両順で当てて出力が同一 ── 両方の印が `exec` の行の後ろに順に入っている', () => {
    const env = { PKC3_MENU_TRACE: '1', PKC3_UEV_TRACE: '1' };
    const base = { [REL_MENU]: EXCERPT_MENU };
    const a = makeRoot(base);
    const b = makeRoot(base);
    try {
      for (const [root, order] of [
        [a, [MENU_SCRIPT, SCRIPT]],
        [b, [SCRIPT, MENU_SCRIPT]],
      ] as const) {
        for (const sc of order) {
          const r = runScript(sc, root.dir, env);
          expect(r.code, `${sc}\n${r.out}`).toBe(0);
        }
      }
      for (const rel of [...FILES, REL_MENU]) {
        expect(a.read(rel), `${rel}: 当てる順で出力が違う`).toBe(b.read(rel));
      }
      const qtm = a.read(REL_QTM);
      const e = qtm.indexOf('QAction* const pPkc3Chosen = mpQMenu->exec(');
      const r1 = qtm.indexOf('pkc3_menu_trace("exec:return"');
      const r2 = qtm.indexOf('pkc3_uev_exec_ret();');
      const rt = qtm.indexOf('    return true;\n}\n', r2);
      expect(e > -1 && e < r1 && r1 < r2 && r2 < rt, 'exec → menu の exec:return → uev の exec-ret → return の順でない').toBe(true);
      // ヘルパーが 2 種とも 1 つずつ(取り合っていない)
      expect(qtm.match(/PKC3-UEV-HELPER-BEGIN/g)?.length).toBe(1);
      expect(qtm.match(/PKC3-MENU-HELPER-BEGIN/g)?.length).toBe(1);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  }, 60_000);
});

describe('#1344 の判別用 ── 門を g++ で実走(偽の時計)', () => {
  /**
   * 🔴 **門を 1 つずつ鳴らす**(1 つ外しても他が救って緑、を許さない)。⚠ `clock_gettime` を**自前の時計**へ名前替えして時間を進める。
   *   - 12 秒前: `wake` は出ない / nest ≥ 2 の `yield-in/out` は出ない / 5000 ms 待った `wait-out` `proxy-out` も出ない(**12 秒の門だけ**が鳴る)
   *   - 12 秒後: 999 ms の `wait-out` `proxy-out` は出ない / nest 1・999 ms の yield は出ない(**1000 ms の門だけ**が鳴る)
   *   - 12 秒後: 1000 ms の `wait-out` `proxy-out` は 1 行 / nest 1・1000 ms の `yield-out` は 1 行(**in 行は出ない**)/
   *     nest 2 は 0 ms でも `yield-in` + `yield-out`(**nest の門だけ**)
   *   - `exec-ret` は 12 秒前でも出る(門なし)
   *   - 深さが戻る: 入れ子の後の nest 1 の 0 ms は出ない(`--depth()` を落とす変異を殺す)
   *   - 上限: wake 2000 / wait-out 600 / proxy-out 600 / exec-ret 200 / yield-in 3000 / yield-out 3000
   * ⚠ 1000 ms と nest ≥ 2 は**行数を抑えるための門**で、測っていない数で断るためではない。
   */
  it('🔴 12 秒 / 1000 ms / nest ≥ 2 の 3 つの門が、それぞれ単独で鳴る。上限は kind ごと。深さは戻る', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-uev-g-'));
    try {
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
    // ── 12 秒前(経過 0 から 5000)──
    pkc3_uev_elapsed_ms();                      // 起点(経過 0)
    pkc3_uev_wake();                            // 12 秒前 → 出ない
    pkc3_uev_exec_ret();                        // 門なし → 出る
    {
        Pkc3UevYieldScope aOuter(true, false);
        Pkc3UevYieldScope aInner(false, true);  // nest 2 だが 12 秒前 → 出ない
    }
    const long long nEarly = pkc3_uev_elapsed_ms();
    g_ms += 5000;
    pkc3_uev_wait_out(nEarly, 1, 0);            // 5000 ms 待ったが 12 秒前 → 出ない
    pkc3_uev_proxy_out(nEarly);                 // 同上
    // ── 12 秒後(経過 12000)──
    g_ms += 7000;
    pkc3_uev_wake();                            // 出る
    const long long nIn = pkc3_uev_elapsed_ms();
    g_ms += 999;
    pkc3_uev_wait_out(nIn, 1, 0);               // 999 ms → 出ない
    pkc3_uev_proxy_out(nIn);                    // 999 ms → 出ない
    g_ms += 1;
    pkc3_uev_wait_out(nIn, 1, 0);               // 1000 ms → 出る
    pkc3_uev_proxy_out(nIn);                    // 1000 ms → 出る
    { Pkc3UevYieldScope a(true, false); }                       // nest 1・0 ms → 出ない
    { Pkc3UevYieldScope a(true, false); g_ms += 999; }          // nest 1・999 ms → 出ない
    { Pkc3UevYieldScope a(false, true); g_ms += 1000; }         // nest 1・1000 ms → yield-out 1 行(in は出ない)
    {
        Pkc3UevYieldScope aOuter(true, true);
        Pkc3UevYieldScope aInner(false, false); // nest 2 → yield-in + yield-out(0 ms でも)
    }
    { Pkc3UevYieldScope a(true, false); }       // 入れ子の後の nest 1・0 ms → 出ない(深さが戻っていれば)
    std::fputs("SENTINEL\\n", stderr);
    // ── 上限(kind ごとに別枠)──
    for (int k = 0; k < 2100; ++k)
        pkc3_uev_wake();
    for (int k = 0; k < 700; ++k)
    {
        pkc3_uev_wait_out(nIn, 1, 0);
        pkc3_uev_proxy_out(nIn);
    }
    for (int k = 0; k < 300; ++k)
        pkc3_uev_exec_ret();
    for (int k = 0; k < 3100; ++k)
    {
        Pkc3UevYieldScope aOuter(true, false);
        Pkc3UevYieldScope aInner(true, false);
    }
    return 0;
}
`;
      writeFileSync(join(dir, 't.cxx'), src, 'utf-8');
      const cc = spawnSync(
        'g++',
        ['-std=c++20', '-Wall', '-Wextra', '-Werror', '-Dclock_gettime=pkc3_fake_clock_gettime', join(dir, 't.cxx'), '-o', join(dir, 't')],
        { encoding: 'utf-8', stdio: 'pipe' },
      );
      expect(cc.status, cc.stderr).toBe(0);
      const run = spawnSync(join(dir, 't'), [], { encoding: 'utf-8', cwd: dir, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
      expect(run.status, run.stderr).toBe(0);
      const rows = run.stderr.split('\n').filter((l) => l.length > 0);
      const norm = (l: string): string => {
        const m = /^PKC3-UEV (\S+) tid=(?:0x[0-9a-f]+|\(nil\)) (x=-?\d+ y=-?\d+ z=-?\d+ ms=-?\d+ in=-?\d+)$/.exec(l);
        expect(m, `書式が決めた形でない: ${l}`).not.toBeNull();
        return `${m![1]} ${m![2]}`;
      };
      const at = rows.indexOf('SENTINEL');
      expect(at, '番兵が出ていない(上限の段まで走っていない)').toBeGreaterThan(-1);
      // 🔑 12 秒前に出たのは exec-ret の 1 行だけ。そのあとは**決めた順に決めた欄**で出る
      expect(rows.slice(0, at).map(norm)).toEqual([
        'exec-ret x=-1 y=-1 z=-1 ms=-1 in=-1',
        'wake x=-1 y=-1 z=-1 ms=-1 in=-1',
        'wait-out x=1 y=0 z=-1 ms=1000 in=12000',
        'proxy-out x=-1 y=-1 z=-1 ms=1000 in=12000',
        'yield-out x=1 y=0 z=1 ms=1000 in=13999',
        'yield-in x=2 y=0 z=0 ms=-1 in=14999',
        'yield-out x=2 y=0 z=0 ms=0 in=14999',
      ]);
      // 上限(番兵の後ろの行を kind で数える ── 番兵の前に出た分も枠に入っている)
      const after = rows.slice(at + 1).map((l) => l.split(' ')[1]);
      const n = (k: string): number => after.filter((x) => x === k).length;
      expect(after.length, '想定外の kind が混じっている').toBe(2000 - 1 + 600 - 1 + 600 - 1 + 200 - 1 + (3000 - 1) + (3000 - 2));
      expect(n('wake'), 'wake は 2000(番兵の前の 1 行を含む)').toBe(1999);
      expect(n('wait-out'), 'wait-out は 600').toBe(599);
      expect(n('proxy-out'), 'proxy-out は 600').toBe(599);
      expect(n('exec-ret'), 'exec-ret は 200').toBe(199);
      expect(n('yield-in'), 'yield-in は 3000').toBe(2999);
      expect(n('yield-out'), 'yield-out は 3000').toBe(2998);
    } finally {
      rmSync('/tmp/pkc3-uev.log', { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
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

  /**
   * 🔴 #1344: `B2w`(B2 と同じ手順の後、2 秒待ってから版面(canvas)の**中**の右下寄りへ `mouse.move` を 1 回)。
   * ⚠ **既定の回(全部)には混ぜない**(既存の腕の回数と所要を変えない)── `PKC3_ARMS=B2w` と名指ししたときだけ。
   */
  it('🔴 B2w は名指しでだけ回る(既定の 13 腕に混ざらない)。B2 の枝の中で、click の後 → 2 秒 → mouse.move 1 回(押さない)', () => {
    const grab = (name: string): string => {
      const m = new RegExp(`const ${name} = [^\\n]+;`).exec(code);
      expect(m, `${name} を取り出せない`).not.toBeNull();
      return m![0];
    };
    const evalArms = (env: Record<string, string>): string[] =>
      new Function(
        'process',
        `${grab('ALL_ARMS')}\n${grab('OPT_IN_ARMS')}\n${grab('ARMS')}\nreturn ARMS;`,
      )({ env }) as string[];
    const def = evalArms({});
    expect(def, '既定の回に B2w が混ざっている').not.toContain('B2w');
    expect(def, '既存の腕を落としている').toEqual(['C', 'B0', 'B1', 'C2', 'B2', 'B2k', 'B3', 'B3c', 'B4', 'B5', 'B6', 'B7', 'B8']);
    expect(evalArms({ PKC3_ARMS: 'B2w' }), '名指しで選べない').toEqual(['B2w']);
    expect(code).toContain("B2w: 'text.odt'");

    const branch = code.indexOf("} else if (arm === 'B2' || arm === 'B2k' || arm === 'B2w') {");
    expect(branch, 'B2 の枝に B2w が入っていない').toBeGreaterThan(-1);
    const clickAt = code.indexOf('await page.mouse.click(cx, cy);', branch);
    expect(clickAt, 'B2 の「コピー」の click を拾えていない').toBeGreaterThan(branch);
    const blockAt = code.indexOf("if (arm === 'B2w') {", clickAt);
    expect(blockAt, 'B2w の塊が click の後ろに無い').toBeGreaterThan(clickAt);
    const blk = /if \(arm === 'B2w'\) \{([\s\S]*?)\n {12}\}/.exec(code.slice(blockAt));
    expect(blk, 'B2w の塊を取り出せない').not.toBeNull();
    const body = blk![1]!;
    expect(body.indexOf('await page.waitForTimeout(2000);'), '2 秒待っていない').toBeGreaterThan(-1);
    expect(body.split('page.mouse.move(').length - 1, 'mouse.move が 1 回でない').toBe(1);
    expect(body.indexOf('await page.waitForTimeout(2000);') < body.indexOf('await page.mouse.move(nx, ny);'), '待つのが move の後').toBe(true);
    expect(body, '押している').not.toContain('mouse.click(');
    // 🔴 canvas の**中**(右下寄り)へ打つ。外(`box.x / 2` ── 余白)だと Qt の event が立たず、対照にならない(1 稿目の誤り)
    expect(body).toContain('Math.round(box.x + box.w * NUDGE_X)');
    expect(body).toContain('Math.round(box.y + box.h * NUDGE_Y)');
    expect(body, '外へ打つ形に戻っている').not.toContain('box.x / 2');
    expect(grab('NUDGE_X')).toBe('const NUDGE_X = 0.9;');
    expect(grab('NUDGE_Y')).toBe('const NUDGE_Y = 0.9;');
    // 判定不能の規則(選択が出ない / メニューが開かない)が B2 と同じ
    expect(code).toContain("['B1', 'B3', 'B3c', 'B4', 'B2', 'B2k', 'B2w', 'B5', 'B6', 'B7', 'B8'].includes(arm) && selected !== true");
    expect(code).toContain("['B2', 'B2k', 'B2w', 'B2f', 'C2'].includes(arm) && row.menuOpened !== true");
  });

  /**
   * 🔴 #1344 の競合を狙う腕 `B2f`(2026-10-05): `Control+a` の直後(`FAST_MS`、既定 150 ms)に右クリック ──
   * status update の burst の最中、main loop が `ProcessEvent` の `emscripten_promise_await` で止まっている窓へ
   * DOM event を入れる。⚠ 既定の回には混ぜない(名指しのときだけ)。選択の印は測れないので「メニューが開いた」を
   * 選択の代わりにし、copy の結果で見る。
   */
  it('🔴 B2f は名指しでだけ回り、Control+a → FAST_MS → 右クリック → B2 と同じ「コピー」の click の順である', () => {
    const grab = (name: string): string => {
      const m = new RegExp(`const ${name} = [^\\n]+;`).exec(code);
      expect(m, `${name} を取り出せない`).not.toBeNull();
      return m![0];
    };
    const evalArms = (env: Record<string, string>): string[] =>
      new Function('process', `${grab('ALL_ARMS')}\n${grab('OPT_IN_ARMS')}\n${grab('ARMS')}\nreturn ARMS;`)({ env }) as string[];
    expect(evalArms({}), '既定の回に B2f が混ざっている').not.toContain('B2f');
    expect(evalArms({ PKC3_ARMS: 'B2f' })).toEqual(['B2f']);
    expect(code).toContain("B2f: 'text.odt'");
    expect(grab('FAST_MS')).toBe("const FAST_MS = Number(process.env.PKC3_FAST_MS ?? 150);");
    const at = code.indexOf("} else if (arm === 'B2f') {");
    expect(at, 'B2f の枝が無い').toBeGreaterThan(-1);
    const blk = /\} else if \(arm === 'B2f'\) \{([\s\S]*?)\n {4}\}\n {4}await page\.waitForTimeout\(3000\);/.exec(code.slice(at));
    expect(blk, 'B2f の枝を取り出せない(枝の終わりの形が変わった)').not.toBeNull();
    const body = blk![1]!;
    const order = ["await page.keyboard.press('Control+a');", 'await page.waitForTimeout(FAST_MS);', 'await ctxClick();', 'await page.mouse.click(cx, cy);'];
    const idx = order.map((k) => body.indexOf(k));
    expect(idx.every((i) => i > -1), `欠けている: ${order.filter((_, i) => idx[i] === -1).join(' / ')}`).toBe(true);
    expect(idx.every((v, i) => i === 0 || v > idx[i - 1]!), `順が違う: ${idx.join(',')}`).toBe(true);
    // ⚠ B2 のように 1 秒待ってから右クリックする形へ戻っていない(それでは burst の窓に入らない)
    expect(body, '1 秒待っている').not.toContain('await page.waitForTimeout(1000);\n      const menuOpen');
    expect(body).toContain('selected = menuOpen ? true : null;');
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
    // いまの `-eq` は 24 ── 後から `patch-lo-ime-nowait.py` が 1 本足した(「22 → 23」の注記は残っている)。#1344 で足した LO 側の直しは効かなかったので外した(24 → 25 → 24)。
    const raw = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(raw).toMatch(/22 → 23\(2026-10-04\)/);
    expect(raw).toContain('patch-lo-uev-trace.py');
    expect(yml).toContain('test "$n" -eq 24');
  });
});
