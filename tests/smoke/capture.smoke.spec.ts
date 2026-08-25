/**
 * smoke(#194 / C-3): **ブックマークから 1 件取り込む**。
 *
 * unit(`tests/adapter/transport/capture.test.ts`)は判定と門を fake で守る。
 * ⚠ ここで守るのは **実物の合成** ── 実 Chromium で
 *
 *   記事の頁 → `window.open('…#pkc?capture=1')` → PKC3 が `window.opener` へ放送
 *   → 記事の頁が合図つきで送り返す → PKC3 が取り込んで **編集の形で出す**
 *
 * が**本当に噛み合う**こと。⚠ `window.opener` は fake で作れない
 * (`opener` は開いた実体でしか繋がらない)ので、unit では原理的に届かない層である。
 *
 * ⚠ 2 つの page は**同じ context**で開く ── `window.open` の親子関係は
 *   context をまたぐと作れない。
 */
import { test, expect } from '@playwright/test';
import { collectPageErrors } from './helpers';

/** 記事の頁の代わり(同一 origin に置く ── 中身は空でよい)。 */
const ARTICLE = '/?pkc-article=1';

test('ブックマークで開いた窓が、合図つきの 1 通だけを受けて編集の形で出す', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);

  /**
   * 🔑 **flag を立てて開く**(既定は OFF ── 立てないと門が 1 つも開かない)。
   * ⚠ `addInitScript` は**全 frame**で走るので、sandbox の frame で
   *   `localStorage` が投げる分は握り潰す(他の smoke と同じ作法)。
   */
  await page.addInitScript(() => {
    try {
      localStorage.setItem('pkc3.flags', JSON.stringify({ 'transport.capture': true }));
    } catch {
      /* sandbox の frame ── アプリの設定とは無関係 */
    }
  });
  // ⚠ **記事の頁を先に開く** ── ここが `window.opener` になる
  await page.goto(ARTICLE);

  /**
   * 🔴 **記事の頁の側の仕掛け**(= user が登録するブックマークそのもの)。
   * ⚠ マニュアルに載せた 1 行と**同じ手順**を踏む ── 手順が食い違うと、
   *   ここが緑でも user の手元では動かない。
   */
  const opened = await page.evaluate(async () => {
    const base = location.href.split('?')[0]!;
    const w = window.open(base + '#pkc?capture=1');
    if (w === null) return { ok: false, why: 'ポップアップが開けない' };
    const grant = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 20_000);
      const h = (e: MessageEvent): void => {
        const d = e.data as { pkc3?: string; grant?: string } | null;
        if (e.source !== w || !d || d.pkc3 !== 'capture-ready') return;
        window.removeEventListener('message', h);
        clearTimeout(timer);
        resolve(typeof d.grant === 'string' ? d.grant : null);
      };
      window.addEventListener('message', h);
    });
    if (grant === null) return { ok: false, why: '合図が届かない' };
    const reply = await new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 20_000);
      const h = (e: MessageEvent): void => {
        const d = e.data as { jsonrpc?: string } | null;
        if (e.source !== w || !d || d.jsonrpc !== '2.0') return;
        window.removeEventListener('message', h);
        clearTimeout(timer);
        resolve(d as Record<string, unknown>);
      };
      window.addEventListener('message', h);
      w.postMessage(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'pkc.createEntry',
          params: {
            grant,
            title: '取り込んだ記事',
            body: '選んだところ\n\n出典: https://example.test/a',
          },
        },
        new URL(base).origin,
      );
    });
    return { ok: true, grant, reply };
  });

  expect(opened.ok, opened.why ?? '').toBe(true);
  // 🔴 **返事に中身が載っていない**(合図で通した相手には `lid` を返さない)
  expect(opened.reply, '返事が返っていない').toMatchObject({ result: { ok: true } });
  expect(JSON.stringify(opened.reply), 'lid が漏れている').not.toContain('lid');

  // 開いた側(PKC3)の画面を見る
  const pkc = context.pages().find((p) => p !== page);
  expect(pkc, 'PKC3 の窓が開いていない').toBeTruthy();
  const errorsPkc = collectPageErrors(pkc!);

  // 🔴 **編集の形で出ている**(黙って積まない ── 見て捨てられる)
  await expect(pkc!.locator('[data-pkc-field="editor-title"]')).toHaveValue('取り込んだ記事', {
    timeout: 20_000,
  });
  // ⚠ 本文も届いている(題名だけ入って中身が空、を作らない)
  await expect(pkc!.locator('[data-pkc-region="center"]')).toContainText('出典:');
  // 🔑 **どこから来たかが帯に出る**(外から増えたことを黙って起こさない)
  await expect(pkc!.locator('[data-pkc-region="status"]')).toContainText('取り込みました');

  expect(errors, '記事の頁で例外').toEqual([]);
  expect(errorsPkc, 'PKC3 で例外').toEqual([]);
});
