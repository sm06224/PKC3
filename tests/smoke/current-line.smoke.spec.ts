/**
 * 🔴 **いま打っている行の左端の線**(#2001 段 4)── 実ブラウザで、位置・折り返し・スクロール・画素を見る。
 *
 * ## unit では原理的に届かない
 *
 * happy-dom は座標が全部 0 で、`Range` の矩形・折り返し・`background-attachment: local` のスクロール追従は測れない。
 * 1 本の道中で全部を見る(起動は 1 回):
 * ① 折り返した長い行に caret を置くと、線の箱が**その論理行の全ての見た目の行**を覆う(別の測り方 = 行を `<span>` で包んだ影の div と突き合わせる)
 * ② **画素**で線が出ている(欄の左端の列を読み、アクセント色の行が箱と重なる)── 変数だけが付いて何も描かれない空振りを防ぐ
 * ③ 欄をスクロールしても線は行について動く(画素の位置が行の動きと同じだけ動く)
 * ④ 別の行へ ↓ で動くと線も動く / 範囲選択中は出ない / 外へ出ると消える
 */
import { test, expect } from '@playwright/test';
import { gotoApp, createEntry, collectPageErrors, dismissAnnounce, useSplitEditor } from './helpers';

test.beforeEach(async ({ page }) => {
  await useSplitEditor(page);
});

const BODY = '[data-pkc-field="editor-body"]';

test('🔴 折り返した長い行に caret を置くと、左端の線がその行の全部を覆い、スクロールについて動く', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectPageErrors(page);
  await gotoApp(page);
  await createEntry(page, 'text');
  await dismissAnnounce(page);
  const ta = page.locator(BODY);
  await ta.click();

  // 40 行 + 途中に折り返す長い行(欄の幅を超える)+ 40 行
  const long = '長い行 ' + 'あいうえお かきくけこ '.repeat(40);
  const doc = [...Array.from({ length: 40 }, (_, i) => `前の行 ${String(i)}`), long, ...Array.from({ length: 40 }, (_, i) => `後の行 ${String(i)}`)].join('\n');
  await ta.fill(doc);
  const caretAt = doc.indexOf('長い行') + 20;
  await ta.evaluate((el: HTMLTextAreaElement, at: number) => {
    el.focus();
    el.setSelectionRange(at, at);
    el.scrollTop = 0;
  }, caretAt);
  await expect(ta, '線の印が付かない').toHaveAttribute('data-pkc-current-line', '', { timeout: 3000 });

  // 変数(内容座標の top / height)と、別の測り方(行を span で包んだ影)
  const read = (): Promise<{ top: number; h: number; lh: number }> =>
    ta.evaluate((el: HTMLTextAreaElement) => {
      const cs = getComputedStyle(el);
      return {
        top: Number.parseFloat(el.style.getPropertyValue('--pkc-cl-top')),
        h: Number.parseFloat(el.style.getPropertyValue('--pkc-cl-h')),
        lh: Number.parseFloat(cs.lineHeight),
      };
    });
  const v = await read();
  const indep = await ta.evaluate((el: HTMLTextAreaElement, at: number) => {
    const cs = getComputedStyle(el);
    const m = document.createElement('div');
    for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom', 'borderTopWidth', 'borderLeftWidth', 'borderRightWidth', 'borderBottomWidth'] as const) m.style[p] = cs[p];
    m.style.cssText += `;position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box;width:${String(el.clientWidth + el.clientLeft * 2)}px`;
    const v = el.value;
    const from = v.lastIndexOf('\n', at - 1) + 1;
    const nl = v.indexOf('\n', at);
    const to = nl === -1 ? v.length : nl;
    const a = document.createElement('span');
    a.textContent = v.slice(0, from);
    const line = document.createElement('span');
    line.textContent = v.slice(from, to);
    m.append(a, line, document.createElement('span'));
    document.body.append(m);
    const r = line.getBoundingClientRect();
    const o = m.getBoundingClientRect();
    const out = { top: r.top - o.top - m.clientTop, bottom: r.bottom - o.top - m.clientTop, rows: line.getClientRects().length };
    m.remove();
    return out;
  }, caretAt);
  expect(indep.rows, '折り返していない(検査の前提)').toBeGreaterThan(2);
  // 線の箱は、論理行の全体を覆う(±2px)。1 行ぶん(lh)しか無ければ折り返しを見ていない
  expect(v.h, '線が折り返した行の全部に届いていない').toBeGreaterThan(v.lh * 2);
  expect(Math.abs(v.top - indep.top), `上端が違う(測り:${String(v.top)} / 別測り:${String(indep.top)})`).toBeLessThanOrEqual(v.lh);
  expect(Math.abs(v.top + v.h - indep.bottom), '下端が違う').toBeLessThanOrEqual(v.lh);

  // ② 画素: 欄の左端の列にアクセント色の線が、箱と同じ高さで出ている(ビューポートの中に入れてから撮る)
  const pixelRows = async (): Promise<{ first: number; last: number; n: number }> => {
    const box = await ta.boundingBox();
    if (box === null) throw new Error('欄が無い');
    const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: 12, height: box.height } });
    const accent = await page.evaluate(() => {
      const c = document.createElement('i');
      c.style.color = getComputedStyle(document.documentElement).getPropertyValue('--accent');
      document.body.append(c);
      const rgb = getComputedStyle(c).color;
      c.remove();
      return rgb;
    });
    return page.evaluate(
      async ([b64, rgb]) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const cv = document.createElement('canvas');
        cv.width = img.width;
        cv.height = img.height;
        const g = cv.getContext('2d')!;
        g.drawImage(img, 0, 0);
        const want = (rgb.match(/\d+/g) ?? []).slice(0, 3).map(Number);
        const scale = img.width / 12;
        let first = -1;
        let last = -1;
        let n = 0;
        // 左から 5 列目(焦点の輪が覆う 3px の外側。線は 2〜5px)を縦に読む
        const x = Math.round(4 * scale);
        // 欄の上下の辺(焦点の輪の 2px)は読まない
        for (let y = Math.round(4 * scale); y < img.height - Math.round(4 * scale); y += 1) {
          const d = g.getImageData(x, y, 1, 1).data;
          if (Math.abs(d[0]! - want[0]!) < 12 && Math.abs(d[1]! - want[1]!) < 12 && Math.abs(d[2]! - want[2]!) < 12) {
            if (first < 0) first = y;
            last = y;
            n += 1;
          }
        }
        return { first: first / scale, last: last / scale, n: n / scale };
      },
      [png.toString('base64'), accent] as const,
    );
  };
  await ta.evaluate((el: HTMLTextAreaElement) => el.scrollIntoView({ block: 'start' }));
  // 線の行が欄の見える範囲に入るまで欄をスクロールする(箱の上端の少し手前)
  const base = Math.max(0, Math.floor(v.top) - 30);
  await ta.evaluate((el: HTMLTextAreaElement, s: number) => {
    el.scrollTop = s;
  }, base);
  await expect.poll(async () => (await pixelRows()).n, { timeout: 3000 }).toBeGreaterThan(v.lh);
  const p0 = await pixelRows();
  expect(p0.n, '線の画素が 1 つも無い(変数だけで何も描かれていない)').toBeGreaterThan(v.lh * 2);
  const taTop = await ta.evaluate((el: HTMLTextAreaElement) => el.clientTop);

  // ③ 欄をスクロール: 線は行について動く(画素の開始位置が、スクロールした分だけ上へ動く)
  const maxScroll = await ta.evaluate((el: HTMLTextAreaElement) => el.scrollHeight - el.clientHeight);
  test.skip(maxScroll < 40, '欄が伸びてスクロールしない構成(autosize)');
  const step = 20;
  await ta.evaluate((el: HTMLTextAreaElement, s: number) => {
    el.scrollTop = s;
  }, base + step);
  await expect.poll(async () => (await pixelRows()).first, { timeout: 3000 }).toBeLessThan(p0.first - step + 3);
  const p1 = await pixelRows();
  expect(Math.abs(p0.first - p1.first - step), `スクロール ${String(step)}px で線が ${String(p0.first - p1.first)}px しか動かない`).toBeLessThanOrEqual(2);
  expect(taTop).toBeGreaterThanOrEqual(0);

  // ④ 別の行へ移ると線も動く / 範囲選択中は出ない / 外へ出ると消える
  const topBefore = (await read()).top;
  await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(2, 2));
  await expect.poll(async () => (await read()).top).not.toBe(topBefore);
  expect((await read()).h, '1 行の箱になる').toBeLessThan(v.lh * 1.6);
  await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 5));
  await expect(ta, '範囲選択中も線が残る').not.toHaveAttribute('data-pkc-current-line', '');
  await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(3, 3));
  await expect(ta).toHaveAttribute('data-pkc-current-line', '');
  await page.locator('[data-pkc-field="title-input"], input[data-pkc-field*="title"]').first().focus();
  await expect(ta, '欄を離れても線が残る').not.toHaveAttribute('data-pkc-current-line', '');

  // ⑤ 重さ: 5000 行の本文で打ち続けても、線を付けた分の増えが 1 打鍵あたり小さい(線を切った対照群と同じ操作で比べる)
  const big = Array.from({ length: 5000 }, (_, i) => `行 ${String(i)} ${'あいうえお'.repeat(3)}`).join('\n');
  await ta.evaluate((el: HTMLTextAreaElement, v: string) => {
    el.value = v;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, big);
  const typeCost = (): Promise<number> =>
    ta.evaluate(async (el: HTMLTextAreaElement) => {
      const mid = Math.floor(el.value.length / 2);
      el.focus();
      el.setSelectionRange(mid, mid);
      const raf = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
      await raf();
      const t0 = performance.now();
      for (let i = 0; i < 30; i += 1) {
        document.execCommand('insertText', false, 'x');
        await raf();
        await raf();
      }
      return (performance.now() - t0) / 30;
    });
  await page.evaluate(() => localStorage.setItem('pkc3.current-line', '0'));
  await typeCost(); // 暖機
  const off = await typeCost();
  await page.evaluate(() => localStorage.removeItem('pkc3.current-line'));
  await typeCost();
  const on = await typeCost();
  console.log(`current-line perf (5000 行 / 1 打鍵あたり ms): 切=${off.toFixed(1)} 入=${on.toFixed(1)} 増え=${(on - off).toFixed(1)}`);
  expect(on - off, `線を付けた分の増えが大きい(切=${off.toFixed(1)}ms / 入=${on.toFixed(1)}ms)`).toBeLessThan(16);

  expect(errors, `console エラー: ${errors.join(' / ')}`).toEqual([]);
});
