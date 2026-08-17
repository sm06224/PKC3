/**
 * P3-2 DoD probe: 15,000 件 seed 済み DB で実アプリを boot し、
 * 選択(実クリック)→ 編集開始 → 入力 → 確定 を通して
 * **サイドバー行の DOM ノードが 1 つも作り直されない**ことを assert する。
 * 前提: vite --port 45731 起動済み。persistent profile(実 OPFS)。
 *
 * 🔴 **観測点はサイドバーの一覧の中だけ**(2026-08-17、#221)。
 *
 * 直す前は `document.querySelectorAll('[data-pkc-entry]')` と **document 全体**を
 * 数えていた。P8(#59)で情報ペインが入り、`inspector.ts` が「書き出す / 履歴 /
 * 削除」の 3 ボタンに **`data-pkc-entry` を書く**ようになったので、**選択した瞬間に
 * 3 件増える** ── 行を 1 つも作り直していなくても「作り直された」に見えた。
 * 実測(2026-08-17): 増えた 3 件は全部 `aside[data-pkc-region="inspector"]` の中の
 * `<button>`。同じ回で一覧の中の 15,000 行は**全ノード同一**だった。
 * ⚠ この空振りで nightly が **2026-08-04 から赤**(走った 11 回転すべて)で、
 *   後続の editor / kanban probe は **13 晩 skip** されていた。
 * 🔑 CLAUDE.md §1「範囲が広すぎて無関係なものに満たされる」/ §4「観測点の選び方」。
 */
import { chromium } from '@playwright/test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PORT = Number(process.env.PKC3_BENCH_PORT ?? 45731);
const PROFILE_DIR =
  process.env.PKC3_PROFILE_DIR ?? join(tmpdir(), 'pkc3-bench-profile');
// ⚠ `??` ではなく `||` ── **空文字を素通りさせない**(CI が path を取れなかった回に
//    「どのブラウザで測ったか分からないまま緑」になるのを止める)
const executablePath = process.env.PKC3_CHROMIUM || '/opt/pw-browsers/chromium';
/** 行を数える器。⚠ ここより外の `data-pkc-entry` は**行ではない**(上のコメント)。 */
const LIST = '[data-pkc-region="entry-list"]';

rmSync(PROFILE_DIR, { recursive: true, force: true });
mkdirSync(PROFILE_DIR, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE_DIR, { executablePath });
try {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`http://localhost:${PORT}/tests/probe/sidebar-probe.html`);
  await page.waitForFunction(() => window.__APP__, null, { timeout: 120_000 });
  await page.waitForFunction(
    (list) => document.querySelectorAll(`${list} [data-pkc-entry]`).length >= 15000,
    LIST,
    { timeout: 60_000 },
  );

  const steps = await page.evaluate(async (list) => {
    const t0 = window.__BOOT_T0__;
    const bootToRowsMs = Math.round(performance.now() - t0);
    // 空振り防止 ── 器が見つからないのに「0 行が同一だった」で緑にしない
    const el = document.querySelector(list);
    if (!el) throw new Error(`${list} が無い ── 観測点が死んでいる`);
    const rows = Array.from(el.querySelectorAll('[data-pkc-entry]'));
    // 行ノードの同一性を後で照合するため WeakSet ではなく直接参照で保持
    window.__LIST_BEFORE__ = el;
    window.__ROWS_BEFORE__ = rows;
    /**
     * 🔴 **同一性だけでは「remove して同じ順に入れ直す」を弁別できない**
     * (2026-08-17 のレビュー ⚠-11)。この repo は unit 側で **999 move が
     * identity assert を全通過した**実証を持っており(`tests/adapter/
     * sidebar-render.test.ts` の `countMoves`)、15,000 行・実ブラウザという
     * この probe の固有の価値はまさに **move の数**である。
     * 🔑 2026-08-17 に**この構成で 0 を実測**したうえで後条件へ昇格させた
     * (CLAUDE.md「通ったのを見てから後条件へ昇格させる」)。
     */
    window.__LIST_MUTATIONS__ = 0;
    // ⚠ `globalThis.` を付ける(この file は node 側の lint 環境で読まれる)
    const obs = new globalThis.MutationObserver((recs) => {
      for (const r of recs)
        window.__LIST_MUTATIONS__ += r.addedNodes.length + r.removedNodes.length;
    });
    obs.observe(el, { childList: true }); // ⚠ subtree は見ない(行の中の文字は対象外)
    return { rowCount: rows.length, bootToRowsMs };
  }, LIST);

  // 実クリックで選択(binder 経路を通す)
  // ⚠ **一覧の中の行**を押す ── `page.click` は最初の一致を採り、それが不可視だと
  //    別の一致へ移らずに待ち続ける(`data-pkc-entry` はファイラ・検索・情報ペインも書く)
  await page.click(`${LIST} [data-pkc-entry="e42"]`);
  await page.waitForFunction(
    () => window.__APP__.dispatcher.getState().openBody?.lid === 'e42',
    null,
    { timeout: 10_000 },
  );

  const result = await page.evaluate(async (list) => {
    const d = window.__APP__.dispatcher;
    const until = async (pred) => {
      for (let i = 0; i < 100; i++) {
        if (pred(d.getState())) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };
    d.dispatch({ type: 'START_EDIT' });
    d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '# entry 42\n\n編集後の本文' });
    d.dispatch({ type: 'COMMIT_EDIT' });
    await new Promise((r) => setTimeout(r, 300)); // persist 完了待ち
    /**
     * 🔴 **器そのものが作り直されていないか**も見る。`__LIST_BEFORE__` の子を
     * 数えると、器ごと差し替えられたとき**外れた古い器**を数えて「全部同一」に
     * なる ── 空振りの作り方そのものなので、**毎回 document から引き直す**。
     */
    const listNow = document.querySelector(list);
    const listSameNode = listNow === window.__LIST_BEFORE__;
    const after = listNow ? Array.from(listNow.querySelectorAll('[data-pkc-entry]')) : [];
    const before = window.__ROWS_BEFORE__;
    let identical = after.length === before.length;
    if (identical) {
      for (let i = 0; i < after.length; i++) {
        if (after[i] !== before[i]) {
          identical = false;
          break;
        }
      }
    }
    // DB 到達の実証(review D-3): 別 entry を経由して再読込し、DB から
    // 編集後の本文が返ることを確認(楽観 baseline でなく実 roundtrip)
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e43' });
    await until((s) => s.openBody?.lid === 'e43');
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e42' });
    await until((s) => s.openBody?.lid === 'e42');
    const state = d.getState();
    return {
      rowsIdenticalThroughEditCycle: identical,
      listSameNode,
      rowCountAfter: after.length,
      // ⚠ 選択の印も**一覧の中の行**で見る(情報ペインのボタンも同じ属性を持つので、
      //   document 全体で引くと**行ではないもの**を先に拾いうる)
      selectedMarked:
        listNow
          ?.querySelector('[data-pkc-entry="e42"]')
          ?.hasAttribute('data-pkc-selected') ?? false,
      persistedRoundtrip: state.openBody?.body?.includes('編集後') ?? false,
      storageVfs: window.__APP__.storageVfs,
      phase: state.phase,
      /**
       * 診断 ── 一覧の**外**に居る `data-pkc-entry` の数(この probe が
       * 2026-08-04 から赤かった当の理由)。⚠ **assert しない**: 実装が変われば
       * 0 にもなりうる「未確認の量」なので、値を出して次の回転で読む
       * (CLAUDE.md「未確認は assert ではなく診断で出す」)。
       */
      entryAttrsOutsideList:
        document.querySelectorAll('[data-pkc-entry]').length - after.length,
      /** 選択 → 編集 → 確定の間に一覧の**直下の子**が出入りした数(期待 0)。 */
      listChildMutations: window.__LIST_MUTATIONS__,
    };
  }, LIST);

  const ok =
    steps.rowCount === 15000 &&
    result.rowsIdenticalThroughEditCycle &&
    // 🔑 2026-08-17 に **0 を実測**したので後条件へ昇格させた(同一性だけでは
    //    「外して同じ順に入れ直す」= move を弁別できない)
    result.listChildMutations === 0 &&
    result.listSameNode &&
    result.selectedMarked &&
    result.persistedRoundtrip &&
    result.storageVfs === 'opfs-sahpool' &&
    result.phase === 'ready';
  console.log(JSON.stringify({ ok, steps, result }, null, 2));
  process.exitCode = ok ? 0 : 1;
} finally {
  await context.close();
  rmSync(PROFILE_DIR, { recursive: true, force: true });
}
