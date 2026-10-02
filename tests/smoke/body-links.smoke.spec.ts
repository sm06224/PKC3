import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors, expectReachable, useSplitEditor, answerAppDialog } from './helpers';
import { peek, withStateOnFail } from './state-dump';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/**
 * 🔴 **本文のリンクが実機で押せる**(2026-08-08)。
 *
 * ## なぜ実ブラウザで見るのか
 *
 * unit(happy-dom)は生成の正しさしか示さない。ここで見るのは unit では
 * 観測できないことだけ:
 *
 * - 🔴 **未知スキームへ遷移しない** ── `<a href="entry:…">` の既定動作は
 *   実ブラウザにしか無い。`preventDefault` を忘れると **URL が変わる /
 *   ページが飛ぶ**。happy-dom は `entry:` のナビゲーションを再現しない
 * - 🔴 **キーボードで押せる** ── Tab でフォーカスが乗るか(`tabindex` が
 *   実際に効いているか)は実ブラウザの話
 * - **本当に markdown が焼いているか** ── unit は手で属性を置いているので、
 *   焼く側が変わっても気づかない
 */
test('🔴 本文の entry: リンクを押すと、そのノートが開く(遷移しない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);

  // ① リンク先のノートを作る(lid は一覧の行から採る ── 手で作らない)
  await createEntry(page, 'text');
  // 🔑 題名は日付にする ── 下の #1169 で、本文の `@2026-10-15` が**この既存のノート**を開くかを見る
  await page.locator('[data-pkc-field="editor-title"]').fill('2026-10-15');
  await page.locator('[data-pkc-field="editor-body"]').fill('着いた先の本文。\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const targetLid = await page
    .locator('[data-pkc-region="filer-table"] [data-pkc-entry]')
    .first()
    .getAttribute('data-pkc-entry');
  expect(targetLid, 'リンク先の lid を採れていない(fixture の空振り)').toBeTruthy();

  // ② そこへリンクするノートを作る
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('リンク元');
  await page
    .locator('[data-pkc-field="editor-body"]')
    // 🔴 3 行目は色コード(#1224)── 起動を増やさず、同じ「リンク元」で見本を見る
    .fill(
      `[あちらへ](entry:${targetLid ?? ''})\n\n@2026-10-15 と @2026-10-16 の件\n\n色は \`#3b82f6\` と \`#FFF\` と \`#3b82f6\` です\n`,
    );
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // 🔴 焼く側が本当に action を付けている(unit の手組みが嘘でないこと)
  const link = page.locator('[data-pkc-field="detail-body"] [data-pkc-action="navigate-entry-ref"]');
  await expect(link, '本文にアプリ内リンクが出ていない').toHaveCount(1);

  const urlBefore = page.url();
  await clickReal(page, '[data-pkc-field="detail-body"] [data-pkc-action="navigate-entry-ref"]');

  // 🔴 **開く**
  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('着いた先の本文');
  // 🔴 **遷移していない**(`entry:` へ飛ぼうとしていない)
  expect(page.url(), 'ブラウザが未知スキームへ遷移した').toBe(urlBefore);

  /**
   * 🔴 **本文の `@2026-10-15` を押すと、その日(題名が日付)のノートが開く**(#1169)。
   *
   * 起動を増やさない ── 上のノート 2 つ(題名 `2026-10-15` のノートと、本文に日付を 2 つ
   * 書いたノート)をそのまま使う。unit(happy-dom)では届かない 3 つを見る:
   *   ① **見た目** ── 点線の下線がつき、**字の色は本文のまま**(`getComputedStyle`。
   *      属性の有無だけでは「押せる字に見えるか」は言えない)
   *   ② 実ブラウザのクリックで開く。無い日は**作らずに聞き**、押したときだけ作る
   *   ③ 描いた字が `@2026-10-15` のまま(勝手に書き換えていない)
   */
  const rows = page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]');
  const backToSource = async (): Promise<void> => {
    await rows.filter({ hasText: 'リンク元' }).first().click();
    await expect(
      page.locator('[data-pkc-field="detail-body"] [data-pkc-action="open-date-note"]'),
      '本文の @日付が押せる字になっていない(前提が崩れた)',
    ).toHaveCount(2);
  };
  await backToSource();
  const day15 = page.locator('[data-pkc-action="open-date-note"][data-pkc-date="2026-10-15"]');
  const look = await day15.evaluate((el) => {
    const cs = getComputedStyle(el);
    const parent = getComputedStyle(el.parentElement!);
    return {
      line: cs.textDecorationLine,
      style: cs.textDecorationStyle,
      color: cs.color,
      parentColor: parent.color,
      cursor: cs.cursor,
      text: el.textContent,
    };
  });
  expect(look.text, '字が書き換わっている').toBe('@2026-10-15');
  expect(look.line, '下線が無い(押せる字に見えない)').toContain('underline');
  expect(look.style, '点線でない').toBe('dotted');
  expect(look.color, '字の色が本文と違う(色で割らない決め)').toBe(look.parentColor);
  expect(look.cursor, 'ポインタが変わらない').toBe('pointer');

  /**
   * 🔴 **日付の右の「あと3日」「5日前」**(#1225)。起動を増やさず、同じ日付の字で見る。
   * 属性の有無だけでは「画面に薄く出ているか」は言えない ── 計算後の `::after` で見る:
   *   ① 字が出ている(`content` に日数)。**期待は page の今日から別に数える**(実装と同じ式にしない)
   *   ② 色は本文の字より薄い(`--muted`)・`inline-block`(日付の点線の下線が添え字まで伸びない。
   *      ⚠ 装飾は子へ伝わるので `text-decoration` の計算値は `none` のままで、**伸びたかは
   *      値からは読めない** ── 伸びない作り(`inline-block`)のほうを見る)
   *   ③ 本文の字(`textContent`)には入らない = 選んでもコピーしても入らない
   */
  const rel = await day15.evaluate((el) => {
    const after = getComputedStyle(el, '::after');
    const d = new Date();
    const diff = Math.round(
      (Date.UTC(2026, 9, 15) - Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000,
    );
    return {
      attr: el.getAttribute('data-pkc-rel'),
      content: after.content,
      color: after.color,
      parentColor: getComputedStyle(el).color,
      display: after.display,
      text: el.textContent,
      expected:
        diff === 0 ? '今日' : diff === 1 ? '明日' : diff > 1 ? `あと${diff}日` : `${-diff}日前`,
    };
  });
  expect(rel.attr, '日付の右に日数が添わっていない').toBe(rel.expected);
  expect(rel.content, '画面に字が出ていない(::after の受け皿が無い)').toContain(rel.expected);
  expect(rel.color, '添え字が本文の字と同じ濃さ(薄くない)').not.toBe(rel.parentColor);
  expect(rel.display, '添え字が inline-block でない(日付の点線の下線が添え字へ伸びる)').toBe('inline-block');
  expect(rel.text, '添え字が本文の字に入っている(選ぶと・コピーすると入る)').toBe('@2026-10-15');

  /**
   * 🔴 **色コードの左の見本**(#1224)。属性の有無だけでは「画面に色が出ているか」は言えない ──
   * 計算後の見た目で見る:
   *   ① 3 つ出ている(`#3b82f6` / `#FFF` / `#3b82f6`)。色は **page の `<code>` の字から**採る
   *      (期待を実装の式と同じにしない)
   *   ② 塗りは字の指定の色(`#3b82f6` = rgb(59, 130, 246)、`#FFF` = rgb(255, 255, 255))で、
   *      文字の高さに合わせた四角(幅 ≒ 高さ ≒ 0.9em)・`inline-block`
   *   ③ **字を持たない**(段落の `textContent` は見本を足す前と同じ ── 選んでもコピーしても入らない)
   */
  const swatchLook = await page.evaluate(() => {
    const p = [...document.querySelectorAll('[data-pkc-field="detail-body"] p')].find((x) =>
      (x.textContent ?? '').startsWith('色は'),
    );
    if (!p) return null;
    const sws = [...p.querySelectorAll<HTMLElement>('[data-pkc-color-swatch]')];
    return {
      text: p.textContent,
      codes: [...p.querySelectorAll('code')].map((c) => c.textContent),
      sws: sws.map((e) => {
        const cs = getComputedStyle(e);
        return {
          bg: cs.backgroundColor,
          w: parseFloat(cs.width),
          h: parseFloat(cs.height),
          fs: parseFloat(getComputedStyle(e.parentElement!).fontSize),
          display: cs.display,
          own: e.textContent,
          next: e.nextElementSibling?.tagName ?? '',
        };
      }),
    };
  });
  expect(swatchLook, '色コードの段落が出ていない(fixture の空振り)').not.toBeNull();
  expect(swatchLook!.codes, '<code> の字が想定と違う').toEqual(['#3b82f6', '#FFF', '#3b82f6']);
  expect(swatchLook!.text, '見本が段落の字に入っている').toBe('色は #3b82f6 と #FFF と #3b82f6 です');
  expect(swatchLook!.sws.map((e) => e.bg)).toEqual([
    'rgb(59, 130, 246)',
    'rgb(255, 255, 255)',
    'rgb(59, 130, 246)',
  ]);
  for (const e of swatchLook!.sws) {
    expect(e.display, '見本が inline-block でない').toBe('inline-block');
    expect(Math.abs(e.w - e.fs * 0.9), '幅が 0.9em でない').toBeLessThan(1);
    expect(Math.abs(e.h - e.fs * 0.9), '高さが 0.9em でない').toBeLessThan(1);
    expect(e.own, '見本が字を持っている').toBe('');
    expect(e.next, '見本の右がコードでない(左に置けていない)').toBe('CODE');
  }

  /**
   * 🔴 **見本を押して色を選び直すと、本文のその 1 つのコードだけが変わる**(#1224 段②)。
   *
   * ⚠ 選ぶ窓(`<input type="color">`)は headless では**開いて選ぶ操作ができない**ので、押して出来た
   *   窓の入力へ `input` → `change` を**合成して撃つ**(本物の窓を閉じたときと同じ 2 つの出来事)。
   *   見ているのは「押す → 窓が出る → `change` 1 回 → 本文が書き換わり、見本が新しい色で描き直される」の配線。
   *   ① 押せない綴り(`#FFF`)は押しても窓が出ない ② 3 つ目(同じ `#3b82f6` の 2 つ目)を押すと、
   *   **3 つ目だけ**が変わる(1 つ目はそのまま)③ `input` だけでは書かない(色を探す間は何も変わらない)
   */
  const codesOf = (): Promise<string[]> =>
    page.evaluate(() => {
      const p = [...document.querySelectorAll('[data-pkc-field="detail-body"] p')].find((x) =>
        (x.textContent ?? '').startsWith('色は'),
      );
      return [...(p?.querySelectorAll('code') ?? [])].map((c) => c.textContent ?? '');
    });
  const swatchAt = (i: number) =>
    page.locator('[data-pkc-field="detail-body"] [data-pkc-color-swatch]').nth(i);
  await expect(swatchAt(1), '押せない綴りが button になっている').not.toHaveAttribute('role', 'button');
  await clickReal(page, swatchAt(1));
  await expect(page.locator('input[data-pkc-field="color-pick"]'), '押せない綴りで窓が開いた').toHaveCount(0);
  await clickReal(page, swatchAt(2));
  await expect(page.locator('input[data-pkc-field="color-pick"]'), '押しても色を選ぶ窓が出ない').toHaveCount(1);
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[data-pkc-field="color-pick"]')!;
    input.value = '#aa0000';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // ③ `input` だけでは書かない
  expect(await codesOf(), '色を探している最中(input)に書いている').toEqual(['#3b82f6', '#FFF', '#3b82f6']);
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[data-pkc-field="color-pick"]')!;
    input.value = '#10b981';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // ② 3 つ目だけが変わり、見本も新しい色で描き直される
  await expect
    .poll(codesOf, { message: '押した見本のコードが書き換わらない' })
    .toEqual(['#3b82f6', '#FFF', '#10b981']);
  await expect(swatchAt(2)).toHaveCSS('background-color', 'rgb(16, 185, 129)');
  await expect(swatchAt(0), '押していない 1 つ目まで変わった').toHaveCSS('background-color', 'rgb(59, 130, 246)');
  await expect(page.locator('input[data-pkc-field="color-pick"]'), '使い終わった窓が残っている').toHaveCount(0);

  // ① 在る日 ── そのノートが開く(押した日付の「ノートを開く」に見える)
  await clickReal(page, day15);
  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('着いた先の本文');
  expect(page.url(), '日付を押してブラウザが遷移した').toBe(urlBefore);

  // ② 無い日 ── 押しただけでは作らず、画面の下で聞く
  await backToSource();
  const before = await rows.count();
  await clickReal(page, '[data-pkc-action="open-date-note"][data-pkc-date="2026-10-16"]');
  const status = page.locator('[data-pkc-region="status"]');
  await expect(status, 'ノートが無いのに何も言わない(無言の dead click)').toContainText(
    '2026-10-16 のノートはまだありません',
  );
  const create = page.locator('[data-pkc-field="status-create-date"]');
  await expect(create, '「作る」が出ていない').toBeVisible();
  await expect(create).toHaveText('2026-10-16 のノートを作る');
  expect(await rows.count(), '押しただけでノートが増えた').toBe(before);

  // ③ 「作る」を押したときだけ作り、開く(編集には入らない)
  await clickReal(page, create);
  await expect(rows.filter({ hasText: '2026-10-16' }), '作っていない').toHaveCount(1);
  await expect(status).toContainText('2026-10-16 のノートを作りました');
  await expect(create, '作った後も「作る」が残っている').toBeHidden();
  await expect(
    page.locator('[data-pkc-field="editor-body"]'),
    '作ったら編集に入ってしまった(読んでいた物の続きで開くだけのはず)',
  ).toBeHidden();

  // 🔑 橋 ── 下の #1174 は「リンク先(題名 2026-10-15)のノートが開いている」所から始まる。
  //   上の #1169 ③ で作った 2026-10-16 のノートが開いているので、リンク先を開き直す。
  await rows.filter({ hasText: '2026-10-15' }).first().click();
  await expect(page.locator('[data-pkc-field="detail-title"]')).toContainText('2026-10-15');
  // ⚠ 右の列は開いた直後に「参照元」(worker から届く)で後から伸びる ── 実測で
  //   「ゴミ箱へ移す」が y=582 → 653 → 815 と動き、途中の瞬間に押すとお知らせのカードに
  //   覆われて落ちた(9 回中 3 回)。伸びる元が届くのを待ってから押す(実時間では待たない)。
  await expect(
    page.locator('[data-pkc-field="inspector-backlinks"] [data-pkc-field="inspector-backlink"]'),
    '参照元(リンク元)が右の列に届いていない',
  ).toHaveCount(1);

  /**
   * 🔴 **無いノートへのリンクは点線になり、ゴミ箱から戻すと開き直さずに消える**(#1174 段①)。
   *
   * ⚠ 上の道中の続きに載せる(新しく起動しない)── 開いているのはリンク先のノートなので、
   *   それをゴミ箱へ入れ、リンク元を選び直すと「先が無いリンク」が描かれる。
   * 🔑 見るのは**実ブラウザの計算後の見た目**(属性ではなく下線の種類と色。unit は
   *   CSS を持たないので、受け皿の規則が在るかは実ブラウザでしか見えない)。
   */
  await clickReal(page, '[data-pkc-action="delete-entry"]');
  await answerAppDialog(page, 'ok');
  await clickReal(page, '[data-pkc-region="filer-table"] [data-pkc-entry]:has-text("リンク元")');
  const missing = page.locator('[data-pkc-field="detail-body"] a[data-pkc-link-missing]');
  await expect(missing, '先のノートを捨てたのに、リンクに印が付いていない').toHaveCount(1);
  await expect(missing).toHaveAttribute('title', /このノートは見つかりません/);
  const lookMissing = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(
      '[data-pkc-field="detail-body"] a[data-pkc-link-missing]',
    )!;
    // 対照群: 先が在る普通のリンクと**字の色が同じ**(色は変えず、下線の種類だけ変える)
    const plain = document.createElement('a');
    plain.setAttribute('href', 'https://example.invalid/');
    el.after(plain);
    const cs = getComputedStyle(el);
    const ps = getComputedStyle(plain);
    // 🔴 薄い字(`--muted`)の実際の色 ── 変数を解く対照物を 1 つ置いて読む(属性・変数名では見ない)
    const muteProbe = document.createElement('span');
    muteProbe.style.color = 'var(--muted)';
    el.after(muteProbe);
    const mutedColor = getComputedStyle(muteProbe).color;
    muteProbe.remove();
    const out = {
      muted: mutedColor,
      style: cs.textDecorationStyle,
      line: cs.textDecorationLine,
      color: cs.color,
      plainColor: ps.color,
      plainStyle: ps.textDecorationStyle,
    };
    plain.remove();
    return out;
  });
  expect(lookMissing.style, '点線になっていない(CSS の受け皿が無い)').toBe('dotted');
  expect(lookMissing.line).toContain('underline');
  expect(lookMissing.plainStyle, '対照群が最初から点線(比べる意味が無い)').not.toBe('dotted');
  /**
   * 🔴 **消えたリンクは薄い字**(#1207 I2)。押せる @日付(上。字の色は本文のまま + 点線)と
   *   同じ点線なので、**押しても見つからない側だけ**を薄くして意味を分ける。
   *   計算後の色で見る(属性や CSS の字面では「薄く見える」は言えない)。
   */
  expect(lookMissing.color, '消えたリンクが薄い字(--muted)でない').toBe(lookMissing.muted);
  expect(lookMissing.color, '消えたリンクが普通のリンクと同じ色(押せない印にならない)').not.toBe(
    lookMissing.plainColor,
  );

  /**
   * 🔴 **戻すと、リンク元を開き直さなくても点線が消える**(再描画なしの当て直し)。
   *
   * ⚠ 主の枠では確かめられない ── ゴミ箱から戻すと**戻したノートが主の枠に開く**ので、
   *   リンク元はどのみち開き直される。だから**リンク元を横に留めた枠**に置いて、
   *   主の枠で出し入れする(留めた枠は選択に追随しない = 本文は描き直されない)。
   * ⚠ 留めた枠の本文は `split-body`(主の `detail-body` とは別の欄)。
   */
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.locator('[data-pkc-field="detail-body"] p').first().click({ button: 'right' });
  const menu = page.locator('[data-pkc-region="context-menu"]');
  await expect(menu, '本文で右クリックしてもメニューが出ない').toBeVisible();
  await menu.locator('button[data-pkc-action="pin-split"]').click();
  const pinned = page.locator('[data-pkc-field="split-body"]');
  await expect(
    pinned.locator('a[data-pkc-link-missing]'),
    '留めた枠でも、先の無いリンクに点線が付いている',
  ).toHaveCount(1);

  await clickReal(page, '[data-pkc-browse="filer"]');
  await clickReal(page, '[data-pkc-action="show-trash"]');
  await clickReal(page, '[data-pkc-action="restore-trash"]');
  // 前提: 戻したノートが主の枠に開いた(= 留めた枠の本文は選択の変化で描き直されていない)
  await expect(page.locator('[data-pkc-split-main] [data-pkc-field="detail-title"]')).toContainText(
    '2026-10-15',
  );
  await expect(
    pinned.locator('a[data-pkc-action="navigate-entry-ref"]'),
    '前提: 留めた枠のリンクが見えていない',
  ).toHaveCount(1);
  await expect(
    pinned.locator('a[data-pkc-link-missing]'),
    '戻したのに、留めた枠の点線が残っている',
  ).toHaveCount(0);

  // 対照群 ── また捨てれば付く(「一度外れたら二度と付かない」ではない)
  await clickReal(page, '[data-pkc-action="delete-entry"]');
  await answerAppDialog(page, 'ok');
  await expect(
    pinned.locator('a[data-pkc-link-missing]'),
    '捨て直したのに、留めた枠の点線が付かない',
  ).toHaveCount(1);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **携帯参照(`pkc://`)が、実機の cid で焼き分けられる**(2026-08-08。Issue #100 段①)。
 *
 * ## unit では届かないもの
 *
 * unit は cid を**自分で作って渡す**ので、「アプリが実際に何を渡しているか」は
 * 1 度も通らない。ここで見るのは:
 *
 * - 🔴 **本物の boot が渡す cid** が描画まで届くこと
 * - 🔴 **本物のワーカー**を通しても焼き分けが同じであること(unit の同期経路と違う)
 * - **対照群** ── 同じ本文の別コンテナあては placeholder のままであること
 *   (これが無いと「全部リンクにする」実装でも通る)
 *
 * ## 🔴 2026-08-19(#260)に書き換えた ── 自分の cid を**手で書かない**
 *
 * 直す前はここに `pkc://default/...` と**直書き**してあった。`main.ts` が
 * 全インストール共通の `'default'` を渡していたからで、
 * **他人の PKC3 が書いた参照が「自分のもの」と判定される**という不具合の
 * 裏返しでもあった(#260)。いまは端末ごとに採番するので、
 * 🔑 **cid はアプリから受け取る**(`data-pkc-container` ──
 * `data-pkc-boot` と同じ「検査のための契約」)。
 * ⚠ 手で書いた `default` は**対照群として残す** ── これが placeholder のままで
 *   あることが、「他人の器と衝突していない」の観測点である。
 */
test('🔴 pkc:// の自分あては押せて、別コンテナあては押せない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('携帯参照の先');
  await page.locator('[data-pkc-field="editor-body"]').fill('携帯参照で着いた本文。\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const targetLid = await page
    .locator('[data-pkc-region="filer-table"] [data-pkc-entry]')
    .first()
    .getAttribute('data-pkc-entry');
  expect(targetLid, 'リンク先の lid を採れていない(fixture の空振り)').toBeTruthy();

  /**
   * 🔴 **この端末の cid をアプリから受け取る**(#260)。
   * ⚠ 手で書くと、採番が壊れても test だけが辻褄を合わせてしまう。
   */
  const selfCid = await page
    .locator('[data-pkc-slot="root"]')
    .getAttribute('data-pkc-container');
  expect(selfCid, 'アプリが cid を出していない(#100 段① の観測点が消えた)').toBeTruthy();
  expect(selfCid, '全インストール共通の既定値を名乗っている(#260)').not.toBe('default');

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('携帯参照の元');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill(
      `[こちらへ](pkc://${selfCid ?? ''}/entry/${targetLid ?? ''})\n\n` +
        `[よそへ](pkc://not-mine/entry/${targetLid ?? ''})\n\n` +
        `[昔の既定へ](pkc://default/entry/${targetLid ?? ''})\n`,
    );
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const body = '[data-pkc-field="detail-body"]';
  const link = page.locator(`${body} [data-pkc-action="navigate-entry-ref"]`);
  await expect(link, '自分あての pkc:// が焼かれていない(cid が届いていない)').toHaveCount(1);
  await expect(
    page.locator(`${body} .pkc-portable-reference-placeholder`),
    '別コンテナあてまでリンクにしている',
  ).toHaveCount(2);
  /**
   * 🔴 **他人の `default` を自分のものと読んでいない**(#260 の実害そのもの)。
   * ⚠ 面へスコープして数える ── 本文の面の外(お知らせ等)の文字に満たされない。
   */
  await expect(
    page.locator(`${body} [data-pkc-portable-container="default"]`),
    '他人の PKC3 の参照を自分のものと判定した(#260)',
  ).toHaveCount(1);

  const urlBefore = page.url();
  await clickReal(page, `${body} [data-pkc-action="navigate-entry-ref"]`);
  await expect(page.locator(body)).toContainText('携帯参照で着いた本文');
  expect(page.url(), 'ブラウザが未知スキームへ遷移した').toBe(urlBefore);

  expect(errors).toEqual([]);
});

/**
 * 🔴 **`@card` はキーボードでも押せる**(user 指示「マウスだけで完結し、
 * キーボードは近道」)。⚠ 直す前は**フォーカスできるのに Enter が効かない**
 * 要素が 1 種類だけ存在していた。
 */
test('🔴 @card の札にフォーカスが乗り、Enter で開く', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('カードの先');
  await page.locator('[data-pkc-field="editor-body"]').fill('カードで着いた本文。\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  const targetLid = await page
    .locator('[data-pkc-region="filer-table"] [data-pkc-entry]')
    .first()
    .getAttribute('data-pkc-entry');

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('カード元');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill(`@[card](entry:${targetLid ?? ''})\n`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  const card = page.locator('[data-pkc-field="detail-body"] [data-pkc-action="navigate-card-ref"]');
  await expect(card, 'カードの札が出ていない').toHaveCount(1);

  /**
   * 🔑 **フォーカスできること自体が観測点**(`tabindex` が効いているか)。
   * ⚠ `focus()` を呼んで確かめる ── Tab の回数はページの構造で変わるので、
   *   ここで数えると構造を変えるたびに壊れる(挙動ではなく形を pin してしまう)。
   */
  await card.focus();
  await expect(card, 'フォーカスが乗らない(キーボードで届かない)').toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-pkc-field="detail-body"]')).toContainText('カードで着いた本文');
  expect(errors).toEqual([]);
});

/**
 * 🔴 **編集中に一覧の行を押しても、無言では断らない**(2026-08-08)。
 *
 * ⚠ 直す前は reducer が `SELECT_ENTRY` を**黙って捨てて**いた ── 押しても
 * 1 ドットも動かず、理由もどこにも出ない。user から見ると「クリックが効かない」。
 * 🔑 **実機で見る意味**: 理由の出口(画面下の帯)は既定で `hidden` なので、
 * 「出た」を実際の可視性で確かめられるのはここだけである。
 */
test('🔴 編集中に一覧の行を押すと、理由が画面に出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('1 件目\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-body"]').fill('2 件目\n');
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // 編集に入る
  await clickReal(page, '[data-pkc-action="start-edit"]');
  /**
   * 🔴 **編集に入ったことを待つ**(#419、2026-08-29)。
   *
   * ⚠ `clickReal` は**押すだけ**で、面の入れ替えは**非同期**である。待たずに次へ進むと、
   *   **まだ編集中でない**ので一覧の行は**ふつうに開けてしまい**、断り文が出ない ──
   *   落ちるのは製品ではなく、この test が**前提を確かめていない**からである。
   * ⚠ 直下の `status.isVisible()` は**待たない一読**なので、前提の代わりにならない
   *   (編集に入っていても入っていなくても false で通る)。
   * 🔑 双子の `context-menu.smoke.spec.ts:166-169` は**同じ検算を既に持っている** ──
   *   こちらだけ落ちていたのは、その 1 行が無かったからである。
   */
  await expect(
    page.locator('[data-pkc-field="editor-body"]'),
    '編集に入っていない(前提が崩れた)',
  ).toBeVisible();
  const status = page.locator('[data-pkc-region="status"]');
  /**
   * 🔴 **編集中は、画面下の行に状態の 1 語「編集中」が常に出ている**(#1038 段 D / C4)。
   * ⚠ だから「帯が見えているか」でも「『編集』の字を含むか」でも、**理由が出たかは
   *   言えない** ── どちらも押す前から「編集中」の 1 語に満たされる(CLAUDE.md §1
   *   「別の字に満たされる」)。C4 の後、この検査は前提の 1 行で落ち、押した後の
   *   2 つは**断り文が出なくても通る形**になっていた。
   * 🔑 前提は「**状態の 1 語だけで、理由はまだ無い**」、見るのは「**断り文そのもの**」。
   */
  const statusText = page.locator('[data-pkc-field="status-text"]');
  await expect(statusText, '編集に入った時点で既に理由が出ている').toHaveText('編集中');

  /**
   * ⚠ **`clickReal` は使わない** ── 断られる操作なので「押した結果」を待たない。
   *
   * 🔴 **ただし occlusion の検出だけは借りる**(2026-08-27、#419)。
   *   ⚠ 「押した結果を待つ」ことと「その座標に本当に届くか」は**別のことである**
   *   のに、旧稿は `clickReal` ごと避けたので**両方を捨てていた**。
   *   ⚠ #419 の本文は「**検出を外している唯一の押し方**」と書いているが、
   *   **これは誤り**である ── 生の `.click()` は smoke 全体に **88 か所**ある
   *   (2026-08-27 に数えた)。⚠ 多くは textarea に焦点を置くためのもので
   *   occlusion が問題になる形ではないが、**「唯一」ではない**。
   * ⚠ #419 は**フル走行で 2 回**落ちており(2026-08-25 / 2026-08-27)、
   *   2 回とも残ったのは「無言で断った」だけ ── **押せていないのか / 断り文が
   *   別の字なのか**が割れていない。`expectReachable` を通しておけば、
   *   次に落ちたとき**どちらなのかが文言で分かる**。
   * 🔑 **押した結果は待たない**(そこは旧稿のまま)── 足したのは
   *   「その座標に届くか」の 1 点だけである。
   * ⚠ 「待ちが増えていない」とは書かない ── `.click()` 自身も
   *   actionability を待つので、**測らずに比べられない**。
   */
  const row = page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]').last();
  const { x, y } = await expectReachable(page, row);
  await page.mouse.click(x, y);

  /**
   * 🔴 理由が**見える**。
   *
   * ⚠ フル走行で **1 回だけ**ここが落ちている(#419)── そのとき残るのは
   *   「見えなかった」だけで、**押せていないのか / 断り文が別の字なのか /
   *   そもそも編集に入っていないのか**が分からない。
   * ⚠ **待ちは伸ばさない**。落ちたときに残る情報だけを増やす。
   */
  await withStateOnFail(
    page,
    '無言で断った(押しても何も起きない)',
    async () => ({
      rows: await peek(page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]')),
      statusText: await peek(status, 1),
      pageErrors: errors,
    }),
    async () => {
      await expect(statusText).not.toHaveText('編集中');
    },
  );
  // 🔑 断り文そのものを見る(「編集中」の 1 語では満たされない字)
  await expect(statusText).toContainText('ノートを開いてください');
  // ⚠ 押した場所に合った呼び名(行を押したのに「リンク先」と言わない)
  await expect(statusText).not.toContainText('リンク先');
  // ⚠ 編集は続いている(勝手に移っていない)
  await expect(page.locator('[data-pkc-field="editor-body"]')).toBeVisible();

  expect(errors).toEqual([]);
});

/**
 * 🔴 #100 段②: 本文の `pkc://<自分>/asset/<key>` を押すと**所有ノートへ飛ぶ**。
 *
 * unit は「焼く」(container-id-render)と「逆引き」(storage-worker)を別々に
 * 見る ── **焼いた属性 → binder → worker の逆引き → SELECT_ENTRY** が 1 本に
 * つながるかは実物でしか確かめられない。
 */
test('🔴 pkc:// の asset あては押すと所有ノート(添付)へ飛ぶ', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);

  // ① 添付を作る(所有ノート)── key は画面の実属性から採る(でっち上げない)
  await clickReal(page, '[data-pkc-bar-tile][data-pkc-action="attach-file"]');
  await page.locator('[data-pkc-field="attach-input"]').setInputFiles({
    name: 'owner.png',
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  });
  const dl = page.locator('[data-pkc-action="download-asset"]');
  await expect(dl).toBeVisible({ timeout: 15000 });
  const key = await dl.getAttribute('data-pkc-asset-key');
  expect(key, '添付の key を画面から採れていない(fixture の空振り)').toBeTruthy();

  // ② 参照を本文に書いたノートを作る
  //    ⚠ cid は**アプリから受け取る**（#260 で端末ごとの採番になった ──
  //    手で `default` と書くと、採番が壊れても test だけが辻褄を合わせる）
  const selfCid = await page
    .locator('[data-pkc-slot="root"]')
    .getAttribute('data-pkc-container');
  expect(selfCid, 'アプリが cid を出していない').toBeTruthy();
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('参照の元');
  await page
    .locator('[data-pkc-field="editor-body"]')
    .fill(`[図へ](pkc://${selfCid ?? ''}/asset/${key})\n`);
  await clickReal(page, '[data-pkc-action="commit-edit"]');

  // ③ 焼けていること(action + 受け手が読む key 属性)
  const link = page.locator('[data-pkc-field="detail-body"] [data-pkc-action="navigate-asset-ref"]');
  await expect(link, '自分あての asset 参照が焼かれていない').toHaveCount(1);
  expect(await link.getAttribute('data-pkc-asset-ref')).toBe(key);

  // ④ 押すと所有ノート(添付)へ飛ぶ ── 添付の面が出る
  const urlBefore = page.url();
  await clickReal(page, '[data-pkc-field="detail-body"] [data-pkc-action="navigate-asset-ref"]');
  await expect(
    page.locator('[data-pkc-field="attachment-media"]'),
    '所有ノートに着いていない(添付の面が出ない)',
  ).toBeVisible();
  expect(page.url(), 'ブラウザが未知スキームへ遷移した').toBe(urlBefore);

  expect(errors).toEqual([]);
});
