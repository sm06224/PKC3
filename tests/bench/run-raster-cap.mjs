/**
 * PKC3 計器: **図ラスタキャッシュが上限(32MB)に触れたときの挙動**。
 *
 * 🔴 なぜ要るか ── この origin の quota は **OPFS の sqlite(ノート本体)と
 * 添付 Blob と共用**である。だからキャッシュの上限が実効的に効かないことは
 * 「無駄が増える」ではなく **ノート消失に接続する**。
 * 上限と追い出しは P8 段⑰ で入り、段㉑ で「鍵と中身を対で舐める」へ直したが、
 * **上限に触れる長さで動かしたことは一度も無かった** ── ゼロ件の次元と同じで、
 * 触れない長さで回している限り、追い出しは 1 度も走らない。
 *
 * ## 何を見るか
 * - **超えないか**: 1 図ごとにキャッシュ総量を読み、上限をどれだけ超えたか(最大)
 * - **収束するか**: 追い出しが取りこぼしても、後続の put で追いつくか
 * - **消えた図が出るか**: 追い出された図をもう一度開いて `<img>` が出るか
 *   (⚠ ここが本丸。上限を守っても絵が出なくなるなら意味がない)
 * - **常駐が増えないか**: heap / DOM / ObjectURL 残高の傾き
 *
 * ⚠ **キャッシュ総量は IDB を直に舐めて数える** ── アプリの内部カウンタを
 * 信じると、カウンタが壊れているときに「守れている」と嘘が出る。
 *
 * 使い方(dist を preview で配ってから):
 *   npm run build && npx vite preview --port 45741 &
 *   node tests/bench/run-raster-cap.mjs --diagrams=90 --nodes=40
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
/** 図の枚数。上限に**触れる**だけ要る(足りないと追い出しが 1 度も走らない)。 */
const DIAGRAMS = Number(args.diagrams ?? 90);
/** 1 枚あたりのノード数(= PNG の大きさ)。 */
const NODES = Number(args.nodes ?? 40);
const PROFILE = '/tmp/pkc3-raster-cap-profile';
/** 実装の上限(`DIAGRAM_CACHE_MAX_BYTES`)。⚠ ここを直したら実装と合わせる。 */
const CAP = 32 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 1 枚ずつ**違う**図(同じだと同じ鍵になり、2 枚目以降が cache hit で焼かれない)。 */
function diagram(i, nodes) {
  const lines = ['```mermaid', 'graph TD'];
  for (let n = 0; n < nodes; n++) {
    const a = `N${i}_${n}`;
    const b = `N${i}_${n + 1}`;
    lines.push(`  ${a}["図 ${i} の節 ${n}(${(i * 7919 + n * 104729) % 100000})"]-->${b}["節 ${n + 1}"]`);
    if (n % 4 === 3) lines.push(`  ${a}-->S${i}_${n}["枝 ${n}"]`);
  }
  lines.push('```');
  return lines.join('\n');
}

async function main() {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    args: ['--js-flags=--expose-gc'],
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('[data-pkc-slot="root"][data-pkc-boot="ready"]', { timeout: 60000 });

  await page.evaluate(() => {
    const w = window;
    w.__m = { made: 0, freed: 0 };
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

  /**
   * キャッシュを **IDB から直に**数える(アプリのカウンタを信じない)。
   * ⚠ version を指定せずに開く ── 指定すると upgrade を起こしてしまう。
   */
  const cacheStats = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open('pkc3-diagram-cache');
          req.onerror = () => resolve({ rows: 0, bytes: 0, missingSize: 0, error: 'open' });
          req.onsuccess = () => {
            const d = req.result;
            if (!d.objectStoreNames.contains('png')) return resolve({ rows: 0, bytes: 0, missingSize: 0 });
            let rows = 0;
            let bytes = 0;
            let missingSize = 0;
            const cur = d.transaction('png', 'readonly').objectStore('png').openCursor();
            cur.onerror = () => resolve({ rows, bytes, missingSize, error: 'cursor' });
            cur.onsuccess = () => {
              const c = cur.result;
              if (!c) {
                d.close();
                return resolve({ rows, bytes, missingSize });
              }
              const row = c.value;
              rows += 1;
              // ⚠ 実際の Blob の大きさで数える ── row.size を信じると、
              //   size が壊れている / 欠けているときに「守れている」と嘘が出る
              const real = row?.png?.size;
              if (typeof row?.size !== 'number') missingSize += 1;
              bytes += typeof real === 'number' ? real : (row?.size ?? 0);
              c.continue();
            };
          };
        }),
    );

  const heap = () =>
    page.evaluate(() => {
      const mem = performance.memory;
      return {
        heapMb: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
        live: window.__m.made - window.__m.freed,
        nodes: document.getElementsByTagName('*').length,
      };
    });

  const img = '[data-pkc-field="detail-body"] img[data-pkc-field="mermaid-image"]';
  const rows = '[data-pkc-region="entry-list"] [data-pkc-entry][data-pkc-archetype="text"]';

  // ── キャッシュが**育つ**のは、ノートを作って確定した時である。
  //    ⚠ 最初の版はここを「作る → 全部作り終わってから 1 枚ずつ開く」に分けていたが、
  //    確定した時点で detail が図を描く(= 焼いて put する)ので、開く側は
  //    **全部 cache hit** だった ── 12 枚で総量が最初から最後まで 1 バイトも
  //    動かず、それで気付いた。育つ所を測らないと追い出しは 1 度も見えない。
  const series = [];
  let firstEvictionAt = null;
  let prevRows = 0;
  for (let i = 0; i < DIAGRAMS; i++) {
    await page.click('[data-pkc-action="create-entry"]');
    await page.fill('[data-pkc-field="editor-title"]', `図 ${i}`);
    await page.fill('[data-pkc-field="editor-body"]', `# 図 ${i}\n\n${diagram(i, NODES)}\n`);
    await page.click('[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    await page.waitForSelector('[data-pkc-action="start-edit"]');
    await page.waitForSelector(img, { timeout: 60000 });
    // 焼き上がり → put → 追い出しが落ち着くのを待つ(書込は非同期)
    await sleep(150);
    const st = await cacheStats();
    // 行が減った = 追い出しが実際に走った(⚠ null のままなら「上限に触れていない」)
    if (firstEvictionAt === null && st.rows < prevRows) firstEvictionAt = i;
    prevRows = st.rows;
    // ⚠ heap は**毎回**取って中央値で見る ── 1 点だけ拾うと揺れる
    //   (実際に踏んだ: 同じ条件の 2 回で early が 9.0 と 16.7 になった)
    series.push({ i, ...st, ...(await heap()) });
  }

  const listed = await page.locator(rows).count();
  if (listed < DIAGRAMS) throw new Error(`ノートが揃っていない: ${listed}/${DIAGRAMS}`);

  const over = series.filter((s) => s.bytes > CAP);
  const maxBytes = Math.max(...series.map((s) => s.bytes));
  const last = series.at(-1);
  const oneRaster = last.rows > 0 ? Math.round(last.bytes / last.rows) : 0;

  // ── 🔴 **一気に焼かせる**(上限のすぐそばで、追い出しと put を重ねる)。
  //    順番に 1 枚ずつ焼く上の loop では、put の間隔が空くので
  //    `evictDiagramCache` の `if (evicting) return 0`(走っている間の依頼を
  //    取りこぼす門)を**一度も踏まない**。1 つの文書に図を何枚も入れると
  //    hydrate が続けて焼く ── これは実 user の書き方でもある。
  const BURST = Number(args.burst ?? 40);
  let burstMax = 0;
  let burstAfter = null;
  // 🔴 **一気に焼いた側で追い出しが実際に走ったか**。ここが false のまま
  //    「はみ出さなかった」と言うのは**空振り**である ── 上限を越えずに
  //    済む枚数で焼いただけなら、取りこぼしの門は 1 度も踏んでいない
  //    (実際に踏んだ: burst=14 では 31.9MB までしか行かず、追い出しは走らなかった)。
  let burstEvicted = false;
  if (BURST > 0) {
    const many = Array.from({ length: BURST }, (_, k) => diagram(1000 + k, NODES)).join('\n\n');
    await page.click('[data-pkc-action="create-entry"]');
    await page.fill('[data-pkc-field="editor-title"]', '図まとめ');
    await page.fill('[data-pkc-field="editor-body"]', `# まとめ\n\n${many}\n`);
    await page.click('[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    await page.waitForSelector('[data-pkc-action="start-edit"]');
    // 焼いている**最中**を舐める(落ち着いてから読むと山を見逃す)
    let burstPrevRows = Infinity;
    for (let t = 0; t < 120; t++) {
      const st = await cacheStats();
      if (st.bytes > burstMax) burstMax = st.bytes;
      if (st.rows < burstPrevRows) burstEvicted = true;
      burstPrevRows = st.rows;
      const painted = await page.locator(img).count();
      if (painted >= BURST && t > 4) break;
      await sleep(250);
    }
    await sleep(500);
    burstAfter = await cacheStats();
    if (burstAfter.bytes > burstMax) burstMax = burstAfter.bytes;
  }

  // ── 本丸: **追い出された図をもう一度開いて、絵が出るか**
  //    ⚠ 上限を守っても絵が出なくなるなら意味がない
  await page.locator(rows).nth(0).click();
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  let reopened;
  try {
    await page.waitForSelector(img, { timeout: 60000 });
    reopened = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el && el.complete && el.naturalWidth > 1 ? 'ok' : `broken(${el?.naturalWidth ?? -1})`;
    }, img);
  } catch {
    reopened = 'timeout(図が出ない)';
  }
  await sleep(200);
  const afterReopen = await cacheStats();

  const med = (xs) => {
    const s = xs.filter((x) => x != null).sort((a, b) => a - b);
    return s.length === 0 ? null : s[Math.floor(s.length / 2)];
  };
  const half = Math.floor(series.length / 2);
  const early = series.slice(0, half);
  const lateHalf = series.slice(half);

  console.log(
    JSON.stringify(
      {
        fixture: { diagrams: DIAGRAMS, nodesPerDiagram: NODES, capMb: +(CAP / 1048576).toFixed(1) },
        observed: {
          // ⚠ **上限に触れたか**。触れていなければ追い出しは 1 度も走っておらず、
          //   下の「超えなかった」は何も証明していない
          firstEvictionAtDiagram: firstEvictionAt,
          reachedCap: maxBytes > CAP * 0.9,
          avgRasterBytes: oneRaster,
          rowsMissingSizeField: series.at(-1)?.missingSize ?? 0,
          // ⚠ DOM ノード数は**ノート件数につれて増える**(一覧の行)── 漏れではない。
          //   これを書いておかないと下の domNodes が leak に見える
          notesInList: listed,
        },
        cap: {
          maxBytesObserved: maxBytes,
          maxOverBytes: Math.max(0, maxBytes - CAP),
          maxOverPct: +(((maxBytes - CAP) / CAP) * 100).toFixed(1),
          samplesOverCap: over.length,
          // 🔴 一気に焼いたときの山(上限のすぐそばで put と追い出しを重ねる)。
          //    ⚠ `burstEvicted` が false なら下の 0 は**何も証明していない**
          burstEvicted,
          burstMaxBytes: burstMax,
          burstOverBytes: Math.max(0, burstMax - CAP),
          burstAfter,
          finalBytes: series.at(-1)?.bytes ?? 0,
          finalRows: series.at(-1)?.rows ?? 0,
        },
        evictedDiagramReopens: reopened,
        afterReopen,
        // 中央値の前半 / 後半(⚠ 傾きを見る。1 点の絶対値で語らない)
        heapMb: { early: med(early.map((x) => x.heapMb)), late: med(lateHalf.map((x) => x.heapMb)) },
        liveObjectUrls: {
          early: med(early.map((x) => x.live)),
          late: med(lateHalf.map((x) => x.live)),
        },
        // ⚠ DOM はノート件数につれて増える(一覧の行)── `notesInList` と併せて読む
        domNodes: { early: med(early.map((x) => x.nodes)), late: med(lateHalf.map((x) => x.nodes)) },
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  await ctx.close();
}

await main();
