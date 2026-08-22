/**
 * PKC3 計器: **`window.open(index.html, '_blank', 'noopener')` の窓は使えるか**
 * (#300 段①。2026-08-22)。
 *
 * 🔴 **これは方針の門である。** #300 は「組み込みアプリを別窓で開く」の実装方針として
 * 「Office の `host.html` 型を作らず、**同じ bundle の `index.html` を窓で開いて
 * follower として boot させる**」を推薦している。その推薦は未検証の仮定に乗っている
 * ── **ここで落ちたら方針ごと覆る**。製品コードは 1 行も変えない。
 *
 * ## 確かめる 3 つ(1 つずつ独立に主張する ── CLAUDE.md「1 job = 1 主張」)
 *
 * ① **follower になるか** ── `noopener` は browsing context group を跨ぐが、
 *    BroadcastChannel も Web Locks も **origin スコープ**なので届くはず、という仮定。
 *    ⚠ 観測点は **状態の行だけ**(`[data-pkc-region="status"]`)。root 全体で探すと
 *    お知らせのカードの文言に満たされて**常に真**になる(2026-08-17 に踏んだ)。
 * ② **本体を閉じたら昇格するか** ── ⚠ 観測点は「起動したか」でも「帯が消えたか」でも
 *    なく「**本体が書いた最新の本文が出るか**」。memory fallback で昇格すると
 *    **帯は消えて起動もする(空で)**。
 * ③ **閉じたら常駐が還るか** ── ⚠ 観測点は**プロセス木の Pss**(#114)。
 *    `performance.memory` はメインの realm の JS heap しか見ない。
 *
 * ## 🔴 対照群は「同じ手順をタブでも通す」── 窓だけ回さない
 *
 * ⚠ 窓が落ちたとき、それが「**窓だから**」なのか「**この一式ではタブでも落ちる**」の
 * かは、窓だけ見ていては区別できない。だから **`tab` と `window` の 2 群**を、
 * **別々の profile で**同じ手順に通す。⚠ **対照群(tab)が落ちた回は、窓側の結果を
 * 読まない**(「判定不能」と書く)。
 *
 * ## 🔴 実測(2026-08-22。2 回走らせて同じ向き・同じ桁)
 *
 * | | tab(対照群) | window(`noopener`) |
 * |---|---|---|
 * | ① follower になるか | ✅ | ✅ |
 * | ② 昇格して最新の本文が出るか | ✅ | ✅ |
 * | 本体のみ | 382.1 MB / 8 プロセス | 381.7 MB / 8 プロセス |
 * | + 2 枚目 | 411.7(**+29.6**)/ 9 | 411.3(**+29.6**)/ 9 |
 * | + 3 枚目 | 436.2(+24.5)/ 10 | 437.5(+26.2)/ 10 |
 * | 3 枚目を閉じた後 | 404.9(**−31.3**)/ 9 | 405.2(**−32.3**)/ 9 |
 *
 * 🔑 **窓はタブと見分けがつかない。** #300 の推薦が言うとおり、follower は
 * `initStorage` を呼ばないので、窓 1 枚の増分は「renderer 1 個」であって
 * 「sqlite worker 1 個」ではない ── 実測 **+29.6MB / プロセス +1**、閉じれば還る。
 * ⚠ `noopener` の窓から**さらに `noopener` の窓**も開けた(3 枚目はそうやって開いた)。
 *
 * ⚠ **測っていないこと**: 実機のポップアップ遮断(この箱の Chromium は
 * `--disable-popup-blocking` 相当の既定で動く可能性がある)/ 長時間の常駐 /
 * 窓が多数のとき。⚠ 段⑤ が「中央の面を退避先として残す」と決めているのは
 * 前者のためであり、この実測はその判断を**覆さない**。
 *
 * 使い方(dist を preview で配ってから):
 *   npm run build && npx vite preview --port 45743 &
 *   node tests/probe/run-window-follower-probe.mjs --port=45743
 */
import { chromium } from '@playwright/test';
import { mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { seedEditorArm, fillBody } from '../bench/editor-arm.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const PORT = Number(args.port ?? 45743);
const BOOTED = '[data-pkc-slot="root"][data-pkc-boot="ready"]';
const STATUS = '[data-pkc-region="status"]';
const FOLLOWER_BADGE = '保存は本体タブ経由です';
/**
 * 🔴 **ノートを数える面は「フォルダの表」である**(2026-08-22 に実測して直した)。
 *
 * ⚠ 初稿は `tests/bench/run-second-tab.mjs` と同じ
 *   `[data-pkc-region="entry-list"] …` を写したが、**その面は既定で `hidden`**
 *   である ── 2026-08-18 に左の列が「フォルダ」で開くようになったため。
 *   数えると必ず 0 件で、**仕込みにも昇格にも同じ 0 が出る**(= 昇格の失敗に見える)。
 * ⚠ かといって document 全体で `[data-pkc-entry]` を数えてはいけない ──
 *   実測では **情報ペインが 4 件**持っている(CLAUDE.md 2026-08-17 の
 *   「別の面の文字に満たされる」と同型で、13 晩 nightly を赤にした当のもの)。
 * 🔑 面(region)へスコープする。実測: 仕込み直後の `filer-table` は **ちょうど 1 件**。
 */
const NOTE_ROWS = '[data-pkc-region="filer-table"] [data-pkc-entry]';
/** 昇格側でだけ意味を持つ印。 */
const MARK = 'さいご-の-しるし-9317';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 常駐(プロセス木の Pss)── tests/bench/run-app-session.mjs と同じ採り方 ──
function readPpid(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return null;
  }
}
function memKb(pid) {
  try {
    const roll = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const pss = /^Pss:\s+(\d+) kB$/m.exec(roll);
    if (pss) return Number(pss[1]);
  } catch {
    /* smaps_rollup が無い環境 */
  }
  return null;
}
function findBrowserPid(profileDir) {
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let cmd;
    try {
      cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (!cmd.includes(`--user-data-dir=${profileDir}`)) continue;
    if (cmd.includes('--type=')) continue;
    return Number(name);
  }
  return null;
}
function treeMemory(rootPid) {
  const kids = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const ppid = readPpid(Number(name));
    if (ppid === null) continue;
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(Number(name));
  }
  let pss = 0;
  let procs = 0;
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    const m = memKb(pid);
    if (m !== null) {
      pss += m;
      procs += 1;
    }
    for (const k of kids.get(pid) ?? []) queue.push(k);
  }
  return { pssMb: +(pss / 1024).toFixed(1), procs };
}
/** 静止させてから木の Pss を採る(揺れの主因を測定対象から外す ── #114)。 */
async function restingMemory(rootPid) {
  if (!rootPid) return null;
  await sleep(2500);
  const xs = [];
  for (let i = 0; i < 3; i++) {
    xs.push(treeMemory(rootPid));
    await sleep(700);
  }
  return {
    pssMb: xs.map((x) => x.pssMb).sort((a, b) => a - b)[1],
    procs: Math.max(...xs.map((x) => x.procs)),
  };
}

/** 本体タブを 1 つ立て、ノートを 1 件書いて `MARK` を残す。 */
async function seedHolder(ctx) {
  const a = ctx.pages()[0] ?? (await ctx.newPage());
  // ⚠ 本文の**用意**は 2 ペイン(split)でやる ── 打ち方はこの計器の測定対象ではない。
  //   ⚠ 最初の goto より前に仕込む(`tests/bench/editor-arm.mjs`)。
  await seedEditorArm(a, 'split');
  await a.goto(`http://localhost:${PORT}/`);
  await a.waitForSelector(BOOTED, { timeout: 60000 });
  await a.click('[data-pkc-action="create-entry"]');
  await a.fill('[data-pkc-field="editor-title"]', 'しるしのノート');
  await fillBody(a, 'split', `# しるし\n\n${MARK}\n`);
  await a.click('[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await a.waitForSelector('[data-pkc-action="start-edit"]', { timeout: 30000 });
  // 🔴 **仕込めたことを確かめてから進む**(空振り防止)── ここが 0 件なら
  //    以降の「昇格しても 0 件」は昇格の話ではない
  const seeded = await a.locator(NOTE_ROWS).count();
  if (seeded < 1) throw new Error('仕込みが失敗している(ノートが 0 件)');
  return a;
}

async function followerState(page) {
  try {
    await page.waitForSelector(BOOTED, { timeout: 60000 });
    await page.waitForFunction(
      // ⚠ `waitForFunction` が渡すのは **1 引数だけ** ── 2 つ書くと 2 つ目が
      //   `undefined` になり `includes(undefined)` が常に false で必ず timeout する
      //   (初稿で踏み、対照群が「follower にならない」に見えた)
      ([sel, text]) => (document.querySelector(sel)?.textContent ?? '').includes(text),
      [STATUS, FOLLOWER_BADGE],
      { timeout: 30000 },
    );
    return { booted: true, follower: true };
  } catch (e) {
    let booted = false;
    try {
      booted =
        (await page.locator('[data-pkc-slot="root"]').getAttribute('data-pkc-boot')) === 'ready';
    } catch {
      /* 窓ごと死んでいる */
    }
    return { booted, follower: false, why: String(e).slice(0, 100) };
  }
}

/** 本体を閉じて、2 枚目が「最新の本文」を出せるところまで昇格するか。 */
async function promotes(holder, second) {
  await holder.close();
  const step = {};
  try {
    await second.waitForSelector(BOOTED, { timeout: 60000 });
    step.stillBooted = true;
    await second.waitForFunction(
      ([sel, text]) => !(document.querySelector(sel)?.textContent ?? '').includes(text),
      [STATUS, FOLLOWER_BADGE],
      { timeout: 60000 },
    );
    step.badgeCleared = true;
    // ⚠ 昇格の再描画に間を置く(帯が消えた瞬間に一覧が揃っているとは限らない)
    step.notes = 0;
    for (let i = 0; i < 20; i++) {
      step.notes = await second.locator(NOTE_ROWS).count();
      if (step.notes > 0) break;
      await sleep(500);
    }
    if (!step.notes) return { promoted: false, why: '昇格後もノートが 0 件(空 DB の疑い)', step };
    await second.locator(NOTE_ROWS).first().click();
    await second.waitForSelector('[data-pkc-field="detail-body"]', { timeout: 30000 });
    await sleep(500);
    const body = (await second.locator('[data-pkc-field="detail-body"]').textContent()) ?? '';
    step.bodyHasMark = body.includes(MARK);
    return { promoted: step.bodyHasMark, why: step.bodyHasMark ? null : '最新の本文が出ない', step };
  } catch (e) {
    return { promoted: false, why: String(e).slice(0, 100), step };
  }
}

/** 1 群を通す。`kind` は `'tab'`(対照群)か `'window'`(本番)。 */
async function runCase(kind) {
  const profile = `/tmp/pkc3-window-probe-${kind}`;
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const ctx = await chromium.launchPersistentContext(profile, {
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH
      ? { executablePath: '/opt/pw-browsers/chromium' }
      : {}),
  });
  const errors = [];
  ctx.on('page', (p) => p.on('pageerror', (e) => errors.push(String(e).slice(0, 100))));
  const rootPid = findBrowserPid(profile);
  const out = { kind, rootPid, memory: {} };

  try {
    const holder = await seedHolder(ctx);
    out.memory.holderOnly = await restingMemory(rootPid);

    let second;
    if (kind === 'tab') {
      second = await ctx.newPage();
      await second.goto(`http://localhost:${PORT}/`);
    } else {
      const opened = new Promise((resolve) => ctx.once('page', resolve));
      out.openReturned = await holder.evaluate(() => {
        const w = window.open(window.location.href, '_blank', 'noopener');
        // ⚠ `noopener` は必ず `null` を返す(参照を渡さないのが仕様)。
        //   「開けたか」はここでは分からない ── 窓が来るかどうかで判定する。
        return w === null ? 'null(noopener の仕様どおり)' : 'ハンドルが返った';
      });
      second = await Promise.race([opened, sleep(15000).then(() => null)]);
      if (!second) {
        out.second = { opened: false, why: '15 秒で窓が現れない(ポップアップ遮断の疑い)' };
        await ctx.close();
        return { ...out, errors };
      }
    }
    // ① follower になるか
    out.second = { opened: true, ...(await followerState(second)) };
    // ③ 2 枚のときの常駐(⚠ **本体は生かしたまま**採る)
    out.memory.holderPlusSecond = await restingMemory(rootPid);

    // ③ 3 枚目を開いて閉じ、還るかを見る
    //   ⚠ **本体も 2 枚目も生かしたまま**やる ── 比べる相手を揃えるため
    //     (2 枚目を閉じてしまうと、昇格の話と混ざる)
    //   🔴 **3 枚目も同じ開き方にする**(初稿は両群ともタブで開いていた ──
    //     それでは「窓を閉じたら還るか」を 1 度も測っていない。
    //     測った物と主張がずれる型、CLAUDE.md #114 と同じ)
    {
      let third;
      if (kind === 'tab') {
        third = await ctx.newPage();
        await third.goto(`http://localhost:${PORT}/`);
      } else {
        const opened3 = new Promise((resolve) => ctx.once('page', resolve));
        await second.evaluate(() => window.open(window.location.href, '_blank', 'noopener'));
        third = await Promise.race([opened3, sleep(15000).then(() => null)]);
      }
      if (!third) {
        out.memory.thirdNote = '3 枚目が開かない(窓から窓を開けなかった)';
      } else {
        await third.waitForSelector(BOOTED, { timeout: 60000 });
        out.memory.plusThird = await restingMemory(rootPid);
        await third.close();
        out.memory.afterThirdClosed = await restingMemory(rootPid);
      }
    }

    // ② 本体を閉じたら昇格するか
    out.promotion = await promotes(holder, second);
  } catch (e) {
    out.fatal = String(e).slice(0, 200);
  }
  await ctx.close();
  return { ...out, errors };
}

async function main() {
  // 🔴 対照群(tab)を先に通し、落ちたら窓側の結果は読まない
  const tab = await runCase('tab');
  const win = await runCase('window');

  const control =
    tab.second?.follower && tab.promotion?.promoted
      ? 'ok'
      : `落ちた(follower=${tab.second?.follower} / promoted=${tab.promotion?.promoted} / ${tab.promotion?.why ?? tab.fatal ?? ''})`;

  const verdict =
    control !== 'ok'
      ? `判定不能 ── 対照群(タブ)が ${control}。窓側は読まない`
      : win.second?.follower && win.promotion?.promoted
        ? '✅ 段① は通る(窓は follower になり、昇格する)'
        : '🔴 覆る ── ' +
          [
            win.second?.opened ? null : '窓が開かない',
            win.second?.follower ? null : '窓が follower にならない',
            win.promotion?.promoted ? null : `昇格しない(${win.promotion?.why})`,
          ]
            .filter(Boolean)
            .join(' / ');

  console.log(JSON.stringify({ port: PORT, control, verdict, tab, window: win }, null, 2));
}

main().catch((e) => {
  console.error('probe が落ちた:', e);
  process.exit(1);
});
