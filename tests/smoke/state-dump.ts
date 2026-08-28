/**
 * 🔴 **落ちた回が、自分で理由を持ってくる**(#382 / #410 / #419 / #387)。
 *
 * フル走行で**たまに 1 回だけ**落ちる smoke がいくつか在る。⚠ そのとき
 * `toHaveCount(1)` が言うのは「**0 だった**」だけで、**なぜ 0 なのかは何も残らない**
 * ── 次の赤も同じ 1 行しか持ってこないので、何度赤くなっても前へ進まない。
 *
 * 🔑 だから**落ちた瞬間に、その場の状態を添えて投げ直す**。
 * ⚠ **test を緩めない**(待ちを伸ばす / assert を外す)── 直すのは
 *   「落ちたときに残る情報の量」だけである(CLAUDE.md「test を緩める前にアプリを疑う」)。
 *
 * ## ⚠ 本文は載せない
 *
 * 状態に本文を混ぜない ── ①落ちた理由に要るのは「**何が出ているか**」であって
 * 中身ではない ②log は外へ出る(機密資料の規律と同じ向き)。
 * 🔑 載せるのは **lid・件数・状態の行・面の名前**だけにする。
 *
 * ## ⚠ ここは 1 本にしてある(§7)
 *
 * #382 は同じ形を**その spec の中に手で書いて**いた ── 3 本目を書くと、
 * 「どこまで状態を採るか」が spec ごとにばらける。**採り方はここ 1 か所**。
 */
import type { Locator, Page } from '@playwright/test';

/** どの回でも要る面の状態。⚠ **絶対に投げない**(状態取りで落ちたら本末転倒)。 */
export async function baseSnapshot(page: Page): Promise<Record<string, unknown>> {
  try {
    return await page.evaluate(() => {
      const text = (sel: string): string =>
        (document.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 200);
      return {
        entries: [...document.querySelectorAll('[data-pkc-region="entry-list"] [data-pkc-entry]')]
          .map((el) => el.getAttribute('data-pkc-entry'))
          .slice(0, 20),
        status: text('[data-pkc-region="status"]'),
        // ⚠ 断り文は状態の行に出る ── 見えているかどうかも採る(字が在っても hidden はある)
        statusHidden:
          (document.querySelector('[data-pkc-region="status"]') as HTMLElement | null)?.hidden ??
          null,
        /**
         * ⚠ **`undefined` を残さない** ── `JSON.stringify` は `undefined` の key を
         *   丸ごと落とすので、「**採れなかった**」が「**そもそも採っていない**」と
         *   見分けられなくなる(2026-08-27 に実際に消えた)。
         */
        view:
          document.querySelector('[data-pkc-view][data-pkc-active]')?.getAttribute('data-pkc-view') ??
          null,
        /**
         * 🔴 **左の列のどの面が開いているか**(一覧 / ファイラ / タイル / 予定)。
         * ⚠ 開いている面は「`hidden` でないほう」で決まる ── 器は 4 つとも
         *   常設で、`hidden` の付け外しで切り替わる。
         * 🔑 #410(札が 1 枚も出ない)は**そもそも別の面を見ていた**が原因でも
         *   ありうるので、これが無いと切り分けられない。
         */
        browse:
          [...document.querySelectorAll('[data-pkc-browse-pane]')]
            .find((el) => !(el as HTMLElement).hidden)
            ?.getAttribute('data-pkc-browse-pane') ?? null,
        editing: document.querySelectorAll('[data-pkc-field="editor-body"]').length > 0,
        dialogOpen: document.querySelectorAll('dialog[open]').length,
        /**
         * 🔴 **予定の面の状態の行**(#410 が「次の赤が理由を持ってくる形」として
         *   名指しした唯一の値)。
         *
         * 🔑 この 1 行が **3 つを見分ける** ── 札が 0 枚だった回に、
         *   どれだったのかが**これでしか分からない**:
         *
         *   | 出ている字 | 何が起きているか |
         *   |---|---|
         *   | `集めています…` | 走査が**まだ返っていない**(`taskScan === null`) |
         *   | `予定を集められませんでした。…` | 走査が**落ちた**(`taskScanFailed`) |
         *   | `チェックの付いた行が…` | 走査は**返った。中身が 0 件**だった |
         *   | `日付を書いた予定が…` | 走査は返り、**日付の無い行だけ**だった |
         *   | 空文字 | 走査は返り、**札は在るはず**(= 別の束 / 別の面を見ている) |
         *
         * ⚠ 空文字と「採れなかった」を混ぜない ── 面が無ければ `null` にする。
         */
        scanNote:
          document.querySelector('[data-pkc-field="schedule-note"]')?.textContent?.slice(0, 120) ??
          null,
      };
    });
  } catch (e) {
    return { snapshotFailed: String(e) };
  }
}

/** その場に居る要素の数と字(⚠ 字は短く切る)。 */
export async function peek(where: Locator, limit = 6): Promise<Record<string, unknown>> {
  try {
    const count = await where.count();
    const texts = await where
      .evaluateAll((els, n) => els.slice(0, n).map((e) => (e.textContent ?? '').trim().slice(0, 60)), limit)
      .catch(() => []);
    return { count, texts };
  } catch (e) {
    return { peekFailed: String(e) };
  }
}

/**
 * 検査を回し、**落ちたらその場の状態を添えて投げ直す**。
 *
 * ⚠ **元の失敗を捨てない**(`cause`)── どこで落ちたかが消える。
 * ⚠ `extra` が落ちても投げ直しは続ける(状態が取れないこと自体を残す)。
 */
export async function withStateOnFail<T>(
  page: Page,
  why: string,
  extra: () => Promise<Record<string, unknown>>,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    let state: Record<string, unknown>;
    try {
      state = { ...(await baseSnapshot(page)), ...(await extra()) };
    } catch (se) {
      state = { extraFailed: String(se) };
    }
    throw new Error(`${why} / 状態: ${JSON.stringify(state)}`, { cause: e });
  }
}
