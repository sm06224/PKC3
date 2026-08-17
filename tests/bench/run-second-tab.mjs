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
import { seedEditorArm, fillBody } from './editor-arm.mjs';

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
  /**
   * ⚠ 本文の**用意**は 2 ペイン(split)でやる(#223)── この計器が測るのは
   * 2 枚目のタブの待機と昇格で、**打ち方は測定対象ではない**。
   */
  const ARM = 'split';
  await seedEditorArm(a, ARM);   // ⚠ 最初の goto より前
  await a.goto(`http://localhost:${PORT}/`);
  await a.waitForSelector('[data-pkc-slot="root"][data-pkc-boot="ready"]', { timeout: 60000 });

  for (let i = 0; i < NOTES; i++) {
    await a.click('[data-pkc-action="create-entry"]');
    await a.fill('[data-pkc-field="editor-title"]', `ノート ${i}`);
    await fillBody(a, ARM, body(i, 0));
    await a.click('[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
    await a.waitForSelector('[data-pkc-action="start-edit"]');
  }

  /**
   * ── タブ B: 後から開く → **フォロワーとして開く**(#177 で挙動が変わった)
   *
   * 🔴 **前提の書き換え**(2026-08-17、#223 の実走で判明)。この計器は
   * 「2 枚目は `別のタブで開いています` で**待機する**」を前提にしていたが、
   * #177(2026-08-15)で **2 枚目も普通に使える**ようになったので、その前提は
   * もう成立しない ── 待機を待って **30 秒で落ちていた**。
   * ⚠ 「観測点が死んだ」だけでなく「**主張が死んだ**」型である(CLAUDE.md §1)。
   * 🔑 いまの前提は「**フォロワーとして boot する**」= 保存は本体タブ経由になる。
   *   その証拠(帯の文言)を先に採る ── これが崩れると下の測定は全部無意味である。
   */
  const b = await ctx.newPage();
  b.on('pageerror', (e) => errors.push(`B: ${String(e)}`));
  await b.goto(`http://localhost:${PORT}/`);
  await b.waitForSelector('[data-pkc-slot="root"][data-pkc-boot="ready"]', { timeout: 60000 });
  /**
   * 🔴 **帯は「状態の行」だけで見る**(2026-08-17。初稿は root 全体を見ていた)。
   * ⚠ root で探すと、**お知らせのカード**(2026-08-15 の「保存は本体タブ経由です
   * と画面下に出ます」)に満たされて**常に真**になる ── 昇格して帯が消えても
   * 「消えていない」と読む。実際に 1 回転それで誤った(CLAUDE.md §1)。
   */
  const STATUS = '[data-pkc-region="status"]';
  const badgeOf = async (page) =>
    ((await page.locator(STATUS).textContent()) ?? '').includes('保存は本体タブ経由です');
  await b.waitForFunction(
    (sel) => (document.querySelector(sel)?.textContent ?? '').includes('保存は本体タブ経由です'),
    STATUS,
    { timeout: 30000 },
  );
  const follower = {
    badge: await badgeOf(b),
    booted: await b.locator('[data-pkc-slot="root"]').getAttribute('data-pkc-boot'),
  };
  // 🔴 **前提が成立しているか**(本体として開いたタブを測っても意味がない)
  if (!follower.badge) throw new Error('2 枚目がフォロワーになっていない(帯が出ていない)');
  if (follower.booted !== 'ready') throw new Error(`2 枚目が boot していない: ${follower.booted}`);

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
    await fillBody(a, ARM, body(i, r));
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
  let badgeAfterPromotion = null;
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
    /**
     * 🔴 **帯が消えることも見る**(`main.ts` の「本体経由はもう成立していない」)。
     * ⚠ 消えないと、昇格したのに user は「保存は他のタブ経由」と読み続ける ──
     * **嘘の表示が残る**形で、起動の成否だけでは捕まらない。
     */
    badgeAfterPromotion = await badgeOf(b);
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
        // ⚠ フォロワーとして開いたことの証拠(ここが崩れると下は全部無意味)
        follower,
        secondTabWhileIdle: {
          heapMb: { early: med(early.map((x) => x.heapMb)), late: med(late.map((x) => x.heapMb)) },
          domNodes: { early: med(early.map((x) => x.nodes)), late: med(late.map((x) => x.nodes)) },
        },
        promotion: {
          result: promoted,
          // 🔴 昇格したら「本体タブ経由」の帯は消えていること(嘘を残さない)
          badgeCleared: badgeAfterPromotion === false,
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
