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
 *
 * 🔴 **2026-09-05(#695)、その「1 主張」を job の粒度でやり直した。**
 * `heavy` 1 本が 30 分の門に当たって **cancelled** になると、末尾に置いていた
 * 台帳 step の `if: !cancelled()` が偽 = **skip** ── つまり **赤い晩ほど台帳に
 * 出ない**。#221 で直したはずの「赤いまま放置される導線」が、timeout の形で
 * 戻っていた(run #38 / #40 で実測)。だから台帳は**別 job**(`needs` +
 * `if: always()`)にし、ここの pin も **job の形**で書き直す。
 */
describe('nightly の job と step', () => {
  const YML = join(DIR, 'nightly.yml');
  /** 前が落ちても走る印。 */
  const GUARD = '!cancelled()';
  /** 仕込みが揃った晩だけ走る印。 */
  const SETUP_GATE = "steps.setup_ok.outputs.ok == '1'";

  interface NightlyStep {
    line: number;
    name: string;
    id: string | null;
    ifExpr: string;
    run: string;
    /**
     * 🔴 **step の `env:`**(#713、2026-09-05)。
     *
     * ⚠ 直す前は**採っていなかった**うえに、`env:` の中身(10 字下げ)が
     *   `run: |` の本体と同じ規則で `run` へ流れ込んでいた ── そして直後の
     *   `run:` 行が `cur.run` を**上書き**するので、結局どこにも残らなかった。
     * 🔑 帰結:**`PKC3_HEAVY: '1'` を消しても、落ちる検査が 1 つも無い**
     *   (= 22 種の焼きが夜に走らなくなっても、PR gate は緑のまま)。
     */
    env: string[];
  }
  interface NightlyJob {
    line: number;
    name: string;
    ifExpr: string;
    timeout: string | null;
    needs: string[];
    steps: NightlyStep[];
  }

  /**
   * `jobs:` 配下を job ごとに切り出す(この repo に YAML parser は入っていない)。
   *
   * 🔴 初稿(job が 1 本だった頃)は head を `- (name|uses):` で採っていたので、
   * **`- run:` 始まりの step を 1 つも見ていなかった**。しかも空振り防止の側が
   * **同じ正規表現**だったので必ず一致し、**見えていないことを検出できなかった**
   * ── 下の空振り防止は**わざと緩い規則**で数える(CLAUDE.md §1)。
   *
   * ⚠ **コメント行と空行は読まない** ── 「実行する行だけを見る」(CLAUDE.md §1
   *   の 5 度目)。job の間に置いた列 0 のコメントを本文と数えると、そこで
   *   `jobs:` を抜けたと誤読して**以降の job が丸ごと見えなくなる**。
   * ⚠ `needs:` は **inline 形**(`[a, b]`)だけを読む ── block 形へ書き換えると
   *   ここが空になるが、下の「ledger の needs に全 job が在る」が落ちて気づく。
   */
  function nightlyJobs(): NightlyJob[] {
    const lines = readFileSync(YML, 'utf-8').split('\n');
    const jobs: NightlyJob[] = [];
    let job: NightlyJob | null = null;
    let cur: NightlyStep | null = null;
    let inJobs = false;
    const closeStep = (): void => {
      if (job && cur) job.steps.push(cur);
      cur = null;
    };
    /** いま 10 字下げの続きが何のものか(`env:` / `run: |` / どちらでもない)。 */
    let block: 'env' | 'run' | null = null;
    for (const [n, line] of lines.entries()) {
      if (/^\s*(#|$)/.test(line)) continue; // コメント・空行
      if (/^jobs:\s*$/.test(line)) {
        inJobs = true;
        continue;
      }
      if (!inJobs) continue;
      if (/^\S/.test(line)) {
        closeStep();
        inJobs = false; // jobs: と同じ深さの別キーへ抜けた
        continue;
      }
      const head = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(line);
      if (head) {
        closeStep();
        job = { line: n + 1, name: head[1]!, ifExpr: '', timeout: null, needs: [], steps: [] };
        jobs.push(job);
        continue;
      }
      if (!job) continue;
      const jobKey = /^ {4}([\w-]+):(?: (.+?))?\s*$/.exec(line);
      if (jobKey) {
        const v = jobKey[2] ?? '';
        if (jobKey[1] === 'timeout-minutes') job.timeout = v;
        if (jobKey[1] === 'if') job.ifExpr = v;
        if (jobKey[1] === 'needs')
          job.needs = v
            .replace(/[[\]]/g, '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        continue;
      }
      const stepHead = /^ {6}- ([\w-]+): (.+?)\s*$/.exec(line);
      if (stepHead) {
        closeStep();
        cur = { line: n + 1, name: '', id: null, ifExpr: '', run: '', env: [] };
        block = null;
        if (stepHead[1] === 'name') cur.name = stepHead[2]!;
        if (stepHead[1] === 'id') cur.id = stepHead[2]!;
        if (stepHead[1] === 'run') {
          cur.run = stepHead[2]!;
          block = 'run';
        }
        continue;
      }
      if (!cur) continue;
      /**
       * ⚠ **8 字下げの key が来たら、続きの持ち主を切り替える**(#713)。
       *   これが無いと `env:` の中身が `run: |` の本体として読まれ、
       *   直後の `run:` 行に**上書きされて消える**。
       */
      const key = /^ {8}([\w-]+):(.*)$/.exec(line);
      if (key) block = key[1] === 'env' ? 'env' : key[1] === 'run' ? 'run' : null;
      const name = /^ {8}name: (.+?)\s*$/.exec(line);
      if (name) cur.name = name[1]!;
      const id = /^ {8}id: (\S+)\s*$/.exec(line);
      if (id) cur.id = id[1]!;
      const ifExpr = /^ {8}if: (.+?)\s*$/.exec(line);
      if (ifExpr) cur.ifExpr = ifExpr[1]!;
      const run = /^ {8}run: (.+?)\s*$/.exec(line);
      if (run) cur.run = run[1]!;
      if (/^ {10}\S/.test(line) && block === 'env') cur.env.push(line.trim());
      else if (/^ {10}\S/.test(line) && block === 'run') cur.run += `\n${line.trim()}`;
    }
    closeStep();
    return jobs;
  }

  const jobs = nightlyJobs();
  const allSteps = jobs.flatMap((j) => j.steps.map((s) => ({ ...s, job: j.name })));
  const ledger = jobs.find((j) =>
    j.steps.some((s) => s.run.includes('scripts/nightly-red.mjs')),
  );

  it('🔴 切り出しが job を取りこぼしていない(素の grep と件数が一致する)', () => {
    // ⚠ 空振り防止は**別の(緩い)規則**で数える ── 切り出しと同じ regex で数えると
    //    「見えていない job」がある状態でも必ず一致してしまう
    const lines = readFileSync(YML, 'utf-8').split('\n');
    const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
    expect(start, '`jobs:` が無い').toBeGreaterThan(-1);
    const raw = lines
      .slice(start + 1)
      .filter((l) => /^ {2}\S+:\s*$/.test(l) && !/^\s*#/.test(l)).length;
    expect(raw, 'job を 1 つも見つけられていない').toBeGreaterThanOrEqual(5);
    expect(jobs.length).toBe(raw);
  });

  it('🔴 切り出しが step を取りこぼしていない(素の grep と件数が一致する)', () => {
    const raw = readFileSync(YML, 'utf-8')
      .split('\n')
      .filter((l) => /^ {6}- \S/.test(l)).length;
    expect(raw).toBeGreaterThan(15);
    expect(allSteps.length).toBe(raw);
  });

  it('🔴 全 step が id を持つ', () => {
    // ⚠ 台帳が読むのは **job の結果**になった(#695)が、id はまだ 2 つの役に立つ:
    //    ① `setup_ok` の gate は `steps` context を読むので、id が無いと成立しない
    //    ② run を開いた人が step を名前で指せる
    const offenders = allSteps
      .filter((s) => !s.id)
      .map((s) => `${YML}:${s.line} ${s.job} / ${s.name || s.run}`);
    expect(offenders).toEqual([]);
  });

  it('🔴 各 job に timeout-minutes が在り、15 分を超えない', () => {
    // 🚫 **上げて誤魔化さない**(user 指示 2026-07-30「CI を長くしない」)──
    //    #695 の直しは「30 分の門を上げる」ではなく「並べて 15 分に収める」である。
    //    ⚠ 門を伸ばすと tripwire が鈍り、次に本当に遅くなった晩に鳴らない。
    const missing = jobs.filter((j) => !j.timeout).map((j) => `${YML}:${j.line} ${j.name}`);
    expect(missing, 'timeout-minutes を持たない job が在る').toEqual([]);
    const tooLong = jobs
      .filter((j) => Number(j.timeout) > 15)
      .map((j) => `${YML}:${j.line} ${j.name} = ${j.timeout}`);
    expect(tooLong, 'timeout を伸ばして誤魔化している').toEqual([]);
  });

  it('🔴 probe の step は全部「前が落ちても走る」(13 晩 skip された形を止める)', () => {
    const probes = allSteps.filter((s) => s.name.startsWith('Probe —'));
    // 空振り防止 ── probe を 1 つも見つけられていないなら検査になっていない
    expect(probes.length, 'probe の step を見つけられていない').toBeGreaterThanOrEqual(5);
    const offenders = probes
      .filter((s) => !s.ifExpr.includes(GUARD))
      .map((s) => `${YML}:${s.line} ${s.name}`);
    expect(offenders).toEqual([]);
  });

  it('🔴 仕込みの gate を持つ job では、後ろの step が全部 guard を持つ', () => {
    // 🔑 検証 step が 2 本以上ある job は、1 本落ちても残りを走らせる(#221)。
    //    ⚠ ただし**仕込みが落ちた晩は走らせない** ── 走らせても「確かめていない」を
    //    「落ちた」と読ませるだけで、本当の原因(npm ci)が名前で出なくなる。
    const gated = jobs.filter((j) => j.steps.some((s) => s.id === 'setup_ok'));
    expect(gated.length, '仕込みの gate を持つ job が 1 つも無い').toBeGreaterThanOrEqual(1);
    for (const j of gated) {
      const at = j.steps.findIndex((s) => s.id === 'setup_ok');
      const after = j.steps.slice(at + 1);
      expect(after.length, `${j.name}: gate の後ろに step が無い`).toBeGreaterThan(0);
      const noGuard = after
        .filter((s) => !s.ifExpr.includes(GUARD))
        .map((s) => `${YML}:${s.line} ${j.name} / ${s.name}`);
      expect(noGuard, 'guard を持たない step が gate の後ろに在る').toEqual([]);
      const noSetupGate = after
        .filter((s) => !s.ifExpr.includes(SETUP_GATE))
        .map((s) => `${YML}:${s.line} ${j.name} / ${s.name}`);
      expect(noSetupGate, '仕込みが落ちても走ってしまう検証 step が在る').toEqual([]);
    }
  });

  it('🔴 台帳の job は、検証 job を 1 つ残らず needs に持つ', () => {
    expect(ledger, '夜の結果を台帳へ出す job が無い').toBeDefined();
    const others = jobs
      .filter((j) => j.name !== ledger!.name)
      .map((j) => j.name)
      .sort();
    // 空振り防止 ── 検証 job を 1 つも見つけられていないなら検査になっていない
    expect(others.length, '検証 job を見つけられていない').toBeGreaterThanOrEqual(4);
    // 🔴 needs から漏れた job の赤は**永久に台帳へ出ない**(step 版の
    //    「台帳は最後に置く」と同じ罠)。集合で突き合わせる ── 件数だけだと
    //    1 つ足して 1 つ落とす取り違えが通る
    expect([...ledger!.needs].sort(), 'needs と検証 job が食い違っている').toEqual(others);
  });

  it('🔴 台帳の job は cancel の晩も走り、判定を workflow に書いていない', () => {
    // 🔴 `!cancelled()` ではなく `always()` ── job が timeout で切られると
    //    **その job は cancelled** になるので、`!cancelled()` だと台帳ごと skip され、
    //    **いちばん記録が要る晩に何も書かない**(#695 の当の症状)
    expect(ledger!.ifExpr, '台帳が cancel の晩に skip される').toContain('always()');
    expect(ledger!.ifExpr, '台帳が cancel の晩に skip される').not.toContain(GUARD);
    const yml = readFileSync(YML, 'utf-8');
    // 🔴 渡すのは **needs**(job の結果)── `steps` に戻すと、台帳 job は
    //    **自分の step しか見えない**ので「毎晩 ✅ 全部緑」になる
    expect(yml, 'needs を渡していない').toContain('PKC3_NIGHTLY_STEPS: ${{ toJSON(needs) }}');
    expect(yml, 'steps を渡す形へ戻っている').not.toContain('toJSON(steps)');
    // 🔴 何を赤と数えるかは script 側(test が通る側)に置く ── workflow に
    //    `result === "failure"` と書くと、skipped / cancelled を緑と読む判定が
    //    **誰にも守られない**
    const run = ledger!.steps.find((s) => s.run.includes('scripts/nightly-red.mjs'))!.run;
    expect(run, '判定が workflow の中に書かれている').not.toContain('outcome');
    expect(run, '判定が workflow の中に書かれている').not.toContain('result');
    // ⚠ 権限が無いと API が 403 を返す ── script は例外で落ちるので静かではないが、
    //   「毎晩 1 つ余計に赤い job」が常態化する。宣言のほうを縛る
    const perms = /^permissions:\n((?:[ #].*\n)+)/m.exec(yml);
    expect(perms, 'permissions が読めない').not.toBeNull();
    expect(perms![1], 'issues: write が無い').toContain('issues: write');
  });

  /**
   * 🔴 **環境変数でしか走らない検査は、渡していることを pin する**(#713、2026-09-05)。
   *
   * `tests/smoke/mermaid-all.smoke.spec.ts` は `PKC3_HEAVY=1` のときだけ走る
   * (22 種を焼くのは重いので PR gate に載せない)。⚠ ところが
   * **その環境変数を落としても、落ちる検査が 1 つも無かった** ── PR gate では
   * `test.skip` になって緑、夜は step が走るだけで中身は 0 件、という形になる。
   * ⚠ 「走らなかった」は「確かめていない」であって緑ではない
   * (CLAUDE.md「skipped も赤に数える」)。
   *
   * 🔑 だから**渡している側**を等値で留める ── 3 つで 1 組:
   *   ① `env` に `PKC3_HEAVY: '1'` が在る ② その step が **その spec を名指し**して
   *   いる ③ **spec 側が読む名前と同じ綴り**である(片方だけ改名したら落ちる)。
   * ⚠ ③ が無いと、`PKC3_HEAVY` を `PKC3_HEAVY2` に改名しても両方緑のまま
   *   すれ違う(CLAUDE.md §7「両端が別々に緑」)。
   */
  it('🔴 重い焼きの step が `PKC3_HEAVY=1` を渡し、spec が同じ名前を読む (#713)', () => {
    const heavy = allSteps.find((s) => s.run.includes('mermaid-all.smoke.spec.ts'));
    expect(heavy, '22 種を焼く step が nightly に無い').toBeDefined();
    expect(heavy!.env, `${YML}:${heavy!.line} が PKC3_HEAVY を渡していない`).toContain(
      "PKC3_HEAVY: '1'",
    );
    // ⚠ 空振り防止 ── `env` を 1 行も採れていないなら、上の toContain は
    //    「採り方が壊れた」だけで落ちる。採れていることを別に見る
    expect(heavy!.env.length, 'env を 1 行も採れていない(切り出しが壊れている)').toBeGreaterThan(
      0,
    );
    // ③ spec 側の綴りと突き合わせる(片方だけ改名したら、ここで落ちる)
    const spec = readFileSync('tests/smoke/mermaid-all.smoke.spec.ts', 'utf-8');
    expect(spec, 'spec が PKC3_HEAVY を読んでいない').toContain("process.env['PKC3_HEAVY']");
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
      /**
       * 🔴 **テンプレートを建てる指示が消えていない**(#591)。
       *
       * ⚠ 渡さないと、上流の `configure.ac:3634-3639` が iOS / Android / **Emscripten** で
       *   `WITH_TEMPLATES` を空にし、`extras/Package_tplpresnt.mk` は `else` 側の
       *   `gb_Package_add_empty_directory` だけを走らせる ──
       *   🔑 **フォルダは作られて中身が 0 件**になり、Impress の「Select a Template」が
       *   **空の一覧**を出す(それが #591 の症状だった)。
       * ⚠ **消えても焼きは通る**(make は止まらない)ので、鳴る計器はここしか無い。
       * ⚠ **heredoc の中だけ**を見る ── file 全体で探すと、上の解説コメントに満たされる。
       */
      expect(conf?.[1], 'テンプレートを建てる --with-templates=yes が消えている').toContain(
        '--with-templates=yes',
      );
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

/**
 * 🔴 **PR gate は 2 job のまま**(2026-08-18)。
 *
 * ⚠ 直す前は smoke が `verify` に同居しており、`playwright install --with-deps` が
 * **22 秒 / 291 秒 / 390 秒**(3 回測った)とぶれるせいで、**10 分の speed budget を
 * 2 度踏んで job ごと cancel** された ── 緑だったはずの PR が赤に見えた。
 * 🔑 守る主張は「**遅い install が速い lane の budget を食わない**」なので、
 *   検査も**その形**で書く(job 数だけ数えても、install が verify に戻れば素通りする)。
 */
describe('PR gate の形(2026-08-18)', () => {
  /**
   * ⚠ **コメントを落としてから見る**(1 稿目で踏んだ)。job の切り出しは
   * 「次の job の見出しまで」なので、**次の job の直前に置いた解説コメント**が
   * 前の job の本文に入る ── そこに `playwright install` と書いてあるだけで
   * 「速い lane に戻っている」と判定していた(CLAUDE.md §1「注釈が検査を満たす」)。
   */
  const codeOnly = (text: string): string =>
    text
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
  const CI = codeOnly(readFileSync(join(DIR, 'ci.yml'), 'utf8'));
  /** job 名 → その job の本文(次の job の見出しまで)。 */
  const jobsOf = (text: string): Map<string, string> => {
    const body = text.slice(text.indexOf('\njobs:'));
    const out = new Map<string, string>();
    const re = /\n {2}([A-Za-z0-9_-]+):\n/g;
    const heads = [...body.matchAll(re)];
    for (let i = 0; i < heads.length; i += 1) {
      const start = heads[i]!.index! + heads[i]![0].length;
      const end = i + 1 < heads.length ? heads[i + 1]!.index! : body.length;
      out.set(heads[i]![1]!, body.slice(start, end));
    }
    return out;
  };

  it('🔴 遅い `playwright install` は smoke 側だけに在る(速い lane の budget を食わない)', () => {
    const jobs = jobsOf(CI);
    // 空振り防止 ── 切り出しが壊れて 1 job も取れていない形で「一致 0 件」と言わない
    /**
     * ⚠ **`audit` を足した**(2026-09-04)── registry が遅い日に 2 分 05 秒を食い、
     *   `npm ci` の 5 分と合わせて `verify` の 10 分を使い切っていた。
     *   🔑 分けると並列に走るので**壁時計は伸びず**、赤が出たときに
     *   「依存の話か、コードの話か」が **job の名前で分かる**(1 job = 1 主張)。
     */
    expect([...jobs.keys()], 'job の切り出しが壊れている').toEqual([
      'audit',
      'verify',
      'smoke',
    ]);
    expect(jobs.get('smoke'), 'smoke に install が無い').toContain('playwright install');
    expect(jobs.get('verify'), '遅い install が速い lane へ戻っている').not.toContain(
      'playwright install',
    );
    expect(jobs.get('verify'), 'smoke が速い lane へ戻っている').not.toContain('test:smoke');
  });

  /**
   * 🔴 **shard は「全部で 1 つ」でなければならない**(2026-08-28)。
   *
   * ⚠ 2026-08-19 の cancel は `playwright install` が遅い回だったが、
   *   **2026-08-28 の cancel は smoke 本体**だった(install 30 秒 /
   *   smoke 9 分 25 秒 → 10 分の job timeout)。⚠ **再実行では直らない**ので、
   *   2 つの runner に割って並べた。
   *
   * 🔑 守る主張は「**割っても 1 件も減らない**」である ── ⚠ 数字がずれると
   *   **落ちた test が誰にも走らないまま緑になる**(いちばん質の悪い形):
   *   `shard: [1]` に減らす / `--shard=1/3` にする / 片方の行を消す。
   * ⚠ **`n/N` の N と、matrix の個数が一致していること**まで見る ──
   *   片方だけ直すのがまさに事故の形である。
   */
  it('🔴 smoke の shard は、全部合わせて全量になる', () => {
    const jobs = jobsOf(CI);
    const smoke = jobs.get('smoke') ?? '';
    // 空振り防止 ── job が取れていない形で「一致した」と言わない
    expect(smoke, 'smoke の本文が取れていない').toContain('test:smoke');

    const list = /shard:\s*\[([^\]]+)\]/.exec(smoke);
    expect(list, 'matrix.shard の一覧が無い(割るのをやめた?)').not.toBeNull();
    const shards = list![1]!.split(',').map((x) => Number(x.trim()));
    expect(shards, 'shard の番号が数字でない').not.toContain(NaN);

    const uses = [...smoke.matchAll(/--shard=\$\{\{\s*matrix\.shard\s*\}\}\/(\d+)/g)];
    expect(uses.length, '`--shard=${{ matrix.shard }}/N` が 1 か所に無い').toBe(1);
    const total = Number(uses[0]![1]);

    // 🔴 ここが本題:matrix の個数 = 分母
    expect(shards.length, `matrix は ${shards.length} 個なのに分母は ${total}`).toBe(total);
    // ⚠ 番号は 1..N が 1 つずつ(重複・抜けを落とす)
    expect([...shards].sort((a, b) => a - b)).toEqual(
      Array.from({ length: total }, (_, i) => i + 1),
    );

    // ⚠ 片方が落ちても**もう片方を最後まで走らせる**(走らなかった shard は
    //    「確かめていない」であって「緑」ではない ── 2026-08-17 の nightly)
    expect(smoke, 'fail-fast を切っていない(片方が落ちたら残りが走らない)').toContain(
      'fail-fast: false',
    );
    // ⚠ tripwire は残す(割ったのは budget を上げないためである)
    expect(smoke, '速度予算の tripwire が消えている').toContain('timeout-minutes: 10');
  });

  it('🔴 2 つは並列(直列にすると budget の問題が解けない)', () => {
    const jobs = jobsOf(CI);
    for (const [name, body] of jobs) {
      expect(body, `${name} に needs が付いている(直列になっている)`).not.toContain('needs:');
      expect(body, `${name} に速度予算の tripwire が無い`).toContain('timeout-minutes: 10');
    }
  });
});

/**
 * 🔴 **可搬単一 HTML の雛形は「検品の後」に足す**(#400 段④)。
 *
 * ⚠ `dist` の中に混ぜると 🔴 **SW の precache に載る** ── 一覧は build 時に
 *   作られるので、build の後に置けば載らないが、build の中に入れると
 *   **全 user が 7 MB を先に落とす**(設計 doc が名指しで戒めている)。
 *
 * 🔑 だから見るのは「在るか」ではなく **順番**である。
 *
 * 🔴 **ただし順番だけでは足りなかった**(2026-08-29、本番配布を止めて分かった)。
 * ⚠ ここには「検品の主張が 6.5 MB ぶんずれる」も理由として書いてあったが、
 *   **それは順番では守れない** ── `release.yml` は自分の検品の後に雛形を zip へ
 *   足し、`pages.yml` は**その zip を展開して検品する**ので、v3.2.0 の配布が
 *   落ちた(run 33256868235)。いまは検品の規則(`scripts/dist-inspect.mjs`)が
 *   雛形を名前で知り、**別立ての予算**で見る(`tests/dist-inspect.test.ts`)。
 * 🔑 教訓:**「順番で守っている」と書いたら、その順番を守れない読み手が
 *   居ないかを数える**(ここでは「zip を展開して検品する側」が居た)。
 * ⚠ そして**両方の配り先**を見る ── 片方だけだと
 *   「dev では書き出せるのに本番では 404」という、いちばん気づけない形になる。
 */
/**
 * 🔴 **焼きたての product だけ `manual.html` の実在を要求する**(#648 💭)。
 *
 * ⚠ `release.yml` / `nightly.yml` は build 直後の dist を検品する ── ここに旗が無いと、
 *   plugin が外れた版をそのまま release できる(product は PR gate が触らない別成果物)。
 * ⚠ `pages.yml` の product の検品は**過去の release の zip** ── ここに旗が付くと、
 *   段②より前の版(v3.2.0)が落ちて `/dev/` の更新まで止まる(2026-08-29 と同じ形)。
 * 🔑 見るのは**実行する行**(`check-dist.mjs product` を含む行)── コメントに満たされない。
 */
describe('#648 💭 ── manual.html の実在を要求する経路', () => {
  const productLines = (file: string): string[] =>
    readFileSync(join(DIR, file), 'utf-8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#') && l.includes('check-dist.mjs product'));

  for (const file of ['release.yml', 'nightly.yml']) {
    it(`${file}: 焼きたての product の検品に --require-manual が付いている`, () => {
      const lines = productLines(file);
      expect(lines, `${file} に product の検品が無い(空振り)`).toHaveLength(1);
      expect(lines[0], '旗が無い(plugin が外れた版を release できる)').toContain('--require-manual');
    });
  }

  it('pages.yml: 過去の zip の検品には付いていない(v3.2.0 を落とさない)', () => {
    const lines = productLines('pages.yml');
    expect(lines, 'pages.yml に product の検品が無い(空振り)').toHaveLength(1);
    expect(lines[0]).not.toContain('--require-manual');
  });

  it('🔴 旗の綴りが check-dist.mjs の受け口と同じ', () => {
    const cli = readFileSync('scripts/check-dist.mjs', 'utf-8');
    expect(cli).toContain("'--require-manual'");
  });
});

describe('#400 段④ ── 雛形を置く順番', () => {
  const cases = [
    { file: 'pages.yml', check: 'check-dist.mjs dev' },
    { file: 'release.yml', check: 'check-dist.mjs product' },
  ] as const;

  for (const c of cases) {
    it(`${c.file}: 検品の後に雛形を焼いて置く`, () => {
      const text = readFileSync(join(DIR, c.file), 'utf-8');
      const at = text.indexOf(c.check);
      const build = text.indexOf('npm run build:portable');
      const copy = text.indexOf('dist-portable/pkc3.html');
      // 空振り防止 ── 3 つとも実在する(消えたら 0 件ではなく -1 で落ちる)
      expect(at, `${c.check} が無い`).toBeGreaterThanOrEqual(0);
      expect(build, '雛形を焼く step が無い').toBeGreaterThanOrEqual(0);
      expect(copy, '雛形を置く行が無い').toBeGreaterThanOrEqual(0);
      expect(build, '🔴 検品の前に雛形を焼いている').toBeGreaterThan(at);
      expect(copy, '焼く前に置こうとしている').toBeGreaterThan(build);
    });
  }

  it('🔴 置き先の名前は、アプリが取りに行く名前と同じ', () => {
    // ⚠ 名前が食い違うと、押しても **404 で「書き出せません」**になる ──
    //   しかも CI は緑のままなので、user の報告でしか分からない
    const app = readFileSync('src/main.ts', 'utf-8');
    expect(app, 'アプリが雛形を取りに行っていない').toContain("'portable-template.html'");
    for (const f of ['pages.yml', 'release.yml'])
      expect(readFileSync(join(DIR, f), 'utf-8'), `${f} が別の名前で置いている`).toContain(
        'portable-template.html',
      );
  });

  /**
   * 🔴 **step の名前が、YAML のコメントで切られていない**(2026-08-29 に踏んだ)。
   *
   * ⚠ YAML は**空白の後の `#`** から先を捨てる。だから
   *   `name: 検品(テンプレートが配られたか / #591)` は
   *   **「検品(テンプレートが配られたか /」で切れる** ── CI の画面には
   *   宙ぶらりんの名前だけが出て、**issue 番号が読み手に届かない**。
   * 🔑 この repo の作法は「**読み手に渡す識別子は、渡す前に実在と中身を確かめる**」で、
   *   番号が消える形はそこに当たる。
   *
   * ⚠ **YAML の parser を足さない**(この repo に dep は無い)── 規則そのものを見る:
   *   **引用符で囲っていない値**の中に ` #` が在れば、そこから先は落ちる。
   *   🔑 直し方は 1 つ、**値を引用符で囲む**こと。
   */
  it('🔴 step の名前が YAML のコメントで切れていない', () => {
    const bad: string[] = [];
    let seen = 0;
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.yml'))) {
      for (const line of readFileSync(join(DIR, file), 'utf-8').split('\n')) {
        const m = /^\s*(?:- )?name:\s*(.*)$/.exec(line);
        if (m === null) continue;
        const v = (m[1] ?? '').trim();
        if (v === '') continue;
        seen += 1;
        // ⚠ 引用符で囲ってあれば `#` は落ちない ── 対象外
        if (/^['"]/.test(v)) continue;
        if (/\s#/.test(v)) bad.push(`${file}: ${line.trim()}`);
      }
    }
    // ⚠ 空振り防止 ── name の行を本当に読めている
    expect(seen, 'name の行が 1 つも読めていない(台の空振り)').toBeGreaterThan(10);
    expect(
      bad,
      'YAML のコメントで名前が切れる ── 値を引用符で囲む(#591 の step で実際に踏んだ)',
    ).toEqual([]);
  });
});
