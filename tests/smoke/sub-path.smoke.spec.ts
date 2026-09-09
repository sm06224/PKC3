import { expect, test } from '@playwright/test';
import { bootedHere, clickReal, collectPageErrors, createEntry, dismissAnnounce } from './helpers';

/**
 * #532 S1: **どこに置いても動く**ことを、実際に置いて確かめる。
 *
 * 🔴 PKC3 は `vite.config.ts` の `base: './'`(相対)に**全面的に依存**している ──
 * Pages の `/` と `/dev/`、そしてセルフホスト(#532)は、どれも
 * 「配置場所を知らないビルドを、任意の場所へ置く」形である。
 * ⚠ ところが 2026-09-09 まで、それを見る smoke は **0 件**だった
 * (既存の 2 本の server は**どちらも根で配る**ので、絶対 path で参照していても通る)。
 *
 * ## 🔑 空振りしない形にする ── **根を 404 にする server で配る**
 *
 * ⚠ 素直に「prefix を剥がして配る」server を書くと、この spec は**何も守らない**:
 * `/assets/x.js` という絶対参照も、剥がす前に根で当たって**通ってしまう**
 * (CLAUDE.md §1「救い手が変わっただけ」)。
 * 🔑 だから sub-path 用の server は **prefix の外を 404 にする**。
 * その前提を spec の先頭で**実際に叩いて確かめる** ── 確かめないと、
 * うっかり根も配る server を指したときに嘘の合格を出す。
 *
 * ⚠ **静的な対は `scripts/dist-inspect.mjs`**(生成物に絶対 path が混ざったら落とす)。
 *   こちらは**実際に配って動かす**側で、`office-pack` のような
 *   「実行時に組み立てる URL」まで含めて見る ── 3 段構えの 3 段目である
 *   (config → 生成物 → 実配信)。
 */

type Info = { config: { metadata?: Record<string, unknown> } };

/** ⚠ 既定の baseURL(preview = 根で配る)ではなく、**sub-path の server** を見る。 */
function subBase(testInfo: Info): { origin: string; prefix: string } {
  const origin = testInfo.config.metadata?.subPathBaseURL;
  const prefix = testInfo.config.metadata?.subPathPrefix;
  if (typeof origin !== 'string' || typeof prefix !== 'string') {
    throw new Error('subPathBaseURL / subPathPrefix が config に無い');
  }
  return { origin, prefix };
}

test('🔴 根を配らない場所(sub-path)に置いても、PKC3 は起動して書ける (#532 S1)', async ({
  page,
}, testInfo) => {
  const errors = collectPageErrors(page);
  const { origin, prefix } = subBase(testInfo);

  // 🔑 prefix の外へ出た要求を控える(落ちた回に理由を添えるため)
  const outside: string[] = [];
  page.on('response', (r) => {
    const u = r.url();
    if (u.startsWith(origin) && !u.startsWith(origin + prefix)) outside.push(`${r.status()} ${u}`);
  });

  /**
   * ── ① **前提を先に固める。** この server は prefix の外を配らない。
   * ⚠ これが無いと、絶対参照(`/assets/…`)が根で当たって**素通りする** ──
   *   そのとき spec は「どこに置いても動く」と**嘘の報告**をする。
   */
  const atRoot = await page.request.get(`${origin}/index.html`);
  expect(atRoot.status(), 'sub-path server が根まで配っている ── 検査が空振りする').toBe(404);
  expect(
    (await page.request.get(`${origin}${prefix}index.html`)).status(),
    'sub-path に index.html が無い',
  ).toBe(200);
  /**
  /**
   * ⚠ **門を、いちばん破りやすい形で確かめる。** prefix を「長さで剥がす」実装は、
   * **prefix と同じ長さの別の頭**を、うっかり配ってしまう ──
   * `/zzz/index.html` は 4 文字を落とすと `/index.html` に化ける。
   * そのとき「根は 404」は**偶然の文字列ずれ**で成り立っているだけで、門は死んでいる
   * (CLAUDE.md §1「救い手が変わっただけ」)。
   * 🔴 **長さは prefix から作る** ── `/zzzz/` のように 1 文字でもずれると、
   *   門が無くても 404 になり、この検査は**何も見なくなる**(実際 1 度そう書いて、
   *   変異が生き延びた)。
   * 🔑 実測:門を外すと、ここ**だけ**が 200 に変わる。
   */
  const sameLengthDecoy = `/${'z'.repeat(prefix.length - 2)}/index.html`;
  expect(sameLengthDecoy.length, '囮の頭が prefix と同じ長さでない ── 検査が空振りする').toBe(
    prefix.length + 'index.html'.length,
  );
  expect(
    (await page.request.get(`${origin}${sameLengthDecoy}`)).status(),
    'prefix の外を配っている ── 「根は 404」が偶然で成り立っている',
  ).toBe(404);

  // ── ② 置いた場所で起動する
  await page.goto(`${origin}${prefix}`);
  await bootedHere(page, () =>
    outside.length === 0
      ? null
      : `起動しない ── prefix の外を ${String(outside.length)} 件叩いて 404 になっている` +
        `(絶対 path で参照している):\n  ${[...new Set(outside)].slice(0, 8).join('\n  ')}`,
  );
  expect(
    await page.evaluate(() => location.pathname),
    '根へ落ちている ── prefix で開けていない',
  ).toContain(prefix);

  /**
   * ── ③ 🔑 **要求した物が全部 prefix の下から来た**ことを見る。
   * 絶対参照が 1 つでも混ざれば、それは 404 になっている ── ②が通っても、
   * 「起動に要らない物」が根を叩いていれば、置いた先で静かに欠ける。
   * ⚠ **空振り防止**: 要求そのものを数える(0 件なら、この検査は何も見ていない)。
   */
  const asked = await page.evaluate((p: string) => {
    const same = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .filter((u) => u.startsWith(location.origin));
    return {
      same,
      // 🔑 空振り防止は **hash 付きの生成物**で見る(下の注記)
      hashed: same.filter((u) => /-[A-Za-z0-9_-]{8}\.(?:js|css)(?:[?#]|$)/.test(u)),
      outside: same.filter((u) => !u.startsWith(location.origin + p)),
    };
  }, prefix);
  /**
   * 🔴 **空振り防止は「件数」で書かない**(2026-09-09、CI で実際に落ちた)。
   *
   * ⚠ 1 稿目は `total > 3` と書いたが、**同一 origin の要求の数はブラウザで違う** ──
   *   実測(2026-09-09、同じ dist・同じ server):
   *   headless shell = `index-*.js` / `index-*.css` / `storage-worker-*.js` の **3 件**、
   *   フル Chromium = それに **`icon.svg` を足した 4 件**(favicon を取りに行く)。
   *   つまり `> 3` は**手元でだけ**成り立っていた ── CLAUDE.md §5
   *   「CI と手元で別のブラウザが動いている」そのもので、**製品ではなく計器の欠陥**である。
   * 🔑 だから**どちらでも必ず成り立つ 1 点**で見る ── アプリは
   *   **hash 付きの entry chunk を取らなければ描けない**。0 件なら、それは
   *   「絶対 path が無い」ではなく「**何も見ていない**」である
   *   (`dist-inspect` の「hash 付き生成物への参照が 1 件でもある」と同じ形)。
   */
  expect(
    asked.hashed.length,
    `hash 付きの生成物を 1 つも取っていない ── 走査が空振りしている: ${asked.same.join(' ')}`,
  ).toBeGreaterThan(0);
  expect(asked.outside, 'prefix の外を要求した(絶対 path が混ざっている)').toEqual([]);

  /**
   * ── ④ **書けて、読み直しても残る。**
   * ⚠ 「起動した」だけでは足りない ── storage worker と sqlite の `.wasm` は
   *   `new Worker(new URL('./…', import.meta.url))` 形で**実行時に**解決するので、
   *   そこが根を向いていても①〜③は通ってしまう(worker は起動の後で作られる)。
   */
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('置いた先で書いたノート');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.getByText('置いた先で書いたノート').first()).toBeVisible();

  await page.reload();
  await bootedHere(page, () =>
    outside.length === 0
      ? null
      : `起動しない ── prefix の外を ${String(outside.length)} 件叩いて 404 になっている` +
        `(絶対 path で参照している):\n  ${[...new Set(outside)].slice(0, 8).join('\n  ')}`,
  );
  await expect(
    page.getByText('置いた先で書いたノート').first(),
    '読み直したら消えた ── 保存先が置いた場所の下に無い',
  ).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
