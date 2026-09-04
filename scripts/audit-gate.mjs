#!/usr/bin/env node
/**
 * 依存の脆弱性の門(#675 で 3 回続けて落ちた `npm audit` の置き換え)。
 *
 * 🔴 **落ちた理由が「脆弱がある」ではなかった。** 2026-09-03〜04 の 3 回とも、
 * 実体は registry 側の停止である:
 *
 *   npm warn audit 503 Service Unavailable - POST
 *     https://registry.npmjs.org/-/npm/v1/security/advisories/bulk
 *   npm error audit endpoint returned an error
 *
 * ⚠ 素の `npm audit --audit-level=high` は、この 2 つを**同じ exit 1** で返す ──
 * つまり門の赤は「**脆弱がある**」とも「**確かめられなかった**」とも読める。
 * どちらか分からない赤は、読み手を毎回ログまで往復させる(実際 3 回往復した)。
 *
 * 🔑 だから**判定を 3 つに割る**:
 *
 * | 読み | どうするか | なぜ |
 * |---|---|---|
 * | `ran`(数が返った) | high+critical が 1 件でもあれば**落とす** | これが本来の門 |
 * | `unreachable`(registry が答えない) | ⚠ **警告して通す** | 依存は 1 バイトも変わっていない ── PR の側に非は無い |
 * | `unreadable`(読み方が分からない) | 🔴 **落とす** | npm の出力が変わったのに黙って通すと、門ごと消える |
 *
 * 🔴 **`|| true` にしない。** それは門の撤廃である(CLAUDE.md §1「tripwire は
 * 上限だけでなく下限も置く」/ §7「除外したら、外したぶんの門を置き直す」)──
 * 見逃してよいのは「**registry がこちらに答えなかった**と名指しできた回」だけで、
 * 読めない出力は**落ちる側**に倒す(fail closed)。
 *
 * ⚠ **判定は workflow の中に書かない**(CLAUDE.md §2「どの test からも実行されない
 * file に判断を書かない」)── `readAudit` / `verdict` は純粋な関数で、
 * `tests/audit-gate.test.ts` が **3 つの読みを全部**通す。
 *
 * 使い方(`.github/workflows/ci.yml`):
 *
 *   node scripts/audit-gate.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * ⚠ 何回試すか。**2 回まで**にしてある ── 観測した 1 回の `npm audit` は
 * **5 分 0 秒**かかっており(22:36:36 → 22:41:36)、verify job の timeout は
 * 10 分である。3 回試すと**門そのものが timeout を跨ぐ**(CLAUDE.md
 * 「回すものの粒度」── 落ちたときに原因が名前で分かる形にする)。
 */
export const ATTEMPTS = 2;
/** 試行の間隔。⚠ 一瞬の瞬断を拾うための物で、長い停止を待つ物ではない。 */
export const RETRY_MS = 5_000;
/**
 * 1 回あたりの上限。
 *
 * 🔴 **これが無いと門が job を殺す。** 落ちた run の verify は
 * `npm ci` 4 分 + `npm audit` 5 分 = **9 分 16 秒**で、job の timeout は **10 分**
 * だった ── つまり素の `npm audit` は**既に余裕を食い切っていた**。
 * ⚠ 手元(この箱)では registry へ届かず **無反応のまま帰ってこない**ので、
 *   上限が無ければ 2 回目で永久に待つ(実測)。
 */
export const ATTEMPT_TIMEOUT_MS = 60_000;
/**
 * npm 自身の再試行を短くする。⚠ 既定(`--fetch-retries=2`・最大 60 秒)のままだと
 * 1 回で 5 分溶ける ── 上の ATTEMPTS の理由と同じ。
 */
export const NPM_ARGS = [
  'audit',
  '--json',
  '--omit=dev',
  '--fetch-retries=1',
  '--fetch-retry-mintimeout=2000',
  '--fetch-retry-maxtimeout=10000',
];

/**
 * registry が答えなかったと**名指しできる**印。
 *
 * ⚠ ここに書いていない error は `unreadable` = 落とす。**広く拾わない** ──
 * 広げるほど「本当の不合格を見逃す」側へ倒れる(CLAUDE.md §1「範囲が広すぎて
 * 無関係な散文に満たされる」の逆向きの顔である)。
 */
const UNREACHABLE = [
  /\b5\d\d\b/, // 500 / 502 / 503 / 504
  /audit endpoint returned an error/i,
  /\bE(NOTFOUND|AI_AGAIN|CONNRESET|CONNREFUSED|TIMEDOUT|HOSTUNREACH|NETUNREACH)\b/,
  /\bENETDOWN\b/,
  /request to .* failed/i,
  /socket hang up/i,
];

/**
 * `npm audit --json` の**標準出力**を読む。
 *
 * @param {string} stdout
 * @returns {{kind:'ran',high:number,critical:number}
 *          |{kind:'unreachable',why:string}
 *          |{kind:'unreadable',why:string}}
 */
export function readAudit(stdout) {
  const text = typeof stdout === 'string' ? stdout.trim() : '';
  if (text === '') return { kind: 'unreadable', why: '出力が空です' };
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { kind: 'unreadable', why: 'JSON として読めません' };
  }
  if (doc === null || typeof doc !== 'object') {
    return { kind: 'unreadable', why: 'JSON の中身が object ではありません' };
  }
  const counts = doc.metadata?.vulnerabilities;
  if (counts !== undefined && counts !== null && typeof counts === 'object') {
    const high = Number(counts.high ?? 0);
    const critical = Number(counts.critical ?? 0);
    if (!Number.isFinite(high) || !Number.isFinite(critical)) {
      return { kind: 'unreadable', why: '件数が数ではありません' };
    }
    return { kind: 'ran', high, critical };
  }
  if (doc.error !== undefined && doc.error !== null) {
    const why = [doc.error.code, doc.error.summary, doc.error.detail]
      .filter((s) => typeof s === 'string' && s !== '')
      .join(' ')
      .trim();
    // ⚠ **空にしない** ── 空の理由は「読めない」と見分けが付かず、
    //    実際この箱で `(理由が書かれていません)` としか出ずに 1 往復した。
    const said = why === '' ? safeJson(doc.error) : why;
    return UNREACHABLE.some((re) => re.test(said))
      ? { kind: 'unreachable', why: said }
      : { kind: 'unreadable', why: said };
  }
  return { kind: 'unreadable', why: '件数も error も入っていません' };
}

/**
 * 試した結果の並びから、門の答えを出す。**最後の読みで決める**。
 *
 * ⚠ 途中で `unreachable` を挟んでも、最後に `ran` が返れば**それが答え**である
 * (瞬断のあとに繋がった回)。
 *
 * @param {ReadonlyArray<ReturnType<typeof readAudit>>} reads
 * @returns {{pass:boolean, level:'ok'|'warning'|'error', message:string}}
 */
export function verdict(reads) {
  const last = reads.length === 0 ? null : reads[reads.length - 1];
  if (last === null) {
    return { pass: false, level: 'error', message: '一度も audit を走らせていません' };
  }
  if (last.kind === 'ran') {
    const bad = last.high + last.critical;
    return bad === 0
      ? { pass: true, level: 'ok', message: `依存の脆弱性 high 以上は 0 件でした(${reads.length} 回目で通じました)` }
      : {
          pass: false,
          level: 'error',
          message: `依存に high 以上の脆弱性が ${bad} 件あります(critical ${last.critical} / high ${last.high})── npm audit fix か依存の更新が要ります`,
        };
  }
  if (last.kind === 'unreachable') {
    return {
      pass: true,
      level: 'warning',
      message:
        `npm の advisory endpoint が答えませんでした(${reads.length} 回試しました)── ` +
        `**脆弱性は確かめられていません**(依存は変わっていないので、この PR の非ではありません)。理由: ${last.why}`,
    };
  }
  return {
    pass: false,
    level: 'error',
    message:
      `npm audit の出力が読めませんでした ── 門が空振りしていないか scripts/audit-gate.mjs を見てください。理由: ${last.why}`,
  };
}

/**
 * `spawnSync` の結果を読みに掛ける。
 *
 * ⚠ **時間切れは `unreachable`** ── registry が答えなかったのと同じ状態で、
 *   npm の出力が壊れているわけではない(`unreadable` に混ぜると、停止のたびに
 *   「門が空振りしていないか見てください」という**的外れな指示**が出る)。
 *
 * @param {{error?:unknown, signal?:string|null, stdout?:string|null}} run
 */
export function readRun(run) {
  const err = run.error;
  if (err !== undefined && err !== null) {
    const code = String(err.code ?? '');
    if (code === 'ETIMEDOUT' || run.signal === 'SIGTERM') {
      return { kind: 'unreachable', why: `npm audit が ${ATTEMPT_TIMEOUT_MS / 1000} 秒で答えませんでした` };
    }
    return { kind: 'unreadable', why: `npm を起動できません: ${String(err.message ?? err)}` };
  }
  return readAudit(run.stdout ?? '');
}

/** GitHub Actions の注記。⚠ 素の環境では前置きだけ落として読める形にする。 */
export function annotate(level, message) {
  if (level === 'ok') return message;
  return `::${level}::${message}`;
}

/** ⚠ 円環参照や巨大な object でも落ちない形にする(理由を作るためだけの物)。 */
function safeJson(value) {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' && text !== '' ? text.slice(0, 300) : String(value);
  } catch {
    return String(value);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function main() {
  /** @type {Array<ReturnType<typeof readAudit>>} */
  const reads = [];
  for (let i = 0; i < ATTEMPTS; i++) {
    if (i > 0) sleep(RETRY_MS);
    const run = spawnSync('npm', NPM_ARGS, {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: ATTEMPT_TIMEOUT_MS,
    });
    const read = readRun(run);
    reads.push(read);
    if (read.kind === 'ran') break;
    process.stderr.write(`audit-gate: ${i + 1} 回目は ${read.kind}(${read.why})\n`);
  }
  const out = verdict(reads);
  process.stdout.write(`${annotate(out.level, out.message)}\n`);
  process.exit(out.pass ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
