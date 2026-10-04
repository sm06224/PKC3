/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-clipboard-png.py` を検める(#121 の**直し**)。
 *
 * 🔴 **直す物**: Office の窓で画像を `Ctrl+C` すると、LO の Qt6-wasm 用の hack
 * (`QtMimeData::formats()` が先頭の flavor **だけ**を一覧に入れる)のせいで、host へ渡る型が
 * `application/x-openoffice-svxb` の 1 つだけになり、ブラウザの `clipboard.write` が受けない。
 * Writer の画像は **SVXB → OBJECTDESCRIPTOR → PNG → …** の順で flavor を足すので、PNG は在るのに
 * 先頭でないから捨てられている。
 *
 * ⚠ 見るのは 5 つ:
 *   ① **錨が原文に当たる**(原文から抜いた抜粋 ── 合成した物ではない)/ 1 つ外しても落ちる / 二重当ては落ちて不変
 *   ② **挙動を変えていない**: 足した行(`PKC3-PNG` を含む行)を除くと原文と 1 バイトも違わない
 *   ③ **型検査**: 当てた後の C++ が模型の型で `-fsyntax-only` / `-c`(`-Wall -Wextra -Werror`)に通る
 *      (wasm の枝が有る / 無いの両方)
 *   ④ **走らせて意図どおり**: PNG が在れば**それ 1 つだけ**を一覧に入れる / 無ければ今までどおり先頭 /
 *      画像として読まれたら PNG で読み直す。⚠ 対照群 = **原文のまま走らせると症状が出る**
 *   ⑤ **複数は入れない**(Qt wasm が複数の ClipboardItem を作って NotAllowedError になる理由が残っている)
 *
 * 🔴 **言えないこと**: 本物の Qt / LO の header で通ること、本物の Qt wasm が画像を読む経路
 * (`QMimeData::imageData()` → `retrieveData("application/x-qt-image")`)で実際に呼ばれること。
 * どちらも**焼いて、`PKC3_CLIP_TRACE=1` の計装で見る**まで確かめられない。
 */
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  EXCERPT_TR,
  HARNESS,
  REL_CB,
  REL_TR,
  build,
  compile,
  makeRoot,
  runPatch,
  stripAdded,
} from './helpers/office-lo-clip';

const SCRIPT = 'build/office-wasm/patch-lo-clipboard-png.py';
const MARK = 'PKC3-PNG';
// g++ を何度も回す test がある(既定の 5 秒では足りない)
vi.setConfig({ testTimeout: 120_000 });

/** patch の module から、錨と置換を取り出す(⚠ 錨の字をここへ書き写さない)。 */
function loadPatch(): { anchors: string[]; replaces: string[] } {
  const code = [
    'import importlib.util,sys,json',
    'sys.dont_write_bytecode=True',
    `sp=importlib.util.spec_from_file_location("p","${SCRIPT}")`,
    'm=importlib.util.module_from_spec(sp); sp.loader.exec_module(m)',
    'print(json.dumps({"anchors":[a for a,_ in m.PARTS],"replaces":[r for _,r in m.PARTS]}))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf-8', stdio: 'pipe' }));
}
const PATCH = loadPatch();

describe('#121 の直し(clipboard-png)── 当て方', () => {
  it('🔑 空振り防止: 錨を拾えている(0 件でも「全部当たった」は真になる)', () => {
    expect(PATCH.anchors.length, '錨を 1 つも拾えていない').toBeGreaterThanOrEqual(3);
    expect(new Set(PATCH.anchors).size, '同じ錨が 2 つ在る').toBe(PATCH.anchors.length);
  });

  it('🔴 錨は、原文から抜いた抜粋に**ちょうど 1 件**ずつ当たる', () => {
    for (const a of PATCH.anchors) {
      expect(EXCERPT_TR.split(a).length - 1, `錨が 1 件でない:\n${a}`).toBe(1);
    }
  });

  it('🔴 当てると 3 か所が入り、足した行は全部 `PKC3-PNG` を含む', () => {
    const t = makeRoot();
    try {
      const r = runPatch(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(0);
      const after = t.read(REL_TR);
      expect(after).not.toBe(EXCERPT_TR);
      expect(after.match(/PKC3-PNG\(#121/g)?.length, '注釈の印が 2 つでない').toBe(2);
      // QtClipboard.cxx には触らない(この patch の当て先は QtTransferable.cxx だけ)
      expect(t.read(REL_CB)).toBe(makeRootCb());
    } finally {
      t.cleanup();
    }
  });

  it('🔴 挙動を変えていない ── 足した行を除くと原文と 1 バイトも違わない', () => {
    const t = makeRoot();
    try {
      expect(runPatch(SCRIPT, t.dir).code).toBe(0);
      // ⚠ 対照群: 当たった後が原文と違うこと(違わなければ、何も足していない)
      expect(t.read(REL_TR)).not.toBe(EXCERPT_TR);
      expect(stripAdded(t.read(REL_TR), MARK)).toBe(EXCERPT_TR);
    } finally {
      t.cleanup();
    }
  });

  it('🔴 二重当ては落ち(exit 1)、file は 1 バイトも変わらない', () => {
    const t = makeRoot();
    try {
      expect(runPatch(SCRIPT, t.dir).code).toBe(0);
      const once = t.read(REL_TR);
      const r = runPatch(SCRIPT, t.dir);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('二重当て');
      expect(t.read(REL_TR)).toBe(once);
    } finally {
      t.cleanup();
    }
  });

  /**
   * 🔴 **錨を 1 つずつ外して、毎回落ちること**(「N 個目だけが鳴る場面を N 通り作る」)。
   * ⚠ 落ちるだけでなく **file が 1 バイトも変わらない**こと ── 「半分だけ当たる」を作らない。
   */
  it('🔴 錨が 1 つでも無ければ落ちる。何も書かない', () => {
    for (let i = 0; i < PATCH.anchors.length; i++) {
      const broken = EXCERPT_TR.replace(PATCH.anchors[i]!, '// 上流が形を変えた\n');
      expect(broken, `錨 ${i} を外せていない`).not.toBe(EXCERPT_TR);
      const t = makeRoot({ [REL_TR]: broken });
      try {
        const r = runPatch(SCRIPT, t.dir);
        expect(r.code, `錨 ${i} を外しても落ちない:\n${r.out}`).toBe(1);
        expect(r.out, `錨 ${i} の落ち方が「錨の欠落」でない`).toContain('錨が 0 件');
        expect(t.read(REL_TR), '落ちたのに書き換えている').toBe(broken);
      } finally {
        t.cleanup();
      }
    }
  });

  it('当て先の file が無ければ落ちる', () => {
    const t = makeRoot();
    try {
      const r = runPatch(SCRIPT, `${t.dir}/no-such-root`);
      expect(r.code).toBe(1);
      expect(r.out).toContain(REL_TR);
    } finally {
      t.cleanup();
    }
  });
});

/** QtClipboard.cxx の原文(この patch は触らない)。 */
function makeRootCb(): string {
  const t = makeRoot();
  try {
    return t.read(REL_CB);
  } finally {
    t.cleanup();
  }
}

describe('#121 の直し(clipboard-png)── 型検査(g++)', () => {
  /** 対照群: 模型が**原文**を通すこと(通さない模型の上の「通った」は何も言わない)。 */
  it('🔑 対照群: 原文は模型の上で通る(wasm の枝が有る / 無い)', () => {
    const t = makeRoot();
    try {
      for (const emscripten of [true, false]) {
        const r = compile(t, REL_TR, { emscripten, mode: '-fsyntax-only' });
        expect(r.code, `原文が模型を通らない(emscripten=${emscripten}):\n${r.out}`).toBe(0);
      }
    } finally {
      t.cleanup();
    }
  });

  it('🔴 当てた後の C++ が、-fsyntax-only と -c(-Wall -Wextra -Werror)に通る。wasm の枝が有る / 無いの両方', () => {
    const t = makeRoot();
    try {
      expect(runPatch(SCRIPT, t.dir).code).toBe(0);
      for (const emscripten of [true, false]) {
        for (const mode of ['-fsyntax-only', '-c'] as const) {
          const r = compile(t, REL_TR, { emscripten, mode });
          expect(r.code, `通らない(emscripten=${emscripten} ${mode}):\n${r.out}`).toBe(0);
        }
      }
    } finally {
      t.cleanup();
    }
  });

  /**
   * 🔴 検査そのものの対照群 ── **壊した C++ を通さない**(通すなら、上の「通った」は何も言っていない)。
   * 型が合わない 1 行を足して、wasm の枝の中で落ちること。
   */
  it('🔑 対照群: wasm の枝の中の型違いは、-fsyntax-only で落ちる', () => {
    const t = makeRoot();
    try {
      expect(runPatch(SCRIPT, t.dir).code).toBe(0);
      const bad = t.read(REL_TR).replace('aList.clear();', 'aList = QImage();');
      expect(bad).not.toBe(t.read(REL_TR));
      t.write(REL_TR, bad);
      expect(compile(t, REL_TR, { emscripten: true, mode: '-fsyntax-only' }).code).not.toBe(0);
    } finally {
      t.cleanup();
    }
  });
});

describe('#121 の直し(clipboard-png)── 走らせて意図どおり', () => {
  const cache = new Map<string, string>();
  /** `patched` なら直しを当てて、模型の上で harness を走らせた stdout。 */
  function run(patched: boolean): string {
    const key = String(patched);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const t = makeRoot();
    try {
      if (patched) expect(runPatch(SCRIPT, t.dir).code).toBe(0);
      const r = build(t, HARNESS, { emscripten: true });
      expect(r.code, `harness が通らない:\n${r.err}`).toBe(0);
      cache.set(key, r.out);
      return r.out;
    } finally {
      t.cleanup();
    }
  }
  const line = (out: string, label: string): string => {
    const l = out.split('\n').find((x) => x.startsWith(`${label}:`));
    expect(l, `${label} の行が出ていない:\n${out}`).toBeDefined();
    return l!;
  };

  it('🔑 対照群: 原文のまま走らせると症状が出る(画像の一覧は先頭の SVXB だけ / 画像としては読めない)', () => {
    const out = run(false);
    expect(line(out, 'A')).toMatch(/^A: \[application\/x-openoffice-svxb;/);
    expect(line(out, 'A')).not.toContain('image/png');
    // 画像として読まれる(`QMimeData::imageData()`)と空 ── Qt wasm は「書く物が無い」で戻る
    expect(line(out, 'R1')).toBe('R1: invalid 0');
    expect(line(out, 'R2')).toBe('R2: invalid 0');
  });

  it('🔴 PNG が在れば、それ **1 つだけ**を一覧に入れる(先頭でなくても)', () => {
    const out = run(true);
    expect(line(out, 'A')).toBe('A: [image/png]');
    expect(line(out, 'H')).toBe('H: [image/png]');
    // パラメータ付きは、原文の字のまま入れる(`retrieveData` が LO へその字で求める)
    expect(line(out, 'C')).toBe('C: [image/png;x=y]');
  });

  it('🔴 PNG が無ければ、今までどおり先頭の 1 つ(字が在れば text/plain 1 つ)', () => {
    const out = run(true);
    expect(line(out, 'B')).toMatch(/^B: \[application\/x-openoffice-svxb;[^\]]*\]$/);
    expect(line(out, 'D')).toMatch(/^D: \[application\/x-openoffice-svxb;[^\]]*\]$/);
    expect(line(out, 'E')).toBe('E: [text/plain]');
    expect(line(out, 'F')).toBe('F:');
    // 基本型が `image/png` の物だけ拾う(前方一致で `image/png2` を拾わない ── 先頭の SVXB のまま)
    expect(line(out, 'G')).toMatch(/^G: \[application\/x-openoffice-svxb;[^\]]*\]$/);
  });

  /**
   * 🔴 **複数は入れない**。Qt wasm の `writeToClipboardApi` は型ごとに ClipboardItem を作るので、
   * 一覧が 2 つ以上だと Chrome 131 で NotAllowedError になる(`formats()` の注釈が理由を書いている)。
   * ⚠ 全場面で、一覧は高々 1 件。
   */
  it('🔴 どの場面でも、一覧は高々 1 件', () => {
    const out = run(true);
    const lists = out.split('\n').filter((l) => /^[A-H]:/.test(l));
    expect(lists.length, '一覧の行を拾えていない').toBe(8);
    for (const l of lists) expect((l.match(/\[/g) ?? []).length, `一覧が 2 件以上:${l}`).toBeLessThanOrEqual(1);
  });

  it('🔴 画像として読まれたら、一覧の PNG で読み直して QImage で返す(読めなければ bytes)', () => {
    const out = run(true);
    // `\211PNG-bytes` = 10 byte。署名が在るので QImage として読める
    expect(line(out, 'R1')).toBe('R1: image 10');
    expect(line(out, 'R5')).toBe('R5: image 10');
    // 画像でない要求は今までどおり bytes(PNG の型で直に求めたとき)
    expect(line(out, 'R2')).toBe('R2: bytes 10');
    expect(line(out, 'R6')).toBe('R6: bytes 5');
  });

  it('🔴 PNG が無い物は、画像として読まれても空のまま(でっち上げない)。一覧に無い型も空', () => {
    const out = run(true);
    expect(line(out, 'R3')).toBe('R3: invalid 0');
    expect(line(out, 'R4')).toBe('R4: invalid 0');
  });
});
