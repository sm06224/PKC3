/**
 * 🔴 **文字の貼付**(#251。HTML → PKC-Markdown / `data:` `blob:` を資産へ)。
 *
 * 🔴 **unit(happy-dom)では届かない層だけ**をここで見る:
 * ① **本物の `ClipboardEvent` + `DataTransfer`** ── `text/html` と `text/plain` を
 *    両方載せたクリップボードは、fake では「こちらが渡した形」しか試していない
 * ② **`document.execCommand('insertText')`** ── happy-dom に無いので unit は
 *    必ず fallback を通る = **本命の経路を 1 度も走らせていない**(CLAUDE.md §2)
 * ③ **実 `fetch('data:…')` + 実 IDB** ── 資産として本当に取り出せて、確定後の
 *    本文で**画像として描かれる**か(字が入っただけなら壊れた key でも通る)
 */
import { test, expect, type Page } from '@playwright/test';
import {
  clickReal,
  createEntry,
  collectPageErrors,
  expectImageRendered,
  gotoApp,
  useSplitEditor,
} from './helpers';

// 1x1 PNG(67 bytes)── 他の smoke と同じ絵
const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * 本物の paste event を、その欄の上で発火させる(焦点も実際に置く)。
 *
 * ⚠ **合成の event はブラウザの既定の貼付を起こさない**(信頼された event では
 * ないため)── だから「横取りしなかった」を **`value` が原文になること**では
 * 見られない。⚠ 観測点は **`defaultPrevented`**(= こちらが止めたかどうか)である。
 * 1 稿目はここを取り違えて「原文が入っていない」と読み、**製品の不具合に見えた**。
 */
async function pasteText(
  page: Page,
  selector: string,
  data: { html?: string; rtf?: string; plain: string },
): Promise<boolean> {
  return await page.evaluate(
    ({ selector, data }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`要素が無い: ${selector}`);
      const dt = new DataTransfer();
      if (data.html !== undefined) dt.setData('text/html', data.html);
      if (data.rtf !== undefined) dt.setData('text/rtf', data.rtf);
      dt.setData('text/plain', data.plain);
      if (el instanceof HTMLElement) el.focus();
      const ev = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    { selector, data },
  );
}

/** 編集中の 1 面(既定 = live)を開いて、行の入力欄を出す。 */
async function openLiveRow(page: Page): Promise<void> {
  await createEntry(page, 'text');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live).toBeVisible();
  await clickReal(page, '[data-pkc-region="editor-live"]');
  await expect(
    live.locator('[data-pkc-field="row-source"]'),
    '空のノートで行が開かない(貼る先が無い)',
  ).toBeVisible();
}

const ROW = '[data-pkc-region="editor-live"] [data-pkc-field="row-source"]';

/**
 * 🔴 **大きい Web ページでも貼れる**(#492。user 指示 2026-08-27
 * 「**貼付やコードブロックフェンスでアセット埋め込みする際の上限バイトは不要。
 * 現実問題、画像埋め込みのHTMLとか増えてるし、できないのは困る**」)。
 *
 * ⚠ かつて `text/html` が **1MB** を超えると**1 バイトも読まずに**平文へ落とし、
 *   「大きすぎて読めませんでした」と出していた。画像を inline で持つ Web ページは
 *   1MB を軽く超えるので、user はそこに当たり続けていた(2026-08-28 に再報告)。
 *
 * 🔴 **unit では原理的に届かない層**:1MB 超の HTML を**本物の `DOMParser`** で
 *   解析して**実際に間に合うのか**。happy-dom の速さは Chromium の速さではない。
 *
 * 📏 実測(この箱、Chromium。押してから戻るまで = user が固まると感じる時間):
 *   1MB **69ms** / 2MB **99ms** / 4MB **193ms** / 8MB **502ms** ── ほぼ線形。
 *   🔑 **旧上限(1MB)が切っていたのは 69ms の地点**である = 守っていたものが無い。
 */
test('🔴 1MB を超えるウェブページでも、平文へ落とさず記法に戻る (#492)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await openLiveRow(page);

  // 画像 inline 入りの Web ページを模す(data: URI が容量を食う実態に寄せる)
  const img = `<img src="data:image/png;base64,${'A'.repeat(1200)}">`;
  const unit = `<p>本文の段落です。${img}</p>`;
  let html = '<h2>大きな見出し</h2>';
  while (html.length < 1024 * 1024 + 1) html += unit;
  // ⚠ **空振り防止** ── 旧上限を本当に超えている
  expect(html.length, '入力が旧上限(1MB)を超えていない').toBeGreaterThan(1024 * 1024);

  await pasteText(page, ROW, { html, plain: '平文に落ちたらこれが入る' });

  const row = page.locator(ROW);
  // 🔴 記法に戻っている = 読んだ(平文へ落ちていたら `##` は出ない)
  await expect(row, '大きいだけで平文へ落とした(旧上限が残っている)').toHaveValue(
    /## 大きな見出し/,
    { timeout: 15_000 },
  );
  // ⚠ **対照群** ── 平文のほうが入っていない(取り違えていない)
  await expect(row, '平文が入っている(横取りしていない)').not.toHaveValue(
    /平文に落ちたらこれが入る/,
  );
  // 🔴 断り文を出していない
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '大きさを理由に断っている',
  ).not.toContainText('大きすぎ');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 ウェブページをコピーして貼ると、形のまま入って描かれる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await openLiveRow(page);

  await pasteText(page, ROW, {
    html:
      '<h2>見出し</h2><p>本文と<strong>強調</strong>と<a href="https://e.com/a">リンク</a></p>' +
      '<ul><li>親<ul><li>子</li></ul></li></ul>' +
      '<table><tr><th>名</th><th>数</th></tr><tr><td>あ</td><td>1</td></tr></table>',
    plain: '見出し 本文と強調とリンク 親 子 名 数 あ 1',
  });

  const row = page.locator(ROW);
  // ① 記法に戻って入る(平文のままなら `##` も `|` も出ない)
  await expect(row, 'HTML が markdown に戻っていない').toHaveValue(/## 見出し/);
  await expect(row).toHaveValue(/\*\*強調\*\*/);
  await expect(row).toHaveValue(/\[リンク\]\(https:\/\/e\.com\/a\)/);
  await expect(row, '入れ子の箇条書きが平らになった').toHaveValue(/- 親\n {2}- 子/);
  await expect(row, '表が入っていない').toHaveValue(/\| 名 \| 数 \|/);

  // ② 🔴 **取り消せる**(`execCommand` の経路を通っている証拠 ── unit では測れない)
  await page.keyboard.press('Control+z');
  await expect(row, '取り消しで戻っていない').not.toHaveValue(/## 見出し/);
  await page.keyboard.press('Control+y');
  await expect(row).toHaveValue(/## 見出し/);

  // ③ 🔴 **確定すると本当にその形で描かれる**(字が入っただけで終わらせない)
  await page.keyboard.press('Tab');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live.locator('h2'), '見出しとして描かれていない').toContainText('見出し');
  await expect(live.locator('table td').first(), '表として描かれていない').toContainText('あ');
  await expect(live.locator('ul ul li'), '入れ子の箇条書きが描かれていない').toContainText('子');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 埋め込みの画像(data:)は資産になり、本文は asset: を指す', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await openLiveRow(page);

  await pasteText(page, ROW, {
    html: `<p>まえ</p><img src="data:image/png;base64,${PNG_1X1_B64}" alt="ず">`,
    plain: 'まえ',
  });

  const row = page.locator(ROW);
  await expect(row, '資産へ逃がしていない').toHaveValue(/!\[ず\]\(asset:[^)]+\)/, {
    timeout: 15_000,
  });
  // 🔴 **本文に base64 が残っていない**(残ると編集・保存のたびに丸ごと運ぶ)
  await expect(row, '本文に base64 が居座っている').not.toHaveValue(/base64/);

  // 確定すると**実際の画像として描かれる**(key が本物である証拠)
  await page.keyboard.press('Tab');
  await expectImageRendered(page, 'img[data-pkc-asset-key]');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 markdown 原文を渡してくるコピー(AI の「コピー」)は横取りしない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await openLiveRow(page);

  // ⚠ text/plain が原文、text/html が描画済み ── 原文のほうが必ず正確である
  const source = '## 題\n\n```ts\nconst a = 1;\n```\n\n- あ';
  const stopped = await pasteText(page, ROW, {
    html: '<h2>題</h2><pre><code class="language-ts">const a = 1;</code></pre><ul><li>あ</li></ul>',
    plain: source,
  });

  // 既定の貼付に委ねた = 止めていない(原文がそのまま入る経路)
  expect(stopped, '原文を捨てて HTML から作り直した').toBe(false);
  // ⚠ 欄も触っていない(横取りしていないのに書き込んでいたら、それも事故)
  await expect(page.locator(ROW)).toHaveValue('');

  // 🔑 逆側 ── **形しか無い**コピーなら止める(この test が「常に止めない」で
  //    通っていないことを、同じ器で確かめる)
  const stoppedRich = await pasteText(page, ROW, {
    html: '<h2>題</h2><p>本文</p>',
    plain: '題 本文',
  });
  expect(stoppedRich, '形のあるコピーまで素通りしている').toBe(true);

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **資産にしている最中に焦点が移っても、本文の欄に入る**(#251)。
 *
 * ⚠ unit では**この行を 1 度も走らせられない** ── happy-dom に `execCommand` が無く、
 * 必ず fallback の `value` 直代入を通るので、焦点の有無が結果を変えない
 * (CLAUDE.md §2「弱いのではなく走っていない」)。#250 と同じ穴がここにも在る。
 * ⚠ **2 列の面で測る** ── 1 面は別の欄を触った瞬間に行を閉じるので、
 *   「欄は生きているのに焦点だけ外れた」というこの次元が作れない。
 */
test('🔴 資産にしている間に焦点が移っても、本文の欄に入る(2 列)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await useSplitEditor(page);
  await gotoApp(page);
  await createEntry(page, 'text');

  const sel = '[data-pkc-field="editor-body"]';
  await expect(page.locator(sel)).toBeVisible();
  await pasteText(page, sel, {
    html: `<p>まえ</p><img src="data:image/png;base64,${PNG_1X1_B64}" alt="ず">`,
    plain: 'まえ',
  });
  // ⚠ 資産にしている**最中に**焦点を奪う(user が絞り込み欄を触った、の再現)
  await page.evaluate((sel) => {
    const ta = document.querySelector<HTMLTextAreaElement>(sel);
    if (ta?.value.includes('asset:'))
      throw new Error('この次元を測れていない(資産化が先に終わった)');
    const other = document.querySelector<HTMLElement>('[data-pkc-field="entry-filter"]');
    if (!other) throw new Error('焦点を移す先が無い(この次元を測れていない)');
    other.focus();
  }, sel);

  await expect(page.locator(sel), '本文の欄に入っていない(焦点を戻していない)').toHaveValue(
    /!\[ず\]\(asset:[^)]+\)/,
    { timeout: 15_000 },
  );
  // ⚠ **絞り込み欄に入っていない**(入ると検索語が壊れる ── 静かな事故)
  await expect(page.locator('[data-pkc-field="entry-filter"]')).toHaveValue('');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **ページ中の図(`<svg>`)を貼ると、資産になって描かれる**(user 裁定 2026-08-18)。
 *
 * ⚠ **実ブラウザでしか測れない次元が 2 つ**ある:
 * ① `<svg>` の中の `<script>` の**解析**(happy-dom は script 以降を丸ごと落とすので、
 *    unit では「掃除が効いた」のか「解析器が落とした」のか**区別できない**)
 * ② `<img>` で SVG が**実際に描ける**か(名前空間を足していないと描けない)
 */
test('🔴 ページ中の図を貼ると、資産になって画像として出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await openLiveRow(page);

  await pasteText(page, ROW, {
    html:
      '<p>まえ</p><svg width="40" height="40" viewBox="0 0 40 40">' +
      '<title>しかく</title><rect width="40" height="40" fill="#4a7"/>' +
      '<script>window.__pwned = 1;</script></svg>',
    plain: 'まえ',
  });

  const row = page.locator(ROW);
  await expect(row, '図が資産になっていない').toHaveValue(/!\[しかく\]\(<?asset:[^)>]+/, {
    timeout: 15_000,
  });
  // 🔴 **掃除が効いている**(資産の中身にスクリプトが残っていない)
  const key = (await row.inputValue()).match(/asset:([^)>\s]+)/)?.[1] ?? '';
  expect(key, '鍵が読めない(この test は空振り)').not.toBe('');
  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned ?? 0),
    '貼っただけでスクリプトが動いた',
  ).toBe(0);

  // 確定すると **実際に絵として描かれる**(名前空間が足りていれば `<img>` が読める)
  await page.keyboard.press('Tab');
  await expectImageRendered(page, 'img[data-pkc-asset-key]');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});



/**
 * 🔴 **リッチテキスト(RTF)の貼付**(user 指示 2026-08-25)。
 *
 * 🔴 **unit(happy-dom)では届かない層だけ**を見る:
 * ① **本物の `DataTransfer` に `text/rtf` を載せて本当に取り出せるか**
 *    ── fake の `getData` は「こちらが渡した形」しか試していない
 * ② **`execCommand('insertText')` の経路**(happy-dom に無いので unit は必ず fallback)
 * ③ **確定すると本当にその形で描かれるか**(字が入っただけで終わらせない)
 */
test('🔴 リッチテキスト(RTF)を貼ると、形のまま入って描かれる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await openLiveRow(page);

  /** WordPad / TextEdit が書く形(⚠ `text/html` は**載せない**のがこの出し手の特徴)。 */
  const RTF =
    String.raw`{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0 Calibri;}}` +
    String.raw`{\*\generator Riched20 10.0.19041;}{\stylesheet{\s0 Normal;}{\s1 heading 1;}}` +
    String.raw`\viewkind4\uc1 \pard\s1 手順\par` +
    String.raw`\pard\ls1\ilvl0{\listtext\'b7\tab}\b 牛乳\b0 を買う\par` +
    String.raw`\pard\ls1\ilvl1{\listtext\'b7\tab}\i 低脂肪\i0\par` +
    String.raw`\pard\trowd\trhdr\intbl 名\cell 数\cell\row` +
    String.raw`\trowd\intbl 卵\cell 6\cell\row` +
    String.raw`\pard 詳しくは{\field{\*\fldinst{HYPERLINK "https://e.com/a"}}{\fldrslt こちら}}\par}`;

  const prevented = await pasteText(page, ROW, {
    rtf: RTF,
    plain: '手順 牛乳を買う 低脂肪 名 数 卵 6 詳しくはこちら',
  });
  expect(prevented, '既定の貼付を止めていない(RTF が届いていない)').toBe(true);

  const row = page.locator(ROW);
  await expect(row, 'RTF が markdown に戻っていない').toHaveValue(/# 手順/);
  await expect(row, '強調が落ちた').toHaveValue(/\*\*牛乳\*\*/);
  await expect(row, '入れ子の箇条書きが平らになった').toHaveValue(/- \*\*牛乳\*\*を買う\n\n {2}- \*低脂肪\*/);
  await expect(row, '表が入っていない').toHaveValue(/\| 名 \| 数 \|/);
  await expect(row, 'リンクが入っていない').toHaveValue(/\[こちら\]\(https:\/\/e\.com\/a\)/);

  // 🔴 **確定すると本当にその形で描かれる**
  await page.keyboard.press('Tab');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live.locator('h1'), '見出しとして描かれていない').toContainText('手順');
  await expect(live.locator('table td').first(), '表として描かれていない').toContainText('卵');
  await expect(live.locator('ul ul li'), '入れ子の箇条書きが描かれていない').toContainText('低脂肪');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

test('🔴 HTML も載っているときは HTML が勝つ(RTF に押しのけさせない)', async ({ page }) => {
  // ⚠ Word / Excel / Google ドキュメントは**両方**を載せる ── HTML のほうが忠実
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await openLiveRow(page);

  await pasteText(page, ROW, {
    html: '<h2>HTML の見出し</h2>',
    rtf:
      String.raw`{\rtf1\ansi\deff0{\stylesheet{\s1 heading 1;}}` +
      String.raw`\pard\s1 RTF の見出し\par}`,
    plain: 'HTML の見出し',
  });
  const row = page.locator(ROW);
  await expect(row, 'RTF が HTML を押しのけている').toHaveValue(/## HTML の見出し/);
  await expect(row).not.toHaveValue(/RTF の見出し/);
});

/**
 * 🔴 **生成 AI チャットの回答を、コードごと貼る**
 * (user 指示 2026-08-25「**最近の生成AIチャットがrtfのコピペを使い始めてる /
 * そのニーズがあるから要望してる**」)。
 *
 * ⚠ **unit では届かない層**:確定したあとに**本当にコードとして描かれるか**。
 *   字が入っただけで終わらせない(``` が本文に在っても、囲みが閉じていなければ
 *   画面はコードにならない)。
 */
test('🔴 生成 AI の回答(RTF)を貼ると、説明とコードが分かれて描かれる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);
  await openLiveRow(page);

  /** ⚠ `\f2` を **`\fmodern`(等幅の族)と宣言**した頭 ── 名前で当てていない。 */
  const RTF =
    String.raw`{\rtf1\ansi\ansicpg1252\deff0` +
    String.raw`{\fonttbl{\f0\fswiss\fcharset0 Helvetica;}{\f2\fmodern\fprq1\fcharset0 Menlo;}}\uc1 ` +
    String.raw`\pard\outlinelevel0\f0 まとめ\par` +
    String.raw`\pard\f0 次のように書きます\par` +
    String.raw`\pard\f2 function f() \{\par\pard\f2   return 1;\par\pard\f2 \}\par` +
    String.raw`\pard\f0 変数 \f2 count\f0  を見てください\par}`;

  const prevented = await pasteText(page, ROW, {
    rtf: RTF,
    plain: 'まとめ 次のように書きます function f() { return 1; } 変数 count を見てください',
  });
  expect(prevented, '既定の貼付を止めていない(RTF が届いていない)').toBe(true);

  const row = page.locator(ROW);
  await expect(row, '見出しになっていない').toHaveValue(/# まとめ/);
  // 🔴 続いた 3 行が**1 つの囲み**になっている(1 行ごとに囲んでいない)
  await expect(row, 'コードが 1 つの囲みになっていない').toHaveValue(
    /```\nfunction f\(\) \{\n {2}return 1;\n\}\n```/,
  );
  await expect(row, '行内コードになっていない').toHaveValue(/`count`/);

  // 🔴 **確定すると本当にコードとして描かれる**
  await page.keyboard.press('Tab');
  const live = page.locator('[data-pkc-region="editor-live"]');
  await expect(live.locator('pre code'), 'コードとして描かれていない').toContainText('return 1;');
  await expect(live.locator('h1'), '見出しとして描かれていない').toContainText('まとめ');
  // ⚠ 行内コードは `pre` の外に在る(塊と行内を取り違えていない)
  await expect(live.locator('p code'), '行内コードとして描かれていない').toContainText('count');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});

/**
 * 🔴 **無言でない ── 読み取る形を切り替えられる**(user 指示 2026-08-25、3 通目)。
 *
 * > 「**無言でHTMLペーストを取得する以外のスイッチ経路を用意するなど、
 * > 実用とデバッグを兼用する工夫をしなさい / そのために設定やフラグはあるんだから!**」
 *
 * 🔴 **unit では届かない層**:設定画面で選んだ値が、**保存を経て**貼付まで届くか。
 *   ⚠ 途中のどこか(画面 → 保存 → 配線)が切れていても、片端の unit は緑になる
 *   (CLAUDE.md §7「A と B が合意していることは、A の test にも B の test にも書けない」)。
 */
test('🔴 設定で「リッチテキストを優先」にすると、貼付の結果が変わる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page);

  const RTF =
    String.raw`{\rtf1\ansi\deff0{\stylesheet{\s1 heading 1;}}` +
    String.raw`\pard\s1 リッチの見出し\par}`;
  const both = { html: '<h2>HTML の見出し</h2>', rtf: RTF, plain: '見出し' };

  // ① 既定(自動)では、ウェブページの形が勝つ ── 🔑 **対照群**
  await openLiveRow(page);
  await pasteText(page, ROW, both);
  await expect(page.locator(ROW), '既定でウェブページの形が勝っていない').toHaveValue(
    /## HTML の見出し/,
  );

  // ② 設定を切り替える(user と同じ手順 ── 設定の面を開いて選ぶ)
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  const select = page.locator('[data-pkc-field="paste-source-select"]');
  await expect(select, '設定に貼付の切替が無い').toBeVisible();
  await select.selectOption('rtf');

  /**
   * ③ 🔴 **再読込を挟む** ── 保存を経ていることまで見る。
   * ⚠ 挟まないと「この session の変数に入っただけ」でも通ってしまう。
   */
  await page.reload();
  await expect(page.locator('[data-pkc-boot="ready"]')).toBeAttached({ timeout: 20_000 });
  await openLiveRow(page);
  await pasteText(page, ROW, both);
  await expect(page.locator(ROW), '設定が貼付まで届いていない').toHaveValue(
    /# リッチの見出し/,
  );

  // ④ 設定の面に戻ると、選んだ値が映っている(古い値を見せない)
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await expect(
    page.locator('[data-pkc-field="paste-source-select"]'),
    '設定画面が古い値を見せている',
  ).toHaveValue('rtf');

  expect(errors, `page error: ${errors.join(' / ')}`).toEqual([]);
});
