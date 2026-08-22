/**
 * PKC3 計器: **開いた窓が「出ましたよ」と返すまでの時間**(#300 段③、2026-08-22)。
 *
 * ## なぜ測るのか
 *
 * 別窓は `noopener` で開くので **戻り値が常に `null`**(塞がれても分からない)。
 * だから「合図(URL の `w=`)を持たせて返させる」形にし、返らなければ
 * **中央の面へ退避する**。⚠ その猶予 `VIEW_WINDOW_ANNOUNCE_MS` を
 * **勘で置いてはいけない** ── 短すぎると、**開けているのに退避する**
 * (= 本文が消える + 「塞がれました」という嘘の案内)。これは user の苦情
 * そのものの再現である。長すぎると、本当に塞がれた user が無反応で待たされる。
 *
 * ## 何を測るか
 *
 * `window.open` を撃った瞬間から、`pkc3-view-window` の放送に合図が返るまで。
 * ⚠ 合図は `main.ts` の**いちばん最初**(storage の初期化より前)で撃つので、
 * ここに含まれるのは「窓が出て bundle が動き出すまで」だけである。
 *
 * ⚠ **対照群を先頭に置く** ── 同じ手順を**タブ**でも通す。窓側だけ遅い / 速いを
 * 見分けるためであり、**対照群が届かない回は結果を読まない**(判定不能と書く)。
 *
 * ## 🔴 実測(2026-08-22。profile を作り直して 5 回 × 2 群)
 *
 * | | 合図が返るまで |
 * |---|---|
 * | 対照群(タブ) | 127 / 153 / 116 / 96 / 85 ms(最大 **153**) |
 * | 別窓(`noopener`) | 151 / 154 / 97 / 90 / 97 ms(最大 **154**) |
 *
 * 🔑 **窓はタブと見分けがつかない**(段① の常駐の実測と同じ向き)。
 * 🔑 `VIEW_WINDOW_ANNOUNCE_MS = 2500` は最大値の **約 16 倍**の余裕がある。
 * 🔑 **対照群は 5/5 届いた** ── だからこの計器は空振りしていない。
 *
 * ⚠ **測っていないこと**:初回訪問(bundle が cache に無い)/ 実機の遅い端末 /
 *   アプリとして入れた窓(PWA)/ 窓が多数のとき。⚠ ここが 2.5 秒を超えると
 *   **開けているのに退避する**(本文が消える + 嘘の案内)ので、
 *   そういう報告が来たらこの定数を上げる ── **下げてはいけない**。
 * ⚠ 逆に**誤って「開いた」と読む**ことは、合図にした時点で原理的に起きない
 *   (自分の窓しか答えられない)。だから**余裕は上へ倒してよい**。
 *
 * 使い方(dist を preview で配ってから):
 *   npm run build && npx vite preview --port 45744 &
 *   node tests/probe/run-view-window-probe.mjs --port=45744
 */
import { chromium } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? '1'];
  }),
);
const PORT = Number(args.port ?? 45744);
const ROUNDS = Number(args.rounds ?? 5);
const URL = `http://127.0.0.1:${PORT}/`;
const PROFILE = '/tmp/pkc3-view-window-probe';

/** 合図が返るまでの ms を 1 回測る。⚠ 聞く耳は**開くより前**に張る。 */
async function once(page, kind) {
  const token = `probe-${kind}-${Math.floor(performance.now() * 1000)}`;
  return page.evaluate(
    async ([url, tok, k]) => {
      const ch = new BroadcastChannel('pkc3-view-window');
      const started = performance.now();
      const answered = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 30_000);
        ch.onmessage = (ev) => {
          if (ev.data?.kind === 'view-window-open' && ev.data.token === tok) {
            clearTimeout(timer);
            resolve(performance.now() - started);
          }
        };
      });
      const target = `${url}#pkc?view=calendar&w=${tok}`;
      // ⚠ 対照群(タブ)は `noopener` を付けない ── そこだけが違う
      const win = window.open(target, '_blank', k === 'window' ? 'noopener' : '');
      const ms = await answered;
      ch.close();
      return { ms, handle: win !== null };
    },
    [URL, token, kind],
  );
}

async function group(kind) {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: process.env.PKC3_CHROMIUM || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox'],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(URL);
  await page.locator('[data-pkc-boot="ready"]').waitFor({ timeout: 60_000 });
  const out = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    const r = await once(page, kind);
    out.push(r.ms);
    // 開いた窓は毎回閉じる(常駐が積まないように ── 段① の実測と同じ作法)
    for (const p of ctx.pages()) if (p !== page) await p.close();
  }
  await ctx.close();
  rmSync(PROFILE, { recursive: true, force: true });
  return out;
}

const tab = await group('tab');
const win = await group('window');
const fmt = (xs) =>
  xs.some((x) => x === null)
    ? `届かなかった回がある: ${JSON.stringify(xs)}`
    : `${xs.map((x) => Math.round(x)).join(' / ')} ms(最大 ${Math.round(Math.max(...xs))})`;
console.log('--- 結果 ---');
console.log(`対照群(タブ)  : ${fmt(tab)}`);
console.log(`別窓(noopener): ${fmt(win)}`);
if (tab.some((x) => x === null)) console.log('⚠ 対照群が届かなかった ── 判定不能。結果を読まない');
