/**
 * 🔴 **表の幅**(#699)── セルの数字がスマホで割れない / 広い表は器の中で横に流れる。
 *
 * ## ⚠ ここでしか見られないもの
 *
 * happy-dom は行を組まないので、「`120` が 1 行に収まっているか」は**実ブラウザでしか
 * 測れない**。CSS の字面(`break-word` が在るか)は `tests/adapter/table-width-css.test.ts`
 * が持つ ── ここは**組んだ結果**だけを見る(重複させない)。
 *
 * 🔑 観測点は **Range の `getClientRects().length`** ── セルの中身が何行に組まれたか、
 *   そのものである(`offsetHeight` は行の高さの都合で揺れる)。
 * ⚠ 対照群: 表の器は**器の中で**横に流れ、**画面は横に広がらない**
 *   (`documentElement.scrollWidth` が `clientWidth` を超えない)。
 */
import { test, expect, type Page } from '@playwright/test';
import { gotoApp, clickReal, createEntry, dismissAnnounce, useSplitEditor } from './helpers';

/**
 * ⚠ **狭い器で表が押し込まれる本文**にする(2 つとも、直す前は数字が割れた形)。
 * - markdown の表: 数字 8 列 + 長い文の列。文の列が伸びるので、数字の列は
 *   `anywhere` だと 1 文字幅まで縮められる(`120` → `12` / `0`)
 * - csv の fence: 8 列の `1234`(#699 の報告そのもの)
 */
const BODY = [
  '| 項目 | 1 月 | 2 月 | 3 月 | 4 月 | 5 月 | 6 月 | 7 月 | 8 月 |',
  '|---|---|---|---|---|---|---|---|---|',
  '| この列には長い説明の文が入っていて、表を器の幅いっぱいまで押し広げます | 120 | 120 | 120 | 120 | 120 | 120 | 120 | 120 |',
  '',
  '```csv',
  'a,b,c,d,e,f,g,h',
  '1234,1234,1234,1234,1234,1234,1234,1234',
  '```',
  '',
].join('\n');

async function openTables(page: Page): Promise<void> {
  await gotoApp(page);
  await dismissAnnounce(page);
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill(BODY);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await expect(
    page.locator('[data-pkc-field="detail-body"] table.pkc-md-rendered-csv'),
    'csv の表が描かれていない(台の空振り)',
  ).toBeVisible({ timeout: 10_000 });
}

/** セルの中身が何行に組まれたか(Range の矩形の数)。 */
async function linesOfCell(page: Page, text: string, where: 'md' | 'csv'): Promise<number[]> {
  return page.evaluate(
    ([t, w]) => {
      const body = document.querySelector('[data-pkc-field="detail-body"]')!;
      const cells = [...body.querySelectorAll('td')].filter((c) => {
        const inCsv = c.closest('table')?.classList.contains('pkc-md-rendered-csv') ?? false;
        return c.textContent?.trim() === t && inCsv === (w === 'csv');
      });
      return cells.map((c) => {
        /**
         * ⚠ **字の node だけを測る**(1 稿目はセル丸ごとで、csv の 1 列目だけ 3 と出た)。
         *   押せる csv の升には行の口(`.pkc-csv-shape` 2 つ)が inline で入っていて、
         *   セル丸ごとの Range は**その箱の数**を返す ── 折れた行の数ではない。
         */
        const textNode = [...c.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim() === t);
        if (textNode === undefined) return -1;
        const r = document.createRange();
        r.selectNodeContents(textNode);
        return r.getClientRects().length;
      });
    },
    [text, where] as const,
  );
}

test.describe('スマホ(390 幅・DPR 3)', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });

  test('🔴 表のセルの数字が途中で折れない ── 表は器の中で横に流れ、画面は横に広がらない (#699)', async ({
    page,
  }) => {
    await useSplitEditor(page);
    await openTables(page);

    // ── markdown の表: `120` が 8 つとも 1 行
    const md = await linesOfCell(page, '120', 'md');
    expect(md.length, '`120` のセルが 8 つ無い(台の空振り)').toBe(8);
    expect(md, 'markdown の表で「120」が途中から折れている(「12 / 0」に割れる)').toEqual(
      md.map(() => 1),
    );
    // ── csv の表: `1234` が 8 つとも 1 行
    const csv = await linesOfCell(page, '1234', 'csv');
    expect(csv.length, '`1234` のセルが 8 つ無い(台の空振り)').toBe(8);
    expect(csv, 'csv の表で「1234」が途中から折れている').toEqual(csv.map(() => 1));

    /**
     * 🔴 **超過は器の中で流れる**(画面ごと横に動かない)。
     * ⚠ 前提を assert する ── 表が器より**広くなっていること**(そうでなければ
     *   「流している」ではなく「そもそも収まっている」で、上の 1 行は何も主張しない)。
     */
    const flow = await page.evaluate(() => {
      const body = document.querySelector('[data-pkc-field="detail-body"]')!;
      const blocks = [
        body.querySelector('.pkc-md-block[data-pkc-md-block-kind="table"]'),
        body.querySelector('table.pkc-md-rendered-csv')?.closest('.pkc-md-block') ?? null,
      ];
      /**
       * 🔴 **超過が器の外へ漏れていないこと**を、器の**先祖**で見る(変異試験 M2 が要求した)。
       * ⚠ 「画面が横に広がらない」だけでは足りない ── 中央の面(`detail`)は自分で
       *   scroll できるので、器が流さなくても**面が丸ごと横に流れて**画面は広がらない
       *   (`overflow-x: visible` の変異が SURVIVED)。それは user から見ると
       *   「表を横に動かすと本文の段落まで一緒に逃げる」形である。
       * 🔑 器から上のどの先祖も横にはみ出していない = 流しているのは器だけ。
       */
      const leaks = (b: Element | null): string[] => {
        const out: string[] = [];
        for (let el = b?.parentElement ?? null; el !== null; el = el.parentElement)
          if (el.scrollWidth > el.clientWidth + 1)
            out.push(`${el.tagName}[${el.getAttribute('data-pkc-region') ?? el.getAttribute('data-pkc-field') ?? el.className}] +${el.scrollWidth - el.clientWidth}`);
        return out;
      };
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        blocks: blocks.map((b) => (b ? { over: b.scrollWidth - b.clientWidth, w: b.clientWidth, leaks: leaks(b) } : null)),
      };
    });
    for (const [i, b] of flow.blocks.entries()) {
      const name = i === 0 ? 'markdown' : 'csv';
      expect(b, `${name} の表の器が無い`).not.toBeNull();
      expect(b!.over, `${name} の表が器より広くなっていない(前提が崩れている)`).toBeGreaterThan(0);
      expect(b!.leaks, `${name} の表の超過が器の外へ漏れている(面ごと横に流れる)`).toEqual([]);
    }
    expect(flow.page, '画面が横に広がっている(表の超過が器の外へ漏れている)').toBeLessThanOrEqual(0);
  });
});
