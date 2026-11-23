/**
 * 🔴 **ログの 1 件 = 1 カード / 情報ペインの 4 カード**(B1)── 実ブラウザで、カードの輪郭・時刻の帯の廃止・
 * 表やコードのカードの内側への収まり・情報ペインの 4 枚を**本当に描かれている**かで見る。
 *
 * | 見る | なぜ unit では見えないか |
 * |---|---|
 * | 🔴 先頭 / 末尾 / 途中の塊に、上 / 下 / 左右の枠と角丸が付く(計算後の枠・地・角丸) | 計算後の値は実ブラウザでしか出ない |
 * | 🔴 時刻(`##`)に左の 3px の帯(枠・影)が無い。畳みの押し所は残り、押すと畳む | 帯が畳みのボタンだったので、描かないことと押せることは別 |
 * | 🔴 表・コード・長い 1 行・引用がカードの右端を越えず、ページが横に広がらない | 幅の解決は実ブラウザ |
 * | 🔴 情報ペインに 4 枚(基本 / 目次と添付 / タグ・つながり / 操作)が見える | 行が畳まれたカードを隠す `:has` は実ブラウザ |
 * | 人が目で見る明暗のスクリーンショット(`PKC3_SHOT_DIR` があれば DPR 2・1440×900 で保存) | 人が見る物 |
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor, dismissAnnounce } from './helpers';

test.use({ deviceScaleFactor: 2 });

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const BODY = '[data-pkc-region="detail"] [data-pkc-field="detail-body"]';
const LONG_WORD = `長い1語${'x'.repeat(260)}`;
const WIDE_CODE = `const wide = '${'0123456789'.repeat(30)}';`;
const WIDE_TABLE = [
  `| ${Array.from({ length: 16 }, (_, i) => `列${i + 1}ほげほげほげ`).join(' | ')} |`,
  `| ${Array.from({ length: 16 }, () => '---').join(' | ')} |`,
  `| ${Array.from({ length: 16 }, (_, i) => `値${i + 1}ふがふがふが`).join(' | ')} |`,
].join('\n');

const FIXTURE = [
  '## 2026-10-09 09:00:00',
  '朝の記録です。',
  WIDE_TABLE,
  `\`\`\`ts\n${WIDE_CODE}\nconsole.log(wide);\n\`\`\``,
  '```csv\n名前,値\nあ,1\nい,2\n```',
  '> 引用の文章です。\n> 2 行目。',
  LONG_WORD,
  '- 箇条書き',
  '### 2026-10-09 09:30:00',
  '追いログ一段',
  '## 2026-10-09 10:00:00',
  '昼の記録(単純)',
  '## 2026-10-10 08:00:00',
  '翌朝の記録',
].join('\n\n');

async function openLog(page: Page): Promise<void> {
  await createEntry(page, 'textlog');
  await page.fill('[data-pkc-field="editor-body"]', FIXTURE);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await page.waitForSelector('[data-pkc-action="start-edit"]');
  await expect(page.locator(`${BODY} > [data-pkc-log-card]`).first()).toBeAttached();
}

test('🔴 ログのカード: 輪郭・時刻の帯の廃止・表とコードと引用と長い 1 行がカードの内側に収まる (B1)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await openLog(page);

  // ① 印: 先頭 = 見出し、末尾 = 次の記録の手前の塊。記録の外(前置き)には付かない
  const edges = await page.locator(`${BODY} > [data-pkc-log-card]`).evaluateAll((els) =>
    els.map((el) => ({ tag: el.tagName.toLowerCase(), card: el.getAttribute('data-pkc-log-card') })),
  );
  expect(edges.filter((e) => e.card === 'first').length, '記録は 3 件(入れ子 ### は親と同じカード)= 先頭が 3 つ').toBe(3);
  expect(edges.filter((e) => e.card === 'last').length, '末尾も 3 つ').toBe(3);
  expect(edges.filter((e) => e.card === 'first').every((e) => e.tag === 'h2'), '先頭は時刻の見出し').toBe(true);

  // ② 輪郭: 先頭 = 上の枠 + 上の角丸、末尾 = 下の枠 + 下の角丸、全部 = 左右の枠 + 紙の地。時刻に左の帯(3px)・影が無い
  const paper = await page.evaluate(() => {
    const i = document.createElement('i');
    i.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--surface');
    document.body.append(i);
    const c = getComputedStyle(i).backgroundColor;
    i.remove();
    return c;
  });
  const css = (sel: string): Promise<Record<string, string>> =>
    page.locator(sel).first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        top: cs.borderTopWidth,
        bottom: cs.borderBottomWidth,
        left: cs.borderLeftWidth,
        right: cs.borderRightWidth,
        radiusTop: cs.borderTopLeftRadius,
        radiusBottom: cs.borderBottomLeftRadius,
        bg: cs.backgroundColor,
        shadow: cs.boxShadow,
        leftColor: cs.borderLeftColor,
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent'),
      };
    });
  const first = await css(`${BODY} > h2[data-pkc-log-card="first"]`);
  expect(first.top, '先頭に上の枠が無い').toBe('1px');
  expect(first.bottom, '先頭に下の枠が付いた').toBe('0px');
  expect(first.radiusTop, '先頭に上の角丸が無い').not.toBe('0px');
  expect(first.radiusBottom, '先頭に下の角丸が付いた').toBe('0px');
  expect(first.left, '時刻の左の帯(3px)が残っている').toBe('1px');
  expect(first.right).toBe('1px');
  expect(first.bg, '紙の地(--surface)でない').toBe(paper);
  expect(first.shadow, '時刻に影(帯)が付いた').toBe('none');
  const mid = await css(`${BODY} > p[data-pkc-log-card="mid"]`);
  expect([mid.top, mid.bottom, mid.left, mid.right], '途中の塊は左右の枠だけ').toEqual(['0px', '0px', '1px', '1px']);
  expect(mid.bg).toBe(paper);
  const last = await css(`${BODY} > [data-pkc-log-card="last"]`);
  expect(last.bottom, '末尾に下の枠が無い').toBe('1px');
  expect(last.radiusBottom, '末尾に下の角丸が無い').not.toBe('0px');
  expect(last.top).toBe('0px');
  // 入れ子の見出し(###)も左の枠は 1px(帯 3px の透明な枠が残っていない)
  expect((await css(`${BODY} > h3[data-pkc-log-card]`)).left).toBe('1px');

  // ③ 畳みの押し所は帯が無くても残り、押すと畳める(見出しの下の塊が隠れ、見出しは単独のカードになる)
  const foldBtn = (): ReturnType<Page['locator']> => page.locator(`${BODY} > h2`).first().locator('[data-pkc-field="heading-fold"]');
  const foldBox = await foldBtn().boundingBox();
  expect(foldBox!.width, '畳みの押し所が潰れた').toBeGreaterThan(8);
  await clickReal(page, foldBtn());
  await expect(page.locator(`${BODY} > h2`).first(), '畳むと見出しだけの単独カードになる').toHaveAttribute('data-pkc-log-card', 'solo');
  await expect(foldBtn()).toHaveAttribute('aria-expanded', 'false');
  await clickReal(page, foldBtn());
  await expect(page.locator(`${BODY} > h2`).first(), '開くとカードに戻る').toHaveAttribute('data-pkc-log-card', 'first');

  // ④ 表・コード・引用・長い 1 行・箇条書きは、カードの右端(枠の内側)を越えない。ページも横に広がらない
  const geo = await page.evaluate((sel) => {
    const host = document.querySelector(sel) as HTMLElement;
    const hostBox = host.getBoundingClientRect();
    const cards = [...host.querySelectorAll(':scope > [data-pkc-log-card]')] as HTMLElement[];
    const record = cards.slice(0, cards.findIndex((c, i) => i > 0 && c.getAttribute('data-pkc-log-card') === 'first'));
    const edge = record[0]!.getBoundingClientRect();
    const out: { what: string; right: number; left: number }[] = [];
    for (const c of record) {
      const what = c.tagName.toLowerCase() + (c.className ? `.${String(c.className).split(' ')[0]}` : '');
      const b = c.getBoundingClientRect();
      out.push({ what: `${what}(card)`, right: b.right, left: b.left });
      for (const d of c.querySelectorAll('table, pre, blockquote, p, ul')) {
        // 自分で横スクロールする器の中身(表・コードの実寸)はあふれて当たり前。見るのは器の端
        const owner = (d.closest('.pkc-md-block') as HTMLElement | null) ?? (d as HTMLElement);
        const db = owner.getBoundingClientRect();
        out.push({ what: `${d.tagName.toLowerCase()}(owner ${owner.tagName.toLowerCase()})`, right: db.right, left: db.left });
      }
    }
    return {
      cardLeft: edge.left,
      cardRight: edge.right,
      out,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      hostOverflow: host.scrollWidth - host.clientWidth,
      paneOverflow: (host.closest('[data-pkc-region="detail"]') as HTMLElement).scrollWidth - (host.closest('[data-pkc-region="detail"]') as HTMLElement).clientWidth,
      hostLeft: hostBox.left,
      hostRight: hostBox.right,
    };
  }, BODY);
  expect(geo.out.length, '検査対象が空(台の空振り)').toBeGreaterThan(8);
  for (const o of geo.out) {
    expect(o.right, `${o.what} がカードの右端(${geo.cardRight})を越えた`).toBeLessThanOrEqual(geo.cardRight + 0.5);
    expect(o.left, `${o.what} がカードの左端(${geo.cardLeft})より外`).toBeGreaterThanOrEqual(geo.cardLeft - 0.5);
  }
  // 記録の中の全部の塊が、同じ左端・右端のカード(表・csv・コードの器だけ狭い / 広いにならない)
  const cardsOnly = geo.out.filter((o) => o.what.endsWith('(card)'));
  expect(cardsOnly.length, '塊が少なすぎる(台の空振り)').toBeGreaterThan(6);
  for (const o of cardsOnly) {
    expect(Math.abs(o.left - geo.cardLeft), `${o.what} の左端がカードとずれた`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(o.right - geo.cardRight), `${o.what} の右端がカードとずれた`).toBeLessThanOrEqual(0.5);
  }
  expect(geo.docOverflow, 'ページが横に広がった').toBe(0);
  expect(geo.paneOverflow, '本文ペインが横に広がった').toBe(0);
  expect(geo.hostOverflow, '本文の器が横に広がった').toBe(0);

  // ⑤ 表とコードは「自分で」横に流す(器の中で scrollWidth > clientWidth)── 両方が実際に広い台であること
  const scroll = await page.evaluate((sel) => {
    const q = (s: string): { sw: number; cw: number } | null => {
      const el = document.querySelector(`${sel} ${s}`) as HTMLElement | null;
      return el === null ? null : { sw: el.scrollWidth, cw: el.clientWidth };
    };
    return { table: q('> .pkc-md-block[data-pkc-md-block-kind="table"]'), pre: q('pre') };
  }, BODY);
  expect(scroll.table, '表の器が無い').not.toBeNull();
  expect(scroll.table!.sw, '表が器より広くない(台の空振り)').toBeGreaterThan(scroll.table!.cw);
  expect(scroll.pre, 'コードが無い').not.toBeNull();
  expect(scroll.pre!.sw, 'コードが広くない(台の空振り)').toBeGreaterThan(scroll.pre!.cw);

  // ⑤b 🔴 横スクロールの器(表・csv)の切り口が、コード・引用と同じ内側の余白で終わる(左右とも)。カードの輪郭まで張り付いて切れない
  const inset = await page.evaluate((sel) => {
    const host = document.querySelector(sel) as HTMLElement;
    const card = host.querySelector(':scope > h2[data-pkc-log-card="first"]')!.getBoundingClientRect();
    const port = (el: HTMLElement): { l: number; r: number } => {
      const b = el.getBoundingClientRect();
      return { l: b.left + el.clientLeft, r: b.left + el.clientLeft + el.clientWidth };
    };
    const table = port(host.querySelector(':scope > .pkc-md-block[data-pkc-md-block-kind="table"]') as HTMLElement);
    const csv = port(host.querySelector(':scope > .pkc-md-block[data-pkc-render-lang="csv"]') as HTMLElement);
    const pre = host.querySelector(':scope > .pkc-md-block pre:not([data-pkc-md-table])') as HTMLElement;
    const code = pre.getBoundingClientRect();
    const quote = (host.querySelector(':scope > blockquote') as HTMLElement).getBoundingClientRect();
    const th = host.querySelector(':scope > .pkc-md-block[data-pkc-md-block-kind="table"] th') as HTMLElement;
    const thW = th.getBoundingClientRect().width;
    // 対照群: カードの印を外した(今までのふつうの本文)ときの同じ列の幅
    const saved = [...host.querySelectorAll('[data-pkc-log-card]')].map((e) => [e, e.getAttribute('data-pkc-log-card')!] as const);
    saved.forEach(([e]) => e.removeAttribute('data-pkc-log-card'));
    const plainTh = (host.querySelector(':scope > .pkc-md-block[data-pkc-md-block-kind="table"] th') as HTMLElement).getBoundingClientRect().width;
    saved.forEach(([e, v]) => e.setAttribute('data-pkc-log-card', v));
    return { cardL: card.left, cardR: card.right, table, csv, codeL: code.left, codeR: code.right, quoteR: quote.right, thW, plainTh };
  }, BODY);
  for (const [name, v] of [['表', inset.table], ['csv', inset.csv]] as const) {
    expect(Math.abs(v.r - inset.codeR), `${name}の切り口の右端がコードの右端とずれた(カードの輪郭まで張り付いて切れている)`).toBeLessThanOrEqual(1);
    expect(Math.abs(v.l - inset.codeL), `${name}の切り口の左端がコードの左端とずれた`).toBeLessThanOrEqual(1);
  }
  expect(inset.codeR, 'コードがカードの内側の余白(8px 以上)に収まっていない').toBeLessThanOrEqual(inset.cardR - 8);
  // 器(表・コード)の左右の輪郭線は、透明な余白の外縁(= カードの縁)に引かれる(余白の内側に引くと輪郭が途切れる)
  const lines = await page.locator(`${BODY} > .pkc-md-block[data-pkc-md-block-kind="table"]`).first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return { origin: cs.backgroundOrigin.split(',')[0]!.trim(), size: cs.backgroundSize.split(',')[0]!.trim(), pos: cs.backgroundPosition.split(',')[0]!.trim(), border: cs.borderLeftColor };
  });
  expect(lines.origin, '輪郭線の起点が余白の内側(カードの縁から離れて途切れる)').toBe('border-box');
  expect(lines.size).toBe('1px 100%');
  expect(lines.pos, '左の輪郭線の位置').toBe('0px 0px');
  // 器の中の表・コードの上の余白が、本文の余白(`pre` / `table` の margin)を残さず、他の塊と同じ細い間隔(0.3em)
  const gaps = await page.locator(`${BODY} > .pkc-md-block`).evaluateAll((els) =>
    els.map((w) => {
      const c = w.querySelector('pre, table') as HTMLElement;
      return c.getBoundingClientRect().top - w.getBoundingClientRect().top;
    }),
  );
  expect(gaps.length, '器が無い(台の空振り)').toBeGreaterThanOrEqual(3);
  for (const g of gaps) expect(g, '器の中の上の余白が本文の余白のまま(塊の間が広い)').toBeLessThanOrEqual(6);
  // 列の折り返しはカードの有無で変わらない(カードの規則が 1 字ずつの折り返しを作らない)
  expect(Math.abs(inset.thW - inset.plainTh), '表の列の幅がカードで変わった').toBeLessThanOrEqual(0.5);

  // ⑥ コピーのボタンはカードの内側(余白のぶん寄る)に出る
  const code = page.locator(`${BODY} > .pkc-md-block:has(pre)`).first();
  await code.hover();
  const btn = await code.locator('.pkc-md-copy-btn').first().boundingBox();
  const cardBox = await code.boundingBox();
  expect(btn, 'コピーのボタンが無い').not.toBeNull();
  expect(btn!.x + btn!.width, 'コピーのボタンがカードの枠に張り付いた').toBeLessThanOrEqual(cardBox!.x + cardBox!.width - 8);

  // ⑦ 新しい順(縦の flex)でも、カードは古い順と同じ左端・幅(字の幅に縮まない)
  const rect = (): Promise<{ left: number; width: number }> =>
    page.locator(`${BODY} > h2[data-pkc-log-card="first"]`).first().evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { left: b.left, width: b.width };
    });
  const asc = await rect();
  await clickReal(page, '[data-pkc-action="toggle-log-order"]');
  await expect(page.locator(BODY)).toHaveAttribute('data-pkc-log-order', 'desc');
  const desc = await rect();
  expect(Math.abs(desc.left - asc.left), '新しい順でカードの左端がずれた').toBeLessThanOrEqual(0.5);
  expect(Math.abs(desc.width - asc.width), '新しい順でカードの幅が変わった').toBeLessThanOrEqual(0.5);
  await clickReal(page, '[data-pkc-action="toggle-log-order"]');
  await expect(page.locator(BODY)).not.toHaveAttribute('data-pkc-log-order', 'desc');

  // 明暗のスクリーンショット(人が見る物)
  const dir = process.env.PKC3_SHOT_DIR;
  if (dir !== undefined && dir !== '') {
    mkdirSync(dir, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-pkc-theme', t), theme);
      await page.screenshot({ path: `${dir}/log-${theme}.png` });
      // 下へ送って、コード・csv・引用・長い 1 行・記録の終わり(カードの下の角)まで 1 枚に収める
      await page.locator(`${BODY} > .pkc-md-block:has(pre:not([data-pkc-md-table]))`).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: `${dir}/log-${theme}-lower.png` });
      await page.locator(BODY).evaluate((el) => (el.closest('[data-pkc-region="detail"]') as HTMLElement).scrollTo(0, 0));
    }
  }

  // 🔴 紙(印刷)にはカードの枠・地を出さない
  await page.emulateMedia({ media: 'print' });
  const printed = await css(`${BODY} > p[data-pkc-log-card="mid"]`);
  expect([printed.left, printed.right], '紙にカードの枠が出た').toEqual(['0px', '0px']);
  await page.emulateMedia({ media: 'screen' });

  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 情報ペイン: 4 枚のカード(基本 / 目次と添付 / タグ・つながり / 操作)が紙の地と輪郭で見える (B1)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await dismissAnnounce(page);
  await openLog(page);

  const cards = page.locator('[data-pkc-region="inspector"] > [data-pkc-card]');
  await expect(cards).toHaveCount(4);
  expect(await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-pkc-card')))).toEqual(['basic', 'toc', 'links', 'actions']);
  const paper = await page.evaluate(() => {
    const i = document.createElement('i');
    i.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--surface');
    document.body.append(i);
    const c = getComputedStyle(i).backgroundColor;
    i.remove();
    return c;
  });
  for (let i = 0; i < 4; i += 1) {
    const c = cards.nth(i);
    await expect(c, `${i} 枚目のカードが見えない`).toBeVisible();
    const s = await c.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, border: cs.borderTopWidth, radius: cs.borderTopLeftRadius, h: el.getBoundingClientRect().height };
    });
    expect(s.bg, `${i} 枚目が紙の地でない`).toBe(paper);
    expect(s.border).toBe('1px');
    expect(s.radius).not.toBe('0px');
    expect(s.h, `${i} 枚目が潰れている`).toBeGreaterThan(20);
  }
  // カードの間は空く(隣り合う 2 枚の間 > 0)
  const gaps = await cards.evaluateAll((els) => els.slice(1).map((e, i) => e.getBoundingClientRect().top - els[i]!.getBoundingClientRect().bottom));
  for (const g of gaps) expect(g, 'カードの間が詰まっている').toBeGreaterThan(2);
  // 列から右へはみ出さない
  const over = await page.evaluate(() => {
    const r = document.querySelector('[data-pkc-region="inspector"]') as HTMLElement;
    return r.scrollWidth - r.clientWidth;
  });
  expect(over, '情報ペインが横に広がった').toBe(0);

  const dir = process.env.PKC3_SHOT_DIR;
  if (dir !== undefined && dir !== '') {
    mkdirSync(dir, { recursive: true });
    const pane = page.locator('[data-pkc-region="inspector"]');
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-pkc-theme', t), theme);
      await pane.evaluate((el) => (el.scrollTop = 0));
      await pane.screenshot({ path: `${dir}/inspector-top-${theme}.png` });
      await pane.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await pane.screenshot({ path: `${dir}/inspector-bottom-${theme}.png` });
    }
  }
  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});
