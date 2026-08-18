/**
 * P3-5 probe: 15,000 件 DB + 実アプリで editor を実 UI 経路(クリック / input
 * イベント)で駆動し、以下を確認する。
 *   1. 打鍵(input)の同期コスト p50/p95 ── 小 body と 200KB body の両方
 *      (value 読取は O(body) なので次元を潰さない)
 *   2. 打鍵中に入力欄のノードが作り直されない(編集中ガードの実ブラウザ確認)
 *   3. 保存クリック → view 再描画 → サイドバー行ノード同一性の維持
 * 前提: vite --port 45731 起動済み。persistent profile(実 OPFS)。
 *
 * 🔴 **腕は 2 本ある**(2026-08-17、#221 の巻き添えで判明)。
 *
 *   node tests/probe/run-editor-probe.mjs            # live(既定。user が使う面)
 *   node tests/probe/run-editor-probe.mjs --arm=split # 2 ペイン(設定で選べる面)
 *
 * ⚠ 直すまでこの probe は `textarea not found` で落ちていた。#172(2026-08-14)で
 * **既定がライブ 1 面になり**、全文 textarea(`editor-body`)は設定 `split` の
 * ときにしか出なくなったのに、probe は `editor-body` を掴んだままだったからである。
 * ⚠ しかも **13 晩 1 度も走っていなかった**(手前の sidebar probe が落ちると
 * 後続 step が skip される作りだった)ので、誰も気づかなかった ──
 * CLAUDE.md §2「経路が一度も通っていない」。
 *
 * 🔑 **腕の切替は localStorage の 1 行**(`tests/smoke/helpers.ts` の `useSplitEditor`
 * と同じ作法)。⚠ URL クエリで腕を足さない ── クエリの切替は flag 扱いという
 * 不可侵指示(2026-08-07)に触れる。
 *
 * 🔴 **2 本の数字は連続していない。** split は 1 打鍵ごとに `UPDATE_OPEN_BODY` を
 * 撃つ(`binder.ts` の `isEditorBody`)が、live は**打鍵では state へ届かない**
 * (`row-swap.ts` の `syncActiveBox` ── 届くのは行の確定時)。だから主張も腕ごとに
 * 変える: split は「打鍵が state に載る」、live は「**打鍵では載らず、確定 1 回で
 * 載る**」。⚠ p50/p95 を並べて「速くなった」と言わないこと。
 */
import { chromium } from '@playwright/test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { waitForRows } from './browse-face.mjs';

const PORT = Number(process.env.PKC3_BENCH_PORT ?? 45731);
const PROFILE_DIR =
  process.env.PKC3_PROFILE_DIR ?? join(tmpdir(), 'pkc3-bench-profile');
// ⚠ `??` ではなく `||` ── **空文字を素通りさせない**(CI が path を取れなかった回に
//    「どのブラウザで測ったか分からないまま緑」になるのを止める)
const executablePath = process.env.PKC3_CHROMIUM || '/opt/pw-browsers/chromium';
/**
 * 行を数える器。⚠ 一覧の外の `data-pkc-entry` は**行ではない**(#221)。
 * 🔴 **名指ししない**(#265)── 既定のタブが入れ替わると hidden 側を見て
 * 永久に 0 件になる。`browse-face.mjs` が**見えている面**を解く。
 */
/** @type {string} */
let LIST;

const ARM = (process.argv.find((a) => a.startsWith('--arm=')) ?? '--arm=live').slice(6);
if (ARM !== 'live' && ARM !== 'split') {
  console.error(`usage: run-editor-probe.mjs [--arm=live|--arm=split](渡されたのは ${ARM})`);
  process.exit(2);
}

rmSync(PROFILE_DIR, { recursive: true, force: true });
mkdirSync(PROFILE_DIR, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE_DIR, { executablePath });
try {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  // ⚠ goto の**前に**仕込む(設定は毎回 localStorage を読むので、面を組む前に居ればよい)
  await page.addInitScript((arm) => {
    try {
      // ⚠ `globalThis.` を付ける(この file は node 側の lint 環境で読まれる)
      globalThis.localStorage.setItem('pkc3.editor-mode', arm);
    } catch {
      /* sandbox の frame ── アプリの設定とは無関係 */
    }
  }, ARM);
  await page.goto(`http://localhost:${PORT}/tests/probe/sidebar-probe.html`);
  await page.waitForFunction(() => window.__APP__, null, { timeout: 120_000 });
  LIST = (await waitForRows(page, 15000)).selector;

  await page.evaluate((list) => {
    // 空振り防止 ── 器が無いのに「0 行が同一だった」で緑にしない
    const el = document.querySelector(list);
    if (!el) throw new Error(`${list} が無い ── 観測点が死んでいる`);
    window.__LIST_BEFORE__ = el;
    window.__ROWS_BEFORE__ = Array.from(el.querySelectorAll('[data-pkc-entry]'));
  }, LIST);

  // 実クリックで選択 → 編集開始(binder 経路)
  await page.click(`${LIST} [data-pkc-entry="e42"]`);
  await page.waitForFunction(
    () => window.__APP__.dispatcher.getState().openBody?.lid === 'e42',
    null,
    { timeout: 10_000 },
  );
  await page.click('[data-pkc-action="start-edit"]');

  /**
   * 打ち込む欄まで開く。⚠ **腕で手順が違う**のはここだけである。
   * live は塊ごとに欄が開く作りなので、座標に依存しない「全文を 1 欄」
   * (`edit-all`)で開く ── どの塊を押したかで結果が変わらないようにする。
   */
  let FIELD;
  if (ARM === 'split') {
    await page.waitForSelector('[data-pkc-region="editor-split"] [data-pkc-field="editor-body"]', {
      timeout: 30_000,
    });
    FIELD = '[data-pkc-region="editor-split"] [data-pkc-field="editor-body"]';
  } else {
    // 本文は worker 経由で描かれるので、面の器ではなく**中身**を待つ
    await page.waitForSelector('[data-pkc-region="editor-live"] h1', { timeout: 60_000 });
    await page.click('[data-pkc-field="edit-all"]');
    await page.waitForSelector('[data-pkc-field="row-source"]', { timeout: 30_000 });
    FIELD = '[data-pkc-field="row-source"]';
  }

  // 打鍵計測本体(小 body → 200KB body の 2 段)
  const result = await page.evaluate(
    async ({ field, arm }) => {
      const d = window.__APP__.dispatcher;
      const ta0 = document.querySelector(field);
      if (!ta0) return { error: `入力欄が見つからない: ${field}` };
      const bodyLen = () => d.getState().openBody?.body?.length ?? -1;

      // withDispatch=false が対照群: value append(DOM 書込)だけを行う。
      // 差分の向きが「input handler(value 読取 + reduce + listener 群)」の寄与
      const typeBatch = (ta, n, withDispatch) => {
        const durs = [];
        for (let i = 0; i < n; i++) {
          const t0 = performance.now();
          ta.value += 'あ';
          if (withDispatch)
            ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
          durs.push(performance.now() - t0);
        }
        durs.sort((a, b) => a - b);
        const pick = (q) => durs[Math.min(durs.length - 1, Math.floor(durs.length * q))];
        return {
          n,
          p50: +pick(0.5).toFixed(3),
          p95: +pick(0.95).toFixed(3),
          max: +durs[durs.length - 1].toFixed(3),
        };
      };

      const lenBeforeTyping = bodyLen();
      const small = typeBatch(ta0, 300, true);
      const sameNodeAfterSmall = document.querySelector(field) === ta0;
      /**
       * 🔴 **腕ごとに主張が違う**(この file 冒頭)。
       * split: 1 打鍵 = 1 dispatch なので、state の長さが欄と一致する。
       * live : 打鍵では state へ**届かない**のが設計値 ── 届いていたら、
       *        「行の確定でまとめて書き戻す」という作りのほうが壊れている。
       */
      const stateSyncedSmall = bodyLen() === ta0.value.length;
      const stateUntouchedWhileTyping = bodyLen() === lenBeforeTyping;

      // 200KB body 次元(value 読取が O(body) ── ゼロ次元を作らない)
      ta0.value = 'x'.repeat(200_000);
      ta0.dispatchEvent(new InputEvent('input', { bubbles: true }));
      const largeControl = typeBatch(ta0, 300, false); // 対照: append のみ
      const large = typeBatch(ta0, 300, true);
      const sameNodeAfterLarge = document.querySelector(field) === ta0;

      return {
        arm,
        small,
        large,
        largeControl,
        sameNodeAfterSmall,
        sameNodeAfterLarge,
        stateSyncedSmall,
        stateUntouchedWhileTyping,
        valueLen: ta0.value.length,
      };
    },
    { field: FIELD, arm: ARM },
  );

  /**
   * live は**行を確定**して初めて state へ届く(`row-swap.ts` の `commitActive`)。
   * ⚠ ここが届かないと「打鍵が保存されない」= 実害そのものなので、腕 live では
   *    **確定 1 回で届くこと**を後条件にする。
   */
  let committedByRowCommit = null;
  if (ARM === 'live' && !result.error) {
    await page.keyboard.press('Tab');
    /**
     * ⚠ **下限ではなく等値で見る**(2026-08-17 のレビュー ⚠-7)。`>= 200_000` だと
     * 末尾 600 字が落ちても、本文が 2 重(401,200 字)になっても真になる ──
     * この probe が通すのは `commitActive` の **行数が変わる枝**(1 行が 3 行の塊を
     * 置き換える)で、実装のコメント自身が「古い座標で無関係な行を潰す」危険を
     * 書いている場所である。長さの下限では、その事故を 1 つも捕まえない。
     */
    committedByRowCommit = await page.evaluate(async (want) => {
      for (let i = 0; i < 100; i++) {
        const len = window.__APP__.dispatcher.getState().openBody?.body?.length ?? 0;
        if (len === want) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return window.__APP__.dispatcher.getState().openBody?.body?.length ?? 0;
    }, result.valueLen);
  }

  // 保存(実クリック)→ view 復帰 → サイドバー行同一性
  // ⚠ `commit-edit` は**追記帯にも在る**(`append-box.ts`)。detail に絞る
  const t0 = Date.now();
  await page.click('[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForFunction(
    () => document.querySelector('[data-pkc-field="detail-body"]') !== null,
    null,
    { timeout: 30_000 },
  );
  const commitToViewMs = Date.now() - t0;

  const post = await page.evaluate(async (list) => {
    await new Promise((r) => setTimeout(r, 300)); // persist 完了待ち
    // 🔴 器ごと作り直されたら「行は同一」が嘘の緑になる ── 毎回引き直す(#221)
    const listNow = document.querySelector(list);
    const listSameNode = listNow === window.__LIST_BEFORE__;
    const after = listNow ? Array.from(listNow.querySelectorAll('[data-pkc-entry]')) : [];
    const before = window.__ROWS_BEFORE__;
    let identical = after.length === before.length;
    if (identical) {
      for (let i = 0; i < after.length; i++) {
        if (after[i] !== before[i]) { identical = false; break; }
      }
    }
    const s = window.__APP__.dispatcher.getState();
    return {
      rowsIdenticalThroughEditCycle: identical,
      listSameNode,
      // ⚠ `?.` だけだと **openBody が無い回に `undefined === undefined` で真**になる
      //    (保存後に本文を失う退行が緑で通る。2026-08-17 のレビュー ⚠-8)
      persistedAck: s.openBody != null && s.openBody.persisted === s.openBody.body,
      phase: s.phase,
      storageVfs: window.__APP__.storageVfs,
      // 診断 ── 一覧の外に居る `data-pkc-entry` の数(#221 で赤かった当の理由)
      entryAttrsOutsideList: document.querySelectorAll('[data-pkc-entry]').length - after.length,
    };
  }, LIST);

  const armOk =
    ARM === 'split'
      ? result.stateSyncedSmall === true
      : result.stateUntouchedWhileTyping === true && committedByRowCommit === true;
  const ok =
    !result.error &&
    armOk &&
    result.sameNodeAfterSmall &&
    result.sameNodeAfterLarge &&
    post.rowsIdenticalThroughEditCycle &&
    post.listSameNode &&
    post.persistedAck &&
    post.phase === 'ready' &&
    post.storageVfs === 'opfs-sahpool';
  console.log(
    JSON.stringify({ ok, arm: ARM, typing: result, committedByRowCommit, commitToViewMs, post }, null, 2),
  );
  process.exitCode = ok ? 0 : 1;
} finally {
  await context.close();
  rmSync(PROFILE_DIR, { recursive: true, force: true });
}
