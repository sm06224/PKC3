/**
 * 計器から**本文を打ち込む口**(#223、2026-08-17)。
 *
 * 🔴 直すまで bench 4 本が動かなかった。#172(2026-08-14)で**既定の編集面が
 * ライブ 1 面になり**、全文 textarea(`editor-body`)は設定 `split` のときしか
 * 出ないのに、bench は `page.fill('[data-pkc-field="editor-body"]', …)` を
 * 掴んだままだった ── 既定では要素が無く **timeout / `null` に触って死ぬ**。
 * ⚠ bench は CI で走らないので、こちらの計器は 1 つも鳴らなかった(#221 で
 * probe を直したときに、同型の反対側として数え上げて見つけた)。
 *
 * 🔑 **腕の切替は `localStorage` の 1 行**(`tests/smoke/helpers.ts` の
 * `useSplitEditor` / `tests/probe/run-editor-probe.mjs` と同じ作法)。
 * ⚠ **URL クエリで腕を足さない** ── クエリの切替は flag 扱いという不可侵指示
 * (2026-08-07)に触れる。
 *
 * ⚠ **腕は「測る対象」と「仕込みの手段」を区別して選ぶ。**
 *   - 編集そのものの定常を測る計器(`run-app-session`)は **既定(live)**を測る
 *     ── user が使う面を測らないなら、その数字は user の体感を語れない
 *   - 本文を用意したいだけの計器(`run-raster-cap` / `run-second-tab`)は **split**
 *     で仕込む ── 打ち方は測定対象ではないので、決定的で速い側を使う
 */

/** `--arm=live|split` を読む(既定は user が使う面 = live)。 */
export function armFrom(argv) {
  const hit = argv.find((a) => a.startsWith('--arm='));
  const arm = hit ? hit.slice(6) : 'live';
  if (arm !== 'live' && arm !== 'split') throw new Error(`--arm は live か split(${arm})`);
  return arm;
}

/**
 * 腕を仕込む。⚠ **最初の `goto` より前に呼ぶ** ── 面を組んだ後に書いても、
 * その回の編集は前の設定で開く(#223 で `run-live-editor` が実際にそうなっていた:
 * 仕込みの goto が既定 live で走り、`editor-body` を掴んで死んでいた)。
 */
export async function seedEditorArm(page, arm) {
  await page.addInitScript((a) => {
    try {
      globalThis.localStorage.setItem('pkc3.editor-mode', a);
    } catch {
      /* sandbox の frame ── アプリの設定とは無関係 */
    }
  }, arm);
}

/**
 * 開いている編集面に本文を入れる(**確定はしない** ── 呼び側が `commit-edit` を押す)。
 *
 * ⚠ live では **打鍵は state へ届かない**(`row-swap.ts` の `syncActiveBox`)ので、
 * 行を確定(`Tab`)して初めて本文が state に入る。ここまでを 1 つの口に閉じる ──
 * 呼び側が腕を意識すると、片方の腕だけ確定を忘れて**黙って空のノートを作る**。
 */
export async function fillBody(page, arm, text) {
  if (arm === 'split') {
    await page.fill('[data-pkc-region="editor-split"] [data-pkc-field="editor-body"]', text);
    return;
  }
  // ライブ 1 面 ── 「全文を編集」で 1 欄にする(座標に依らない・決定的)
  await page.waitForSelector('[data-pkc-field="edit-all"]', { timeout: 60_000 });
  await page.click('[data-pkc-field="edit-all"]');
  await page.waitForSelector('[data-pkc-field="row-source"]', { timeout: 60_000 });
  await page.evaluate((t) => {
    const ta = document.querySelector('[data-pkc-field="row-source"]');
    if (!ta) throw new Error('row-source が無い ── 観測点が死んでいる');
    ta.value = t;
    ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, text);
  // 行の確定 → ここで初めて本文が state に届く
  await page.keyboard.press('Tab');
}
