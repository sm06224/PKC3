/**
 * 計器: **ライブエディタの打鍵中の仕事**(2026-08-05。ライブエディタ S5〜S8)。
 *
 * > user 指示 2026-08-03(不可侵)「**初回起動が遅くとも、そこは許容 / その後の
 * > 動作がメモリくったり、もっさりだと嫌なだけです**」
 *
 * だから測るのは配る量ではなく **継続使用**である。ここで見るのは 4 つ:
 *  ① **打鍵中にワーカーへ飛ぶ仕事の件数**(ライブは 0 が設計値)
 *  ② **打鍵中の long task**(合計と最大 ── もっさりの実体)
 *  ③ **確定 / 打鍵停止から画面に出るまで**(反映の待ち時間)
 *  ④ **常駐 RSS**(中央値と最大)
 *
 * ## 対照群(PKC2 から継承した規律)
 * 🔑 「何もしない」ではなく **測りたい違いだけが違うもの**にする ──
 * **同じビルド・同じ本文・同じ打鍵**で、設定 `pkc3.editor-mode` だけを変える。
 *  - `--arm=live`  : 1 面(行を開いて打つ → Tab で確定)
 *  - `--arm=split` : 今日の 2 列(原文欄に同じ位置・同じ文字を打つ)
 * ⚠ 打つ**位置**も合わせる(2 列側は `setSelectionRange` で同じ文字位置へ置く)。
 *
 * ## ⚠ 測っていない次元(主張しない)
 * fixture は **図 1 枚 / 添付 0 / 履歴 0 / 関連 0**。図の焼き直しの費用は
 * `run-raster-cap.mjs` の担当で、ここでは「1 枚在っても打鍵中に触られない」ことだけ見る。
 *
 * 使い方(dist を配信してから ── smoke と同じ「配る物を測る」):
 *   npm run build
 *   npx vite preview --port 45735 --strictPort &
 *   node tests/bench/run-live-editor.mjs --arm=live  --port=45735
 *   node tests/bench/run-live-editor.mjs --arm=split --port=45735
 */
import { chromium } from '@playwright/test';
import { readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const ARM = args.arm === 'split' ? 'split' : 'live';
const BLOCKS = Number(args.blocks ?? 400);
const KEYS = Number(args.keys ?? 120);
const DELAY_MS = Number(args.delay ?? 30);
const PORT = Number(args.port ?? 45735);
const PROFILE_DIR = args.profile ?? '/home/user/PKC3/.bench-profile-live';
const executablePath = process.env.PKC3_CHROMIUM ?? '/opt/pw-browsers/chromium';

/** 目印。打った文字が画面に出た瞬間を見るために使う。 */
const MARK = 'ЖЖ';

/** 実データに近い形(見出し / 段落 / 表 / 箇条書き / コード / 図)を混ぜる。 */
function buildBody(blocks) {
  const out = ['# 計測用の文書', ''];
  out.push('```mermaid', 'graph TD', '  A["始め"]-->B["終わり"]', '```', '');
  out.push('編集する段落。', '');
  for (let i = 0; i < blocks; i += 1) {
    const k = i % 5;
    if (k === 0) out.push(`## 節 ${i}`, '');
    else if (k === 1) out.push(`段落 ${i} の本文です。**強調**と \`コード\`を含みます。`, '');
    else if (k === 2) out.push(`| 品 ${i} | 数 |`, '|---|---|', `| あ | ${i} |`, '');
    else if (k === 3) out.push(`- 項目 ${i}-1`, `- 項目 ${i}-2`, '');
    else out.push('```js', `const x${i} = ${i};`, '```', '');
  }
  return out.join('\n');
}

function rssOfProfileMb() {
  let total = 0;
  for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!cmd.includes(PROFILE_DIR)) continue;
      const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/);
      if (m) total += Number(m[1]);
    } catch {
      /* プロセス終了との競合は想定内 */
    }
  }
  return +(total / 1024).toFixed(1);
}

const body = buildBody(BLOCKS);
rmSync(PROFILE_DIR, { recursive: true, force: true });
mkdirSync(PROFILE_DIR, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE_DIR, { executablePath });
try {
  /**
   * 🔑 **計器はページに仕込む**。
   * - ワーカーへ飛ぶ仕事は `Worker.prototype.postMessage` を数える(job 単位)
   * - long task は `PerformanceObserver`
   * ⚠ グローバルを丸ごと差し替えず、**その 1 メソッドだけ**包む(CLAUDE.md)。
   */
  await context.addInitScript(() => {
    const w = window;
    w.__probe = { jobs: 0, longTasks: [], armed: false };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (...a) {
      if (w.__probe.armed) w.__probe.jobs += 1;
      return post.apply(this, a);
    };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (w.__probe.armed) w.__probe.longTasks.push(+e.duration.toFixed(1));
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      /* longtask を持たない環境ではこの次元は測れない(下で明記する) */
    }
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // ── ① 本文を仕込む(今日の 2 列で作って保存 ── 実アプリの経路)
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('[data-pkc-boot="ready"]', { timeout: 20_000 });
  await page.click('[data-pkc-field="create-pick"]');
  await page.click('[data-pkc-region="create-menu"] [data-pkc-archetype="text"]');
  await page.click('[data-pkc-field="create-run"]');
  /**
   * ⚠ `page.fill` は使わない ── 大きい本文だと「要素が安定するまで」待って
   * **30 秒で落ちる**(プレビューが描き続けている間ずっと不安定と判定される)。
   * 値を入れて `input` を撃つのは binder が聴いている経路そのもの。
   */
  await page.evaluate((text) => {
    const ta = document.querySelector('[data-pkc-field="editor-body"]');
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, body);
  await page.click('[data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-field="detail-body"]');

  // ── ② 腕ごとに読み直して編集へ入る(**同じビルド**・flag だけ違う)
  // ⚠ 2026-08-14(#104 第 2 弾): flag は設定 `pkc3.editor-mode` へ昇格(既定 live)
  //    ── 腕の差は**設定だけ**にする(URL を変えると cache の効きが割れる)
  await page.addInitScript((arm) => {
    globalThis.localStorage.setItem('pkc3.editor-mode', arm === 'live' ? 'live' : 'split');
  }, ARM);
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('[data-pkc-boot="ready"]', { timeout: 20_000 });
  // 読み直すと選択は空 ── 一覧から選ぶ(user と同じ手順)
  await page.click('[data-pkc-region="entry-list"] [data-pkc-entry]');
  await page.waitForSelector('[data-pkc-action="start-edit"]', { timeout: 20_000 });
  await page.click('[data-pkc-action="start-edit"]');
  const pane = ARM === 'live' ? '[data-pkc-region="editor-live"]' : '[data-pkc-region="editor-split"]';
  await page.waitForSelector(pane);
  if (ARM === 'live') {
    // 面が組み上がるまで待つ(ここは初回描画 ── 打鍵中の計測に混ぜない)
    await page.waitForSelector('[data-pkc-region="editor-live"] h1', { timeout: 30_000 });
  } else {
    await page.waitForSelector('[data-pkc-region="editor-preview"] h1', { timeout: 30_000 });
  }

  // ── ③ 打つ位置を合わせる(どちらも「編集する段落。」の末尾)
  const target = '編集する段落。';
  if (ARM === 'live') {
    const el = page.locator(`${pane} p`, { hasText: target }).first();
    const box = await el.boundingBox();
    await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
    await page.waitForSelector('[data-pkc-field="row-source"]');
    await page.evaluate(() => {
      const ta = document.querySelector('[data-pkc-field="row-source"]');
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  } else {
    await page.evaluate((t) => {
      const ta = document.querySelector('[data-pkc-field="editor-body"]');
      const at = ta.value.indexOf(t) + t.length;
      ta.focus();
      ta.setSelectionRange(at, at);
    }, target);
  }

  // ── ④ 計測開始 → 打鍵
  const rss = [];
  const sampler = setInterval(() => rss.push(rssOfProfileMb()), 500);
  await page.evaluate(() => {
    window.__probe.jobs = 0;
    window.__probe.longTasks = [];
    window.__probe.armed = true;
  });
  const t0 = Date.now();
  await page.keyboard.type(MARK + 'あ'.repeat(Math.max(0, KEYS - MARK.length)), {
    delay: DELAY_MS,
  });
  const typedMs = Date.now() - t0;
  const typing = await page.evaluate(() => ({
    jobs: window.__probe.jobs,
    longTasks: [...window.__probe.longTasks],
  }));

  // ── ⑤ 反映まで(ライブ = Tab で確定 / 2 列 = 静穏を待つ)
  const t1 = Date.now();
  if (ARM === 'live') await page.keyboard.press('Tab');
  const shown = ARM === 'live' ? pane : '[data-pkc-region="editor-preview"]';
  await page.waitForFunction(
    ({ sel, mark }) => {
      const host = document.querySelector(sel);
      if (!host) return false;
      // ⚠ **描画済みの塊**に出たことを見る(入力欄の中の文字では意味がない)
      return [...host.querySelectorAll('p')].some((p) => p.textContent?.includes(mark));
    },
    { sel: shown, mark: MARK },
    { timeout: 30_000 },
  );
  const reflectMs = Date.now() - t1;
  const after = await page.evaluate(() => ({
    jobs: window.__probe.jobs,
    longTasks: [...window.__probe.longTasks],
  }));
  clearInterval(sampler);

  const sum = (a) => +a.reduce((x, y) => x + y, 0).toFixed(1);
  const sorted = [...rss].sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        arm: ARM,
        fixture: {
          blocks: BLOCKS,
          lines: body.split('\n').length,
          bytes: body.length,
          diagrams: 1,
          zeroDims: ['assets', 'revisions', 'relations'],
        },
        keys: { count: KEYS, delayMs: DELAY_MS, typedMs },
        /** 🔴 打鍵中の仕事(ライブの設計値は jobs 0) */
        typing: {
          workerJobs: typing.jobs,
          longTaskCount: typing.longTasks.length,
          longTaskTotalMs: sum(typing.longTasks),
          longTaskMaxMs: typing.longTasks.length ? Math.max(...typing.longTasks) : 0,
        },
        /** 反映まで(ライブ = 確定してから / 2 列 = 打ち終わってから) */
        reflect: {
          ms: reflectMs,
          workerJobsTotal: after.jobs,
          longTaskTotalMs: sum(after.longTasks),
        },
        rssMB: {
          samples: rss.length,
          median: sorted[Math.floor(sorted.length / 2)] ?? null,
          max: sorted[sorted.length - 1] ?? null,
        },
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  rmSync(PROFILE_DIR, { recursive: true, force: true });
}
