/**
 * 外部の画像の同意(2026-08-06、user 裁定)。
 *
 * 🔑 **unit では届かない 2 つ**を実ブラウザで見る:
 *
 * 1. **要求が本当に飛ばないか** ── `src` を消したことを DOM で pin するのは
 *    unit がやっている。ここが見るのは「その結果ネットワークに 1 本も出ないか」
 *    である(`loading="lazy"` は「飛ばない」ではないので、属性だけでは足りない)
 * 2. **箱の CSP が本当に止めるか + 申告が届くか** ── `securitypolicyviolation` は
 *    happy-dom に無い。CSP を焼いておきながら**止まっていない**ことも、
 *    止まったのに**帯が出ない**ことも、unit からは見えない
 *
 * ⚠ 器の見た目(寸法)もここで見る ── `src` の無い `<img>` は既定で **0×0** なので、
 *   CSS が効いていないと「画像を書いたのに何も無い」になる(CSS は build 物にしか
 *   在らず、unit は寸法を測れない)。
 */
import { test, expect, type Page } from '@playwright/test';
import { gotoApp, collectPageErrors, clickReal, createEntry } from './helpers';

/**
 * 「外」の画像として使う URL。
 * ⚠ **同じ preview サーバの絶対 URL** ── 判定は scheme の有無なので、これは
 *   規則上「外」であり、かつ**実際に読み込める**(押したら本当に出ることまで見える)。
 *   ⚠ 本物の第三者を叩かない(CI は外に出られないし、出るべきでもない)。
 */
function externalUrl(page: Page): string {
  return new URL('/icon.svg', page.url()).href;
}

/** そのノートに書いて確定する。 */
async function writeNote(page: Page, text: string): Promise<void> {
  await createEntry(page, 'text');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  await ta.click();
  await page.keyboard.type(text);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
}

test('既定(常に確認)では要求が飛ばず、器は見える大きさで置かれる', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  const url = externalUrl(page);

  /**
   * 🔑 ここの観測点は **`request` そのもの**でよい ── 塞いだ本文の画像は
   * `src` を**持たない**ので、**試行そのものが起きない**という主張である
   * (下の箱の test とは主張が違う ── あちらは「試行はするが CSP が止める」なので
   *  `request` では判定できない。理由はその test の註記に書いた)。
   * ⚠ 数え始めるのは本文を書く前。起動時の `/icon.svg`(manifest のアイコン)を
   *   数えてしまうと常に 1 件以上になり、**この検査は何も見なくなる**。
   */
  const asked: string[] = [];
  page.on('request', (r) => {
    if (r.url() === url) asked.push(r.url());
  });

  await writeNote(page, `![外の絵](${url})`);

  const img = page.locator('[data-pkc-field="detail-body"] img.pkc-external-img');
  await expect(img).toBeAttached();
  expect(await img.getAttribute('src'), 'src が載っている(要求が飛ぶ)').toBeNull();
  expect(await img.getAttribute('data-pkc-external-src'), 'URL が失われている').toBe(url);

  // 器が見える大きさで在る(0×0 だと「消えた」に見える)
  await expect(img).toBeVisible();
  const box = (await img.boundingBox())!;
  expect(box.width, '器の幅が無い(CSS が効いていない)').toBeGreaterThan(50);
  expect(box.height, '器の高さが無い(CSS が効いていない)').toBeGreaterThan(20);

  // 確認の帯が出ている
  const bar = page.locator('[data-pkc-field="external-image-bar"]');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('1 件');

  // 🔴 ここまでで**1 本も飛んでいない**
  expect(asked, `外部へ要求が飛んだ: ${asked.join(', ')}`).toEqual([]);

  /**
   * 押すと**本当に読み込まれる**(同意が効いていることの本体)。
   * ⚠ `src` が付くだけでは足りない ── `complete` と `naturalWidth` で
   *   「絵として届いた」ところまで見る。
   */
  await clickReal(page, '[data-pkc-action="allow-external-images"]');
  /**
   * ⚠ **器の class で探し直さない**。`pkc-external-img` は「読み込んでいない画像」の
   * 印なので、許可すると**付かない** ── 同じ locator を使い回すと、要素が
   * 見つからないまま待ち続けて「src が付かない」に見える(実際そう外した)。
   */
  const after = page.locator('[data-pkc-field="detail-body"] img');
  await expect.poll(async () => after.getAttribute('src'), { timeout: 5_000 }).toBe(url);
  await expect.poll(async () => asked.length, { timeout: 5_000 }).toBeGreaterThan(0);
  await expect
    .poll(async () => after.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), {
      timeout: 5_000,
    })
    .toBe(true);
  // 帯は消える(答えたので聞かない)
  await expect(page.locator('[data-pkc-field="external-image-bar"]')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('「読み込まない」を押すと、飛ばないまま帯だけ消える', async ({ page }) => {
  const errors = collectPageErrors(page);
  await gotoApp(page);
  const url = externalUrl(page);
  const asked: string[] = [];
  page.on('request', (r) => {
    if (r.url() === url) asked.push(r.url());
  });

  await writeNote(page, `![外の絵](${url})`);
  await expect(page.locator('[data-pkc-field="external-image-bar"]')).toBeVisible();
  await clickReal(page, '[data-pkc-action="deny-external-images"]');
  await expect(page.locator('[data-pkc-field="external-image-bar"]')).toHaveCount(0);

  const img = page.locator('[data-pkc-field="detail-body"] img.pkc-external-img');
  await expect(img).toBeVisible();
  expect(await img.getAttribute('src')).toBeNull();
  expect(asked).toEqual([]);
  expect(errors).toEqual([]);
});

/**
 * 🔴 **箱の CSP が実際に止め、止めたことが親へ届く**。
 *
 * ⚠ 箱の中身は script なので、外部画像を出すかは**描く前には判らない** ──
 *   だから「止まった」という事実だけが確認を出す材料になる。ここが壊れると
 *   「常に確認」で箱の画像を**同意する手段が無い**(帯が出ない)。
 * ⚠ CSP 違反は箱の中の console にも出る ── `collectPageErrors` は console.error を
 *   0 件と主張するので、この spec では**使わない**(違反が出るのが正常な動作である)。
 */
test('箱の中の外部画像は CSP で止まり、帯が出る', async ({ page }) => {
  await gotoApp(page);
  const url = externalUrl(page);
  /**
   * 🔴 **ネットワークの event を「飛んだ / 止まった」の判定に使わない**
   * (2026-08-06、2 つのブラウザで別の答えが出て判明)。
   *
   * 実測: CSP が止めた試行も `request` として上がり、`requestfailed` の
   * `errorText` は **両ビルドとも `'csp'`**(= 応答は返らない / bytes は出ない)。
   * ところが **到着の時期がまるで違う**:
   *   - `chromium_headless_shell`(CI が使う): assert より**先**に上がる
   *   - `chromium`(同梱・手元): 5 秒待っても上がらないことがある
   * 片方で `request` を数えると「外へ飛んだ」という**誤った読み**になり、
   * 片方で `requestfailed` を待つと**永遠に来ない**。どちらに寄せても
   * 「手元で緑・CI で赤」(あるいはその逆)になる。
   *
   * 🔑 だから観測点は**アプリ自身の信号**にする ── **帯が出たこと**が
   * 「箱の中で img-src の違反が実際に起きた」の証拠である(箱の script が
   * 動かなかった空振りなら帯は出ない)。加えて **応答が 1 度も返らない**ことを
   * 見る ── この 2 つが揃って初めて「止まった」と言える。
   */
  const responses: number[] = [];
  page.on('response', (r) => {
    if (r.url() === url) responses.push(r.status());
  });

  // ⚠ 箱の中身は script で画像を要求する(静的な `<img>` では「CSP が止めた」と
  //    「そもそも書いていない」の区別が弱い ── 実際に取りに行かせる)
  await writeNote(
    page,
    // ⚠ `<\/script>` と書かない ── ここは JS 文字列ではなく**本文**なので、
    //    バックスラッシュがそのまま入って箱の script が閉じない(実際そう外した)
    '```html\n<script>new Image().src=' + JSON.stringify(url) + ';</script>\n```',
  );

  const iframe = page.locator('iframe[data-pkc-html-render-id]');
  await expect(iframe).toBeAttached();

  const bar = page.locator('[data-pkc-field="external-image-bar"]');
  await expect(bar).toBeVisible({ timeout: 10_000 });
  await expect(bar).toContainText('HTML の中');
  // 🔴 帯が出た = 箱の中で img-src の違反が**実際に起きた**(空振りではない)。
  //    そのうえで、応答は 1 度も返っていない = bytes は外へ出ていない
  expect(responses, `箱の要求に応答が返っている(外へ出た): ${responses.join(', ')}`).toEqual([]);
});
