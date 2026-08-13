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
