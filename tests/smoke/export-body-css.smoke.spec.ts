/**
 * 書き出した HTML の**本文の見た目**(2026-08-07)。
 *
 * 🔴 **直す前、配った HTML は本文が素のままだった。** `app.css` の本文の規則は 71 個の
 * class に及ぶのに、書き出し HTML の `<style>` には `.pkc-*` の規則が **10 個**しか
 * 無かった。実ブラウザで 21 の観測点を並べて測ったところ **17 が違って**いた ──
 * `:::note` / `:::danger` は枠も地も無く**本文の段落と見分けが付かず**、タスク行は
 * **丸ポチとチェック欄が二重**に出て、圏点が付かず、`_3`(空行 3 つ)の高さが 0 だった。
 *
 * ## この spec の作り
 *
 * 🔑 **同じ本文をアプリと配った HTML の両方で描き、computed style を突き合わせる。**
 * 「規則が載っているか」は unit(`tests/features/pkc3-html.test.ts`)が見る ── ここは
 * **値が実際に効いているか**だけを見る。
 *
 * ⚠ **空振り防止は「素のままの値」で置く**(CLAUDE.md「ガードは代替物で満たせない
 *   条件にする」)。各観測点に「焼く前はこうだった」を書き、**アプリ側がその値でない**
 *   ことを先に確かめる ── 一致だけを見ると、**両面とも素のまま**でも通る。
 * ⚠ **絶対値で比べられない観測点がある**。本文の字は アプリ 13px / 閲覧 15px なので、
 *   `em` 由来の長さ(空行の高さ)は**字の大きさとの比**で見る。
 * ⚠ **配色を固定する**。既定の配色は OS の `prefers-color-scheme` に従う
 *   (`render/theme.ts` の `initialTheme`)ので、両面 `light` に寄せてから測る ──
 *   でないと「アプリは dark・紙は light」で偽の不一致になる。
 */
import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gotoApp, clickReal, createEntry, collectPageErrors, useSplitEditor } from './helpers';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

interface Point {
  /** 落ちたときに読む名前。 */
  readonly name: string;
  readonly sel: string;
  /** CSS の property 名(kebab-case)。 */
  readonly prop: string;
  /**
   * 🔴 **焼く前(素のまま)の値**。アプリ側がこの値なら、この観測点は
   * **何も守っていない** ── 規則が消えたことに気づけない。
   */
  readonly bare: string;
  /** `em` 由来の長さ。字の大きさとの比で比べる(面ごとに本文の字が違う)。 */
  readonly em?: true;
}

/**
 * 観測点。⚠ **記法を足したらここにも足す** ── 足さないと、その記法の見た目は
 * どちらの面でも誰にも守られない。
 */
const POINTS: readonly Point[] = [
  // 注意書き ── 直す前は枠も地も無く、本文の段落と見分けが付かなかった
  { name: '注意書きの枠の太さ', sel: '.pkc-section-callout', prop: 'border-left-width', bare: '0px' },
  {
    name: '注意書きの地',
    sel: '.pkc-section-callout',
    prop: 'background-color',
    bare: 'rgba(0, 0, 0, 0)',
  },
  { name: '危険の枠の色', sel: '.pkc-section-danger', prop: 'border-left-color', bare: 'rgb(0, 0, 0)' },
  // タスク行 ── 直す前は丸ポチとチェック欄が二重に出ていた
  { name: 'タスク行の丸ポチ', sel: 'li.pkc-task-item', prop: 'list-style-type', bare: 'disc' },
  // 圏点 ── 直す前は素の字だった
  { name: '圏点', sel: '.pkc-em-dot', prop: 'text-emphasis-style', bare: 'none' },
  // 印 ── 直す前は UA 既定の黄色のままだった
  { name: '印の地', sel: 'mark', prop: 'background-color', bare: 'rgb(255, 255, 0)' },
  // 目次 ── 直す前は枠も地も無かった
  { name: '目次の地', sel: '.pkc-toc-formal', prop: 'background-color', bare: 'rgba(0, 0, 0, 0)' },
  // 表のセル罫 ── 直す前は無彩色の半透明(#8884)で、アプリの罫と色が違った
  { name: '表のセル罫の色', sel: 'td', prop: 'border-top-color', bare: 'rgb(0, 0, 0)' },
  // 空行 ── 直す前は高さ 0(`_3` を書いても何も空かない)
  { name: '空行 3 つの高さ(字の大きさ比)', sel: '.pkc-blank-line', prop: 'height', bare: '0.00', em: true },
  /**
   * 本文のリンク。焼いた `.pkc-md-rendered a{color:var(--accent)}` が効く。
   * ⚠ この観測点は**紙の側でも見る**(下の `onPaper`)── 書き出し側の
   *   `@media print{.b a{color:inherit}}` を取り下げた判断は、これまで無検査だった
   *   (レビュー 2 巡目の指摘)。紙で黒へ戻す変異が、これで鳴る。
   */
  { name: '本文のリンク色', sel: 'a[href^="https"]', prop: 'color', bare: 'rgb(0, 0, 238)' },
  /**
   * 読み幅(user 裁定 2026-08-08 で統一)── アプリの 42rem/各ブロックが焼き込みで
   * 配った HTML にも届く(書き出し側の `.b` の 46em/器 は消えた)。
   * ⚠ 42rem は root(16px)基準なので、本文の字が違っても(13px / 15px)両面とも
   *   672px へ解決する ── `em` 比ではなく素の値で比べてよい。
   * ⚠ この観測点は器の `data-pkc-field='detail-body'` に依存する ── 属性を片方だけ
   *   落とすと、その面だけ 'none' になってここが鳴る(「片方だけ」の罠の門)。
   * ⚠ 紙の側でも見る(下の `onPaper`)── かつての `.b{max-width:none}` を書き戻す
   *   変異は、紙だけ 'none' になってここが鳴る。
   */
  { name: '段落の読み幅', sel: 'p', prop: 'max-width', bare: 'none' },
];

/**
 * 観測点を全部読む。⚠ 要素が無いのは**不一致ではなく空振り**なので別の値で返す。
 *
 * @param viaPrint 「全体を印刷」を押し、**`beforeprint` の瞬間に**測る。
 *
 * 🔴 **ここは環境差に強い側へ寄せた観測点である**(CLAUDE.md 2026-08-05 の規律)。
 * 押した**後**に測る書き方は、同梱 `chromium` では通るのに CI の
 * `chromium_headless_shell` で落ちる ── 後者は `window.print()` で
 * **`beforeprint` + `afterprint` を同期発火**し、`afterprint` の `dropAll()` が
 * 組んだ `#all` を**その場で捨てる**。だから「押した直後」には箱がもう無い
 * (実際にこの spec で踏んだ)。`beforeprint` はどちらのビルドでも成立する。
 */
async function measure(page: Page, host: string, viaPrint = false): Promise<Record<string, string>> {
  return page.evaluate(
    ({ host, points, viaPrint }) => {
      const read = (): Record<string, string> => {
        const out: Record<string, string> = {};
        const root = document.querySelector(host);
        if (!root) return { '(器)': `${host} が無い` };
        for (const p of points) {
          const el = root.querySelector(p.sel);
          if (!el) {
            out[p.name] = '(要素が無い)';
            continue;
          }
          const cs = getComputedStyle(el);
          // ⚠ 圏点は環境によって接頭辞つきしか返らないことがある
          let raw = cs.getPropertyValue(p.prop).trim();
          if (raw === '') raw = cs.getPropertyValue(`-webkit-${p.prop}`).trim();
          out[p.name] = p.em ? (parseFloat(raw) / parseFloat(cs.fontSize)).toFixed(2) : raw;
        }
        return out;
      };
      if (!viaPrint) return read();
      return new Promise<Record<string, string>>((resolve, reject) => {
        addEventListener('beforeprint', () => resolve(read()), { once: true });
        const btn = document.getElementById('printall');
        if (!btn) {
          reject(new Error('「全体を印刷」のボタンが無い'));
          return;
        }
        btn.click();
        // ⚠ 上限を置く ── 来なかったことを「一致」と読ませない
        setTimeout(() => reject(new Error('beforeprint が来なかった')), 5000);
      });
    },
    { host, points: POINTS as unknown as Point[], viaPrint },
  );
}

const BODY = [
  '# 見出し',
  '',
  '[外](https://example.com/x)',
  '',
  ':::note',
  '注意',
  ':::',
  '',
  ':::danger',
  '危険',
  ':::',
  '',
  '- [ ] やること',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '==印== と ^^強^^',
  '',
  '前',
  '',
  '_3',
  '',
  '後',
  '',
  // ⚠ 切替(描画 / 原文)を出すために fence を 1 つ置く ── 下の「切替の位置」で使う
  '```csv',
  '列A,列B',
  '1,2',
  '```',
  '',
  ':::toc{depth=2}',
  '',
].join('\n');

test('🔴 配った HTML の本文が、アプリと同じ見た目で出る', async ({ page }) => {
  const errors = collectPageErrors(page);
  // ⚠ 配色を固定する(既定は OS に従うので、面ごとに違うと偽の不一致になる)
  await page.emulateMedia({ colorScheme: 'light' });
  await gotoApp(page);
  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.click();
  await ta.fill(BODY);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();

  const app = await measure(page, '[data-pkc-field="detail-body"]');

  /**
   * 🔴 **空振り防止を先に置く。** アプリ側が「素のまま」の値なら、下の突合は
   * **両面とも壊れていても通る** ── 一致は正しさではない。
   */
  for (const p of POINTS) {
    expect(app[p.name], `${p.name}: アプリで観測できていない`).toBeDefined();
    expect(app[p.name], `${p.name}: アプリ側が素のまま(この観測点は何も守っていない)`).not.toBe(
      p.bare,
    );
    expect(app[p.name], `${p.name}: アプリで要素が出ていない(本文を足す)`).not.toBe(
      '(要素が無い)',
    );
  }

  // ── 配って、単体で開く(アプリの CSS は届かない)
  const dl = page.waitForEvent('download');
  // ⚠ #239 でこの操作は設定の中(書き出しと片づけ)へ移った ── 先に開く
  await clickReal(page, '[data-pkc-action="set-view"][data-pkc-view="settings"]');
  await clickReal(page, '[data-pkc-action="export-html"]');
  const file = join(tmpdir(), `pkc3-bodycss-${process.pid}.html`);
  await (await dl).saveAs(file);

  const viewer = await page.context().newPage();
  await viewer.emulateMedia({ colorScheme: 'light' });
  await viewer.goto(`file://${file}`);
  await expect(viewer.locator('#body')).toBeVisible();
  const exported = await measure(viewer, '#body');

  // 🔴 全観測点を**一度に**比べる(1 個ずつ見ると、最初の 1 件で止まって全体像が出ない)
  expect(exported, '配った HTML の見た目がアプリと違う').toEqual(app);

  /**
   * ⚠ **「全体を印刷」が組む器は別経路**(CLAUDE.md「同じ値を複数の描画経路へ渡す
   * ものは経路ごとに pin する」)。押して組ませてから、同じ観測点をもう一度測る ──
   * class を片方だけに足すと、ここだけ素のまま出る。
   */
  const printed = await measure(viewer, '#all section:nth-child(2) > div', true);
  expect(printed, '「全体を印刷」の本文だけ素の見た目で出る').toEqual(app);

  /**
   * 🔴 **紙でも同じ**(2026-08-07 のレビュー指摘で足した)。
   *
   * ⚠ 直す前、この spec は `@media print` を**一度も評価していなかった** ── 画面で
   * 揃っていても、`@media print` の `.b` 規則は焼いた分より**手前**に在るので、
   * 紙でだけ食い違う余地が残る。⚠ 紙の版面は紙の幅(A4 縦)で見る
   * (`print.smoke.spec.ts` の罠②・罠③ と同じ)。
   */
  await viewer.setViewportSize({ width: 794, height: 1123 });
  await viewer.emulateMedia({ media: 'print', colorScheme: 'light' });
  const onPaper = await measure(viewer, '#body');
  expect(onPaper, '紙にすると本文の見た目が変わる').toEqual(app);
  await viewer.emulateMedia({ media: 'screen', colorScheme: 'light' });

  /**
   * 🔴 **書き出し側にしかない 2 つ**(アプリに対応物が無いので parity 表に入れない)。
   * どちらも「焼いたら app.css が勝ってしまった」型の退行で、**実測で見つけた**。
   */
  const own = await viewer.evaluate(() => {
    const host = document.querySelector('#body')!;
    const tg = host.querySelector('.pkc-render-toggle');
    // ⚠ 添付のボタンは本文に無いので、同じ形の要素を器に置いて**継承だけ**を見る
    const f = document.createElement('a');
    f.className = 'f';
    // ⚠ **href を持たせる** ── 本物は blob URL を持つ。href が無いと UA の
    //    a:-webkit-any-link{color:-webkit-link} を一度も踏まず、肝心の
    //    「UA スタイルとの勝負」が再現されない(CLAUDE.md「stub は本物の意味論を真似る」)
    f.href = 'blob:probe';
    f.textContent = '添付';
    host.appendChild(f);
    const color = getComputedStyle(f).color;
    const bodyColor = getComputedStyle(host).color;
    f.remove();
    return {
      attachBtnColor: color,
      bodyColor,
      toggleRight: tg ? getComputedStyle(tg).right : '(切替が無い)',
      copyBtn: host.querySelector('.pkc-md-copy-btn') ? 'ある' : 'ない',
    };
  });
  // ① 添付のダウンロードボタンは**本文のリンクではない** ── 緑にしない
  expect(own.attachBtnColor, '添付のボタンが本文のリンク色に食われている').toBe(own.bodyColor);
  // ② 切替は右端 ── 閲覧側はコピーボタンを外すので app.css の 26px は空きになる
  expect(own.copyBtn, 'コピーボタンが残っている(前提が変わった ── 下の 2px を見直す)').toBe(
    'ない',
  );
  expect(own.toggleRight, '切替の右に 24px の空きが残っている').toBe('2px');

  await viewer.close();
  expect(errors, errors.join('\n')).toEqual([]);
});
