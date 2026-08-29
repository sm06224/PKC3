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

/**
 * 記事の頁の代わり。
 *
 * ⚠ **クエリを足さない**(`?pkc-article=1` のような目印を付けたら
 * `tests/features/flags.test.ts` の全数検査が落とした ── smoke の URL も
 * 「flag 以外のクエリで開くな」の対象である。**検査が効いている**)。
 * 🔑 ここで要るのは「**同一 context の、別の頁**」だけなので、素の `/` でよい。
 * ⚠ **別 origin の記事**(本来の姿)は unit が見ている ──
 * `capture.test.ts` は `https://news.test` から、**許可リストが空のまま**
 * 通ることを確かめている(= 通したのは合図の門である)。
 */
const ARTICLE = '/';

test('ブックマークで開いた窓が、合図つきの 1 通だけを受けて編集の形で出す', async ({
  page,
  context,
}) => {
  const errors = collectPageErrors(page);

  /**
   * 🔴 **例外が出た「瞬間」の状態**(#387 診断第 3 段)。
   *
   * 既存の diag()(下)は**最後の assert 時点**の状態しか採れない ── 5 度の赤は
   * どれも `(+118〜161ms)` = **序盤**に出ており、「その瞬間に窓が何枚で、記事の頁が
   * 生きていたか」は残らなかった。ここでは `pageerror` の**その場**で採る。
   *
   * ⚠ handler の中の `page.evaluate` は「実行文脈がその瞬間に死んでいるか」を測る
   *   当のもの ── 失敗したら失敗自体が手掛かりなので、落とさず印にする。
   * ⚠ test は 1 ミリも緩めない ── 増えるのは赤の情報量だけ(緑の回はほぼ無費用)。
   */
  const t0 = Date.now();
  const moments: string[] = [];
  page.on('pageerror', () => {
    const at = Date.now() - t0;
    const pages = context.pages();
    const urls = pages
      .map((p) => {
        try {
          const u = new URL(p.url());
          return `${u.pathname}${u.hash}`;
        } catch {
          return p.url();
        }
      })
      .join(' ');
    moments.push(`(+${at}ms) 窓 ${pages.length} 枚 [${urls}]`);
    void page
      .evaluate(() => `${location.pathname} readyState=${document.readyState}`)
      .then(
        (s) => moments.push(`(+${at}ms) 記事の頁は生きている: ${s}`),
        (e) => moments.push(`(+${at}ms) 記事の頁の evaluate が落ちた: ${String(e).slice(0, 80)}`),
      );
  });

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
  /**
   * 🔴 **`window.open` を何回呼んだか数える**(#387 診断第 5 段。2026-08-29)。
   *
   * ## なぜこの観測点か
   *
   * 2026-08-29 の赤で、**両立しない 2 つ**が同時に成り立っていた:
   * - 例外は `<anonymous>:3:22` = **この関数の 3 行目 = 下の `window.open`**
   * - それでいて **合図も返事も帯も揃っており、流れは最後まで成功**していた
   *
   * ⚠ もし `window.open` が投げて終わったなら `w` は手に入らず、
   *   `e.source !== w` が永久に真になって**合図は 0 字のはず**である。
   * 🔑 つまり「**使えた窓**」と「**投げた呼び出し**」は別 ── 考えられるのは
   *   ① 同じ行が **2 回走った** ② **窓を作ったうえで例外も上げた** の 2 つ。
   *
   * 🔑 **数えれば割れる**:2 なら①、1 なら②。
   * ⚠ 原因はまだ書かない(CLAUDE.md §4)── これは**次の赤に理由を持たせる**ためだけの計器である。
   * ⚠ 緑の回はほぼ無費用(整数を 1 つ増やすだけ)。
   */
  await page.evaluate(() => {
    const w = window as unknown as { __pkcOpenCalls?: number };
    w.__pkcOpenCalls = 0;
    const real = window.open.bind(window);
    window.open = ((...args: Parameters<typeof window.open>) => {
      w.__pkcOpenCalls = (w.__pkcOpenCalls ?? 0) + 1;
      return real(...args);
    }) as typeof window.open;
  });

  const opened = await page.evaluate(async () => {
    const base = location.href.split('#')[0]!.split('?')[0]!;
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

  /**
   * 🔴 **落ちた回に「その瞬間の状態」を残す**(#387)。
   *
   * ⚠ `toEqual([])` は「**何か例外が出た**」としか言わない ── #387 は
   *   **3 度観測して原因に 1 歩も近づいていない**(2026-08-25 / 2026-08-27 × 2。
   *   どれも `Failed to execute 'open' on 'Window'` の 1 行だけが残った)。
   *
   * 🔑 **#452 の診断はこの件には効かない ── そう doc に書いてある。**
   *   `page-errors.ts` の `firstAppFrame` が名指しできるのは **URL を持つ script**
   *   だけで、この例外の投げ元は**この spec の `page.evaluate`**(上の
   *   `window.open`)である。実際、採れた行に `@ path:line` は付いていない。
   *   ⚠ **時刻 `(+Nms)` は効いている** ── `+137ms` から「最後の assert の後ではなく
   *   序盤で出た」ことは読めた。だから足すのは**時刻ではなく状態**である。
   *
   * ⚠ **緑の回でも計算する**(数十 ms)── 落ちてから採りに行くことはできない。
   * ⚠ **窓を数えるだけにしない。** いちばん知りたいのは
   *   **記事の頁がまだ同じ頁に居るか**である ── 「callback is no longer runnable」は
   *   実行文脈が入れ替わったときの文言なので、`page` が別の URL へ移っていれば
   *   そこが読める(⚠ ただし**そう決めつけない** ── 移っていないことも同じだけ
   *   情報である。判定は次の赤に委ねる)。
   */
  const diag = async (): Promise<string> => {
    const pages = context.pages();
    const where = pages
      .map((p) => {
        const u = p.url();
        const tag = p === page ? '記事' : p === pkc ? 'PKC' : '他';
        try {
          const parsed = new URL(u);
          return `${tag}=${parsed.pathname}${parsed.search}${parsed.hash}`;
        } catch {
          return `${tag}=${u}`;
        }
      })
      .join(' ');
    let band = '(読めない)';
    try {
      band = (
        (await pkc!.locator('[data-pkc-region="status"]').textContent({ timeout: 1_000 })) ?? ''
      )
        .trim()
        .slice(0, 60);
    } catch {
      /* 窓が閉じた / 読めない ── それ自体が手掛かりなので既定の字を残す */
    }
    const grant = 'grant' in opened ? opened.grant : undefined;
    return (
      `窓 ${pages.length} 枚 [${where}]` +
      ` / 合図 ${typeof grant === 'string' ? `有り(${grant.length} 字)` : '無し'}` +
      ` / 返事 ${JSON.stringify('reply' in opened ? opened.reply : null)}` +
      ` / 帯「${band}」`
    );
  };
  const state = await diag();
  // ⚠ handler 内の evaluate の返りを拾い切る(赤の回だけ意味を持つ)
  if (moments.length > 0) await new Promise((r) => setTimeout(r, 300));
  const moment = moments.length > 0 ? ` / 瞬間 [${moments.join(' → ')}]` : '';
  /**
   * 🔴 **`window.open` を何回呼んだか**(#387 診断第 5 段)── 赤の回に
   *   ①「同じ行が 2 回走った」②「窓を作ったうえで例外も上げた」を**割る**。
   * ⚠ 読めなかった回は `?` と出す(採れないことも情報である)。
   */
  const calls = await page
    .evaluate(() => (window as unknown as { __pkcOpenCalls?: number }).__pkcOpenCalls ?? null)
    .catch(() => null);
  const opens = ` / window.open ${calls ?? '?'} 回`;
  /**
   * ⚠ **計器そのものの空振り防止** ── 壊れていたら「赤の日」に初めて分かる、では遅い。
   * 🔑 緑の回は**必ず 1 回**である(この spec は `window.open` を 1 か所しか持たない)。
   *   ⚠ ここが 2 になったら、それは**製品ではなく赤の正体**である
   *   ── そのときは `#387` の①(同じ行が 2 回走った)が確定する。
   */
  expect(calls, '計器が働いていない(window.open を数えられていない)').toBe(1);

  expect(errors, `記事の頁で例外 ── ${state}${opens}${moment}`).toEqual([]);
  expect(errorsPkc, `PKC3 で例外 ── ${state}`).toEqual([]);
});
