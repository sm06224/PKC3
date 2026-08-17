/** @vitest-environment node */
/**
 * workflow の **step の重複**を止める(2026-08-09)。
 *
 * 🔴 実際に踏んだ事故: `office-wasm-build.yml` に同じ step が **3 組**貼り付いており
 * (`id: c_tar` が 3 回)、GitHub が workflow を**解析できなくなった** ──
 * `event: push` で **job 0 件のまま即 failure**、run の名前が workflow 名ではなく
 * **ファイルパス**になる。同一 job 内の step id は一意でなければならない。
 *
 * ⚠ **手元の検査は全部通っていた**。`yaml.safe_load` ✓ / タブ無し ✓ / 制御文字無し ✓ /
 * 「重複キー無し」✓ ── 最後のが効かなかったのは、step が **mapping ではなく
 * sequence の要素**だからである。**同じ要素が 2 つ在る sequence は完全に正しい YAML**。
 * つまり「重複キー」を見る検査は、この形の重複を**構造上 1 件も検出できない**。
 * 原因を heredoc だと**推測して 1 往復無駄にした**ので、機械で止める。
 *
 * ⚠ 空振り防止は「id が 1 件でもある」では足りない(走査が 1 job しか見られなく
 * なっても満たされる)。**素の grep 件数と突き合わせる** ── job の切り出しが壊れて
 * step を取りこぼしたら、その瞬間に数が合わなくなる。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = '.github/workflows';

const FILES = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));

interface Step {
  file: string;
  job: string;
  line: number;
  id: string;
}

/**
 * `jobs:` 配下の各 job を切り出し、その中の `id:` を集める。
 * ⚠ `with:` の中にも `id` という入力名がありうるので、**step の直下**
 * (`- name:` / `- uses:` / `- run:` と同じ深さ)だけを拾う。
 */
function collect(): Step[] {
  const out: Step[] = [];
  for (const file of FILES) {
    const lines = readFileSync(join(DIR, file), 'utf-8').split('\n');
    let inJobs = false;
    let job = '';
    let stepIndent = -1;
    for (const [n, line] of lines.entries()) {
      if (/^jobs:\s*$/.test(line)) {
        inJobs = true;
        continue;
      }
      if (!inJobs) continue;
      if (/^\S/.test(line)) {
        inJobs = false; // jobs: と同じ深さの別キーへ抜けた
        continue;
      }
      const j = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(line);
      if (j) {
        job = j[1]!;
        stepIndent = -1;
        continue;
      }
      const s = /^(\s*)- (?:name|uses|run|id):/.exec(line);
      if (s) stepIndent = s[1]!.length;
      if (stepIndent < 0) continue;
      // ⚠ `id:` は **2 つの書き方**で現れる ── `- id: x`(要素の 1 行目)と
      // `  id: x`(2 行目以降)。前者を落としていて空振り防止に叱られた。
      // 揃うのは字下げではなく**キーの開始列**なので、そちらで判定する
      const m = /^(\s*)(- )?id: (\S+)\s*$/.exec(line);
      if (!m) continue;
      const column = m[1]!.length + (m[2] ? 2 : 0);
      if (column === stepIndent + 2) out.push({ file, job, line: n + 1, id: m[3]! });
    }
  }
  return out;
}

describe('workflow の step', () => {
  const steps = collect();

  it('🔴 走査が step を取りこぼしていない(素の grep と件数が一致する)', () => {
    // ⚠ これが空振り防止の本体。「1 件でもある」では、job の切り出しが壊れて
    // 1 job しか見えなくなっても満たされてしまう
    let raw = 0;
    for (const file of FILES) {
      for (const line of readFileSync(join(DIR, file), 'utf-8').split('\n')) {
        if (/^\s+(?:- )?id: \S+\s*$/.test(line)) raw += 1;
      }
    }
    expect(raw).toBeGreaterThan(0);
    expect(steps.length).toBe(raw);
  });

  it('🔴 同一 job 内の step id が一意(重複すると GitHub が workflow ごと読めなくなる)', () => {
    const seen = new Map<string, Step>();
    const dupes: string[] = [];
    for (const s of steps) {
      const key = `${s.file}::${s.job}::${s.id}`;
      const first = seen.get(key);
      if (first) dupes.push(`${s.file}:${s.line} id:${s.id}(${s.job}) ── ${first.line} 行目と重複`);
      else seen.set(key, s);
    }
    expect(dupes).toEqual([]);
  });

  it('🔴 ccache の鍵は Qt の同一性を含む(同じパスで中身が変わる罠)', () => {
    // 🔴 2026-08-10 に実測で踏んだ。Qt を 6.11 → 6.9 に替えたのに、`make` が
    // `undefined symbol: QObject::doSetProperty(char const*, QVariant const&, QVariant*)`
    // で落ちた。**この参照版のシグネチャは 6.11 にしか無い**(6.9 はポインタ版のみ)──
    // つまり **6.11 のヘッダでコンパイルされた古い object が ccache から出ていた**。
    //
    // 原因: LibreOffice は **depend mode の ccache** を使い、`$QT6DIR` は版が変わっても
    // **パスが同じ**なので、中身だけ変わったヘッダを取りこぼす。
    //
    // ⚠ **Qt キャッシュの鍵は直したのに、ccache の鍵を直していなかった**
    // (「1 巡目の修正は 2 巡目の対象である」を自分で踏んだ)。注意書きでは 2 度目を
    // 止められないので、機械で止める。
    const keys: { file: string; line: number; key: string }[] = [];
    for (const file of FILES) {
      const lines = readFileSync(join(DIR, file), 'utf-8').split('\n');
      for (const [n, line] of lines.entries()) {
        const m = /^\s*(?:key|restore-keys):\s*(\S.*)$/.exec(line);
        if (m) keys.push({ file, line: n + 1, key: m[1]! });
        // `restore-keys: |` のブロック本体も拾う
        if (/^\s*restore-keys:\s*\|\s*$/.test(line)) {
          for (let i = n + 1; i < lines.length; i += 1) {
            const body = lines[i]!;
            if (body.trim() === '' || !/^\s{10,}\S/.test(body)) break;
            keys.push({ file, line: i + 1, key: body.trim() });
          }
        }
      }
    }
    // 空振り防止 ── ccache の鍵が実際に在ること
    const ccacheKeys = keys.filter((k) => /ccache/.test(k.key));
    expect(ccacheKeys.length).toBeGreaterThan(0);

    const offenders = ccacheKeys
      .filter((k) => !/inputs\.qt_ref/.test(k.key))
      .map((k) => `${k.file}:${k.line}: ${k.key}`);
    expect(offenders).toEqual([]);
  });

  it('🔴 同一 job 内に同じ step 名が 2 つ無い(貼り付けの取り違えを見つける)', () => {
    // id 重複だけを見ると、**id を持たない step の複製**が素通りする
    // (実際の事故では `- name: 上流 Qt6 経路の取りこぼしを当てる` も 3 つあった)。
    // ⚠ GitHub は名前の重複を拒まないので、これは構文ではなく**取り違えの検出**である
    const seen = new Map<string, number>();
    const dupes: string[] = [];
    for (const file of FILES) {
      const lines = readFileSync(join(DIR, file), 'utf-8').split('\n');
      let job = '';
      let inJobs = false;
      for (const [n, line] of lines.entries()) {
        if (/^jobs:\s*$/.test(line)) inJobs = true;
        else if (/^\S/.test(line)) inJobs = false;
        if (!inJobs) continue;
        const j = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(line);
        if (j) {
          job = j[1]!;
          continue;
        }
        const m = /^\s*- name: (.+?)\s*$/.exec(line);
        if (!m) continue;
        const key = `${file}::${job}::${m[1]!}`;
        const first = seen.get(key);
        if (first) dupes.push(`${file}:${n + 1} "${m[1]!}" ── ${first} 行目と重複`);
        else seen.set(key, n + 1);
      }
    }
    expect(dupes).toEqual([]);
  });
});

/**
 * 夜の検査は **1 つ落ちても後ろを止めない**(#221、2026-08-17)。
 *
 * 🔴 実際に踏んだ事故: `Probe — sidebar` が落ちた **13 晩**、その後ろの
 * `Probe — editor` / `Probe — kanban` は step の既定(前が落ちたら skip)で
 * **1 度も走っていなかった**。⚠ 症状は「赤が 1 つ」に見えるので、
 * **走っていない検査が 2 つある**ことは run を開いても分からない
 * (`editor` は同じ空振り検定を持っており、走っていれば同じ日に露見していた)。
 * 🔑 CLAUDE.md「回すものの粒度: **1 job = 1 主張**。落ちたとき何が壊れたか、
 * 名前で言える形にする」。文言では 2 度目を止められないので機械で止める。
 */
describe('nightly の step', () => {
  const YML = join(DIR, 'nightly.yml');
  const GUARD = 'if: ${{ !cancelled() }}';

  /** 設定の都合で guard を持たない step の id(**明示の carve-out**)。 */
  const SETUP_IDS = new Set(['pw']);

  interface NightlyStep {
    line: number;
    name: string;
    id: string | null;
    hasGuard: boolean;
    run: string;
  }

  /** `heavy` job の step を切り出す(この repo に YAML parser は入っていない)。 */
  function nightlySteps(): NightlyStep[] {
    const lines = readFileSync(YML, 'utf-8').split('\n');
    const out: NightlyStep[] = [];
    let inSteps = false;
    let cur: NightlyStep | null = null;
    for (const [n, line] of lines.entries()) {
      if (/^ {4}steps:\s*$/.test(line)) {
        inSteps = true;
        continue;
      }
      if (!inSteps) continue;
      if (/^ {0,4}\S/.test(line) && line.trim() !== '') break; // job の外へ出た
      const head = /^ {6}- (name|uses): (.+?)\s*$/.exec(line);
      if (head) {
        if (cur) out.push(cur);
        cur = { line: n + 1, name: head[1] === 'name' ? head[2]! : '', id: null, hasGuard: false, run: '' };
        continue;
      }
      if (!cur) continue;
      const name = /^ {8}name: (.+?)\s*$/.exec(line);
      if (name) cur.name = name[1]!;
      const id = /^ {8}id: (\S+)\s*$/.exec(line);
      if (id) cur.id = id[1]!;
      if (line.trim() === GUARD) cur.hasGuard = true;
      const run = /^ {8}run: (.+?)\s*$/.exec(line);
      if (run) cur.run = run[1]!;
      if (/^ {10}\S/.test(line)) cur.run += `\n${line.trim()}`; // run: | の本体
    }
    if (cur) out.push(cur);
    return out;
  }

  const steps = nightlySteps();

  it('🔴 切り出しが step を取りこぼしていない(素の grep と件数が一致する)', () => {
    // 空振り防止 ── 1 つも読めていない形で「全部 guard 付き」と言わない
    const raw = readFileSync(YML, 'utf-8')
      .split('\n')
      .filter((l) => /^ {6}- (name|uses):/.test(l)).length;
    expect(raw).toBeGreaterThan(5);
    expect(steps.length).toBe(raw);
  });

  it('🔴 probe の step は全部「前が落ちても走る」(13 晩 skip された形を止める)', () => {
    const probes = steps.filter((s) => s.name.startsWith('Probe —'));
    // 空振り防止 ── probe を 1 つも見つけられていないなら検査になっていない
    expect(probes.length, 'probe の step を見つけられていない').toBeGreaterThanOrEqual(5);
    const offenders = probes
      .filter((s) => !s.hasGuard || !s.id)
      .map((s) => `${YML}:${s.line} ${s.name}${s.id ? '' : '(id が無い)'}`);
    expect(offenders).toEqual([]);
  });

  it('🔴 id を持つ検証 step は全部 guard を持つ(足した step が静かに skip されない)', () => {
    const offenders = steps
      .filter((s) => s.id && !SETUP_IDS.has(s.id) && !s.hasGuard)
      .map((s) => `${YML}:${s.line} id:${s.id}`);
    expect(offenders).toEqual([]);
  });

  it('🔴 赤い夜を台帳へ出す step が在り、書ける権限が宣言されている', () => {
    const ledger = steps.find((s) => s.run.includes('scripts/nightly-red.mjs'));
    expect(ledger, '夜の結果を台帳へ出す step が無い').toBeDefined();
    expect(ledger!.hasGuard, '台帳の step が skip されうる').toBe(true);
    // ⚠ 権限が無いと API が 403 を返す ── script は例外で落ちるので静かではないが、
    //   「毎晩 1 つ余計に赤い step」が常態化する。宣言のほうを縛る
    const yml = readFileSync(YML, 'utf-8');
    const perms = /^permissions:\n((?:[ #].*\n)+)/m.exec(yml);
    expect(perms, 'permissions が読めない').not.toBeNull();
    expect(perms![1], 'issues: write が無い').toContain('issues: write');
  });
});

/**
 * LibreOffice へ当てるパッチの**本数**が、workflow の主張と一致する(#117)。
 *
 * 🔴 workflow 側は `test "$n" -eq 3` と**実数で**書いてある(「2 本以上」だと
 * 1 本落としても気づけないため)。⚠ ところが**その数を直し忘れる**と、
 * 気づくのは **6 時間ビルドの中**である ── しかも「当たらなかった」ではなく
 * 「本数が違う」で落ちるので、原因は分かるが**転回を 1 つ捨てる**。
 * 🔑 ここで機械的に突き合わせれば、`npm test` の時点で分かる。
 *
 * ⚠ file 名指しで書かない ── `patch-*.py` を**数える**(CLAUDE.md
 * 「guard を file 名指しで書かない」)。
 */
describe('office-wasm のパッチ', () => {
  const YML = join(DIR, 'office-wasm-build.yml');
  const PATCH_DIR = 'build/office-wasm';

  /**
   * workflow の中の「**glob で回して本数を主張する**」組を全部拾う。
   *
   * 🔴 初稿は `test "$n" -eq (\d+)` を **1 件だけ**取っていた(2026-08-13 に破れた)。
   * qtbase 用のループを足した瞬間、**先頭 1 件しか見ない**ので
   * 「qtbase の本数(1)」を「LO のパッチ本数(3)」と突き合わせて落ちる ──
   * ⚠ 検査そのものが、**対象が 1 組しか無い前提**で書かれていた。
   * 🔑 いまは **glob と主張を対にして全部**拾い、それぞれ実在数と突き合わせる。
   */
  function loops(): { glob: string; claimed: number }[] {
    const yml = readFileSync(YML, 'utf-8');
    const out: { glob: string; claimed: number }[] = [];
    const re = /for p in "\$GITHUB_WORKSPACE"\/build\/office-wasm\/([^;]+); do/g;
    for (const m of yml.matchAll(re)) {
      const rest = yml.slice(m.index + m[0].length);
      const claim = /test "\$n" -eq (\d+)/.exec(rest);
      expect(claim, `${m[1]} のループに本数の主張が無い`).not.toBeNull();
      out.push({ glob: m[1]!.trim(), claimed: Number(claim![1]) });
    }
    return out;
  }

  /** shell の glob(`patch-*.py`)を正規表現へ。 */
  function toRe(glob: string): RegExp {
    return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  }

  it('🔴 workflow が主張する本数と、実在する数が glob ごとに一致する', () => {
    expect(existsSync(YML), `${YML} が無い`).toBe(true);
    const all = readdirSync(PATCH_DIR);
    const found = loops();
    // 空振り防止 ── ループが 1 つも見つからない形で「一致した」と言わない
    expect(found.length, 'パッチのループを 1 つも見つけられていない').toBeGreaterThan(1);
    for (const { glob, claimed } of found) {
      const files = all.filter((f) => toRe(glob).test(f));
      expect(files.length, `${glob} に当たる file が 1 本も無い`).toBeGreaterThan(0);
      expect(claimed, `${glob} = ${files.join(', ')} の ${files.length} 本`).toBe(files.length);
    }
  });

  /**
   * 🔴 **qtbase のパッチは Qt の cache 鍵に入っていなければならない**(#134)。
   * ⚠ 入っていないと、パッチを足したのに**パッチ前の Qt が復元され**、
   *   当てたつもりで効かない ── workflow が同じ罠を別の箇所で注記している。
   */
  it('🔴 qtbase のパッチが Qt / ccache の鍵に含まれる', () => {
    const yml = readFileSync(YML, 'utf-8');
    const keys = [...yml.matchAll(/^\s*key: (.+)$/gm)].map((m) => m[1]!);
    const qtKeys = keys.filter((k) => /^qt-|^ccache-/.test(k));
    expect(qtKeys.length, 'Qt / ccache の鍵が見つからない').toBeGreaterThan(0);
    for (const k of qtKeys) {
      expect(k, `鍵が qtbase パッチを見ていない: ${k}`).toContain('qtbase-patch-');
    }
  });

  /**
   * ⚠ qtbase のパッチは **Qt をビルドする前**に当たること(後では意味が無い)。
   *
   * 🔴 初稿は `indexOf('qtbase-patch-*.py')` で位置を採ったが、**cache 鍵のほうに
   * 当たっていた**(鍵は file の上のほうに在るので、step をどこへ動かしても
   * 常に「前」になる)── **代替物に満たされる条件**だった(CLAUDE.md)。
   * 🔑 いまは**実行する行そのもの**(`for p in …qtbase-patch-*.py`)で採る。
   */
  it('🔴 qtbase のパッチは Qt のビルドより前に当たる', () => {
    const yml = readFileSync(YML, 'utf-8');
    const patchAt = yml.indexOf('/qtbase-patch-*.py; do');
    const buildAt = yml.indexOf('- name: Qt6 wasm ビルド');
    expect(patchAt, 'qtbase のパッチを実行するループが無い').toBeGreaterThan(-1);
    expect(buildAt, 'Qt6 wasm ビルドの step が無い').toBeGreaterThan(-1);
    expect(patchAt, 'ビルドより後に当てている').toBeLessThan(buildAt);
    // ⚠ 当てる先が qtbase であること(`~/lo-core` を渡すと「src/plugins が無い」で落ちる)
    const loop = yml.slice(patchAt, patchAt + 400);
    expect(loop, 'qtbase 以外へ当てている').toContain('~/qtbase');
  });

  /**
   * 🔴 **頼んだモジュールと、確かめる grep の釣り合い**(#145)。
   *
   * 上流 `configure.ac` の `--with-wasm-module` 既定は **`'calc writer'`** で、
   * 渡さないと Impress は**一式に 1 file も入らない**(実測: `simpress` 0 / `sdraw` 0)。
   * ⚠ しかも**入らなかったことは静かである** ── user から見ると「開こうとしても
   * 無反応」でしかなく、ビルドは緑のまま通る。
   *
   * だから configure の step は、頼んだモジュールごとに
   * 「落とされていない」(`ENABLE_WASM_STRIP_… =` が空)を確かめている。
   * 🔑 ここで縛るのは**その釣り合い**である ── モジュールを 1 つ足して
   * grep を足し忘れると、**確かめないまま焼く**ことになる
   * (CLAUDE.md「片側を直したら、対称の反対側を必ず疑う」)。
   */
  /**
   * 🔴 **頼んだ UI 言語と、確かめる検品の釣り合い**(#158)。
   *
   * ⚠ `--with-lang` は**渡していなかった** ── LO の既定は en-US だけなので、
   * **日本語 UI が 1 file も入っていなかった**(日本語フォントは入れてあったので
   * 「描画は日本語・UI は英語」という食い違いになり、user が実機で気づいた)。
   * 🔑 縛るのは**釣り合い**である ── 言語を足したら
   * ① 構成に入ったか(`WITH_LANG`)② **配る物に入ったか**(metadata の件数)
   * の 2 段を必ず持つ。⚠ ①だけだと #145 と同じ轍(渡したのに入っていない)。
   */
  it('🔴 頼んだ UI 言語は、構成と配る物の 2 段で確かめている', () => {
    const yml = readFileSync(YML, 'utf-8');
    const m = /--with-lang=([^\n]*)/.exec(yml);
    expect(m, 'configure が --with-lang を渡していない').not.toBeNull();
    const langs = m![1]!.trim().split(/\s+/).filter(Boolean);
    // 空振り防止 ── 1 つも読めていない形で「全部確かめた」と言わない
    expect(langs.length, '言語を 1 つも読めていない').toBeGreaterThan(0);
    expect(langs, '既定の en-US を落としている').toContain('en-US');
    /**
     * 🔴 **日本語を配ることそのものを縛る**(#158)。
     * ⚠ 上の釣り合いだけでは **`ja` を外す変異が生き延びる**(実測)──
     * 「頼んだ言語には検品が在る」は、**1 つも頼まなければ真**である。
     * user が実機で困ったのは「UI が英語」なので、**要件のほうを pin する**。
     */
    expect(langs, '日本語 UI を配らない構成になっている').toContain('ja');

    for (const lang of langs) {
      if (lang === 'en-US') continue; // 既定なので検品は要らない
      // ① 構成の途中経過は **assert しない**(2026-08-14 に訂正)。
      // ⚠ ここは 3 回続けて「**達成できると確かめていない結果**」を後条件に固めた場所で
      //    ある ── `WITH_LANG` に `ja`(wasm では変数ごと別 file)→
      //    `--disable-wasm-strip-locales`(上流に無い option)→
      //    `ENABLE_WASM_STRIP_LOCALES=$`(**死に変数**。上流全体で読み手ゼロ、
      //    かつ `configure.ac:1301` が `enable_wasm_strip=yes` を無条件に上書きする)。
      //    どれも「渡せばこうなるはず」を pin しており、落ちたとき
      //    「実装が悪いのか、期待が間違いか」が区別できなかった。
      // 🔑 **未確認は診断で出す**。構成の実体(`config_host_lang.mk`)は印字して次の回転で
      //    読む ── 通ったのを見てから後条件へ昇格させる。
      expect(yml, '構成の実体(config_host_lang.mk)を診断に出していない').toContain(
        'cat config_host_lang.mk',
      );
      // 🚫 死に変数への guard を**戻さない**ための等値 pin(直したら消さないと落ちる形)。
      expect(yml, '効かないと分かっている guard が戻っている').not.toContain(
        "grep -q '^export ENABLE_WASM_STRIP_LOCALES=$' config_host.mk",
      );
      // 🚫 `--disable-wasm-strip` は Emscripten では上書きされて効かない(上記)。
      //    ⚠ 仮に効いたら `enable_dynamic_loading` まで戻ってリンクしない。
      // 🔴 **見るのは distro conf の中だけ**(2026-08-14、この 1 行で実際に踏んだ)。
      //    file 全体で `not.toContain` すると、**上の解説コメントに満たされて必ず落ちる**
      //    ── CLAUDE.md §1「検査の範囲を、自分が書いた場所に限定する」の
      //    (`SAFE_HEAP` の件と)**同じ罠**である。渡す行は heredoc の中にしか無い。
      const conf = /cat > distro-configs\/PKC3WASM-Qt6\.conf <<'CONF'\n([\s\S]*?)\n\s*CONF\n/.exec(
        yml,
      );
      expect(conf, 'distro conf の heredoc が読めない ── 検査が空振りしている').not.toBeNull();
      expect(conf?.[1], '効かない --disable-wasm-strip が distro conf に戻っている').not.toContain(
        '--disable-wasm-strip',
      );
      // 空振り防止 ── heredoc を本当に読めているか(読めていれば必ずこれが在る)
      expect(conf?.[1], 'heredoc の抜き出しが壊れている').toContain('--with-lang=');
      // ② 🔴 **配る物に入ったか**(0 件なら落とす)
      // 🔑 観測点は**代替物で満たせない形**にする(2026-08-14 に絞り込んだ)──
      //    `/ja/` だけだと無関係な path(フォント等)に満たされる。見るのは
      //    **翻訳の実体**(`.mo`)と**言語の登録**(Langpack)で、これは別の機構なので
      //    **両方**要る(片方だけでも UI は英語のまま出荷される)。
      expect(yml, `${lang} の翻訳が配る物に入ったことを確かめていない`).toContain(
        `program/resource/${lang}/LC_MESSAGES/[A-Za-z0-9_]*\\.mo`,
      );
      expect(yml, `${lang} の言語登録が配る物に入ったことを確かめていない`).toContain(
        `Langpack-${lang}\\.xcd`,
      );
    }
  });

  it('🔴 頼んだ wasm モジュールは、全部「落とされていない」ことを確かめている', () => {
    const yml = readFileSync(YML, 'utf-8');
    const m = /--with-wasm-module=([^\n]*)/.exec(yml);
    expect(m, 'configure が --with-wasm-module を渡していない').not.toBeNull();
    const modules = m![1]!.trim().split(/\s+/).filter(Boolean);
    // 空振り防止 ── 1 つも読めていない形で「全部確かめた」と言わない
    expect(modules.length, 'モジュールを 1 つも読めていない').toBeGreaterThan(0);

    /** `configure.ac:4374-4389` の case が空にする変数。 */
    const STRIP_VAR: Record<string, string> = {
      calc: 'ENABLE_WASM_STRIP_CALC',
      writer: 'ENABLE_WASM_STRIP_WRITER',
      impress: 'ENABLE_WASM_STRIP_BASIC_DRAW_MATH_IMPRESS',
    };
    for (const mod of modules) {
      const v = STRIP_VAR[mod];
      expect(v, `知らないモジュール "${mod}"(configure.ac の case に無い)`).toBeDefined();
      // ⚠ `=$` まで含めて見る ── 「変数名が在る」だけでは TRUE でも通ってしまう
      expect(yml, `${mod} を頼んでいるのに、落とされていないことを確かめていない`).toContain(
        `grep -q '^export ${v}=$' config_host.mk`,
      );
    }
  });
});
