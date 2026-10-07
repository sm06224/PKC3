/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-menu-popup-sync.py` を検める(#121 の**直し**)。
 *
 * 🔴 **直す物**: Writer の右クリック popup で「コピー」を選んでも `.uno:Copy` が実行されない。
 * 計装(焼き run 37222907850)で割れた事実:popup でも `QAction::triggered` →
 * `QtMenu::slotMenuTriggered` → `Menu::HandleMenuCommandEvent` → `ImplSelect`(PostUserEvent)→
 * `PopupMenu::FinishRun` → `ImplFlushPendingSelect` が同期に `Select()` を呼ぶところまでは正常。
 * その先 `framework::MenuBarManager::Select` が `Application::PostUserEvent(AsyncMenuExecute)` で
 * 命令を**後回し**にする。menubar では 7 ms 後に走るが、popup(入れ子の `QMenu::exec` の後)では
 * 10 秒間走らず、走った回は `libc++abi: terminating` で落ちる。Ctrl+C(キー入力の callback の中で
 * **同期に** dispatch する経路)は成功する。
 * 直しは、Emscripten では popup(`!m_bHasMenuBar`)の命令だけ後回しにせず、その場で dispatch する。
 * menubar 側は触らない。
 *
 * ⚠ 見るのは 6 つ:
 *   ① **錨が原文に当たる**(上流の原文から抜いた抜粋 ── 合成した物ではない)/ 1 つ外しても落ちる /
 *      二重当ては落ちて不変
 *   ② **直しの中身を、描いた結果で見る**: `#if defined __EMSCRIPTEN__` の中で `!m_bHasMenuBar` のときだけ
 *      同期に dispatch し、`else` で**後回しの経路へ戻る**(menubar の `PostUserEvent` が 1 本だけ残る)
 *   ③ **足した行は全部印を含み、原文の行は 1 行も書き換えない**(印の行を除くと原文と一致する)
 *   ④ **`<cstdio>`** が足されている(`std::fputs` の宣言)
 *   ⑤ スコープ検査(`check-patch-scope.py`)の一覧に載っている **+ その FIXES を抜粋に対して実際に走らせる**
 *   ⑥ workflow の本数の主張が、この 1 本を数えている
 *
 * 🔴 **言えないこと**: 当てた後の C++ が本物の LO / Qt の header でコンパイルできること /
 * 本物の JSPI で popup の「コピー」が clipboard へ届くこと。どちらも**焼いて、popup の「コピー」を押す
 * probe で `PKC3-POPUPSYNC:` の行が出る**まで確かめられない
 * (抜粋は上流の原文だが、全文ではない)。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-menu-popup-sync.py';
const REL = 'framework/source/uielement/menubarmanager.cxx';
const MARK = 'PKC3-POPUPSYNC';
const EXCERPT = readFileSync('tests/fixtures/office-lo/menubarmanager.excerpt.cxx', 'utf-8');
const SCHED_EXCERPT = readFileSync('tests/fixtures/office-lo/scheduler.excerpt.cxx', 'utf-8');
const WINPROC_EXCERPT = readFileSync('tests/fixtures/office-lo/winproc.excerpt.cxx', 'utf-8');

/** python の module から値を取り出す(⚠ 錨の字をここへ書き写さない)。 */
function pyJson(script: string, expr: string): unknown {
  const code = [
    'import importlib.util,sys,json',
    'sys.dont_write_bytecode=True',
    `sp=importlib.util.spec_from_file_location("p","${script}")`,
    'm=importlib.util.module_from_spec(sp); sp.loader.exec_module(m)',
    `print(json.dumps(${expr}))`,
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf-8', stdio: 'pipe' }));
}

const FIX_ANCHORS = pyJson(SCRIPT, '[a for a,_ in m.PARTS]') as string[];

interface Tree {
  dir: string;
  read: () => string;
  write: (body: string) => void;
  cleanup: () => void;
}

function tree(body: string = EXCERPT): Tree {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-popupsync-'));
  const put = (b: string): void => {
    mkdirSync(dirname(join(dir, REL)), { recursive: true });
    writeFileSync(join(dir, REL), b, 'utf-8');
  };
  put(body);
  return {
    dir,
    read: () => readFileSync(join(dir, REL), 'utf-8'),
    write: put,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function run(script: string, dir: string): { code: number; out: string } {
  const r = spawnSync('python3', [script, dir], { encoding: 'utf-8', stdio: 'pipe' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** 数える(部分文字列の出現数)。 */
const count = (text: string, needle: string): number => text.split(needle).length - 1;

const POST = '        Application::PostUserEvent(LINK_NONMEMBER(nullptr, AsyncMenuExecute), pData.release());\n';

/**
 * 足した行(印を含む行)を取り除く。この直しは**原文の行を 1 行も書き換えない**(足すだけ)ので、
 * 取り除いた残りが原文と一致しなければ「足す以外」をしている。
 */
function restore(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.includes(MARK))
    .join('\n');
}

describe('#121 の直し(menu-popup-sync)── 当て方', () => {
  it('🔑 空振り防止: 錨を拾えている(0 件でも「全部当たった」は真になる)', () => {
    expect(FIX_ANCHORS.length, '直しの錨を拾えていない').toBe(2);
    expect(new Set(FIX_ANCHORS).size, '同じ錨が 2 つ在る').toBe(FIX_ANCHORS.length);
    expect(EXCERPT, '抜粋が空').toContain('IMPL_LINK( MenuBarManager, Select, Menu *, pMenu, bool )');
  });

  it('🔴 錨は、上流の原文の抜粋に**ちょうど 1 件**ずつ当たる', () => {
    for (const a of FIX_ANCHORS) {
      expect(count(EXCERPT, a), `錨が 1 件でない:\n${a}`).toBe(1);
    }
  });

  it('🔴 毎回当たる(入力で gate しない)。当てると印が入り、file が変わる', () => {
    const t = tree();
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(0);
      expect(t.read()).not.toBe(EXCERPT);
      expect(t.read()).toContain(MARK);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 二重当ては落ち(exit 1)、file は 1 バイトも変わらない', () => {
    const t = tree();
    try {
      expect(run(SCRIPT, t.dir).code).toBe(0);
      const once = t.read();
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('二重当て');
      expect(t.read()).toBe(once);
    } finally {
      t.cleanup();
    }
  });

  /** 🔴 錨を 1 つずつ外して、毎回落ちること。⚠ 落ちるだけでなく file が 1 バイトも変わらないこと。 */
  it('🔴 錨が 1 つでも無ければ落ちる。何も書かない', () => {
    for (let i = 0; i < FIX_ANCHORS.length; i++) {
      const broken = EXCERPT.replace(FIX_ANCHORS[i]!, '// 上流が形を変えた\n');
      expect(broken, `錨 ${i} を外せていない`).not.toBe(EXCERPT);
      const t = tree(broken);
      try {
        const r = run(SCRIPT, t.dir);
        expect(r.code, `錨 ${i} を外しても落ちない:\n${r.out}`).toBe(1);
        expect(r.out, `錨 ${i} の落ち方が「錨の欠落」でない`).toContain('錨が 0 件');
        expect(t.read(), '落ちたのに書き換えている').toBe(broken);
      } finally {
        t.cleanup();
      }
    }
  });

  it('🔴 錨が 2 件になっても落ちる(同じ形が上流に増えたら、どちらかを選ばない)', () => {
    const doubled = `${EXCERPT}\n${FIX_ANCHORS[1]}`;
    const t = tree(doubled);
    try {
      const r = run(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('錨が 2 件');
      expect(t.read()).toBe(doubled);
    } finally {
      t.cleanup();
    }
  });

  it('当て先の file が無ければ落ちる', () => {
    const t = tree();
    try {
      const r = run(SCRIPT, `${t.dir}/no-such-root`);
      expect(r.code).toBe(1);
      expect(r.out).toContain(REL);
    } finally {
      t.cleanup();
    }
  });
});

describe('#121 の直し(menu-popup-sync)── 当てた結果(描いた C++ で見る)', () => {
  function patched(): string {
    const t = tree();
    try {
      expect(run(SCRIPT, t.dir).code).toBe(0);
      return t.read();
    } finally {
      t.cleanup();
    }
  }

  it('🔴 popup だけ同期に dispatch し、menubar は `else` で後回しの経路へ戻る(順序で見る)', () => {
    const after = patched();
    const at = (needle: string): number => {
      expect(count(after, needle), `「${needle.trim()}」が 1 件でない`).toBe(1);
      return after.indexOf(needle);
    };
    const guardAt = at('#if defined __EMSCRIPTEN__ // PKC3-POPUPSYNC');
    const popupAt = at('if (!m_bHasMenuBar) // PKC3-POPUPSYNC');
    const dispatchAt = at('pData->xDispatch->dispatch(pData->aTargetURL, comphelper::containerToSequence(pData->aArgs)); // PKC3-POPUPSYNC');
    const catchAt = at('catch (const css::uno::Exception&) // PKC3-POPUPSYNC');
    const elseAt = at('else // PKC3-POPUPSYNC');
    const endifAt = at('#endif // PKC3-POPUPSYNC');
    const postAt = at(POST);
    // 順序: #if → popup の条件 → 同期 dispatch → 例外の受け → else → #endif → 後回し(menubar)
    expect(guardAt).toBeLessThan(popupAt);
    expect(popupAt).toBeLessThan(dispatchAt);
    expect(dispatchAt).toBeLessThan(catchAt);
    expect(catchAt).toBeLessThan(elseAt);
    expect(elseAt).toBeLessThan(endifAt);
    expect(endifAt).toBeLessThan(postAt);
    // 🔴 全部、`if (pData->xDispatch.is())` の塊の中(= 命令が引けたときだけ)
    const isAt = at('    if (pData->xDispatch.is())\n');
    expect(isAt).toBeLessThan(guardAt);
    expect(postAt).toBeLessThan(at('    if ( !m_bHasMenuBar )\n'));
  });

  it('🔴 menubar の経路(後回し)は消えていない: PostUserEvent は元のまま 1 本だけ残る', () => {
    const after = patched();
    // ⚠ 数えるのは**呼び出し**(`Application::PostUserEvent(`)── 足した注釈にも語は出る
    expect(count(EXCERPT, 'Application::PostUserEvent('), '抜粋の前提(元は 1 件)').toBe(1);
    expect(count(after, 'Application::PostUserEvent(')).toBe(1);
    expect(count(after, POST)).toBe(1);
    // `AsyncMenuExecute` の定義と、`SolarMutexReleaser` の中の dispatch も触っていない
    expect(after).toContain('void AsyncMenuExecute(void* /*instance*/, void* data)\n');
    expect(after).toContain('        SolarMutexReleaser aReleaser;\n');
    // popup の `m_bActive = false` は残る(同期に dispatch した後も後始末へ戻る)
    expect(after).toContain('    if ( !m_bHasMenuBar )\n');
    expect(after).toContain('        m_bActive = false;\n');
  });

  it('🔴 `#include <cstdio>` が `menubarmanager.hxx` の直後に足されている(`std::fputs` の宣言)', () => {
    const after = patched();
    expect(count(EXCERPT, '#include <cstdio>'), '抜粋の前提(元には無い)').toBe(0);
    expect(after).toContain(
      `#include <uielement/menubarmanager.hxx>\n#include <cstdio> // ${MARK}\n#include <uielement/styletoolbarcontroller.hxx>\n`,
    );
    // include は file の頭(関数の外)に在り、fputs を使う所より前
    expect(after.indexOf('#include <cstdio>')).toBeLessThan(after.indexOf('std::fputs'));
  });

  it('🔴 足した行は全部印を含み、原文の行は 1 行も書き換えない(印の行を除くと原文と一致)', () => {
    const after = patched();
    // ⚠ 対照群: 当たった後が原文と違うこと(違わなければ、何も足していない)
    expect(after).not.toBe(EXCERPT);
    expect(restore(after)).toBe(EXCERPT);
    // 足した行は 21 行(include 1 + `#if` 1 + 注釈 5 + 本体 13 + `#endif` 1)
    const added = after.split('\n').filter((l) => l.includes(MARK));
    expect(added.length).toBe(21);
    // 🔴 中身まで見る: 件数と順序だけだと、注釈の 1 行を `return;` に替える /
    //    注釈の行末に `\\` を足して次の宣言をコメントに連結する、という変異が緑のまま C++ を壊す。
    //    ⚠ 期待値は patch から取らず**手で書く**(同じ盲点を共有しない)。
    const code = added.filter((l) => !/^\s*\/\/ /.test(l)).map((l) => l.trim());
    expect(code).toEqual([
      `#include <cstdio> // ${MARK}`,
      `#if defined __EMSCRIPTEN__ // ${MARK}`,
      `if (!m_bHasMenuBar) // ${MARK}`,
      `{ // ${MARK}`,
      `std::fputs("${MARK}: popup command dispatched synchronously\\n", stderr); // ${MARK}`,
      `try // ${MARK}`,
      `{ // ${MARK}`,
      `pData->xDispatch->dispatch(pData->aTargetURL, comphelper::containerToSequence(pData->aArgs)); // ${MARK}`,
      `} // ${MARK}`,
      `catch (const css::uno::Exception&) // ${MARK}`,
      `{ // ${MARK}`,
      `std::fputs("${MARK}: dispatch threw; swallowed\\n", stderr); // ${MARK}`,
      `} // ${MARK}`,
      `} // ${MARK}`,
      `else // ${MARK}`,
      `#endif // ${MARK}`,
    ]);
    for (const l of added) {
      expect(l, '行末の \\ は次の行をコメントへ連結する').not.toMatch(/\\\s*$/);
      expect(l, 'ブロックコメントは使わない').not.toMatch(/\/\*|\*\//);
    }
    // 注釈は 5 行で、全部 `//` 始まり(実行文を注釈の顔で足していない)
    expect(added.filter((l) => /^\s*\/\/ /.test(l)).length).toBe(5);
    // 括弧は釣り合っている(足した `{` と `}` の数が同じ)
    const braces = code.join('\n').replace(/"[^"]*"/g, '');
    expect(count(braces, '{')).toBe(count(braces, '}'));
  });
});

describe('#121 の直し(menu-popup-sync)── 他の検査との関係', () => {
  it('🔑 当て先が、スコープ検査(check-patch-scope.py)の一覧に載っている', () => {
    // ⚠ 一覧は手書き ── 足し忘れると、この patch だけ検査の外になる
    const scope = readFileSync('build/office-wasm/check-patch-scope.py', 'utf-8');
    const at = scope.indexOf('FIXES = [');
    expect(at, 'check-patch-scope.py に FIXES が無い').toBeGreaterThan(-1);
    const block = scope.slice(at, scope.indexOf('print("=== 本番(ヘルパーを持たない直し', at));
    expect(block).toContain('"patch-lo-menu-popup-sync.py"');
    expect(block).toContain(`"${REL}"`);
    expect(block).toContain('"if (!m_bHasMenuBar) // PKC3-POPUPSYNC"');
  });

  it('🔑 workflow の本数の主張が、この 1 本を数えている', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(yml).toMatch(/21 → 22\(2026-10-04\)/);
    expect(yml).toContain('patch-lo-menu-popup-sync.py');
    // 22 → 23 → 24 → 25 → 24: `patch-lo-uev-trace.py`(計装)/ `patch-lo-ime-nowait.py`(直し)を足し、#1344 で足した LO 側の直しは効かなかったので外した(真因は Qt 側)。「21 → 22」の注記は残っている
    // いまの `-eq` は 31 ── 2026-10-07 に #1393 / #1396 / #1402 の LO 側の直し 5 本を足し(24 → 29)、timer-mutex で 30、yield-wait(#1408 の印)で 31
    expect(yml).toContain('test "$n" -eq 34');
  });

  it('🔑 check-patches-on-ref.sh が拾える形(`SRC = "…"`)で当て先を宣言している', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/^SRC\s*=\s*"framework\/source\/uielement\/menubarmanager\.cxx"/m);
  });
});

describe('#121 の直し(menu-popup-sync)── スコープ検査(check-patch-scope.py の FIXES)を実際に走らせる', () => {
  const CHECK = 'build/office-wasm/check-patch-scope.py';
  const TASK_GONE = 'build/office-wasm/patch-lo-scheduler-task-gone.py';
  const IME_NOWAIT = 'build/office-wasm/patch-lo-ime-nowait.py';

  /** FIXES だけを走らせる(`PKC3_SCOPE_ONLY=fixes`)。⚠ FIXES は 3 本 ── 全部の当て先が木に要る。 */
  function scopeTree(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-popupsync-scope-'));
    for (const [rel, body] of [
      [REL, EXCERPT],
      ['vcl/source/app/scheduler.cxx', SCHED_EXCERPT],
      ['vcl/source/window/winproc.cxx', WINPROC_EXCERPT],
    ] as const) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), body, 'utf-8');
    }
    return dir;
  }

  function scope(checkScript: string, dir: string): { code: number; out: string } {
    const r = spawnSync('python3', [checkScript, dir], {
      encoding: 'utf-8',
      env: { ...process.env, PKC3_SCOPE_ONLY: 'fixes' },
      stdio: 'pipe',
    });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  }

  /** この直しの行だけ(もう 1 本の直しは ✅ のままなので、全体を見ると取り違える)。 */
  const mine = (out: string): string[] => out.split('\n').filter((l) => l.includes('patch-lo-menu-popup-sync.py'));

  /**
   * 検査と直しの patch を**別の場所へ写し**、patch の描く C++ だけを壊して走らせる。
   * ⚠ 検査は `HERE`(自分の置き場)から patch を引くので、写した先の patch が当たる。
   * ⚠ 壊す前に「元の字が 1 件在る」ことを見る(当たらなかった変異を「落ちた」と読まない)。
   */
  function scopeWithBrokenPatch(from: string, to: string): { code: number; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'pkc3-popupsync-mut-'));
    const root = scopeTree();
    try {
      const src = readFileSync(SCRIPT, 'utf-8');
      expect(count(src, from), '壊す元の字が 1 件でない(変異が当たらない)').toBe(1);
      writeFileSync(join(dir, 'patch-lo-menu-popup-sync.py'), src.replace(from, to), 'utf-8');
      writeFileSync(join(dir, 'patch-lo-scheduler-task-gone.py'), readFileSync(TASK_GONE, 'utf-8'), 'utf-8');
      writeFileSync(join(dir, 'patch-lo-ime-nowait.py'), readFileSync(IME_NOWAIT, 'utf-8'), 'utf-8');
      writeFileSync(join(dir, 'check-patch-scope.py'), readFileSync(CHECK, 'utf-8'), 'utf-8');
      return scope(join(dir, 'check-patch-scope.py'), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('🔴 抜粋に当てた木で、FIXES が ✅(exit 0)。この直しの行も ✅', () => {
    const root = scopeTree();
    try {
      const r = scope(CHECK, root);
      expect(r.code, r.out).toBe(0);
      const lines = mine(r.out);
      expect(lines.length, 'この直しの行が出ていない').toBe(1);
      expect(lines[0]).toContain('✅ 同じスコープ');
      expect(lines[0]).toContain('MenuBarManager::Select の popup の分岐');
      expect(lines[0]).toContain('include 深さ 0');
      expect(r.out).toContain('fail=0');
      expect(r.out).not.toContain('元 file が無い');
      expect(r.out).not.toContain('🔴');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('🔴 `if (!m_bHasMenuBar)` が 1 段深くなる(`{` が 1 つ増える)と ✗(exit ≠ 0)', () => {
    // ⚠ 字下げではなく**括弧**で深さが決まる(検査は `{` `}` を数える)
    const from = '        if (!m_bHasMenuBar) // PKC3-POPUPSYNC\n';
    const r = scopeWithBrokenPatch(from, `        { // PKC3-POPUPSYNC\n${from}`);
    expect(r.code, r.out).toBe(1);
    const lines = mine(r.out);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('スコープが違う');
    expect(lines[0]).not.toContain('✅ 同じスコープ');
    expect(r.out).toContain('fail=1');
  });

  it('🔴 `#include` が file scope でなくなる(`namespace { }` の中)と ✗', () => {
    const from = '#include <cstdio> // PKC3-POPUPSYNC\n';
    const r = scopeWithBrokenPatch(from, `namespace { // PKC3-POPUPSYNC\n${from}} // PKC3-POPUPSYNC\n`);
    expect(r.code, r.out).toBe(1);
    const lines = mine(r.out);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('include 深さ 1');
    expect(lines[0]).toContain('スコープが違う');
  });
});
