/**
 * 🔴 **`clickReal` の当て判定そのものを検める**(2026-08-28)。
 *
 * ## なぜ道具を test するのか
 *
 * #494 のフル smoke で「**× が別要素に覆われている**」と出たが、**覆われていなかった**。
 * 真相は `clickReal` の中の競り合いである ──
 *
 * 1. `boundingBox()` で箱を測る
 * 2. その間に情報ペインが**作り直される**(保存の直後に worker から更新時刻が
 *    遅れて届く。この file の `isRerenderRace` が書いているとおり)
 * 3. `evaluate()` は**新しい要素**を掴むのに、座標は**古い箱**のまま
 * 4. → `elementFromPoint` は別の物を返し、**嘘の「覆われている」**が出る
 *
 * ⚠ 直しは「retry を足す」ではない ── **作り直されたことを見分けて**から retry へ回す。
 * 🔑 だからここで見るのは **2 つの主張**である:
 *
 * | 見る | 何を守るか |
 * |---|---|
 * | **動いたら retry して通る** | 嘘の「覆われている」を出さない |
 * | 🔴 **動いていないのに当たらなければ落ちる** | **検出力を 1 ミリも下げていない** |
 *
 * ⚠ 2 つ目が無いと、この直しは「何でも通す」ことと見分けがつかない(§1)。
 */
import { test, expect } from '@playwright/test';
import { clickReal } from './helpers';

/** 押されたら `#log` に印を残すだけの的。 */
const PAGE = `
<style>
  body { margin: 0; }
  #target { position: absolute; left: 40px; top: 40px; width: 80px; height: 30px; }
  #cover { position: absolute; left: 0; top: 0; width: 300px; height: 200px; }
</style>
<button id="target" data-pkc-action="probe">的</button>
<p id="log"></p>
<script>
  document.getElementById('target').addEventListener('click', () => {
    document.getElementById('log').textContent = 'pressed';
  });
</script>
`;

test('🔴 測った後に的が動いても、retry して押せる(嘘の「覆われている」を出さない)', async ({
  page,
}) => {
  await page.setContent(PAGE);
  /**
   * 🔑 **競り合いを決定的に起こす。** `elementFromPoint` が呼ばれる**直前**に
   * 的を 1 度だけ動かす ── これは `clickReal` が「箱を測る」と「当て判定する」の
   * 間に面が作り直された状況そのものである。
   * ⚠ 2 回目以降は動かさない(実際の作り直しも落ち着く)。
   */
  await page.evaluate(() => {
    const orig = document.elementFromPoint.bind(document);
    let moved = false;
    document.elementFromPoint = (x: number, y: number): Element | null => {
      if (!moved) {
        moved = true;
        (document.getElementById('target') as HTMLElement).style.left = '400px';
      }
      return orig(x, y);
    };
  });
  await clickReal(page, '#target');
  await expect(page.locator('#log'), '動いた回に押せていない').toHaveText('pressed');
});

/**
 * 🔴 **対照群 ── 本物の occlusion は落ちる。**
 * ⚠ これが落ちなくなったら、上の直しは「何でも通す」になっている。
 */
test('🔴 本当に覆われていれば落ちる(検出力を下げていない)', async ({ page }) => {
  await page.setContent(PAGE + '<div id="cover"></div>');
  let threw = '';
  try {
    await clickReal(page, '#target');
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  expect(threw, '覆われているのに通った').toContain('覆われている');
  // ⚠ **押されていない**(通したうえで落ちた、ではない)
  await expect(page.locator('#log')).toHaveText('');
});

/** ⚠ **対照群の対照群** ── 何もしなければ、ふつうに押せる。 */
test('⚠ 何も邪魔が無ければ押せる', async ({ page }) => {
  await page.setContent(PAGE);
  await clickReal(page, '#target');
  await expect(page.locator('#log')).toHaveText('pressed');
});
