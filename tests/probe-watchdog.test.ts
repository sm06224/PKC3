/** @vitest-environment node */
/**
 * `build/office-wasm/probe-watchdog.mjs` と、**その配線**を検める(#624)。
 *
 * ## なぜ要るか
 *
 * 2026-08-30、`open-doc-probe` が **4h58m** 固まった ── renderer の CPU 時間
 * 5h00m / RSS 1.07 GB / log **0 byte**。⚠ `page.evaluate()` に既定の締切は無く、
 * 固まった `await` は**例外を投げない**ので `finally` も走らない。
 * つまり「何段目で止まったか」は**見張りだけ**が残せる。
 *
 * ## 🔴 字面ではなく**鳴らして**確かめる
 *
 * ⚠ 「`timer.unref()` が書いてある」は、効いている証拠ではない
 * (CLAUDE.md §1「これが無いと壊れると書いたら、外して壊れるのを見る」)。
 * 🔑 だから **node を起こして 2 通り**走らせる:
 *
 * | 腕 | 仕掛け | 期待 |
 * |---|---|---|
 * | **B** | `disarm()` を書き忘れ + 仕事は即終わる | 素通りして `exit 0`・**JSON を書かない** |
 * | **C** | 固まる(参照つき handle が居る) | 締切で `exit 2`・**段の名前**が出る |
 *
 * ⚠ B が無いと「見張りが良い出力の上に偽の時間切れを書く」事故を検出できない
 * (実測: `unref()` の前は 3 秒の締切で `elapsedMs: 3003` を**上書き**していた)。
 * ⚠ C が無いと「unref したら発火しなくなった」を検出できない ── **対である**。
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { codeOnly } from './helpers/code-only';

const DIR = 'build/office-wasm';
const MODULE = resolve(`${DIR}/probe-watchdog.mjs`);

/**
 * 🔴 **見張りを掛ける probe の等値リスト**(#624)。
 *
 * ⚠ **件数ではなく身元で pin する** ── 同じ数だけ取り違えても件数は合う
 * (CLAUDE.md §8「集合で突き合わせる」)。
 * 🔑 新しい probe を足したら**ここも足す**(足さないと落ちる)= 忘れられない。
 */
const WATCHED = [
  'boot-probe.mjs',
  'combo-popup-probe.mjs',
  'convert-to-probe.mjs',
  'dialog-crash-probe.mjs',
  'ime-probe.mjs',
  'io-layer-probe.mjs',
  'ja-typography-probe.mjs',
  'office-real-path-probe.mjs',
  'open-doc-probe.mjs',
  'options-pane-probe.mjs',
  'save-existing-probe.mjs',
  'sidebar-deadclick-probe.mjs',
  'steady-probe.mjs',
  'window-reclaim-probe.mjs',
];

/** ⚠ **コメントを落としてから**探す ── 注釈が検査を満たすと、配線を消しても緑になる。 */
const codeOf = (f: string): string => codeOnly(readFileSync(join(DIR, f), 'utf-8'));

/** ブラウザを起こす probe か(= 締切が要る相手か)。 */
const launches = (f: string): boolean => codeOf(f).includes('chromium.launchPersistentContext(');

describe('probe の締切 ── 誰に掛かっているか', () => {
  it('ブラウザを起こす probe の集合が、等値リストと一致する', () => {
    const found = readdirSync(DIR)
      .filter((f) => f.endsWith('.mjs'))
      .filter(launches)
      .sort();
    expect(found).toEqual([...WATCHED].sort());
  });

  it.each(WATCHED)('%s に見張りが掛かっている', (f) => {
    const src = codeOf(f);
    expect(src).toContain('armWatchdog(');
    // 🔑 **閉じる相手を渡している**ことまで見る ── 渡していないと chrome が残る
    expect(src).toContain('browser: () =>');
  });

  it('🔴 空振り防止: 注釈の中の綴りは拾わない', () => {
    // ⚠ この検査そのものが「コメントを落とせているか」を見る ──
    //    落とせていなければ、配線を消してコメントに残すだけで上の検査が通る
    const commentOnly = '/* armWatchdog( chromium.launchPersistentContext( */\nconst x = 1;\n';
    expect(codeOnly(commentOnly)).not.toContain('armWatchdog(');
    expect(codeOnly(commentOnly)).not.toContain('launchPersistentContext(');
  });
});

/** 🔑 使い捨ての script を書いて node を起こす(**実際に鳴らす**)。 */
function run(body: string, out: string | null): { code: number | null; err: string; json: string | null } {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-wd-'));
  const js = join(dir, 'arm.mjs');
  const jsonPath = out === null ? '' : join(dir, out);
  writeFileSync(js, body.replace('__MODULE__', MODULE).replace('__OUT__', jsonPath), 'utf-8');
  try {
    // ⚠ `stdio` を明示する(#558)── 書かないと子の stderr が画面へ漏れる。
    //   ここは `stderr` を読むので **`pipe`**(捨てるのではなく受け取る)。
    const r = spawnSync(process.execPath, [js], { encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 });
    return {
      code: r.status,
      err: r.stderr ?? '',
      json: jsonPath !== '' && existsSync(jsonPath) ? readFileSync(jsonPath, 'utf-8') : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('probe の締切 ── 鳴らして確かめる', () => {
  it('腕 B: disarm を書き忘れても、仕事が終われば素通りする', () => {
    const r = run(
      `import { armWatchdog } from '__MODULE__';
       armWatchdog({ result: {}, out: '__OUT__', limitSec: 1, browser: () => null });
       // ⚠ disarm を**わざと呼ばない**
      `,
      'b.json',
    );
    expect(r.code).toBe(0);
    // 🔴 いちばん大事な一行 ── 偽の「時間切れ」を書いていないこと
    expect(r.json).toBeNull();
    expect(r.err).toBe('');
  }, 30_000);

  it('腕 C: 固まったら締切で落ち、止まった段の名前が出る', () => {
    const r = run(
      `import { armWatchdog } from '__MODULE__';
       const wd = armWatchdog({ result: { arm: 'C' }, out: '__OUT__', limitSec: 1, browser: () => null });
       wd.mark('固まる段');
       // ⚠ 参照つきの handle(実物では browser の socket)が event loop を生かす
       await new Promise((r) => setTimeout(r, 60000));
      `,
      'c.json',
    );
    expect(r.code).toBe(2);
    expect(r.json).not.toBeNull();
    const j = JSON.parse(r.json ?? '{}') as { timedOut?: boolean; timedOutPhase?: string; arm?: string };
    expect(j.timedOut).toBe(true);
    // 🔑 **名前で言える**ことが見張りの仕事である(「落ちた」だけでは足りない)
    expect(j.timedOutPhase).toBe('固まる段');
    // ⚠ probe が書き溜めていた分も残る
    expect(j.arm).toBe('C');
  }, 30_000);
});
