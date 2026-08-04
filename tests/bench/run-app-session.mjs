/**
 * PKC3 計器: **アプリの継続使用**(P8 の UI 一式が入った状態の定常)。
 *
 * > user 指示 2026-08-03(不可侵)「**その後の動作がメモリくったり、もっさりだと
 * > 嫌なだけです**」/「測って報告すべきは配る量ではなく、**継続使用の常駐メモリ**と
 * > **操作の応答**である」
 *
 * 🔴 既存の `run-edit-session.mjs` は **storage core だけ**を測る(StoreClient を
 * 直に叩く)。P8 で入った描画・プレビュー・図のラスタ・ワーカー・ObjectURL は
 * **1 度も定常を測っていない** ── ここがその計器。
 *
 * ## 計測規律(PKC2 から継承)
 * - **persistent profile 必須**(ephemeral は storage がメモリバックで実 I/O を踏まない)
 * - **固定ポート**(origin が変わると毎回「初回起動」になる)
 * - **boot 窓で語らない** ── 最初の数ラウンドは暖機として捨て、そこから先の**傾き**を見る
 * - **ゼロ件次元を明記する** ── 下の FIXTURE がどの次元を持つかを出力に書く
 * - 差し引きは**向きのみ**信頼する(倍率は書かない)
 *
 * 使い方(dist を preview で配ってから):
 *   npm run build && npx vite preview --port 45741 &
 *   node tests/bench/run-app-session.mjs --rounds=40
 */
import { chromium } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const PORT = Number(args.port ?? 45741);
const ROUNDS = Number(args.rounds ?? 40);
/** 暖機(boot と初回の遅延生成を定常に混ぜない)。 */
const WARMUP = Number(args.warmup ?? 8);
const PROFILE = '/tmp/pkc3-app-session-profile';

/**
 * fixture の次元。⚠ **ゼロの次元は「測っていない次元」**なので明記する。
 * 図と添付を**必ず入れる**のは、そこが P8 で増えた確保元だから
 * (ラスタの PNG / ObjectURL / worker)。
 */
const FIXTURE = {
  notes: 12,
  withDiagram: 4,
  withTable: 4,
  attachments: 0, // ⚠ 0 件 = この計器は添付の定常を測っていない
  revisions: '編集のたびに増える(round 数ぶん)',
};

const DIAGRAM = '```mermaid\ngraph TD\n  A["始め"]-->B["途中"]\n  B-->C["終わり"]\n```\n';
const TABLE = '```csv\n品目,数\nりんご,120\nみかん,80\n```\n';

function body(i, rev) {
  const para =
    `パラグラフ ${i}-${rev}: PKC-Markdown の本文。**強調** と \`code\` を含む行を` +
    '繰り返して 1KB 級にする。\n';
  const extra = i % 3 === 0 ? DIAGRAM : i % 3 === 1 ? TABLE : '';
  return `# ノート ${i}(rev ${rev})\n\n${extra}\n${para.repeat(8)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    args: ['--js-flags=--expose-gc'],
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH
      ? { executablePath: '/opt/pw-browsers/chromium' }
      : {}),
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('[data-pkc-slot="root"][data-pkc-boot="ready"]', { timeout: 60000 });

  // 計器を仕込む(long task と、作った / 返した ObjectURL の残高)
  await page.addInitScript(() => {});
  await page.evaluate(() => {
    const w = window;
    w.__m = { long: 0, longMs: 0, made: 0, freed: 0 };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        w.__m.long += 1;
        w.__m.longMs += e.duration;
      }
    }).observe({ entryTypes: ['longtask'] });
    const mk = URL.createObjectURL.bind(URL);
    const fr = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (b) => {
      w.__m.made += 1;
      return mk(b);
    };
    URL.revokeObjectURL = (u) => {
      w.__m.freed += 1;
      fr(u);
    };
  });

  // ── ノートを用意する(計測の外)
  for (let i = 0; i < FIXTURE.notes; i++) {
    await page.click('[data-pkc-action="create-entry"]');
    await page.fill('[data-pkc-field="editor-title"]', `ノート ${i}`);
    await page.fill('[data-pkc-field="editor-body"]', body(i, 0));
    await page.click('[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    await page.waitForSelector('[data-pkc-action="start-edit"]');
  }

  const sample = async () => {
    const m = await page.evaluate(() => {
      const w = window;
      const mem = performance.memory;
      return {
        heapMb: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
        long: w.__m.long,
        longMs: Math.round(w.__m.longMs),
        live: w.__m.made - w.__m.freed,
        nodes: document.getElementsByTagName('*').length,
      };
    });
    return m;
  };

  const rows = [];
  const seen = { diagram: 0, table: 0 };
  const list = '[data-pkc-region="entry-list"] [data-pkc-entry]';
  for (let r = 0; r < ROUNDS; r++) {
    const i = r % FIXTURE.notes;
    // 1 ラウンド = 開く → 編集 → 打つ → 確定(user が実際にやる形)
    await page.locator(list).nth(i).click();
    await page.waitForSelector('[data-pkc-action="start-edit"]');
    await page.click('[data-pkc-action="start-edit"]');
    await page.fill('[data-pkc-field="editor-body"]', body(i, r + 1));
    await sleep(600); // プレビューの静穏(500ms)を越えて 1 回描かせる
    await page.click('[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    await page.waitForSelector('[data-pkc-action="start-edit"]');
    if (r >= WARMUP) rows.push({ round: r, ...(await sample()) });
    if (r >= WARMUP && r < WARMUP + FIXTURE.notes) {
      // 🔴 **fixture がその次元を持っているか**を測定の中で確かめる
      //    (ゼロ件の次元は「測っていない次元」── CLAUDE.md)
      seen.diagram += await page.locator('[data-pkc-field="detail-body"] [data-pkc-mermaid-src]').count();
      seen.table += await page.locator('[data-pkc-field="detail-body"] table').count();
    }
  }

  // 定常の傾きを見る(前半 / 後半の中央値)
  const med = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const half = Math.floor(rows.length / 2);
  const early = rows.slice(0, half);
  const late = rows.slice(half);
  const out = {
    fixture: FIXTURE,
    // ⚠ **実際に出た数**(0 なら、その次元は測れていない)
    observed: seen,
    rounds: ROUNDS,
    warmup: WARMUP,
    heapMb: { early: med(early.map((x) => x.heapMb)), late: med(late.map((x) => x.heapMb)) },
    liveObjectUrls: { early: med(early.map((x) => x.live)), late: med(late.map((x) => x.live)) },
    domNodes: { early: med(early.map((x) => x.nodes)), late: med(late.map((x) => x.nodes)) },
    longTasks: rows.at(-1)?.long ?? 0,
    longTaskMsTotal: rows.at(-1)?.longMs ?? 0,
    pageErrors: errors,
  };
  console.log(JSON.stringify(out, null, 2));
  await ctx.close();
}

await main();
