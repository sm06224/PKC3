/**
 * PKC3 計器: **2 枚目のタブ**(writer lease の待機側)。
 *
 * 🔴 なぜ要るか ── user はタブを開きっぱなしにする。SAHPool は実質単一接続なので
 * 2 枚目は待機に入るが、**待機側が何をどれだけ抱えるかを一度も測っていなかった**
 * (段㉗ の doc で「未測定」に挙げた最後の項目)。
 *
 * ## 何を見るか
 * 1. **待機側は太らないか** ── 1 枚目が編集し続けている間、2 枚目の heap / DOM の傾き
 * 2. **待機側は本当に待機しているか** ── boot 済みのタブを測っても意味がない
 * 3. 🔴 **1 枚目を閉じたら、2 枚目が正しく昇格するか** ── ここが本丸。
 *    `initStorage(promoted)` は「旧タブの SAH 解放が lock 解放より遅れて
 *    **memory fallback しうる**(空 DB に見え、編集が reload で消える)」を
 *    backoff で避けている。既存の probe(`tests/probe/run-lease-probe.mjs`)は
 *    **専用の HTML** で lock と init だけを見ており、**実アプリが実データを
 *    出せるか**は見ていない。空の DB で昇格したら、user から見て
 *    「ノートが全部消えた」である。
 *
 * ⚠ 昇格の観測点は「起動したか」ではなく「**1 枚目が書いた最新の本文が出るか**」
 *   ── memory fallback で昇格すると **起動はする**(空で)。
 *
 * 使い方(dist を preview で配ってから):
 *   npm run build && npx vite preview --port 45741 &
 *   node tests/bench/run-second-tab.mjs --rounds=30
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
const ROUNDS = Number(args.rounds ?? 30);
const NOTES = Number(args.notes ?? 6);
const PROFILE = '/tmp/pkc3-second-tab-profile';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 昇格側で必ず見つかる印。⚠ **最後のラウンドでしか書かれない**値にする。 */
const MARK = (r) => `さいご-${r}`;

function body(i, rev) {
  return `# ノート ${i}\n\n${MARK(rev)}\n\n本文を 1KB 級にする行。**強調**と \`code\`。\n`.repeat(4);
}

async function main() {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const errors = [];

  // ── タブ A: 先に開いて lease を握る
  const a = ctx.pages()[0] ?? (await ctx.newPage());
  a.on('pageerror', (e) => errors.push(`A: ${String(e)}`));
  await a.goto(`http://localhost:${PORT}/`);
  await a.waitForSelector('[data-pkc-slot="root"][data-pkc-boot="ready"]', { timeout: 60000 });

  for (let i = 0; i < NOTES; i++) {
    await a.click('[data-pkc-action="create-entry"]');
    await a.fill('[data-pkc-field="editor-title"]', `ノート ${i}`);
    await a.fill('[data-pkc-field="editor-body"]', body(i, 0));
    await a.click('[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    await a.waitForSelector('[data-pkc-action="start-edit"]');
  }

  // ── タブ B: 後から開く → 待機に入る
  const b = await ctx.newPage();
  b.on('pageerror', (e) => errors.push(`B: ${String(e)}`));
  await b.goto(`http://localhost:${PORT}/`);
  await b.waitForFunction(
    () => (document.querySelector('[data-pkc-slot="root"]')?.textContent ?? '').includes('別のタブ'),
    null,
    { timeout: 30000 },
  );
  // 🔴 **前提が成立しているか**(boot 済みのタブを測っても意味がない)
  const waiting = {
    message: (await b.locator('[data-pkc-slot="root"]').textContent())?.slice(0, 24) ?? '',
    booted: await b.locator('[data-pkc-slot="root"]').getAttribute('data-pkc-boot'),
  };
  if (waiting.booted !== null) throw new Error(`2 枚目が待機していない: boot=${waiting.booted}`);

  const sampleB = () =>
    b.evaluate(() => {
      const mem = performance.memory;
      return {
        heapMb: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
        nodes: document.getElementsByTagName('*').length,
      };
    });

  // ── A が働いている間、B を測る
  const rows = [];
  const noteRows = '[data-pkc-region="entry-list"] [data-pkc-entry][data-pkc-archetype="text"]';
  let lastRound = 0;
  for (let r = 1; r <= ROUNDS; r++) {
    const i = r % NOTES;
    await a.locator(noteRows).nth(i).click();
    await a.waitForSelector('[data-pkc-action="start-edit"]');
    await a.click('[data-pkc-action="start-edit"]');
    await a.fill('[data-pkc-field="editor-body"]', body(i, r));
    await a.click('[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    await a.waitForSelector('[data-pkc-action="start-edit"]');
    lastRound = r;
    rows.push({ r, ...(await sampleB()) });
  }
  // 🔴 **最後の書き込みがどのノートに入ったか**を控える(昇格側で照合する)
  const lastNote = lastRound % NOTES;

  // ── 🔴 本丸: A を閉じて、B が昇格するか
  await a.close();
  let promoted;
  let promotedNotes = -1;
  let promotedBody = '';
  try {
    await b.waitForSelector('[data-pkc-slot="root"][data-pkc-boot="ready"]', { timeout: 60000 });
    promoted = 'booted';
    promotedNotes = await b.locator(noteRows).count();
    // ⚠ 観測点は「起動したか」ではなく「**最新の本文が出るか**」
    //   ── memory fallback で昇格すると**起動はする**(空で)
    await b.locator(noteRows).nth(lastNote).click();
    await b.waitForSelector('[data-pkc-field="detail-body"]', { timeout: 30000 });
    await sleep(400);
    promotedBody = (await b.locator('[data-pkc-field="detail-body"]').textContent()) ?? '';
  } catch (e) {
    promoted = `失敗(昇格しない): ${String(e).slice(0, 80)}`;
  }

  const med = (xs) => {
    const s = xs.filter((x) => x != null).sort((a2, b2) => a2 - b2);
    return s.length === 0 ? null : s[Math.floor(s.length / 2)];
  };
  const half = Math.floor(rows.length / 2);
  const early = rows.slice(0, half);
  const late = rows.slice(half);

  console.log(
    JSON.stringify(
      {
        fixture: { notes: NOTES, rounds: ROUNDS },
        // ⚠ 待機していたことの証拠(ここが崩れると下は全部無意味)
        waiting,
        secondTabWhileIdle: {
          heapMb: { early: med(early.map((x) => x.heapMb)), late: med(late.map((x) => x.heapMb)) },
          domNodes: { early: med(early.map((x) => x.nodes)), late: med(late.map((x) => x.nodes)) },
        },
        promotion: {
          result: promoted,
          notesShown: promotedNotes,
          expectedNotes: NOTES,
          // 🔴 最後に書いた印が出ているか(空 DB で昇格していないか)
          lastMarkExpected: MARK(lastRound),
          lastMarkFound: promotedBody.includes(MARK(lastRound)),
          /**
           * ⚠ **観測点が落ちうることを示す**(空振り防止の対照)。
           * これは**同じノートの 1 つ前の版**の印 ── 古い snapshot で昇格したら
           * こちらが true / 上が false になる。両方 true なら本文の照合が
           * 効いていない(部分一致の取り違え)ので、そこも分かる。
           */
          staleMarkExpected: MARK(lastRound - NOTES),
          staleMarkFound: promotedBody.includes(MARK(lastRound - NOTES)),
        },
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  await ctx.close();
}

await main();
