#!/usr/bin/env node
/**
 * 夜が赤いことを**台帳に出す**(#221、2026-08-17)。
 *
 * 🔴 直すまで、Nightly は **2026-08-04 から 13 晩**赤かったのに誰も気づかなかった。
 * PR gate は緑なので、**こちらの計器は 1 つも鳴らない** ── 気づく導線が
 * 「たまたま Actions を開く」しか無かったのが原因である。
 *
 * 🔑 **やることは issue に置く**(user 指示 2026-08-15「ファイルをただ置いておくのは
 * やめろ」)。だから赤くなったら issue を 1 本立て、赤い間はそこへ積み、
 * **緑に戻ったら閉じる**。⚠ 夜ごとに新しい issue を立てない(台帳が埋まる)。
 *
 * 入力は workflow の `toJSON(needs)`(job を割る前は `toJSON(steps)`)を素通しした
 * `PKC3_NIGHTLY_STEPS`:
 *
 *   PKC3_NIGHTLY_STEPS='{"rust_and_probes":{"result":"failure"}}' node scripts/nightly-red.mjs
 *   PKC3_NIGHTLY_STEPS='{"probe_sidebar":{"outcome":"failure"}}' node scripts/nightly-red.mjs
 *
 * ⚠ 規則の本体(**どれを赤と数えるか** / どの API をどう叩くか)は
 *   `unmetSteps` と `reconcileNightlyIssue` に閉じてあり、`tests/nightly-red.test.ts` が
 *   偽の `fetch` で全経路を走らせる ──「どの test からも実行されない file に判断を
 *   書かない」(CLAUDE.md §2)。**workflow の中に判定を書かない**のが要点である。
 */
import { fileURLToPath } from 'node:url';

/** 赤い夜を束ねる 1 本の issue を指す印。 */
export const LABEL = 'nightly-red';

const API = 'https://api.github.com';

/**
 * `toJSON(needs)` / `toJSON(steps)` から **揃わなかったもの**を拾う
 * (`名前:結果` の並び)。
 *
 * 🔴 **2 つの形を受ける**(#695、2026-09-05)。job を割って台帳を `needs` で
 * 受けるようにしたとき、`needs` の各 job が持つのは `outcome` ではなく
 * **`result`** である。⚠ 直す前の実装は「`outcome` が文字列でなければ `''`」と
 * 畳んでいたので、`{smoke_chromium:{result:'failure'}}` を **`[]`(全部緑)** と
 * 読んだ ── 割った瞬間から**毎晩「✅ 全部緑」**になる、いちばん気づけない壊れ方。
 * 🔑 だから **どちらも無ければ投げる**(黙って緑にしない。CLAUDE.md §1
 * 「空を緑と読まない」と同じ向き)。
 *
 * 🔴 **`failure` だけを数えてはいけない**(2026-08-17 のレビュー 🔴-1)。
 * 初稿は workflow の中に `node -e '…v.outcome==="failure"…'` と書いていたので:
 *   ① `skipped` / `cancelled` を**緑と読む** ── 仕込みが落ちて以降が飛んだ晩に、
 *      「✅ 緑に戻りました」と報告して**開いている issue を閉じる**
 *   ② その 1 行は **どの test からも実行されない**(CLAUDE.md §2)
 * だから判定はここへ出し、下の test で全経路を通す。
 *
 * ⚠ **意図的に飛ばす step を nightly に足さないこと** ── ここでは `skipped` を
 *   「走らなかった = 主張が確かめられていない」として赤に数える。夜の検査は
 *   「全部走って全部通った」を主張する場所なので、飛んだら赤が正しい。
 *
 * @param {string | undefined} stepsJson
 * @returns {string[]} 例 `['npm_ci:failure', 'probe_sidebar:skipped']`
 */
export function unmetSteps(stepsJson) {
  let steps;
  try {
    steps = JSON.parse(stepsJson || 'null');
  } catch {
    throw new Error('STEPS が JSON として読めない ── 集計が壊れている');
  }
  if (!steps || typeof steps !== 'object' || Array.isArray(steps) || Object.keys(steps).length === 0)
    // 🔴 空を「緑」と読まない ── `needs` は張り忘れると空、`steps` に入るのは
    //    **id を宣言した step だけ**なので id を落とすと空。どちらも集計の故障で
    //    あって、良い知らせではない
    throw new Error('STEPS が空 ── needs を張っていないか、渡し忘れている');
  const bad = [];
  for (const [id, v] of Object.entries(steps)) {
    // job(`needs`)は `result`、step(`steps`)は `outcome` を持つ
    const got =
      typeof v?.result === 'string' ? v.result : typeof v?.outcome === 'string' ? v.outcome : null;
    // 🔴 どちらも無いのは**集計の故障**である ── 緑と読まない(渡す形を
    //    取り違えたときに「毎晩全部緑」になるのを、ここで止める)
    if (got === null) throw new Error(`${id} に result も outcome も無い ── 集計が壊れている`);
    // 走っている最中の step(この script 自身)は outcome が空
    if (got === '' || got === 'success') continue;
    bad.push(`${id}:${got}`);
  }
  return bad;
}

/**
 * 夜の結果に合わせて issue を 1 本だけ保つ。
 *
 * @param {object} o
 * @param {typeof globalThis.fetch} o.fetch
 * @param {string} o.repo   `owner/name`
 * @param {string} o.token
 * @param {string[]} o.failedSteps 揃わなかった job / step の名(空 = 緑)
 * @param {string} o.runUrl この run の URL
 * @param {string} o.today  `2026-08-17`(件名に入れる)
 * @returns {Promise<{action: 'created'|'commented'|'closed'|'noop', issue: number|null}>}
 */
export async function reconcileNightlyIssue({ fetch, repo, token, failedSteps, runUrl, today }) {
  const red = failedSteps.length > 0;
  /**
   * @param {'GET'|'POST'|'PATCH'} method
   * @param {string} path
   * @param {unknown} [body]
   * @param {number[]} [allow] 失敗として扱わない status(例: label が既に在る 422)
   */
  const call = async (method, path, body, allow = []) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // ⚠ 落ちたら**黙って続けない** ── 通知が届かないことこそ、この script が
    //   直そうとしている症状である(例外は step を赤くする)。
    // 🔴 **判定と header はここ 1 か所**(2026-08-17 のレビュー ⚠-12)── label 作成だけ
    //    生の fetch で書いていたので、「落ちたら止まる」規則が 2 か所に生え、
    //    片方を消す変異が 2 件生き延びていた(authorization を落とす / 検査を消す)
    if (!res.ok && !allow.includes(res.status)) throw new Error(`${method} ${path} → ${res.status}`);
    return res.json();
  };

  const list = await call(
    'GET',
    `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(LABEL)}&per_page=10`,
  );
  // ⚠ issues API は **PR も返す** ── 混ざると PR にコメントし始める
  const openIssue = (Array.isArray(list) ? list : []).find((i) => !i.pull_request) ?? null;

  if (!red) {
    if (!openIssue) return { action: 'noop', issue: null };
    await call('POST', `/repos/${repo}/issues/${openIssue.number}/comments`, {
      body: `✅ 夜が緑に戻りました(${today})。\n\n${runUrl}\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_`,
    });
    await call('PATCH', `/repos/${repo}/issues/${openIssue.number}`, {
      state: 'closed',
      state_reason: 'completed',
    });
    return { action: 'closed', issue: openIssue.number };
  }

  const steps = failedSteps.map((s) => `- ${s}`).join('\n');
  if (openIssue) {
    await call('POST', `/repos/${repo}/issues/${openIssue.number}/comments`, {
      body: `🔴 ${today} も赤でした。\n\n揃わなかった検査(落ちた / 走らなかった):\n${steps}\n\n${runUrl}\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_`,
    });
    return { action: 'commented', issue: openIssue.number };
  }

  // ⚠ label が無い repo で issue 作成ごと落ちないように、先に作っておく
  //   (既に在れば 422。**それは失敗ではない**)
  await call(
    'POST',
    `/repos/${repo}/labels`,
    { name: LABEL, color: 'b60205', description: '夜の検査が赤い' },
    [422],
  );

  const created = await call('POST', `/repos/${repo}/issues`, {
    title: `🔴 Nightly が赤い(${today} 〜)`,
    labels: [LABEL],
    body:
      `${today} の Nightly が赤くなりました。**緑に戻るまでこの issue へ積まれます**` +
      `(戻ったら自動で閉じます)。\n\n揃わなかった検査(落ちた / 走らなかった):\n${steps}\n\n${runUrl}\n\n` +
      `⚠ 夜の検査は **1 つ落ちても後続を止めません**(#221)。並んでいる名前が複数なら、` +
      `それぞれ別の主張が壊れています(末尾が skipped のものは「走らなかった」= ` +
      `確かめていない)。\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_`,
  });
  return { action: 'created', issue: created.number };
}

/* ── CLI ── */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const runId = process.env.GITHUB_RUN_ID;
  const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
  if (!repo || !token) {
    console.error('✗ GITHUB_REPOSITORY / GITHUB_TOKEN が要る');
    process.exit(2);
  }
  // 🔑 集計は `unmetSteps`(test が通る側)でやる ── workflow に判定を書かない
  const failedSteps = unmetSteps(process.env.PKC3_NIGHTLY_STEPS);
  const today = new Date().toISOString().slice(0, 10);
  const out = await reconcileNightlyIssue({
    fetch: globalThis.fetch,
    repo,
    token,
    failedSteps,
    runUrl: `${server}/${repo}/actions/runs/${runId}`,
    today,
  });
  console.log(
    failedSteps.length > 0 ? `🔴 揃わなかった検査: ${failedSteps.join(', ')}` : '✅ 全部緑',
  );
  console.log(`台帳: ${out.action}${out.issue ? ` #${out.issue}` : ''}`);
}
