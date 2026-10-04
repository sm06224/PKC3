/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-menu-trace.py` を検める(#121 の**計装**)。
 *
 * 🔴 **これは直しではなく、thread と順番を数える計装である。** Writer の右クリック popup で「コピー」を選んでも
 * LO の中で `.uno:Copy` が実行されない ── 仮説は「`QMenu::exec()` の中で選んでも `triggered` が exec の戻りの後に
 * 届き、`PopupMenu::ImplFlushPendingSelect` の時点で Select が積まれていない」。焼きは 15〜30 分かかる。
 *
 * ⚠ 見るのは 6 つ:
 *   ① **既定(`PKC3_MENU_TRACE!=1`)は 1 バイトも書かない**。⚠ 錨の検査は毎回する
 *   ② **挙動を変えていない** ── 足した行(行末が `// PKC3-MENU`)と helper の塊を除き、置換した 3+1 行を
 *      手書きの原文へ戻すと、原文と一致する
 *   ③ **錨が 1 つでも外れたら落ちる**(上流の変形を黙って通さない)/ 二重当ては落ちて不変
 *   ④ **印が全部在る**(where の字を手書きで列挙)── 1 つ落とすと落ちる
 *   ⑤ **同じ file を触る別の patch が無い**(増えたら、錨が重ならないことと両順同一をここへ書く)
 *   ⑥ 台帳(スコープ検査 / workflow の 4 か所 / ref 検査の既定)に載っている
 *
 * 🔴 **言えないこと**: 本物の Qt / LO の header で通ること(焼かないと分からない)。
 *   ここで g++ に通すのは **helper の単体**(libc だけで書いてあるので通せる)で、呼び側の行は通していない。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-menu-trace.py';
const REL_QM = 'vcl/qt5/QtMenu.cxx';
const REL_MN = 'vcl/source/window/menu.cxx';
const EXCERPT_QM = readFileSync('tests/fixtures/office-lo/QtMenu.excerpt.cxx', 'utf-8');
const EXCERPT_MN = readFileSync('tests/fixtures/office-lo/menu.excerpt.cxx', 'utf-8');
const ORIG: Record<string, string> = { [REL_QM]: EXCERPT_QM, [REL_MN]: EXCERPT_MN };
const MARK = '// PKC3-MENU';
const ON = { PKC3_MENU_TRACE: '1' };
const OFF = { PKC3_MENU_TRACE: '0' };

/**
 * 印の where の全部(手書き ── patch から引かない)。🔑 patch から引くと、where を 1 つ落とした変異が
 * 「引く側も一緒に縮む」ので素通りする。
 *   - 呼び出し(`pkc3_menu_trace("…"`)として本体に在る物 9 つ
 *   - `run:native` は helper(`pkc3_menu_native`)の中に在り、menu.cxx の呼び出しは `pkc3_menu_native(` の 1 行
 */
const CALL_WHERES = [
  'show:enter',
  'exec:enter',
  'exec:return',
  'slot:enter',
  'slot:handled',
  'select:post',
  'select:call',
  'flush:check',
  'popup:dtor',
] as const;
const NATIVE_WHERE = 'run:native';

/** 置換した 3 + 1 行(原文の字面が動く物)と、戻したときの原文。⚠ 手書き。 */
const RESTORES: { marked: string[]; original: string }[] = [
  {
    marked: ['QAction* const pPkc3Chosen = mpQMenu->exec(aRect.bottomLeft());'],
    original: '    mpQMenu->exec(aRect.bottomLeft());',
  },
  {
    marked: ['const bool bPkc3Handled = pTopLevel->GetMenu()->HandleMenuCommandEvent(pMenu, mnId);'],
    original: '    pTopLevel->GetMenu()->HandleMenuCommandEvent(pMenu, mnId);',
  },
  {
    marked: ['if (pMenu && bRealExecute && pkc3_menu_native(pMenu, '],
    original: '    if (pMenu && bRealExecute && pMenu->ShowNativePopupMenu(pWin, rRect, nPopupModeFlags))',
  },
];

interface Root {
  dir: string;
  read: (rel: string) => string;
  cleanup: () => void;
}

/** LO の root の形(`vcl/qt5/…`)を一時 dir に作る。既定は 2 file とも原文の抜粋。 */
function makeRoot(files: Record<string, string> = {}): Root {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-menu-'));
  const put = (rel: string, body: string): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body, 'utf-8');
  };
  put(REL_QM, EXCERPT_QM);
  put(REL_MN, EXCERPT_MN);
  for (const [rel, body] of Object.entries(files)) put(rel, body);
  return {
    dir,
    read: (rel) => readFileSync(join(dir, rel), 'utf-8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runPatch(dir: string, env: Record<string, string> = {}): { code: number; out: string } {
  const r = spawnSync('python3', ['-B', SCRIPT, dir], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    stdio: 'pipe',
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** patch の module から、錨・helper を取り出す(⚠ 錨の字をここへ書き写さない)。 */
function loadPatch(): {
  helper: string;
  targets: { src: string; anchor: string }[];
  helperTargets: { src: string; anchor: string }[];
} {
  const code = [
    'import importlib.util,sys,json',
    'sys.dont_write_bytecode=True',
    `sp=importlib.util.spec_from_file_location("p","${SCRIPT}")`,
    'm=importlib.util.module_from_spec(sp); sp.loader.exec_module(m)',
    'print(json.dumps({"helper":m.HELPER,' +
      '"targets":[{"src":s,"anchor":a} for s,a,_r in m.TARGETS],' +
      '"helperTargets":[{"src":s,"anchor":a} for s,a,_h in m.HELPER_TARGETS]}))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf-8', stdio: 'pipe' }));
}
const PATCH = loadPatch();

/** helper の塊を除く(1 file に 1 つ)。 */
function dropHelper(t: string): string {
  return t.replace(/\/\/ PKC3-MENU-HELPER-BEGIN\n[\s\S]*?\/\/ PKC3-MENU-HELPER-END\n\n/g, '');
}

/** 置換した行を原文へ戻す。⚠ **それぞれちょうど 1 行**に当たること(当たらない / 2 行 は落とす)。 */
function restoreReplaced(t: string): string {
  const lines = t.split('\n');
  for (const r of RESTORES) {
    const idx = lines.map((l, i) => (r.marked.every((m) => l.includes(m)) && l.includes(MARK) ? i : -1)).filter((i) => i >= 0);
    // 🔑 戻す先が無い / 2 つ在るなら、戻す側が嘘をつける ── ここで落とす
    if (idx.length > 1) throw new Error(`置換行が 2 つ以上: ${r.marked[0]}`);
    if (idx.length === 1) lines[idx[0]!] = r.original;
  }
  return lines.join('\n');
}

/** 足した行(行末が印)を除く。 */
function dropMarked(t: string): string {
  return t
    .split('\n')
    .filter((l) => !l.includes(MARK))
    .join('\n');
}

describe('#121 の計装(menu-trace)── 当て方', () => {
  it('🔑 空振り防止: 錨・ヘルパーの当て先を拾えている', () => {
    expect(PATCH.targets.length, '錨を拾えていない').toBe(9);
    expect(PATCH.helperTargets.length, 'ヘルパーの当て先を拾えていない').toBe(2);
    expect(new Set(PATCH.targets.map((t) => t.anchor)).size, '同じ錨が 2 つ在る').toBe(PATCH.targets.length);
    // 2 file に当てる(片方に偏っていない)
    expect(PATCH.targets.filter((t) => t.src === REL_QM).length).toBeGreaterThanOrEqual(4);
    expect(PATCH.targets.filter((t) => t.src === REL_MN).length).toBeGreaterThanOrEqual(5);
  });

  it('🔴 錨は、原文から抜いた抜粋に**ちょうど 1 件**ずつ当たる', () => {
    for (const t of [...PATCH.targets, ...PATCH.helperTargets]) {
      const hits = ORIG[t.src]!.split(t.anchor).length - 1;
      expect(hits, `${t.src} の錨が 1 件でない:\n${t.anchor}`).toBe(1);
    }
  });

  it('🔴 既定(PKC3_MENU_TRACE!=1)は 1 バイトも書き換えない。錨の検査はする', () => {
    for (const env of [OFF, {}]) {
      const t = makeRoot();
      try {
        const r = runPatch(t.dir, env);
        expect(r.code, r.out).toBe(0);
        expect(r.out).toContain('skip');
        expect(t.read(REL_QM), '既定なのに書き換えている').toBe(EXCERPT_QM);
        expect(t.read(REL_MN), '既定なのに書き換えている').toBe(EXCERPT_MN);
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
      for (const rel of [REL_QM, REL_MN]) {
        const after = t.read(rel);
        expect(after.match(/PKC3-MENU-HELPER-BEGIN/g)?.length, `${rel}: helper が 1 つでない`).toBe(1);
        expect(after.match(/^void pkc3_menu_trace\(/gm)?.length, `${rel}: 入口が 1 つでない`).toBe(1);
        expect(after, `${rel}: 当たっていない`).not.toBe(ORIG[rel]);
      }
    } finally {
      t.cleanup();
    }
  });

  it('🔴 挙動を変えていない ── helper と足した行を除き、置換した 3 行を原文へ戻すと一致する', () => {
    const t = makeRoot();
    try {
      expect(runPatch(t.dir, ON).code).toBe(0);
      let replaced = 0;
      for (const rel of [REL_QM, REL_MN]) {
        const after = dropHelper(t.read(rel));
        const back = restoreReplaced(after);
        replaced += RESTORES.filter((r) => after.split('\n').some((l) => r.marked.every((m) => l.includes(m)))).length;
        expect(dropMarked(back), `${rel}: 足した以外のことをしている`).toBe(ORIG[rel]);
        // 🔑 対照群: 戻さずに除くだけでは**原文に戻らない**(= 戻す手順が効いている。置換行が無ければ戻らない理由が無い)
        expect(dropMarked(after) === ORIG[rel], `${rel}: 置換行が無い(対照群が成り立たない)`).toBe(false);
      }
      // 置換した行は 3 本(QtMenu 2 / menu 1)── 1 本でも原文の字面を動かしていない / 増えているなら気づく
      expect(replaced, '置換した行の数が違う').toBe(RESTORES.length);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 足した行は全部、行末が印で終わる(印の無い行は 1 行も足していない)', () => {
    const t = makeRoot();
    try {
      expect(runPatch(t.dir, ON).code).toBe(0);
      for (const rel of [REL_QM, REL_MN]) {
        const orig = new Set(ORIG[rel]!.split('\n'));
        for (const line of dropHelper(t.read(rel)).split('\n')) {
          if (orig.has(line)) continue;
          expect(line.trimEnd().endsWith(MARK), `${rel}: 印の無い足し行: ${line}`).toBe(true);
        }
      }
    } finally {
      t.cleanup();
    }
  });

  it('🔴 二重当ては落ち(exit 1)、file は 1 バイトも変わらない', () => {
    const t = makeRoot();
    try {
      expect(runPatch(t.dir, ON).code).toBe(0);
      const once = [t.read(REL_QM), t.read(REL_MN)];
      const r = runPatch(t.dir, ON);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('二重当て');
      expect([t.read(REL_QM), t.read(REL_MN)]).toEqual(once);
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
      ...PATCH.helperTargets.map((t) => ({ ...t, kind: 'ヘルパーの錨' })),
    ];
    for (let i = 0; i < all.length; i++) {
      const { src, anchor, kind } = all[i]!;
      const broken = ORIG[src]!.replace(anchor, '// 上流が形を変えた\n');
      expect(broken, `${kind} ${i} を外せていない`).not.toBe(ORIG[src]);
      for (const env of [OFF, ON]) {
        const t = makeRoot({ [src]: broken });
        try {
          const other = src === REL_QM ? REL_MN : REL_QM;
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

describe('#121 の計装(menu-trace)── 印が全部在る', () => {
  it('🔴 where の 10 個(呼び出し 9 + run:native)が、それぞれ決まった数だけ入る', () => {
    const t = makeRoot();
    try {
      expect(runPatch(t.dir, ON).code).toBe(0);
      const qm = t.read(REL_QM);
      const mn = t.read(REL_MN);
      const bodies = dropHelper(qm) + dropHelper(mn);
      // 呼び出し 9 つ: 本体に **ちょうど 1 度**(2 つ以上は、同じ where を 2 か所に撃っている)
      for (const w of CALL_WHERES) {
        expect(bodies.split(`pkc3_menu_trace("${w}"`).length - 1, `where ${w} が本体に 1 つでない`).toBe(1);
      }
      // 置き場所も見る(QtMenu 側 5 / menu 側 4)── 「別の file に撃っている」を許さない
      const inQm = ['show:enter', 'exec:enter', 'exec:return', 'slot:enter', 'slot:handled'];
      const inMn = ['select:post', 'select:call', 'flush:check', 'popup:dtor'];
      for (const w of inQm) expect(dropHelper(qm), `QtMenu.cxx に ${w} が無い`).toContain(`pkc3_menu_trace("${w}"`);
      for (const w of inMn) expect(dropHelper(mn), `menu.cxx に ${w} が無い`).toContain(`pkc3_menu_trace("${w}"`);
      // run:native は helper の中(各 file 1 つ)と、menu.cxx の呼び出し 1 行
      expect(qm.split(`"${NATIVE_WHERE}"`).length - 1, 'QtMenu.cxx の helper に run:native が無い').toBe(1);
      expect(mn.split(`"${NATIVE_WHERE}"`).length - 1, 'menu.cxx の helper に run:native が無い').toBe(1);
      expect(dropHelper(mn), 'menu.cxx に native の呼び出しが無い').toContain('pkc3_menu_native(pMenu, pMenu->ShowNativePopupMenu(');
      expect(dropHelper(qm), 'QtMenu.cxx が native を呼んでいる(menu.cxx だけの印)').not.toContain('pkc3_menu_native(');
    } finally {
      t.cleanup();
    }
  });

  it('🔑 決め手の 3 つ: exec の戻り値が null かを d に出す / slot が thread を出す / flush が pSelect を出す', () => {
    const t = makeRoot();
    try {
      expect(runPatch(t.dir, ON).code).toBe(0);
      const qm = dropHelper(t.read(REL_QM));
      const mn = dropHelper(t.read(REL_MN));
      // exec の**前**に enter、**後**に return(順番)
      const e = qm.indexOf('pkc3_menu_trace("exec:enter"');
      const x = qm.indexOf('mpQMenu->exec(aRect.bottomLeft())');
      const r = qm.indexOf('pkc3_menu_trace("exec:return"');
      expect(e).toBeGreaterThan(-1);
      expect(e < x && x < r, 'exec の前後に enter / return が並んでいない').toBe(true);
      expect(qm).toMatch(/exec:return"[^;]*pPkc3Chosen \? 1 : 0/);
      // slot は IsMainThread と mnId を出す
      expect(qm).toMatch(/slot:enter"[^;]*IsMainThread\(\)[^;]*mnId/);
      // slot:handled は HandleMenuCommandEvent の**後**
      expect(qm.indexOf('slot:handled') > qm.indexOf('HandleMenuCommandEvent(pMenu, mnId)')).toBe(true);
      // flush は pSelect を判定した**直後**(ImplFindSelectMenu の後、`if (pSelect)` の前)
      const f = mn.indexOf('Menu* pSelect = ImplFindSelectMenu();');
      const fc = mn.indexOf('pkc3_menu_trace("flush:check"');
      const ifs = mn.indexOf('if (pSelect)');
      expect(f < fc && fc < ifs, 'flush:check が pSelect の判定の直後にない').toBe(true);
      expect(mn).toMatch(/flush:check"[^;]*pSelect \? 1 : 0/);
      // select:post は PostUserEvent の**後**
      expect(mn.indexOf('select:post') > mn.indexOf('Application::PostUserEvent(')).toBe(true);
    } finally {
      t.cleanup();
    }
  });
});

describe('#121 の計装(menu-trace)── 他の patch と同じ行を触らない', () => {
  it('🔴 同じ 2 file を触る patch は、この 1 本だけ(増えたら、錨が重ならないことと両順同一をここへ書く)', () => {
    const dir = 'build/office-wasm';
    const files = readdirSync(dir).filter((f) => /^(qtbase-)?patch-.*\.py$/.test(f));
    // ⚠ 空振り防止 ── 一覧が空なら 0 本は真になる
    expect(files.length, 'patch を 1 本も拾えていない').toBeGreaterThanOrEqual(20);
    expect(files).toContain('patch-lo-menu-trace.py');
    const touching = files.filter((f) => {
      // 🔑 注釈ではなく**コード**の中の path 文字列(引用符つき)だけを見る
      const code = readFileSync(join(dir, f), 'utf-8')
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
      return /["']vcl\/(qt5\/QtMenu|source\/window\/menu)\.cxx["']/.test(code);
    });
    expect(touching, 'QtMenu.cxx / menu.cxx を触る patch').toEqual(['patch-lo-menu-trace.py']);
  });
});

describe('#121 の計装(menu-trace)── helper は g++ で通り、決めた形の 1 行を出す', () => {
  it('🔴 -Wall -Wextra -Werror で通り、a=%p b=%llu c=%d d=%d の形で出る。native は値をそのまま返す', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-menu-h-'));
    try {
      const src = `${PATCH.helper}
int main()
{
    int nObj = 0;
    pkc3_menu_trace("w:probe", pkc3_menu_ptr(&nObj), 1, 2);
    const bool bT = pkc3_menu_native(&nObj, true);
    const bool bF = pkc3_menu_native(&nObj, false);
    return (bT && !bF) ? 0 : 3;
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
      const rows = run.stderr.split('\n').filter((l) => l.startsWith('PKC3-MENU '));
      // 1 行目: probe(a は pointer / b は thread / c d は渡した値)。2 行目: native が true のときだけ run:native
      expect(rows[0]).toMatch(/^PKC3-MENU w:probe a=0x[0-9a-f]+ b=\d+ c=1 d=2$/);
      expect(rows[1]).toMatch(/^PKC3-MENU run:native a=0x[0-9a-f]+ b=\d+ c=1 d=0$/);
      expect(rows.length, 'native が false のときも出している').toBe(2);
    } finally {
      // ⚠ 計装は固定の path(/tmp/pkc3-menu.log)へも書く ── 走らせた後に残さない
      rmSync('/tmp/pkc3-menu.log', { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('#121 の計装(menu-trace)── 台帳(スコープ検査 / workflow)に載っている', () => {
  it('🔑 helper の当て先が、スコープ検査(check-patch-scope.py)にも載っている', () => {
    // ⚠ SPECS は手書きの一覧 ── 足し忘れると、この 2 file だけ検査の外になる
    const scope = readFileSync('build/office-wasm/check-patch-scope.py', 'utf-8');
    const at = scope.indexOf('"PKC3_MENU_TRACE"');
    expect(at, 'SPECS に PKC3_MENU_TRACE が無い').toBeGreaterThan(-1);
    const block = scope.slice(at, scope.indexOf('"PKC3_IME_TRACE"', at));
    expect(block).toContain('"patch-lo-menu-trace.py"');
    expect(block).toContain('"pkc3_menu_trace"');
    expect(block).toContain('"vcl/qt5/QtMenu.cxx"');
    expect(block).toContain('"vcl/source/window/menu.cxx"');
    // 当て先の file は、patch の HELPER_TARGETS と**集合で**一致する(件数ではなく集合)
    expect(PATCH.helperTargets.map((t) => t.src).sort()).toEqual(['vcl/qt5/QtMenu.cxx', 'vcl/source/window/menu.cxx']);
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
    expect(yml, '入力が無い').toMatch(/^ {6}menu_trace:\n[\s\S]*?default: false/m);
    expect(yml, '環境変数の export が無い').toContain('export PKC3_MENU_TRACE=1');
    expect(yml, '既定(=0)の export が無い').toContain('export PKC3_MENU_TRACE=0');
    expect(yml, '別 tag の接尾辞が無い').toContain('SAFE_SUFFIX="${SAFE_SUFFIX}-menutrace"');
    expect(yml, 'build-info.json に入っていない').toContain('\\"menu_trace\\": \\"${{ inputs.menu_trace }}\\"');
    expect(yml.match(/inputs\.menu_trace/g)?.length, '入力を読む所が 3 か所でない').toBe(3);
    expect(code('build/office-wasm/check-patches-on-ref.sh')).toContain('PKC3_MENU_TRACE=0');
  });
});
