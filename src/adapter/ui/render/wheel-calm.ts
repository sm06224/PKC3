/**
 * **ホイールで送っている間だけ、透明な蓋を 1 枚かぶせる**(#1467)。
 *
 * 🔑 何が起きていたか:長いノート(20,000 行 + 図 400 枚)をホイールで送ると、ブラウザは
 *   **フレームごとに「いまカーソルの下に何があるか」を引き直す**(中身が流れるので、
 *   カーソルが動かなくても hover が変わりうる)。この引き直し(HitTest)が、実測で
 *   Paint の次に重かった(trace: HitTest 29 s / 対照群 6 s)。
 * 🔑 送っている最中の hover は誰も見ていない ── だから**送っている間だけ**、読む面の一番手前に
 *   透明な蓋を 1 枚置く。引き直しは一番手前の蓋で止まり、本文の 27,000 要素を辿らない。
 *
 * 🔴 **`pointer-events: none` を本文にかける案は捨てた**(実測)。`pointer-events` は**継承する**ので、
 *   付け外しのたびに本文の全要素のスタイルが引き直され(20,000 行で 1 回 200〜400 ms)、
 *   送りの出だしと終わりに 300〜900 ms の long task が出た(frame の中央値は良くなったが、p95 が 130 → 830 ms)。
 *   蓋は**1 要素の付け外し**で済む(強制レイアウト 1 ms)。
 *
 * 🔴 **蓋は `wheel` の中で出さない ── 最初の `scroll` で出す**(smoke `read-columns` が落ちて分かった)。
 *   ブラウザは `wheel` の処理が済んだ**後**で「どの物を送るか」をもう一度当てる。`wheel` の中で蓋を出すと
 *   その当て直しが蓋に当たり、**面の中の送れる箱(編集の箱・横に長い表・コード枠)の上のホイールが、
 *   箱ではなく面全体を送ってしまう**。`scroll` は送り先が決まった後に届くので、蓋は届かない
 *   (以後の送りは最初の送り先に留まる)。
 *
 * ⚠ **効かせない場面**(目的:字の選択と文書のズームと、編集の操作を壊さない):
 *   ⓪ **編集中**(編集の箱を送った直後の「保存」が空振りする)
 *   ① **ボタンを押している間**(字をなぞって選んでいる最中にホイールで送る ── 蓋があると選択が止まる)
 *   ② **Ctrl / Meta を押している間**(ブラウザのズームで、送りではない)。
 *   ③ 🔴 **段組みが効いている間**(user 報告 2026-10-11「段組み表示時にまともにスクロールできなくなる」)。
 *      段組みは縦のホイールを本文の器の上でだけ横送りに読み替える(`read-columns.ts` の `installColumnWheel` が
 *      `host.contains(ev.target)` を見る)ので、最初の送りで蓋が出ると、**2 回目からのホイールは蓋に当たって
 *      器の外になり、横へ送れなくなる**。段組みは送りの向き自体が違うので、蓋は出さない。
 * ⚠ 蓋を出すのは **`wheel` の直後の `scroll` だけ**。位置の復元(`scrollTop = …`)・キーボード・スクロールバーの
 *   ドラッグは対象外 ── 復元の直後に押したボタンが空振りする、を作らないため。
 * ⚠ 最後のホイールから 150ms は、本文の字を押せない(送り終わった直後。指が離れて押すまでの間より短い、という見積り ──
 *   実機で測った値ではない)。
 * ⚠ 蓋は読む面の**最後の子**に置く(`position: sticky; bottom: 0` ── 下端に貼り付いて、送っても画面の中に居続ける)。
 *   高さ 0 の枠なので、並びにも寸法にも出ない。他の物が後ろに足されたら、出すたびに最後へ戻す。
 */

import { COLUMNS_ON_ATTR } from './read-columns';

/** 蓋を入れる枠 / 蓋そのもの(CSS は `app.css`)。 */
export const SHIELD_FIELD = 'wheel-shield';
export const SHIELD_COVER_FIELD = 'wheel-shield-cover';
/** 送っている間だけ枠に付く印。CSS がこの印で蓋を出す。 */
export const SHIELD_ON_ATTR = 'data-pkc-shield-on';
/** 最後のホイールから、蓋を外すまで(ms)。 */
export const WHEEL_IDLE_MS = 150;

/** 段組みが実際に効いているか(`data-pkc-columns-on` が器か、器の中に在る)。 */
export function isColumnsOn(region: HTMLElement): boolean {
  return region.hasAttribute(COLUMNS_ON_ATTR) || region.querySelector(`[${COLUMNS_ON_ATTR}]`) !== null;
}

/** 読む面が編集中か(`data-pkc-detail-mode="editor"` が器か、器の中に在る)。 */
export function isEditing(region: HTMLElement): boolean {
  return (
    region.getAttribute('data-pkc-detail-mode') === 'editor' ||
    region.querySelector('[data-pkc-detail-mode="editor"]') !== null
  );
}

/** 枠と蓋を作る。⚠ どちらも見えない・読み上げない。 */
function makeShield(doc: Document): HTMLElement {
  const frame = doc.createElement('div');
  frame.setAttribute('data-pkc-field', SHIELD_FIELD);
  frame.setAttribute('aria-hidden', 'true');
  const cover = doc.createElement('div');
  cover.setAttribute('data-pkc-field', SHIELD_COVER_FIELD);
  frame.append(cover);
  return frame;
}

/**
 * `region`(スクロールする器)に、ホイールの間だけ出る蓋を配線する。⚠ 1 つの器に 1 度だけ呼ぶ。
 * 蓋は**ホイールの後の最初の `scroll` で作る**(ホイールを回さない面には 1 要素も足さない)。
 * @returns 外す関数(test 用。タイマーも蓋も片付ける)
 */
export function installWheelCalm(region: HTMLElement): () => void {
  let shield: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const off = (): void => {
    timer = null;
    shield?.removeAttribute(SHIELD_ON_ATTR);
  };
  /** ホイールを回している最中か(= 次の `scroll` は送りの結果)。最後のホイールから `WHEEL_IDLE_MS` で下りる。 */
  const onWheel = (e: WheelEvent): void => {
    if (e.buttons > 0 || e.ctrlKey || e.metaKey) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(off, WHEEL_IDLE_MS);
  };
  const onScroll = (): void => {
    if (timer === null) return; // ホイールの最中ではない(復元・キー・スクロールバー)
    // ⚠ 編集中は蓋を出さない(smoke `read-columns` ⑤ が落ちて分かった):編集の箱を送った直後に
    //   「保存」を押すと、蓋に当たって空振りする。引っかかりが問題なのは読む面のほうである
    if (isEditing(region)) return;
    // ⚠ 段組みの間も出さない(蓋が横送りのホイールを本文の器の外へ逸らす)
    if (isColumnsOn(region)) return;
    shield ??= makeShield(region.ownerDocument);
    // 後ろに何かが足されていたら最後へ戻す(貼り付く位置は「末尾」で決まる)
    if (region.lastElementChild !== shield) region.append(shield);
    shield.setAttribute(SHIELD_ON_ATTR, '');
  };
  region.addEventListener('wheel', onWheel, { passive: true });
  // ⚠ capture ── 面の中の送れる箱(`scroll` は泡立たない)の送りも「送っている」に数える
  region.addEventListener('scroll', onScroll, { passive: true, capture: true });
  return () => {
    region.removeEventListener('wheel', onWheel);
    region.removeEventListener('scroll', onScroll, { capture: true });
    if (timer !== null) clearTimeout(timer);
    shield?.remove();
    shield = null;
    timer = null;
  };
}
