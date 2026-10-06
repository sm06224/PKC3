/**
 * 🔴 **OS から md を開く → その場で見えて、元ファイルへ戻せる**(2026-08-05、
 * user 報告「マークダウンファイルに紐付けれるけど、取り込みもスポットの編集
 * プレビュー導線も存在しない」/「開いたら何も起きずに終わる」)。
 *
 * ⚠ **unit では main.ts の配線に届かない**。`launchQueue` の受け口・取込・紐づけ・
 * 情報ペインの導線・書き戻しは、それぞれ unit で守っているが、**それらを繋いでいる
 * のは `main.ts` の closure だけ**である ── 既存の launch test は「受け口が
 * 張られたか」しか見ておらず、繋ぎ目が外れていても緑だった(調査 doc §5)。
 *
 * ここでは `window.launchQueue` を**アプリが読む前に**差して、実ブラウザで
 * 端から端まで通す。⚠ handle の fake は**本物の意味論**を真似る
 * (`isSameEntry` は同じファイルにだけ true / `createWritable` は書いた文字を貯める)。
 */
import { test, expect } from '@playwright/test';
import { answerAppDialog, gotoApp, clickReal, collectPageErrors, useSplitEditor } from './helpers';

// 2026-08-14(#104 第 2 弾): 既定は live ── この file は全文 textarea
// (editor-body)を入力の道具に使うので、設定で split を明示する。
// 既定(live)の顔は live-editor.smoke.spec.ts が守る。
test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

/** アプリが `armLaunchQueue` を呼ぶ前に `launchQueue` を用意する。 */
async function stubLaunch(
  page: import('@playwright/test').Page,
  files: { name: string; text: string; id: string }[],
): Promise<void> {
  await page.addInitScript((specs: { name: string; text: string; id: string }[]) => {
    const w = window as unknown as {
      __written?: Record<string, string>;
      __fire?: (which: number[]) => void;
    };
    w.__written = {};
    const handles = specs.map((spec) => ({
      id: spec.id,
      kind: 'file',
      getFile: () =>
        // ⚠ `lastModified` を**固定**する ── 既定は呼ぶたびに「いま」で、押し直し・書き戻しの前に
        //    「パソコン側で変わっています」(#1264 §2 欠陥 1)が出てしまう(本物は触っていない file なら同じ値)
        Promise.resolve(
          new File([spec.text], spec.name, { type: 'text/markdown', lastModified: Date.UTC(2026, 9, 1) }),
        ),
      // ⚠ 本物は「同じファイルを指すか」を答える(名前ではなく実体)
      isSameEntry: (other: { id?: string }) => Promise.resolve(other.id === spec.id),
      queryPermission: () => Promise.resolve('granted'),
      createWritable: () =>
        Promise.resolve({
          write: (data: string) => {
            w.__written![spec.name] = data;
            return Promise.resolve();
          },
          close: () => Promise.resolve(),
        }),
    }));
    let consumer: ((p: unknown) => void) | null = null;
    /**
     * ⚠ **代入では差せない**(2026-08-05 に踏んだ)。`window.launchQueue` は
     * 読み取り専用の platform 属性なので、`window.launchQueue = …` は
     * **黙って無視される** ── アプリは本物(空)の queue を読み、ファイルが
     * 一度も届かないまま test は「何も起きない」を見る(= 空振り)。
     * `defineProperty` で置き換える。
     */
    Object.defineProperty(w, 'launchQueue', {
      configurable: true,
      value: {
        setConsumer: (fn: (p: unknown) => void) => {
          consumer = fn;
          // 仕様どおり「登録前に溜まっていた分が即座に流れる」を再現
          fn({ files: [handles[0]] });
        },
      },
    });
    // 2 通目以降(起動中に別の md を開く / 同じ md をもう一度開く)
    w.__fire = (which) => consumer?.({ files: which.map((i) => handles[i]) });
  }, files);
}

test('🔴 OS から開いた md が画面に出て、直して元ファイルへ戻せる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await stubLaunch(page, [
    { id: 'inbox/議事録.md', name: '議事録.md', text: '# 議事録\n\n本文です。\n' },
    { id: 'archive/議事録.md', name: '議事録.md', text: '# 別の議事録\n' },
  ]);
  await gotoApp(page);

  // ① **開いたら画面に出る**(直す前は末尾に足すだけで、何も起きないように見えた)
  await expect(page.locator('[data-pkc-region="detail"]')).toContainText('本文です。');
  // ② **どのファイルから来たか**が情報ペインに出る
  await expect(page.locator('[data-pkc-field="inspector-linked-file"]')).toHaveText(
    '議事録.md',
  );

  // ③ 中身を直す(実際の編集導線 ── 本文欄は 1 打鍵ごとに state へ写る)
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
  await page.fill('[data-pkc-field="editor-body"]', '# 議事録\n\n直しました。\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');

  // ④ **元ファイルへ書き戻す**(確認は出る ── user のファイルを上書きするので)
  await clickReal(page, '[data-pkc-action="write-back-file"]');
  // 🔴 #1231 段②: 確認の小窓に**ファイルとのちがい**が出る(− が消える行、+ が書かれる行)。
  //    ⚠ 色は**画面の計算後の色**で見る(印の字だけでは「見分けられる」を言えない)
  const addRow = page.locator('[data-pkc-field="dialog-diff-rows"] [data-pkc-diff="add"]');
  const delRow = page.locator('[data-pkc-field="dialog-diff-rows"] [data-pkc-diff="del"]');
  await expect(addRow, '書かれる行が + で出ていない').toHaveText('+ 直しました。');
  await expect(delRow, '消える行が − で出ていない').toHaveText('− 本文です。');
  const colorOf = (loc: typeof addRow) => loc.evaluate((el) => getComputedStyle(el).color);
  const [addColor, delColor] = [await colorOf(addRow), await colorOf(delRow)];
  expect(addColor, '+ の行と − の行が同じ色(色の規則が当たっていない)').not.toBe(delColor);
  await expect(page.locator('[data-pkc-field="dialog-ok"]')).toHaveText('書き戻す');
  await answerAppDialog(page, 'ok');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __written: Record<string, string> }).__written['議事録.md']))
    .toBe('# 議事録\n\n直しました。\n');

  // ④-2 🔴 **本文を空にして書き戻しても、元ファイルは空にならない**(#215 段③)。
  //   確認の窓は出ず(押せて、理由を言う)、ファイルは ④ で書いた中身のまま。
  //   ⚠ 空白だけが空(設定行だけは空ではない = #1266。判定は unit が全形を見る ── ここは実画面を通す 1 本)。
  const writtenOf = () =>
    page.evaluate(() => (window as unknown as { __written: Record<string, string> }).__written['議事録.md']);
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="start-edit"]');
  await page.fill('[data-pkc-field="editor-body"]', '  \n\n');
  await clickReal(page, '[data-pkc-region="detail"] [data-pkc-action="commit-edit"]');
  await clickReal(page, '[data-pkc-action="write-back-file"]');
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '空の本文なのに、書かない理由を言っていない(無言の dead click)',
  ).toContainText('本文が空なので、元ファイルへは書き戻しません');
  await expect(page.locator('[data-pkc-field="dialog-body"]'), '空なのに確認の窓が出た').toBeHidden();
  expect(await writtenOf(), '空の本文で元ファイルが上書きされた').toBe('# 議事録\n\n直しました。\n');

  // ⑤ 🔴 **同じファイルをもう一度開いても増えない**(前のノートを出す)
  const count = () => page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]').count();
  const before = await count();
  await page.evaluate(() => (window as unknown as { __fire: (w: number[]) => void }).__fire([0]));
  // ⚠ 「増えなかった」だけでは**何も起きなくても通る** ── 経路が走った証拠を見る
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '重複を弾いたことを言っていない(黙って終えている)',
  ).toContainText('すでに開いている');
  await expect.poll(count, { message: '同じ md で増えた' }).toBe(before);

  // ⑥ 🔴 **同名の別ファイル**は別のノートになる(名前で照合していない証拠)
  await page.evaluate(() => (window as unknown as { __fire: (w: number[]) => void }).__fire([1]));
  await expect.poll(count, { message: '同名の別ファイルが同じ物と見なされた' }).toBe(before + 1);
  await expect(page.locator('[data-pkc-region="detail"]')).toContainText('別の議事録');

  expect(errors).toEqual([]);
});

/**
 * 🔴 **左の「PC」タブ → フォルダを選ぶ → 一覧 → 行を押すと取り込んで開く**(#215 段①②。
 * 🟣 Gemini 裁定 2026-10-01)。
 *
 * ⚠ `showDirectoryPicker` を**アプリが読む前に**差す(本物の選択画面は headless で出せない)。
 *   handle の fake は本物の意味論を真似る(`values()` は非同期の列挙 / `queryPermission` は
 *   `'granted'` を返す / `isSameEntry` は同じ file にだけ true / `createWritable` は書いた字を貯める)。
 * 🔑 既存の道中(OS から開く)と**同じ取り込みの口**を通るので、ここで見るのは
 *   「**押した先が本当にそこへ繋がっている**」こと(`main.ts` の配線 ── unit は届かない):
 *   ① md は取り込まれて中央に開き、**元ファイルへ書き戻す**が出る ② 画像は添付として開き、**書き戻すは出ない**
 *   ③ **同じ md をもう一度押しても増えない** ④ 開いても左の列は「PC」のまま。
 */
test('🔴 PC のタブ: 選ぶ → 並ぶ → 押すと取り込んで開く(md は書き戻せる / 画像は添付)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.addInitScript(() => {
    const w = window as unknown as { __picked?: unknown[]; __getFile?: string[] };
    w.__picked = [];
    // 🔴 `getFile` を呼んだ file の名前(#1271 ── 一覧を出すだけでは 1 件も呼ばれない)
    w.__getFile = [];
    const png = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
      (c) => c.charCodeAt(0),
    );
    const mk = (name: string, parts: BlobPart[], type: string) => {
      const h = {
        kind: 'file',
        name,
        getFile: () => {
          w.__getFile!.push(name);
          return Promise.resolve(new File(parts, name, { type, lastModified: Date.UTC(2026, 8, 30) }));
        },
        // ⚠ 本物は「同じ file を指すか」を答える(名前ではなく実体)
        isSameEntry: (other: unknown) => Promise.resolve(other === h),
        queryPermission: () => Promise.resolve('granted'),
        createWritable: () => Promise.resolve({ write: () => Promise.resolve(), close: () => Promise.resolve() }),
      };
      return h;
    };
    const entries = [
      mk('メモ.md', ['# パソコンのメモ\n\n本文です。\n'], 'text/markdown'),
      mk('猫.png', [png], 'image/png'),
      { kind: 'directory', name: '下の階層' },
      mk('名刺.vcf', ['BEGIN:VCARD\nVERSION:3.0\nFN:山田 太郎\nTEL:090-1234-5678\nEND:VCARD\n'], 'text/vcard'),
    ];
    const dir = {
      kind: 'directory',
      name: '資料',
      queryPermission: () => Promise.resolve('granted'),
      values: async function* () {
        for (const e of entries) yield e;
      },
    };
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: (o: unknown) => {
        w.__picked!.push(o);
        return Promise.resolve(dir);
      },
    });
  });
  await gotoApp(page);

  // 基準 ── フォルダのタブの行数(あとで「増えたのは 2 件だけ」を見る)
  const filerRows = () => page.locator('[data-pkc-region="filer-table"] [data-pkc-entry]').count();
  const base = await filerRows();

  // ① タブを押す → 説明と「フォルダを選ぶ…」だけが出る
  const tab = page.locator('[data-pkc-action="set-browse"][data-pkc-browse="pc"]');
  await clickReal(page, tab);
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const pane = page.locator('[data-pkc-browse-pane="pc"]');
  await expect(pane).toBeVisible();
  await expect(pane.locator('button')).toHaveCount(1);

  // ② 選ぶ → 直下が並ぶ(フォルダ・名前順)。読むだけの許可で選ばせている
  await clickReal(page, '[data-pkc-action="pc-pick-folder"]');
  await expect(pane.locator('[data-pkc-field="pc-folder-name"]')).toHaveText('資料');
  await expect(pane.locator('[data-pkc-pc-row] [data-pkc-field="pc-name"]')).toHaveText([
    '下の階層',
    'メモ.md',
    '猫.png',
    '名刺.vcf',
  ]);
  expect(
    await page.evaluate(() => (window as unknown as { __picked: unknown[] }).__picked),
    '書く許可でフォルダを選ばせている',
  ).toEqual([{ mode: 'read' }]);
  // 🔴 #1271: 一覧を出しただけでは `getFile` を 1 件も呼ばない(クラウド同期のフォルダで実体が一斉に落ちる)。
  // 大きさ・更新日は「—」(実値が出ていたら、どこかで読んでいる)
  await expect(pane.locator('[data-pkc-pc-row] [data-pkc-field="pc-meta"]').nth(1)).toHaveText('Markdown · — · —');
  expect(
    await page.evaluate(() => (window as unknown as { __getFile: string[] }).__getFile),
    '一覧を出しただけで getFile が呼ばれた',
  ).toEqual([]);
  // 目印: **Markdown の行にだけ**「元ファイルとつながります」(#1264 §2 改善 1)/ 画像には何も添えない / フォルダの行は押せない
  const row = (name: string) => pane.locator('[data-pkc-pc-row]').filter({ hasText: name });
  await expect(row('メモ.md').locator('[data-pkc-field="pc-link-note"]')).toHaveText('元ファイルとつながります');
  await expect(row('猫.png').locator('[data-pkc-field="pc-link-note"]')).toHaveCount(0);
  await expect(pane.locator('[data-pkc-field="pc-link-note"]'), '結びつく行は md の 1 行だけ').toHaveCount(1);
  await expect(pane.locator('[data-pkc-field="pc-readonly"]'), '「書き戻せません」が全行に戻っている').toHaveCount(0);
  // 🔴 帯に「更新」と「別のフォルダ…」(#1264 §2 欠陥 4-a)── 更新は名前と種類だけ読み直す(getFile を呼ばない)
  await clickReal(page, '[data-pkc-action="pc-refresh-folder"]');
  await expect(pane.locator('[data-pkc-pc-row] [data-pkc-field="pc-name"]')).toHaveCount(4);
  expect(
    await page.evaluate(() => (window as unknown as { __getFile: string[] }).__getFile),
    '更新で getFile が呼ばれた',
  ).toEqual([]);
  await expect(pane.locator('[data-pkc-field="pc-repick"]')).toHaveText('別のフォルダ…');
  await expect(pane.locator('[data-pkc-field="pc-refresh"]')).toHaveText('更新');
  await expect(row('下の階層').locator('button')).toHaveCount(0);
  // 🔴 vCard は連絡先になることが見える字で出る(ホバーだけにしない)/ サブフォルダは押しても無言にならない(#1264 §1)
  await expect(row('名刺.vcf').locator('[data-pkc-field="pc-contact-note"]')).toHaveText('連絡先として取り込みます');
  await expect(row('メモ.md').locator('[data-pkc-field="pc-contact-note"]')).toHaveCount(0);
  await expect(row('下の階層')).toHaveAttribute('title', /中へは入りません/);
  // 🔴 行頭に種類の絵(#1272)── 属性だけでなく、実ブラウザで ::before が字を出し、名前と中心が揃っている
  await expect(pane.locator('[data-pkc-pc-row] [data-pkc-icon]')).toHaveCount(4);
  for (const [name, symbol] of [
    ['下の階層', 'folder'],
    ['メモ.md', 'note'],
    ['猫.png', 'camera'],
    ['名刺.vcf', 'person'],
  ] as const) {
    const head = row(name).locator('[data-pkc-field="pc-head"]');
    await expect(head.locator('[data-pkc-icon]'), `${name} の絵`).toHaveAttribute('data-pkc-symbol', symbol);
    const seen = await head.evaluate(async (el) => {
      await document.fonts.ready;
      const icon = el.querySelector('[data-pkc-icon]') as HTMLElement;
      const nameEl = el.querySelector('[data-pkc-field="pc-name"]') as HTMLElement;
      const a = icon.getBoundingClientRect();
      const b = nameEl.getBoundingClientRect();
      return {
        content: getComputedStyle(icon, '::before').content,
        iconW: a.width,
        dy: Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)),
      };
    });
    expect(seen.content, `${name}: 絵が描かれていない`).not.toMatch(/^(none|normal|"")$/);
    expect(seen.iconW, `${name}: 絵に幅が無い`).toBeGreaterThan(4);
    expect(seen.dy, `${name}: 絵と名前の中心がずれている`).toBeLessThan(3);
  }
  // 🔴 普通の一覧(#1272)── 下地は透明(余りが灰色のベタにならない)/ 各行に下罫線 / フォルダの行と他の行で文字の左端が同じ
  const look = await pane.locator('[data-pkc-field="pc-list"]').evaluate((ul) => {
    const lis = [...ul.querySelectorAll<HTMLElement>(':scope > li')];
    const left = (li: HTMLElement) =>
      (li.querySelector('[data-pkc-icon]') as HTMLElement).getBoundingClientRect().left - li.getBoundingClientRect().left;
    const cs = getComputedStyle(ul);
    return {
      bg: cs.backgroundColor,
      gap: cs.rowGap,
      borders: lis.map((li) => getComputedStyle(li).borderBottomWidth),
      lefts: lis.map(left),
    };
  });
  expect(look.bg, '一覧の下地が塗られている(余りがベタになる)').toBe('rgba(0, 0, 0, 0)');
  expect(look.gap, '行の間を gap で空けている(下地が透ける)').toBe('normal');
  expect(look.borders, '各行の下罫線').toEqual(['1px', '1px', '1px', '1px']);
  expect(Math.max(...look.lefts) - Math.min(...look.lefts), '行頭の絵の左端が行ごとにずれている').toBeLessThan(1);
  await clickReal(page, row('下の階層'));
  await expect(
    page.locator('[data-pkc-region="status"]'),
    'サブフォルダの行を押したのに、理由が出ない(無言)',
  ).toContainText('中へは入りません');
  await expect(tab, '押したら場所が動いた').toHaveAttribute('aria-selected', 'true');
  await expect(pane.locator('[data-pkc-field="pc-folder-name"]')).toHaveText('資料');

  // ③ md の行を押す → 取り込まれて中央に開き、元ファイルの名前が出て、書き戻す押し所が在る
  await clickReal(page, row('メモ.md').locator('button'));
  await expect(page.locator('[data-pkc-region="detail"]')).toContainText('本文です。');
  expect(
    await page.evaluate(() => (window as unknown as { __getFile: string[] }).__getFile),
    '押した 1 件だけ読むはず',
  ).toEqual(['メモ.md']);
  await expect(page.locator('[data-pkc-field="inspector-linked-file"]')).toHaveText('メモ.md');
  await expect(page.locator('[data-pkc-action="write-back-file"]').first()).toBeVisible();
  // ④ 🔴 開いても、左の列は「PC」のまま(別の場所を守る)
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(pane).toBeVisible();

  // ⑤ 画像の行を押す → 添付として中央に開く。⚠ 書き戻す押し所は出ない
  await clickReal(page, row('猫.png').locator('button'));
  await expect(page.locator('[data-pkc-region="detail"]')).toContainText('猫.png');
  await expect(page.locator('[data-pkc-action="write-back-file"]')).toHaveCount(0);
  await expect(tab).toHaveAttribute('aria-selected', 'true');

  // ⑥ 🔴 同じ md をもう一度押しても増えない(前のノートを出して、そう言う)
  await clickReal(page, row('メモ.md').locator('button'));
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '重複を弾いたことを言っていない(黙って終えている)',
  ).toContainText('すでに開いている');
  await clickReal(page, row('猫.png').locator('button'));
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('すでに取り込んである');

  // ⑥-b 🔴 vCard も同じ(#1264 §1)── 1 回目は連絡先が 1 枚入り、2 回目は増やさず連絡先の一覧へ送って言う
  await clickReal(page, row('名刺.vcf').locator('button'));
  const contacts = page.locator('[data-pkc-browse-pane="contacts"] [data-pkc-contact]');
  await expect(page.locator('[data-pkc-region="status"]')).toContainText('取り込み完了');
  await clickReal(page, row('名刺.vcf').locator('button'));
  await expect(
    page.locator('[data-pkc-region="status"]'),
    '同じ vCard を弾いたことを言っていない(黙って終えている)',
  ).toContainText('すでに取り込んであります');
  await expect(
    page.locator('[data-pkc-action="set-browse"][data-pkc-browse="contacts"]'),
    '連絡先の面へ送っていない',
  ).toHaveAttribute('aria-selected', 'true');
  await expect(contacts, '同じ vCard で連絡先が増えた(または入っていない)').toHaveCount(1);
  // PC のタブへ戻る(繋ぎは残っている)
  await clickReal(page, tab);
  await expect(pane).toBeVisible();

  // ⑦ 切る → 繋ぐ前へ戻る
  await clickReal(page, '[data-pkc-action="pc-cut-folder"]');
  await expect(pane.locator('[data-pkc-action="pc-pick-folder"]')).toBeVisible();
  await expect(pane.locator('[data-pkc-pc-row]')).toHaveCount(0);

  // ⑧ 増えたのは md と画像と vCard の 3 件だけ(2 回目の押しでは増えていない)
  await clickReal(page, '[data-pkc-action="set-browse"][data-pkc-browse="filer"]');
  await expect.poll(filerRows, { message: '取り込みが 3 件ではない(押し直しで増えた / 入っていない)' }).toBe(base + 3);

  expect(errors).toEqual([]);
});
