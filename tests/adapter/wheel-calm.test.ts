/** @vitest-environment happy-dom */
/**
 * #1467: ホイールで送っている間だけ読む面にかぶせる透明な蓋(`wheel-calm.ts`)。
 *
 * 🔑 守るもの:① 蓋は**最初のホイールまで 1 要素も足さない** ② 送り始めに蓋の印が付く
 *   ③ 最後のホイールから 150ms 経てば外れる(押せない時間が残らない)④ 続けて送る間は外れない
 *   ⑤ ボタンを押している間 / Ctrl・Meta 付きは付けない ⑥ `scroll` だけ(位置の復元・スクロールバー)では出さない
 *   ⑦ 後ろに足された物があっても、出すたびに最後へ戻る(貼り付く位置は末尾で決まる)⑧ 外す関数が全部片付ける。
 * ⚠ 蓋が本当に hit-test を止めることと、見た目・寸法が変わらないことは、実ブラウザの smoke
 *   (`center-scroll.smoke.spec.ts`)で見る ── happy-dom は hit-test も `sticky` も持たない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installWheelCalm,
  SHIELD_COVER_FIELD,
  SHIELD_FIELD,
  SHIELD_ON_ATTR,
  WHEEL_IDLE_MS,
} from '../../src/adapter/ui/render/wheel-calm';

describe('ホイールで送っている間の蓋', () => {
  let region: HTMLElement;
  let dispose: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    region = document.createElement('div');
    region.append(document.createElement('section'));
    document.body.append(region);
    dispose = installWheelCalm(region);
  });
  afterEach(() => {
    dispose();
    region.remove();
    vi.useRealTimers();
  });
  const wheel = (init: WheelEventInit = {}): void => {
    const ev = new WheelEvent('wheel', { deltaY: 100, bubbles: true, ...init });
    // ⚠ happy-dom の WheelEvent は init の `buttons` / 修飾キーを落とす ── 本物は MouseEvent なので持つ。自分で足す
    for (const k of ['buttons', 'ctrlKey', 'metaKey'] as const) {
      if (init[k] !== undefined) Object.defineProperty(ev, k, { value: init[k] });
    }
    region.dispatchEvent(ev);
  };
  /** 送りの結果として届く `scroll`(⚠ 本物は `wheel` の処理が済んだ後に届く)。 */
  const scrolled = (): void => {
    region.dispatchEvent(new Event('scroll'));
  };
  /** ホイール → 送りの結果の scroll(= 1 回送った)。 */
  const roll = (init: WheelEventInit = {}): void => {
    wheel(init);
    scrolled();
  };
  const frame = (): HTMLElement | null => region.querySelector<HTMLElement>(`[data-pkc-field="${SHIELD_FIELD}"]`);
  const on = (): boolean => frame()?.hasAttribute(SHIELD_ON_ATTR) ?? false;

  it('🔴 蓋は wheel の中では作らない ── 最初の scroll で作る(送り先を蓋に取らせない)', () => {
    expect(frame(), '何もしていないのに蓋の枠が在る').toBeNull();
    expect(region.children.length).toBe(1);
    scrolled(); // 復元・キー・スクロールバーの scroll
    expect(frame(), 'ホイールの無い scroll で蓋ができた').toBeNull();
    wheel();
    expect(frame(), 'wheel の中で蓋を作った(ブラウザの送り先の当て直しが蓋に当たり、面の中の送れる箱が送れなくなる)').toBeNull();
    expect(region.children.length, 'wheel の中で面に要素を足した').toBe(1);
    scrolled();
    expect(frame(), 'ホイールの後の scroll で枠ができない').not.toBeNull();
    expect(frame()!.querySelector(`[data-pkc-field="${SHIELD_COVER_FIELD}"]`), '枠の中に蓋が無い').not.toBeNull();
  });

  it('🔴 編集中は蓋を出さない(編集の箱を送った直後の「保存」を空振りさせない)', () => {
    const pane = region.firstElementChild as HTMLElement;
    pane.setAttribute('data-pkc-detail-mode', 'editor');
    roll();
    expect(on(), '編集中なのに蓋が出た(送った直後に押した「保存」が蓋に当たる)').toBe(false);
    // 対照群:読む面に戻れば出る(門が常に閉じているのではない)
    pane.setAttribute('data-pkc-detail-mode', 'view');
    vi.advanceTimersByTime(WHEEL_IDLE_MS);
    roll();
    expect(on(), '読む面で蓋が出ない').toBe(true);
  });

  it('送り始めに付き、最後のホイールから 150ms で外れる', () => {
    roll();
    expect(on()).toBe(true);
    vi.advanceTimersByTime(WHEEL_IDLE_MS - 1);
    expect(on(), '150ms 経つ前に外れた').toBe(true);
    vi.advanceTimersByTime(1);
    expect(on(), '150ms 経っても外れない(送り終わった直後の本文が押せないまま)').toBe(false);
  });

  it('続けて送る間は外れない(ホイールのたびに延びる)', () => {
    roll();
    for (let i = 0; i < 10; i++) {
      // 最初のホイールから数えると 150ms を超えて続ける ── 延ばしていなければ 2 周目で外れている
      vi.advanceTimersByTime(WHEEL_IDLE_MS * 0.7);
      expect(on(), `${String(i + 1)} 回目のホイールの後、送っている最中に外れた(タイマーを延ばしていない)`).toBe(true);
      roll();
    }
    expect(on(), '送っている最中に外れた').toBe(true);
    vi.advanceTimersByTime(WHEEL_IDLE_MS);
    expect(on()).toBe(false);
  });

  it('止めてからもう一度送ると、また付く(枠は作り直さない)', () => {
    roll();
    const first = frame();
    vi.advanceTimersByTime(WHEEL_IDLE_MS);
    expect(on()).toBe(false);
    roll();
    expect(on(), '2 度目の送りで付かない').toBe(true);
    expect(frame(), '送るたびに枠を作り直している').toBe(first);
  });

  it('🔴 ボタンを押している間(字をなぞって選んでいる最中)/ Ctrl・Meta 付き(ズーム)は出さない', () => {
    roll({ buttons: 1 });
    expect(frame(), '選択中のホイールで蓋を作った').toBeNull();
    roll({ ctrlKey: true });
    expect(frame(), 'Ctrl+ホイール(ズーム)を送りと読んだ').toBeNull();
    roll({ metaKey: true });
    expect(frame()).toBeNull();
    // 対照群: 同じ形でボタン・修飾なしなら出る(上の 3 つが「ホイールを聞いていない」で満たされていない)
    roll();
    expect(on()).toBe(true);
    // 蓋が出ている最中に押しながら送っても、出ている蓋を延ばさない(選択を始めた後は外れる側へ向かう)
    vi.advanceTimersByTime(WHEEL_IDLE_MS - 10);
    roll({ buttons: 1 });
    vi.advanceTimersByTime(10);
    expect(on(), 'ボタンを押しながらのホイールが蓋を延ばしている').toBe(false);
  });

  it('🔴 後ろに何かが足されていても、出すたびに最後へ戻る', () => {
    roll();
    const f = frame()!;
    expect(region.lastElementChild).toBe(f);
    const late = document.createElement('div');
    region.append(late);
    expect(region.lastElementChild).toBe(late);
    roll();
    expect(region.lastElementChild, '貼り付く位置が末尾でなくなった').toBe(f);
    expect(frame(), '枠が 2 つできた').toBe(f);
    expect(region.querySelectorAll(`[data-pkc-field="${SHIELD_FIELD}"]`).length).toBe(1);
  });

  it('🔴 ホイールが済んで 150ms 後の scroll(スムーズスクロールの尻・復元)では出さない', () => {
    wheel();
    vi.advanceTimersByTime(WHEEL_IDLE_MS);
    scrolled();
    expect(frame(), '送り終わった後の scroll で蓋が出た(復元の直後に押したボタンが空振りする)').toBeNull();
  });

  it('🔴 面の中の送れる箱(scroll は泡立たない)の送りでも蓋が出る', () => {
    const inner = document.createElement('div');
    region.firstElementChild!.append(inner);
    wheel();
    inner.dispatchEvent(new Event('scroll')); // 泡立たない
    expect(on(), '箱の中を送っている間は蓋が出ない').toBe(true);
  });

  it('外す関数は 2 つの listener を外す(面に残さない)', () => {
    const spy = vi.spyOn(region, 'removeEventListener');
    dispose();
    const removed = spy.mock.calls.map((c) => c[0]);
    expect(removed, 'wheel を外していない').toContain('wheel');
    expect(removed, 'scroll を外していない(面が長生きすると listener が溜まる)').toContain('scroll');
  });

  it('外す関数は蓋・印・タイマーを片付け、以後ホイールを聞かない', () => {
    roll();
    dispose();
    expect(frame(), '枠が残っている').toBeNull();
    expect(vi.getTimerCount(), 'タイマーが残っている').toBe(0);
    roll();
    expect(frame(), '外した後もホイールを聞いている').toBeNull();
  });
});
