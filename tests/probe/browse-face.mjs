/**
 * 🔴 **probe は「いま見えている一覧の面」を測る**(2026-08-18、#265)。
 *
 * ## なぜ要ったか
 *
 * 3 本の probe(sidebar / editor / kanban)は器を
 * `[data-pkc-region="entry-list"]` と**名指し**していた。ところが #259 で
 * **既定のタブがフォルダ(`filer-table`)になった** ── `entry-list` は
 * `hidden` で常駐する側に回り、**行が永久に 0 件**になる。
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

/** 一覧の面(タブで入れ替わる)。⚠ 増えたらここに足す ── 名指しはここ 1 か所。 */
export const LIST_FACES = ['entry-list', 'filer-table'];

/**
 * いま見えている一覧の面を解く。
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ region: string, selector: string }>}
 */
export async function resolveListFace(page) {
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
  }, LIST_FACES);

  const missing = seen.filter((f) => !f.present).map((f) => f.region);
  if (missing.length > 0) {
    throw new Error(
      `一覧の面が DOM に無い: ${missing.join(', ')} ── ` +
        `名前が変わったか、面ごと消えた(${LIST_FACES.join(' / ')} を見直すこと)`,
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
 * `run-raster-cap` / `run-second-tab` は全部 `[data-pkc-region="entry-list"] …` を
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
 * 面を解いて、そこに行が出そろうのを待つ。
 * ⚠ **どの面で測ったかを必ず印字する** ── 既定が入れ替わったとき、
 *   数字だけ見て「同じものを測り続けている」と誤読しないため。
 * @param {import('@playwright/test').Page} page
 * @param {number} rows 期待する最小の行数
 * @param {number} timeout ms
 */
export async function waitForRows(page, rows, timeout = 60_000) {
  const face = await resolveListFace(page);
  console.log(`[probe] 一覧の面: ${face.region}(${rows} 行を待つ)`);
  await page.waitForFunction(
    ([sel, n]) => document.querySelectorAll(`${sel} [data-pkc-entry]`).length >= n,
    [face.selector, rows],
    { timeout },
  );
  return face;
}
