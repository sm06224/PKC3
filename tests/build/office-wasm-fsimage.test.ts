/** @vitest-environment node */
/**
 * 🔴 **wasm の一式に「コードが読む file」が入る**ことを縛る(#135)。
 *
 * `Ctrl+T` の自動書式の一覧が空だったのは、上流の詰め込み一覧が
 * **上流自身の変更に追いついていない**からである ── LibreOffice は
 * 表の自動書式を `autotbl.fmt` → `tablestyles.xml` へ移したのに、
 * `static/CustomTarget_emscripten_fs_image.mk` は**古いほうを入れたまま**だった。
 *
 * ## ⚠ 観測点は「文字列が在るか」ではない
 *
 * この patch が壊れる形は 2 つあり、**どちらも「文字列は在る」まま**である:
 *
 * | 壊れ方 | 何が起きるか |
 * |---|---|
 * | 継続行の外に落ちる | make が `missing separator` で**止まる**(初稿がこれだった) |
 * | 違うブロックに入る | make は通るが、**Writer を切ったときに Calc の file が消える**等 |
 *
 * 🔑 だから **make に実際に解析させ、変数の中身**を見る。
 * ⚠ 併せて `ENABLE_WASM_STRIP_*` を立てた対照群を回す ──
 * 「読む側のブロックに入れた」という主張は、**切ったときに消えて初めて**証明される。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** ⚠ shell の cwd に依らせない。 */
const PATCHER = fileURLToPath(
  new URL('../../build/office-wasm/patch-lo-fsimage.py', import.meta.url),
);

const MK = 'static/CustomTarget_emscripten_fs_image.mk';

/**
 * 上流の該当箇所を再現した極小の fixture。
 *
 * ⚠ **空行を落とさないこと** ── 一覧の最後の entry と `endif` の間の空行が、
 * まさに初稿を壊した当のものである(そこで make の代入が終わる)。
 * fixture からこれを消すと、**壊れた patch が緑で通る**。
 */
const UPSTREAM = [
  'gb_emscripten_fs_image_files := \\',
  '    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/filter/vml-shape-types \\',
  '',
  'ifneq ($(ENABLE_WASM_STRIP_WRITER),TRUE)',
  'gb_emscripten_fs_image_files += \\',
  '    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/soffice.cfg/modules/swriter/menubar/menubar.xml \\',
  '',
  'endif # !ENABLE_WASM_STRIP_WRITER',
  '',
  'ifneq ($(ENABLE_WASM_STRIP_CALC),TRUE)',
  'gb_emscripten_fs_image_files += \\',
  '    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/soffice.cfg/modules/scalc/menubar/menubar.xml \\',
  '',
  'endif # !ENABLE_WASM_STRIP_CALC',
  '',
  'gb_emscripten_fs_image_files += \\',
  '    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/main.xcd \\',
  '    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/registry/Langpack-en-US.xcd \\',
  '',
  // ⚠ **言語ブロックの錨**(#158)。一覧が閉じた直後のこの行より**前**に入らないと、
  //    make は通るのに file は詰まらない(#135 と同じ「無言で空」)。
  'gb_emscripten_fs_image_all_files = $(gb_emscripten_fs_image_files) $(EXTRA)',
  '',
].join('\n');

/** make に解析させるだけの受け皿。⚠ 変数の**中身**を出す。 */
const HARNESS = [
  'INSTROOT := /I',
  'LIBO_SHARE_FOLDER := share',
  // #158 の言語ブロックが読むもの。⚠ 上流と**同じ式**で導く ── ここに直値を置くと、
  //    上流の導出が変わったときに test だけ通り続ける
  'SRCDIR := $(CURDIR)',
  'LIBO_SHARE_RESOURCE_FOLDER := program/resource',
  'gb_WITH_LANG ?= en-US ja',
  'gb_AllLangMoTarget_LANGS := $(filter-out qtz,$(filter-out en-US,$(gb_WITH_LANG)))',
  'gb_Configuration_LANGS := en-US $(filter-out en-US,$(gb_WITH_LANG))',
  'gb_AllLangMoTarget_REGISTERED ?= sw sc cui',
  `include ${MK}`,
  'print:',
  '\t@echo "FILES=$(gb_emscripten_fs_image_files)"',
  '',
].join('\n');

/**
 * `localestr` の代役。上流は言語名をロケール名へ写す(`zh-CN` → `zh_CN`)。
 * ⚠ **本物と同じ意味論**にする ── stub が実装より素直だとバグが隠れる。
 */
const LOCALESTR = '#!/bin/sh\necho "$1" | tr - _\n';

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Run {
  readonly status: number;
  readonly stderr: string;
  readonly dir: string;
}

function runPatcher(dir: string): Run {
  try {
    execFileSync('python3', [PATCHER, dir], { encoding: 'utf-8', stdio: 'pipe' });
    return { status: 0, stderr: '', dir };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer | string };
    return { status: err.status ?? -1, stderr: String(err.stderr ?? ''), dir };
  }
}

/** fixture を撒くだけ(patch は当てない)。 */
function seed(source = UPSTREAM): string {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-fsimg-'));
  made.push(dir);
  mkdirSync(join(dir, 'static'), { recursive: true });
  mkdirSync(join(dir, 'solenv', 'bin'), { recursive: true });
  writeFileSync(join(dir, MK), source);
  writeFileSync(join(dir, 'harness.mk'), HARNESS);
  writeFileSync(join(dir, 'solenv', 'bin', 'localestr'), LOCALESTR, { mode: 0o755 });
  return dir;
}

function apply(source = UPSTREAM): Run {
  return runPatcher(seed(source));
}

/**
 * make に読ませて、変数に入った path を返す。
 * ⚠ 解析に失敗したら**例外**にする(`missing separator` を「0 件」と読まない)。
 */
function fileList(dir: string, env: Record<string, string> = {}): string[] {
  const out = execFileSync('make', ['-C', dir, '-f', 'harness.mk', 'print'], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env: { ...process.env, ...env },
  });
  const line = out.split('\n').find((l) => l.startsWith('FILES='));
  if (line === undefined) throw new Error(`make の出力に FILES= が無い:\n${out}`);
  return line.slice('FILES='.length).trim().split(/\s+/).filter(Boolean);
}

/** コードが読むのに一式へ入っていなかった 4 件(全数走査の結果)。 */
const ADDED = {
  'Writer 表の自動書式': '/I/share/svx/tablestyles.xml',
  'Writer ラベル定義': '/I/share/labels/labels.xml',
  'Calc 表スタイル': '/I/share/calc/tablestyles.xml',
  'Calc 既定セルスタイル': '/I/share/calc/styles.xml',
} as const;

/**
 * 🔴 **日本語 UI のために入るもの**(#158)。
 *
 * ⚠ **`gb_AllLangMoTarget_REGISTERED` が `sw sc cui` の 3 つ**という harness の
 * 前提から導かれる。上流の一覧そのものではない ── 見たいのは
 * 「**登録済み × 頼んだ言語**の直積が、正しい path で入るか」である。
 */
const LANG_ADDED = [
  '/I/program/resource/ja/LC_MESSAGES/sw.mo',
  '/I/program/resource/ja/LC_MESSAGES/sc.mo',
  '/I/program/resource/ja/LC_MESSAGES/cui.mo',
  '/I/share/registry/Langpack-ja.xcd',
  '/I/share/registry/res/fcfg_langpack_ja.xcd',
  '/I/share/registry/res/registry_ja.xcd',
] as const;

describe('wasm 一式の詰め込み一覧(#135)', () => {
  it('🔴 make が解析でき、4 件が変数に入る(対照群では 0 件)', () => {
    const before = apply();
    // ⚠ 対照群 ── パッチ前に既に入っているなら、この test は何も測っていない
    const control = fileList(seed());
    for (const [why, p] of Object.entries(ADDED)) {
      expect(control, `${why}: 対照群に既に在る = 何も測っていない`).not.toContain(p);
    }

    expect(before.status, before.stderr).toBe(0);
    const after = fileList(before.dir);
    for (const [why, p] of Object.entries(ADDED)) {
      expect(after, `${why}(${p})が一覧に入っていない`).toContain(p);
    }
    // ⚠ 既存の entry を巻き添えにしていない(下限も置く)
    expect(after).toContain('/I/share/filter/vml-shape-types');
    // #135 の 4 件 + #158 の言語 6 件(.mo 3 × ja + registry 3 × ja)
    expect(after.length).toBe(control.length + 4 + LANG_ADDED.length);
  });

  /**
   * 🔴 **置いた場所の主張は、切ったときに消えて初めて証明される。**
   * 「Writer が読むものは Writer のブロックに入れた」を、
   * `ENABLE_WASM_STRIP_WRITER=TRUE` で実際に落として確かめる。
   */
  it('🔴 Writer を切ると Writer 用の 2 件だけ消える', () => {
    const r = apply();
    expect(r.status, r.stderr).toBe(0);
    const stripped = fileList(r.dir, { ENABLE_WASM_STRIP_WRITER: 'TRUE' });
    expect(stripped).not.toContain(ADDED['Writer 表の自動書式']);
    expect(stripped).not.toContain(ADDED['Writer ラベル定義']);
    expect(stripped).toContain(ADDED['Calc 表スタイル']);
    expect(stripped).toContain(ADDED['Calc 既定セルスタイル']);
  });

  /**
   * 🔴 **日本語 UI(#158)。** 上流の一覧は言語成果物を `en-US` で**名指し**しており、
   * `program/resource/**`(`.mo`)を **1 行も入れていない**。
   *
   * ⚠ 観測点は「`ja` という字が在るか」ではなく **path が組み上がっているか**である。
   * make は `\` + 改行を**空白 1 個**にするので、path の途中で折ると
   * `…/program/resource/ ja/LC_MESSAGES/…` に化ける ── 字面検査では通ってしまう。
   */
  it('🔴 頼んだ言語の .mo と registry が、正しい path で一覧に入る(#158)', () => {
    const control = fileList(seed());
    for (const p of LANG_ADDED) {
      expect(control, `対照群に既に在る = 何も測っていない: ${p}`).not.toContain(p);
    }
    // ⚠ 空振り防止 ── 対照群に `.mo` が 1 件も無いことを明示する
    expect(control.filter((p) => p.endsWith('.mo')), '上流が既に .mo を入れている').toEqual([]);

    const r = apply();
    expect(r.status, r.stderr).toBe(0);
    const after = fileList(r.dir);
    for (const p of LANG_ADDED) expect(after, `入っていない: ${p}`).toContain(p);
    // ⚠ en-US を二重に入れていない(上流が既に持っている)
    expect(after.filter((p) => p.includes('Langpack-en-US')).length).toBe(1);
  });

  /**
   * 🔴 **言語を頼まなければ止まる。** `+=` は空でも**成功する**ので、
   * 黙って英語だけを配る形(#135 と同じ「無言で空」)を作らない。
   */
  it('🔴 --with-lang に en-US しか無いなら make が止まる(#158)', () => {
    const r = apply();
    expect(r.status, r.stderr).toBe(0);
    expect(() => fileList(r.dir, { gb_WITH_LANG: 'en-US' })).toThrow(/gb_AllLangMoTarget_LANGS/);
    // ⚠ 登録一覧が空でも止まる(展開の順序が変わったときに効く)
    expect(() => fileList(r.dir, { gb_AllLangMoTarget_REGISTERED: ' ' })).toThrow(
      /gb_AllLangMoTarget_REGISTERED/,
    );
  });

  /**
   * ⚠ `qtz` は翻訳 QA 用の**疑似ロケール**。配ると LO の UI 言語の一覧に
   * 化けた言語が並ぶ。上流も `gb_AllLangMoTarget_LANGS` で同じ理由で外している。
   * 🔑 この分岐は**実際に走らせて**確かめる(「両方向」と書いた検査が片方しか
   * 走っていなかった 2026-08-13 の反省)。
   */
  it('⚠ qtz が混ざっても配らない(#158)', () => {
    const r = apply();
    expect(r.status, r.stderr).toBe(0);
    const withQtz = fileList(r.dir, { gb_WITH_LANG: 'en-US ja qtz' });
    expect(withQtz.filter((p) => p.includes('qtz')), 'qtz を配ろうとしている').toEqual([]);
    // ⚠ 空振り防止 ── qtz を外した結果、ja まで消えていないか
    expect(withQtz).toContain('/I/share/registry/Langpack-ja.xcd');
  });

  /**
   * ⚠ ロケール名は言語名と**同じとは限らない**(`zh-CN` → `zh_CN`)。
   * 上流の `localestr` を通していることを、化ける言語で確かめる。
   */
  it('⚠ ロケール名へ写してから path を組む(zh-CN → zh_CN)(#158)', () => {
    const r = apply();
    expect(r.status, r.stderr).toBe(0);
    const zh = fileList(r.dir, { gb_WITH_LANG: 'en-US zh-CN' });
    expect(zh).toContain('/I/program/resource/zh_CN/LC_MESSAGES/sw.mo');
    // registry のほうは**言語名のまま**(上流の Package_registry.mk がそう作る)
    expect(zh).toContain('/I/share/registry/Langpack-zh-CN.xcd');
  });

  it('🔴 Calc を切ると Calc 用の 2 件だけ消える', () => {
    const r = apply();
    expect(r.status, r.stderr).toBe(0);
    const stripped = fileList(r.dir, { ENABLE_WASM_STRIP_CALC: 'TRUE' });
    expect(stripped).not.toContain(ADDED['Calc 表スタイル']);
    expect(stripped).not.toContain(ADDED['Calc 既定セルスタイル']);
    expect(stripped).toContain(ADDED['Writer 表の自動書式']);
    expect(stripped).toContain(ADDED['Writer ラベル定義']);
  });

  /**
   * ⚠ 上流が同じ file を入れたら**止まる** ── 二重に入れない。
   * 🔑 止まったときは「patch が要らなくなった」合図なので、消す判断ができる。
   */
  it('⚠ 上流が既に入れていたら異常終了する', () => {
    const r = apply();
    expect(r.status, r.stderr).toBe(0);
    const twice = runPatcher(r.dir);
    expect(twice.status, '2 回目が通ってしまった(二重に入る)').not.toBe(0);
    expect(twice.stderr).toContain('上流が既に入れている');
  });

  /**
   * 🔴 **一覧の外へ落ちたら止まる。**
   *
   * 変異試験で「置いた場所の後条件を外す」が生き延びたので足した ──
   * 振る舞いの test(上の 2 件)は**正しく置けた形**しか通らないので、
   * 後条件そのものは誰も見ていなかった。
   *
   * ⚠ ここで作るのは**上流が組み替えた**状況である:`endif` が対応する
   * `ifneq` より**前**に在ると、錨の本数(1 件)は満たしたまま、
   * 差し込み先がどのブロックにも属さなくなる。
   * 🔑 30 分のビルドの中で静かに間違えるより、**ここで止まる**ほうがよい。
   */
  it('🔴 差し込み先がブロックの外なら異常終了する', () => {
    const broken = [
      'gb_emscripten_fs_image_files := \\',
      '    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/filter/vml-shape-types \\',
      '',
      'endif # !ENABLE_WASM_STRIP_WRITER',
      '',
      'ifneq ($(ENABLE_WASM_STRIP_WRITER),TRUE)',
      'gb_emscripten_fs_image_files += \\',
      '    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/soffice.cfg/modules/swriter/x.xml \\',
      '',
      'ifneq ($(ENABLE_WASM_STRIP_CALC),TRUE)',
      'gb_emscripten_fs_image_files += \\',
      '    $(INSTROOT)/$(LIBO_SHARE_FOLDER)/config/soffice.cfg/modules/scalc/x.xml \\',
      '',
      'endif # !ENABLE_WASM_STRIP_CALC',
      '',
      // ⚠ 言語ブロックの錨は在らせる ── 無いと**そちらの検査で先に落ちて**、
      //    この test が主張したい「ブロックの外」を 1 度も通らなくなる
      'gb_emscripten_fs_image_all_files = $(gb_emscripten_fs_image_files)',
      '',
    ].join('\n');
    const r = apply(broken);
    expect(r.status, '一覧の外へ落ちたのに通ってしまった').not.toBe(0);
    expect(r.stderr).toContain('ブロックの外に在る');
    // ⚠ 落ちたときは書き換えていない
    expect(readFileSync(join(r.dir, MK), 'utf-8')).not.toContain('svx/tablestyles.xml');
  });

  it('⚠ 錨が無ければ異常終了する(黙って素通りしない)', () => {
    const r = apply(UPSTREAM.replace('endif # !ENABLE_WASM_STRIP_CALC', 'endif'));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('錨が 0 件');
    // ⚠ 落ちたときは書き換えていない
    expect(readFileSync(join(r.dir, MK), 'utf-8')).not.toContain('tablestyles.xml');
  });
});
