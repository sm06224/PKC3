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
  // ⚠ **定義の順は上流の実物に合わせる**(2026-08-14 に fixture 側だけ逆順にして、
  //    実物では通る patch を fixture が偽って落とした)── 上流は
  //    `emscripten_fs_image_WORKDIR :=`(1787 行)→ `all_files =`(1808 行)→
  //    filelist 規則、の順。MO_BLOCK の前提行は WORKDIR を展開するので、
  //    **all_files より前に WORKDIR が定義済み**であることが上流の実物の前提である。
  'emscripten_fs_image_WORKDIR := $(WORKDIR)/fsimg',
  '',
  // ⚠ **言語ブロックの錨**(#158)。registry はこの行より**前**(前提の側)、
  //    .mo の `+=` はこの行より**後ろ**(上書きで消えない側)に入る。
  'gb_emscripten_fs_image_all_files = $(gb_emscripten_fs_image_files) $(EXTRA)',
  '',
  // ⚠ 上流の filelist 規則の縮小版。**recipe の実行時に all_files を展開して file へ
  //    書く**という性質が本物と同じであることが、.mo の wildcard 検査の成立条件。
  '$(emscripten_fs_image_WORKDIR)/.dir:',
  '\tmkdir -p $(dir $@)',
  '.PHONY: $(emscripten_fs_image_WORKDIR)/soffice.data.filelist',
  '$(emscripten_fs_image_WORKDIR)/soffice.data.filelist: $(gb_emscripten_fs_image_files) | $(emscripten_fs_image_WORKDIR)/.dir',
  '\t@printf "%s\\n" $(gb_emscripten_fs_image_all_files) > $@',
  '',
].join('\n');

/** make に解析させるだけの受け皿。⚠ 変数の**中身**を出す。 */
const HARNESS = [
  // ⚠ INSTROOT は**実在するディレクトリ**にする ── .mo の wildcard 検査は
  //    「AllResources が建てた実 file を拾えるか」を見るため
  'INSTROOT := $(CURDIR)/I',
  'WORKDIR := $(CURDIR)/W',
  'LIBO_SHARE_FOLDER := share',
  'SRCDIR := $(CURDIR)',
  'LIBO_SHARE_RESOURCE_FOLDER := program/resource',
  'gb_WITH_LANG ?= en-US ja',
  'gb_Configuration_LANGS := en-US $(filter-out en-US,$(gb_WITH_LANG))',
  // ⚠ 上流の Postprocess の縮小版。**本物と同じ意味論**にする ──
  //    「AllResources を建てたときに初めて .mo が INSTROOT に現れる」。
  //    stub が最初から file を置いてしまうと、**前提(順序)の欠落が隠れる**。
  // ⚠ 上流の Package catch-all の縮小版 ── 「名指しの前提には install 規則が在る」
  //    という前提を fixture でも成立させる(実 file を作って配達の代わりにする)。
  //    ⚠ 本物と違い、これは**どんな名前でも黙って作る**ので、「規則の無い名前を
  //    要求して止まる」失敗の形は fixture では出ない ── その守りは変数側の
  //    「.mo が名指しの前提に居ない」assert が担う(registry の test)。
  '$(INSTROOT)/%:',
  '\tmkdir -p $(dir $@) && printf x > $@',
  '',
  // 🔴 **make の dir cache をわざと温める**(レビュー指摘 C の再現)── 解析時に
  //    resource dir を一度読むと、make は**その時点の内容(空)をキャッシュ**し、
  //    recipe 時の `$(wildcard)` は自分が作った .mo を見ない(GNU Make 4.3 実測)。
  //    実装が `$(shell find)` なら影響しない ── つまりこの 1 行が
  //    **find → wildcard の変異を殺す**。上流の誰かが同じ dir を読む日への備え。
  'PKC3_TEST_CACHE_PRIME := $(wildcard $(INSTROOT)/$(LIBO_SHARE_RESOURCE_FOLDER)/*/LC_MESSAGES/*.mo)',
  '',
  'gb_Postprocess_get_target = $(WORKDIR)/Postprocess/$(1)',
  '$(WORKDIR)/Postprocess/AllResources:',
  '\tmkdir -p $(INSTROOT)/$(LIBO_SHARE_RESOURCE_FOLDER)/ja/LC_MESSAGES',
  '\tprintf x > $(INSTROOT)/$(LIBO_SHARE_RESOURCE_FOLDER)/ja/LC_MESSAGES/sw.mo',
  '\tprintf x > $(INSTROOT)/$(LIBO_SHARE_RESOURCE_FOLDER)/ja/LC_MESSAGES/sc.mo',
  '\tmkdir -p $(dir $@) && touch $@',
  '',
  `include ${MK}`,
  'print:',
  '\t@echo "FILES=$(gb_emscripten_fs_image_files)"',
  '',
].join('\n');

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
  writeFileSync(join(dir, MK), source);
  writeFileSync(join(dir, 'harness.mk'), HARNESS);
  return dir;
}

function apply(source = UPSTREAM): Run {
  return runPatcher(seed(source));
}

/**
 * make に読ませて、変数に入った path を返す。
 * ⚠ 解析に失敗したら**例外**にする(`missing separator` を「0 件」と読まない)。
 * ⚠ INSTROOT は実在 dir(`$(CURDIR)/I`)なので、比較しやすいよう `/I` へ正規化する。
 */
function fileList(dir: string, env: Record<string, string> = {}): string[] {
  const out = execFileSync('make', ['-C', dir, '-f', 'harness.mk', 'print'], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env: { ...process.env, ...env },
  });
  const line = out.split('\n').find((l) => l.startsWith('FILES='));
  if (line === undefined) throw new Error(`make の出力に FILES= が無い:\n${out}`);
  return line
    .slice('FILES='.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.replaceAll(`${dir}/I`, '/I'));
}

/**
 * 🔴 filelist を**実際に build して**、詰まる一覧を読む(#158 の .mo の観測点)。
 *
 * ⚠ 変数の print では足りない ── .mo は `gb_emscripten_fs_image_all_files` の
 * **recipe 実行時の wildcard** で入るので、「AllResources が前提として走ったか」
 * まで含めて **make に本当に建てさせないと**検査にならない。
 */
function builtFileList(dir: string, env: Record<string, string> = {}): string[] {
  // ⚠ target は harness の `$(CURDIR)/W/…` と**同じ綴り**(絶対 path)で頼む ──
  //    相対で頼むと make は「そんな target は無い」と言う
  execFileSync(
    'make',
    ['-C', dir, '-f', 'harness.mk', join(dir, 'W', 'fsimg', 'soffice.data.filelist')],
    { encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, ...env } },
  );
  return readFileSync(join(dir, 'W', 'fsimg', 'soffice.data.filelist'), 'utf-8')
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.replaceAll(`${dir}/I`, '/I'));
}

/** コードが読むのに一式へ入っていなかった 4 件(全数走査の結果)。 */
const ADDED = {
  'Writer 表の自動書式': '/I/share/svx/tablestyles.xml',
  'Writer ラベル定義': '/I/share/labels/labels.xml',
  'Calc 表スタイル': '/I/share/calc/tablestyles.xml',
  'Calc 既定セルスタイル': '/I/share/calc/styles.xml',
} as const;

/**
 * 🔴 **日本語 UI のために「名指しの前提」で入るもの**(#158)= 言語の登録(registry)。
 *
 * ⚠ `.mo` はここに**居ない** ── 名簿から予言すると、構成で建たないもの(`cnr` =
 * DBCONNECTIVITY 落ち)を要求して**ビルド全体が止まる**(run 31777661606 で実証)。
 * `.mo` は AllResources を建てさせてから wildcard で拾う(下の専用 test)。
 */
const LANG_ADDED = [
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
   * 🔴 **日本語 UI の「言語の登録」**(#158)。上流の一覧は言語成果物を `en-US` で
   * **名指し**しており、他言語の registry を 1 行も入れていない。
   *
   * ⚠ 観測点は「`ja` という字が在るか」ではなく **path が組み上がっているか**である。
   * make は `\` + 改行を**空白 1 個**にするので、path の途中で折ると
   * `…/registry/ Langpack-…` に化ける ── 字面検査では通ってしまう。
   */
  it('🔴 頼んだ言語の registry が、正しい path で一覧に入る(#158)', () => {
    const control = fileList(seed());
    for (const p of LANG_ADDED) {
      expect(control, `対照群に既に在る = 何も測っていない: ${p}`).not.toContain(p);
    }
    const r = apply();
    expect(r.status, r.stderr).toBe(0);
    const after = fileList(r.dir);
    for (const p of LANG_ADDED) expect(after, `入っていない: ${p}`).toContain(p);
    // ⚠ en-US を二重に入れていない(上流が既に持っている)
    expect(after.filter((p) => p.includes('Langpack-en-US')).length).toBe(1);
    // ⚠ .mo は**名指しの前提に居ない**こと ── 居ると、構成で建たないもの(cnr)を
    //    要求して catch-all が `$<` 空で止まる(run 31777661606 の実物の落ち方)
    expect(after.filter((p) => p.endsWith('.mo')), '.mo を名指しの前提に戻している').toEqual([]);
  });

  /**
   * 🔴 **`.mo` は「建てさせてから、届いた物を拾う」**(#158 の本体)。
   *
   * REGISTERED からの予言は cnr(DBCONNECTIVITY 落ちで建たない)を要求して
   * **ビルド全体を止めた**(run 31777661606)。正しい形は:
   * ① filelist の前提に AllResources(**この構成で実体化した** mo の全集合)
   * ② 一覧は recipe 実行時の wildcard(前提が済んだ後の実在 file が入る)
   *
   * ⚠ harness の AllResources stub は**本物と同じ意味論** ── 建てたときに初めて
   * `.mo` が INSTROOT に現れる。だからこの test は「①の前提が本当に張られて
   * いるか」まで守る(前提が消えると wildcard が空を拾い、ここで落ちる)。
   */
  it('🔴 .mo は AllResources を建てさせてから wildcard で拾う(#158)', () => {
    // 対照群 ── patch 前は、build しても .mo が 1 件も入らない
    const control = builtFileList(seed());
    expect(control.filter((p) => p.endsWith('.mo')), '対照群に .mo が在る = 測っていない').toEqual(
      [],
    );

    const r = apply();
    expect(r.status, r.stderr).toBe(0);
    const after = builtFileList(r.dir);
    expect(after, 'sw.mo が詰まっていない').toContain('/I/program/resource/ja/LC_MESSAGES/sw.mo');
    expect(after, 'sc.mo が詰まっていない').toContain('/I/program/resource/ja/LC_MESSAGES/sc.mo');
    // registry も最終の一覧に居る(前提 → all_files 経由)
    expect(after).toContain('/I/share/registry/Langpack-ja.xcd');
  });

  /**
   * 🔴 **言語を頼まなければ止まる。** `+=` は空でも**成功する**ので、
   * 黙って英語だけを配る形(#135 と同じ「無言で空」)を作らない。
   */
  it('🔴 --with-lang に en-US しか無いなら make が止まる(#158)', () => {
    const r = apply();
    expect(r.status, r.stderr).toBe(0);
    expect(() => fileList(r.dir, { gb_WITH_LANG: 'en-US' })).toThrow(/配る言語が無い/);
  });

  /**
   * ⚠ `qtz` は翻訳 QA 用の**疑似ロケール**。配ると LO の UI 言語の一覧に
   * 化けた言語が並ぶ。上流も `gb_AllLangMoTarget_LANGS` で同じ理由で外している。
   * 🔑 この分岐は**実際に走らせて**確かめる(「両方向」と書いた検査が片方しか
   * 走っていなかった 2026-08-13 の反省)。
   */
  it('⚠ qtz が混ざっても registry を配らない(#158)', () => {
    const r = apply();
    expect(r.status, r.stderr).toBe(0);
    const withQtz = fileList(r.dir, { gb_WITH_LANG: 'en-US ja qtz' });
    expect(withQtz.filter((p) => p.includes('qtz')), 'qtz を配ろうとしている').toEqual([]);
    // ⚠ 空振り防止 ── qtz を外した結果、ja まで消えていないか
    expect(withQtz).toContain('/I/share/registry/Langpack-ja.xcd');
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
