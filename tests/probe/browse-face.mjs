/**
 * 🔴 **probe は「いま見えている一覧の面」を測る**(2026-08-18、#265)。
 *
 * ## なぜ要ったか
 *
 * 3 本の probe(sidebar / editor / kanban)は器を
 * 「一覧」タブの器(`entry-list`)と**名指し**していた。ところが #259 で
 * **既定のタブがフォルダ(`filer-table`)になった** ── 一覧の器は
 * `hidden` で常駐する側に回り、**行が永久に 0 件**になる
 * (その器自体は #813 段③ で外した)。
 * 症状は「60 秒 待って timeout」で、原因はどこにも書かれない。
 * 実測(2026-08-18): `entry-list` = hidden / 0 行、`filer-table` = 表示 / 15000 行。
 *
 * ⚠ これは #221 で直した「document 全体で数えていた」の**裏返し**である。
 * あのとき観測点を面へ絞ったのは正しかったが、**絞った先の面が既定から外れた**
 * ときに気づく仕掛けが無かった(CLAUDE.md §4「観測点の選び方」)。
 *
 * ## 何を条件にするか
 *
 * 🔑 **代替物で満たせない条件**にする ── 「どれか 1 つが見えている」だけだと、
 * 面が 1 つ消えても残った方に救われる。だから:
 *
 * 1. 既知の面が **2 つとも DOM に在る**(片方が消えたら落とす)
 * 2. そのうち **見えているのはちょうど 1 つ**(両方見えている / 両方隠れているは異常)
 *
 * ⚠ 「見えている」は `hidden` 属性ではなく **`getClientRects()`** で採る ──
 * 面は `hidden` でも CSS でも隠れうるので、**画面に出ているか**を直に見る。
 */

/**
 * 一覧の面(タブで入れ替わる)。⚠ 増えたらここに足す ── 名指しはここ 1 か所。
 * 🔴 かつては `['entry-list', 'filer-table']` の 2 面だったが、「一覧」タブは #813 段③ で
 *   外した ── いまは `filer-table` 1 つである(面が複数のときの「ちょうど 1 つ見えている」
 *   の判断は `faces` 引数で残してあり、`tests/adapter/probe-browse-face.test.ts` が見る)。
 */
export const LIST_FACES = ['filer-table'];

/**
 * いま見えている一覧の面を解く。
 * @param {import('@playwright/test').Page} page
 * @param {readonly string[]} [faces] ⚠ 既定は `LIST_FACES`。test が複数の面で判断を見るために差せる
 * @returns {Promise<{ region: string, selector: string }>}
 */
export async function resolveListFace(page, faces = LIST_FACES) {
  const seen = await page.evaluate((faces) => {
    return faces.map((region) => {
      const el = document.querySelector(`[data-pkc-region="${region}"]`);
      return {
        region,
        present: el !== null,
        // ⚠ `instanceof HTMLElement` は使わない(この file は node 側の lint 環境でも
        //    読まれる)。`getClientRects` は Element が必ず持つ
        visible: el !== null && el.getClientRects().length > 0,
      };
    });
  }, [...faces]);

  const missing = seen.filter((f) => !f.present).map((f) => f.region);
  if (missing.length > 0) {
    throw new Error(
      `一覧の面が DOM に無い: ${missing.join(', ')} ── ` +
        `名前が変わったか、面ごと消えた(${faces.join(' / ')} を見直すこと)`,
    );
  }
  const visible = seen.filter((f) => f.visible).map((f) => f.region);
  if (visible.length !== 1) {
    throw new Error(
      `見えている一覧の面が ${visible.length} 個(1 個であるべき): ` +
        `[${visible.join(', ')}] ── 観測点が決まらないので測らない`,
    );
  }
  const region = visible[0];
  return { region, selector: `[data-pkc-region="${region}"]` };
}

/**
 * 🔴 **一覧の行を指す selector を、いま見えている面から組む**(2026-08-22、#300 段①)。
 *
 * ⚠ この helper は 2026-08-18 に **probe 3 本のために**書かれたが、
 * **bench 4 本は名指しのまま残っていた** ── `run-app-session` / `run-live-editor` /
 * `run-raster-cap` / `run-second-tab` は全部 一覧の器の名指しを
 * 直に書いており、既定がフォルダになった日から**行を 1 つも掴めない**。
 * 実測(2026-08-22): `run-second-tab.mjs --rounds=1 --notes=1` は
 * `locator.click: Timeout 30000ms exceeded` で落ちる。
 * ⚠ bench は CI で走らないので、**こちらの計器は 1 つも鳴らなかった**
 * (CLAUDE.md「片側を直したら、対称の反対側を必ず疑う」)。
 *
 * 🔑 だから名指しを**この 1 か所**に閉じる。
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} [archetype] `text` / `attachment` など。省略すると種類を問わない
 * @returns {Promise<string>} 行を指す selector
 */
export async function listRowsSelector(page, archetype) {
  const face = await resolveListFace(page);
  const kind = archetype ? `[data-pkc-archetype="${archetype}"]` : '';
  return `${face.selector} [data-pkc-entry]${kind}`;
}

/**
 * 面を解いて、**全件が state に載り、見えている塊の行が組み上がって落ち着く**のを待つ。
 * ⚠ **どの面で測ったかを必ず印字する** ── 既定が入れ替わったとき、
 *   数字だけ見て「同じものを測り続けている」と誤読しないため。
 *
 * 🔴 **DOM の行の数で全件を待たない**(2026-11-08、#1928)。#1924(2026-10-30)で一覧は
 *   `ROW_CHUNK`(50 行)ずつの塊に分かれ、**見えている前後の塊だけ**行を組むようになった
 *   (`src/adapter/ui/render/filer.ts`)。15,000 行を DOM で待つ旧い形は二度と満たされず、
 *   probe 3 本(sidebar / editor / schedule)が 60 秒待って毎晩赤だった。
 * 🔑 だから見るものを 2 つに分ける:
 *   ① 件数 ── **state**(`entryMetas.size`)が `rows` 件に達したこと
 *   ② 描画 ── 見えている面に行が組まれ(`mustShow` の行を含む)、**組まれた行の数が 400ms 動かない**こと
 *     (塊を組むのは配置の後なので、組み上がる途中で行を握ると、後の同一性の比較が「数が違う」で空振りする)
 * ⚠ 組まれた行の数が `rows` 以上なら、**塊に分ける仕組みが効いていない**(全部組んでいる)── 落とす。
 *   ここを黙って通すと、仮想化が外れた退行を probe が見逃す。
 * @param {import('@playwright/test').Page} page
 * @param {number} rows 期待する件数(state に載る件数)
 * @param {number} timeout ms
 * @param {{ mustShow?: string }} [opts] 組まれているべき行の lid(先頭の塊に居るはずのもの)
 * @returns {Promise<{ region: string, selector: string, stateCount: number, renderedRows: number }>}
 */
export async function waitForRows(page, rows, timeout = 60_000, opts = {}) {
  const face = await resolveListFace(page);
  console.log(`[probe] 一覧の面: ${face.region}(state に ${rows} 件、見えている塊の行を待つ)`);
  await page.waitForFunction(
    (n) => (window.__APP__?.dispatcher.getState().entryMetas?.size ?? 0) >= n,
    rows,
    { timeout },
  );
  const handle = await page.waitForFunction(
    ([sel, lid]) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const n = el.querySelectorAll('[data-pkc-entry]').length;
      if (n === 0) return false;
      if (lid && !el.querySelector(`[data-pkc-entry="${lid}"]`)) return false;
      const now = performance.now();
      const w = /** @type {any} */ (window);
      if (w.__PROBE_ROWS_N__ !== n) {
        w.__PROBE_ROWS_N__ = n;
        w.__PROBE_ROWS_AT__ = now;
        return false;
      }
      return now - w.__PROBE_ROWS_AT__ >= 400 ? n : false;
    },
    [face.selector, opts.mustShow ?? null],
    { timeout, polling: 100 },
  );
  const renderedRows = /** @type {number} */ (await handle.jsonValue());
  const stateCount = await page.evaluate(() => window.__APP__.dispatcher.getState().entryMetas.size);
  console.log(`[probe] state ${stateCount} 件 / 組まれた行 ${renderedRows}`);
  if (renderedRows >= rows) {
    throw new Error(
      `組まれた行が ${renderedRows}(全 ${rows} 件以上)── 塊に分けて画面の外を組まない仕組み(#1924)が効いていない`,
    );
  }
  return { ...face, stateCount, renderedRows };
}
