import { test, expect } from '@playwright/test';
import { gotoApp, clickReal, createEntry, collectPageErrors } from './helpers';

/**
 * 🔴 **文書 globals(`writing` / `direction` / `align`)と logical align の規約**
 * (2026-08-06。user 裁定)。
 *
 * > user:「**それは PKC-Markdown と PKC IR の規約だから、PKC2 の実装が間違えて
 * > いるなら、直す必要がある**」
 *
 * 規約(`PKC2: docs/development/notation-redesign-2026-05/`):
 * - `02-frontmatter-and-globals.md` §2.3.3 `writing` × `align` の matrix
 *   (横書きは left/right/center、縦書きは top/bottom/center)
 * - 同 §2.3.4 `direction: rtl` では **`align` の既定が `right` になる**
 *   (= 既定 align は logical `start`)
 * - 同 §2.3.5 **縦書きでは text 内 `direction` は `ltr`**(CSS mapping を規約が明示)
 * - `11-canonicalization-spec.md` §53 / `docs/spec/markdown-dialect-for-ai-authors-v3.md`
 *   (唯一 canonical)/ `pkc-markdown-complete-spec-v4.md` §6.2:
 *   **`|>` = logical end(LTR で右、RTL で左)**、physical(`left`/`right`)は
 *   **強制的に物理方向**で formal 専用
 *
 * 🔴 **`|>` の意味は裁定済み**(user 裁定 2026-08-08、Issue #103)──
 * 「**|> も<|も|<も意味は同じ、グローバルの文字の寄せを反対にする**」。規約の 2 通り
 * (① §2.3.6 draft「宣言した `align` の反対側」/ ② 上記 canonical 3 本「flow の end」)は
 * **① に決着**。属性は `end` のまま、「宣言 align が flow start と逆の文書」でだけ
 * app.css の入れ替え規則が見え方を反転する ── **本 spec の ② 段がそれを実ブラウザで見る**。
 *
 * PKC3 に何が無かったか(移植で落ちていた):
 * ① `data-pkc-doc-align` / `data-pkc-writing` を**消費する CSS が 1 行も無かった**
 *    ── 書いても何も起きない
 * ② physical の `right` / `left` を logical の `end` / `start` と**同居**させていた
 *    ── `direction: rtl` で**物理強制が反転**する
 * ③ 縦書きで `direction: ltr` に固定していなかった ── `writing: vertical` +
 *    `direction: rtl`(= 日本語の伝統的な縦書き)で**本文が下から上へ流れる**
 * ④ 縦書き × `top` / `bottom` の規則がゼロ ── 属性は出るのに誰も読まない
 *
 * ⚠ **ここは実ブラウザでしか測れない**(CSS の解決結果)。
 * unit(happy-dom)は CSS を解決しないので、生成された属性しか見えない。
 */

/** 1 件作って本文を入れ、保存して読む面に出す。 */
async function writeNote(
  page: import('@playwright/test').Page,
  title: string,
  body: string,
): Promise<void> {
  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill(title);
  await page.locator('[data-pkc-field="editor-body"]').fill(body);
  await clickReal(page, '[data-pkc-action="commit-edit"]');
  await expect(page.locator('[data-pkc-field="detail-body"]')).toBeVisible();
}

/**
 * 読む面の段落が**実際にどちら側へ寄ったか**を、版面の位置から採る。
 *
 * 🔴 **computed style では測れない**(2026-08-06 に実測で判明)。Chromium は
 * `text-align: end` を **`"end"` のまま**返し、物理側へ解決しない(解決は layout)。
 * だからキーワードを読むと「logical のまま = 物理側は不明」で、
 * 「どちらへ寄ったか」を一度も検査できない。
 * ⚠ **文字の実際の箱**(Range の rect)と段落の箱を比べて、
 *   どちらの余白が大きいかで判定する ── これは見た目そのものである。
 * @param axis 横書きは `'x'`(left / right)、縦書きは `'y'`(top / bottom)。
 */
async function alignsOf(
  page: import('@playwright/test').Page,
  axis: 'x' | 'y' = 'x',
): Promise<string[]> {
  return page.locator('[data-pkc-field="detail-body"]').evaluate(
    (host, ax) =>
      [...host.querySelectorAll('p')].map((p) => {
        const box = p.getBoundingClientRect();
        const r = document.createRange();
        r.selectNodeContents(p);
        const text = r.getBoundingClientRect();
        const nearGap = ax === 'x' ? text.left - box.left : text.top - box.top;
        const farGap = ax === 'x' ? box.right - text.right : box.bottom - text.bottom;
        const near = ax === 'x' ? 'left' : 'top';
        const far = ax === 'x' ? 'right' : 'bottom';
        // ⚠ 余白が両側とも小さい(= 折り返して幅いっぱい)ときは判定できない
        if (Math.abs(nearGap - farGap) <= 2) return nearGap + farGap < 4 ? 'full' : 'center';
        return nearGap < farGap ? near : far;
      }),
    axis,
  );
}

test('🔴 `|>` はグローバルの寄せの反対側に寄る ── 物理強制は反転しない', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);

  // ① 既定(align 宣言なし・LTR)── グローバルの寄せは flow start(左)なので反対 = 右
  await writeNote(page, '既定', '普通の段落\n\n|> 終端\n\n|| 中央\n');
  {
    const a = await alignsOf(page);
    expect(a[0], '普通の段落が寄っている').toBe('left');
    expect(a[1], '`|>` が終端(右)に寄っていない').toBe('right');
    expect(a[2], '`||` が中央でない').toBe('center');
  }

  /**
   * ② 🔴 **宣言した既定の寄せが効く**(直す前は `data-pkc-doc-align` を読む CSS が
   * 1 行も無く、`align: right` は 100% 見た目 no-op だった)。
   * 🔴 このとき `|>`(end)は**左**(user 裁定 2026-08-08、Issue #103
   * 「グローバルの文字の寄せを反対にする」)── 宣言 align(右)の反対側。
   * ⚠ 2026-08-08 まではここを「右のまま(logical end 固定)」と pin していた ──
   *   裁定で反転した。app.css の入れ替え規則が実際に効いているかを見る観測点は
   *   ここ(実ブラウザの版面)だけである(unit は CSS を解決しない)。
   */
  await writeNote(page, '既定を右に宣言', '---\nalign: right\n---\n\n普通の段落\n\n|> 終端\n');
  {
    const a = await alignsOf(page);
    expect(a[0], '宣言した既定の寄せ(右)が効いていない').toBe('right');
    expect(a[1], '`|>` が宣言 align の反対側(左)に寄っていない').toBe('left');
  }

  // ③ RTL の既定 ── §2.3.4 で align の既定が right になるので `|>` は左
  await writeNote(page, '右から左', '---\ndirection: rtl\n---\n\n普通の段落\n\n|> 終端\n');
  {
    const a = await alignsOf(page);
    expect(a[0], 'RTL で無印が右(行頭)に寄っていない').toBe('right');
    expect(a[1], 'RTL で `|>` が左になっていない').toBe('left');
  }

  /**
   * ④ 🔴 **physical は反転しない**(formal 専用の「物理強制」)。
   * 直す前は `right` を `text-align: end` に同居させていたので、RTL の文書で
   * **物理右が左へ寄っていた**。
   */
  await writeNote(
    page,
    '物理強制',
    '---\ndirection: rtl\n---\n\n:::paragraph{align=right}\n物理右\n:::\n\n' +
      ':::paragraph{align=left}\n物理左\n:::\n',
  );
  {
    const a = await alignsOf(page);
    expect(a[0], 'RTL で物理右が反転した(物理強制が壊れている)').toBe('right');
    expect(a[1], 'RTL で物理左が反転した').toBe('left');
  }

  /**
   * ⑤ 🔴 **`:align:{position=left}` も物理**(同じ「潰し」が parser 側に残っていた)。
   * 直す前は `left → start` と写していたので、RTL の文書で**左と書いて右へ行った**。
   */
  await writeNote(
    page,
    '寛容記法の物理',
    '---\ndirection: rtl\n---\n\n:align:{position=left}\n\n左と書いた段落\n',
  );
  {
    const a = await alignsOf(page);
    expect(a[0], 'RTL で `position=left` が右へ行った').toBe('left');
  }

  expect(errors).toEqual([]);
});

/**
 * 🔴 **編集中のプレビューにも文書 globals が届き、消したら消える**(2026-08-06)。
 *
 * 直す前は `applyDocumentGlobals` の呼び出しが読む面の 1 か所だけで、プレビューには
 * `dir` も `data-pkc-doc-align` も付かなかった ── `align: right` を宣言した文書は
 * **書いている最中だけ効いていない**(確定した瞬間に動く)。
 *
 * ⚠ **掃除(当てる前に全部消す)の観測点はここである**。読む面の器は選択が動くと
 *   作り直される(`skeletonLid !== lid` で骨組みごと捨てる)ので、そちらでは
 *   汚れが残らない ── 最初は「別のノートへ切り替える」で書いて、掃除を消す変異が
 *   **生き延びた**。プレビューの器は打鍵のあいだ同じ要素なので、**宣言を消したときに
 *   前の宣言が残るか**がそのまま出る(= 実際に user が踏む形)。
 */
test('🔴 プレビューにも宣言が届き、宣言を消すと戻る(器が汚れない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);

  await createEntry(page, 'text');
  await page.locator('[data-pkc-field="editor-title"]').fill('宣言の出し入れ');
  const ta = page.locator('[data-pkc-field="editor-body"]');
  const preview = page.locator('[data-pkc-region="editor-preview"]');

  await ta.fill('---\ndirection: rtl\nalign: right\n---\n\n本文\n');
  await expect(preview, 'プレビューに direction が届いていない').toHaveAttribute('dir', 'rtl');
  await expect(preview, 'プレビューに既定の寄せが届いていない').toHaveAttribute(
    'data-pkc-doc-align',
    'right',
  );

  // 宣言を消す ── **前の宣言が残ってはいけない**
  await ta.fill('本文だけ\n');
  await expect(preview, '消した direction が残っている').not.toHaveAttribute('dir', 'rtl');
  expect(
    await preview.getAttribute('data-pkc-doc-align'),
    '消した既定の寄せが残っている',
  ).toBeNull();
  expect(await preview.getAttribute('data-pkc-direction'), '消した direction が残っている').toBeNull();

  expect(errors).toEqual([]);
});

/**
 * 縦書きの本文が**どちら向きに流れているか**を、最初の文字と最後の文字の
 * 位置で採る。
 *
 * ⚠ **寄せの測り方(余白の比較)ではこれを検出できない** ── 短い段落 1 本だと
 *   器が inline 軸方向に content 幅まで縮み、余白が両側ゼロになる(実測で
 *   `'full'` が返る)。向きは「文字の順序」に出るので、そこを見る。
 */
async function flowOf(page: import('@playwright/test').Page): Promise<'top-down' | 'bottom-up'> {
  return page.locator('[data-pkc-field="detail-body"]').evaluate((host) => {
    const text = host.querySelector('p')!.firstChild!;
    const len = (text.textContent ?? '').length;
    const rect = (s: number, e: number): DOMRect => {
      const r = document.createRange();
      r.setStart(text, s);
      r.setEnd(text, e);
      return r.getBoundingClientRect();
    };
    return rect(0, 1).top < rect(len - 1, len).top ? 'top-down' : 'bottom-up';
  });
}

/**
 * ⚠ 縦書きの寄せを測るには、**inline 軸(垂直)に余白が要る** ── 器は content まで
 *   縮むので、短い段落 1 本だと寄せようが無い。長い段落を 1 本置いて器を伸ばし、
 *   その隣の短い段落がどちらへ寄るかを見る(これが実際の見た目でもある)。
 */
const LONG_LINE = 'あ'.repeat(40);

test('🔴 縦書きは上から下へ流れる(`direction: rtl` で下から上にならない)', async ({ page }) => {
  const errors = collectPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoApp(page);

  await writeNote(page, '縦書き', '---\nwriting: vertical\n---\n\n縦に流れる本文\n');
  const mode = await page
    .locator('[data-pkc-field="detail-body"]')
    .evaluate((h) => getComputedStyle(h).writingMode);
  // ⚠ 既定(direction 未宣言)は右起こし = vertical-rl
  expect(mode, '縦書きの宣言が描画に届いていない').toBe('vertical-rl');

  // `direction: ltr` + 縦書き = 左起こし(蒙古文等)
  await writeNote(
    page,
    '縦書き左起こし',
    '---\nwriting: vertical\ndirection: ltr\n---\n\n縦に流れる本文\n',
  );
  const modeLtr = await page
    .locator('[data-pkc-field="detail-body"]')
    .evaluate((h) => getComputedStyle(h).writingMode);
  expect(modeLtr, '`direction: ltr` の縦書きが右起こしになっている').toBe('vertical-lr');

  /**
   * 🔴 **本題** ── 日本語の伝統的な縦書き宣言(`writing: vertical` +
   * `direction: rtl`)。規約 §2.3.5 は text 内 `direction` を `ltr` に固定せよと
   * 言っている(`vertical-rl` の inline 軸は**垂直**なので、`rtl` を残すと
   * inline 軸が**下→上**になり、本文が下から上へ流れる)。
   * ⚠ 属性(`dir="rtl"`)は残っていてよい ── 右起こし / 左起こしの区別を持つのは
   *   属性の側で、CSS の `direction` は固定するのが規約である。
   */
  await writeNote(
    page,
    '日本語の縦書き',
    `---\nwriting: vertical\ndirection: rtl\n---\n\n${LONG_LINE}\n\n短い段落\n`,
  );
  {
    const host = page.locator('[data-pkc-field="detail-body"]');
    expect(await host.getAttribute('dir'), '宣言した direction が属性に出ていない').toBe('rtl');
    const resolved = await host.evaluate((h) => ({
      mode: getComputedStyle(h).writingMode,
      dir: getComputedStyle(h).direction,
    }));
    expect(resolved.mode, '右起こしになっていない').toBe('vertical-rl');
    expect(resolved.dir, '縦書きで direction が ltr に固定されていない').toBe('ltr');
    // 版面でも上から下へ流れていること(rtl のままなら最初の文字が下に来る)
    expect(await flowOf(page), '縦書きの本文が下から上へ流れている').toBe('top-down');
    // 既定の寄せ(= logical start)は「上」
    expect((await alignsOf(page, 'y'))[1], '縦書きの既定が上寄せでない').toBe('top');
  }

  /**
   * 🔴 **縦書き × `align: bottom`**。直す前は「text-align では表現できない」という
   * CSS の誤認がコメントごと移植されており、規則がゼロ = 黙った no-op だった。
   * ⚠ 縦書きの inline 軸は垂直なので `text-align: end` がそのまま「下」になる。
   */
  await writeNote(
    page,
    '縦書きで下寄せ',
    `---\nwriting: vertical\ndirection: rtl\nalign: bottom\n---\n\n${LONG_LINE}\n\n短い段落\n`,
  );
  {
    const a = await alignsOf(page, 'y');
    expect(a[1], '`align: bottom` が効いていない(属性だけ出して終わっている)').toBe('bottom');
    // 向きは変わらない(寄せと流れは別物)
    expect(await flowOf(page), '寄せを変えたら流れまで変わった').toBe('top-down');
  }

  /**
   * 🔴 段落 formal の物理縦(`:::paragraph{align=bottom}`)。
   * `PHYSICAL_ALIGNS` は `top`/`bottom` を受理して属性まで出すのに、
   * 消費する規則が両面ゼロだった。
   */
  await writeNote(
    page,
    '縦書きで段落だけ下寄せ',
    `---\nwriting: vertical\ndirection: rtl\n---\n\n${LONG_LINE}\n\n` +
      ':::paragraph{align=bottom}\n短い段落\n:::\n',
  );
  {
    const a = await alignsOf(page, 'y');
    expect(a[1], '`:::paragraph{align=bottom}` が効いていない').toBe('bottom');
  }

  expect(errors).toEqual([]);
});
