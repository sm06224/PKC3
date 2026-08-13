/** @vitest-environment happy-dom */
/**
 * #135: Office の窓が**固まった**ことに、本体側から気づく。
 *
 * 守りたい主張:
 *  ① 窓が**表**に居たまま通知が絶えたら言う(4 秒)
 *  ② 窓が**背面**なら 4 秒では言わない ── 絞りが掛かるので**60 秒空くのが正常**。
 *     🔴 ここが本体の主張である。物差しを 1 本にすると**必ず誤検知する**
 *  ③ **1 度も通知を受けていない**なら言わない(窓の有無が分からない)
 *  ④ 閉じた(`closed`)なら言わない ── user の意思である
 *  ⑤ 停止した(`crashed`)なら言わない ── 窓が自分で停止画面を出している
 *  ⑥ **2 度言わない**。ただし生き返ったら**また言える**
 *  ⑦ 見るのは `hidden → visible` の**1 点だけ**。常駐タイマーを立てない
 */
import { describe, expect, it, vi } from 'vitest';
import {
  HANG_GAP_BACKGROUND_MS,
  HANG_GAP_FOREGROUND_MS,
  HANG_MESSAGE,
  OfficeHangWatch,
  watchOfficeHang,
} from '../../src/adapter/platform/office/office-hang-watch';
import { ALIVE_TTL_MS, type OfficeWindowEvent } from '../../src/adapter/platform/office/office-window';

/** 時刻を手で進められる watch。 */
function harness(): {
  w: OfficeHangWatch;
  tick: (ms: number) => void;
  beat: (visible: boolean) => void;
} {
  const clock = { t: 1_000_000 };
  const w = new OfficeHangWatch({ now: () => clock.t });
  return {
    w,
    tick: (ms) => { clock.t += ms; },
    beat: (visible) => { w.note({ type: 'alive', visible }); },
  };
}

describe('#135 ハングの検知(物差しは 2 本)', () => {
  it('🔴 窓が表のまま通知が絶えたら言う', () => {
    const h = harness();
    h.beat(true);
    h.tick(HANG_GAP_FOREGROUND_MS);
    expect(h.w.onMainVisible()).toBe(HANG_MESSAGE);
  });

  it('物差しの手前では言わない(1 ミリ秒の差で分ける)', () => {
    const h = harness();
    h.beat(true);
    h.tick(HANG_GAP_FOREGROUND_MS - 1);
    expect(h.w.onMainVisible()).toBeNull();
  });

  it('🔴 窓が背面なら、表の物差しでは言わない(絞りが掛かるので正常)', () => {
    const h = harness();
    h.beat(false);
    // ⚠ 表なら「固まった」と言う長さ。背面では**言ってはいけない**
    h.tick(HANG_GAP_FOREGROUND_MS * 4);
    expect(h.w.onMainVisible(), '背面タブの絞りを誤検知している').toBeNull();
  });

  it('窓が背面でも、絞りの周期を越えたら言う', () => {
    const h = harness();
    h.beat(false);
    h.tick(HANG_GAP_BACKGROUND_MS);
    expect(h.w.onMainVisible()).toBe(HANG_MESSAGE);
  });

  it('⚠ 背面の物差しは intensive throttling(1 分周期)より長い', () => {
    // 🔑 これを 60 秒以下にすると、**背面に置いただけ**の窓で鳴る
    expect(HANG_GAP_BACKGROUND_MS).toBeGreaterThan(60_000);
    // 表の物差しは既存の使い回し判定と同じ材料(2 つの閾値を作らない)
    expect(HANG_GAP_FOREGROUND_MS).toBe(ALIVE_TTL_MS);
  });

  it('通知を 1 度も受けていないなら言わない(窓が開いたのかも分からない)', () => {
    const h = harness();
    h.tick(HANG_GAP_BACKGROUND_MS * 10);
    expect(h.w.onMainVisible()).toBeNull();
  });

  it('閉じたなら言わない(user の意思)', () => {
    const h = harness();
    h.beat(true);
    h.w.note({ type: 'closed' });
    h.tick(HANG_GAP_BACKGROUND_MS);
    expect(h.w.onMainVisible()).toBeNull();
  });

  it('🔴 停止したなら言わない(窓が自分で停止画面を出している)', () => {
    const h = harness();
    h.beat(true);
    h.w.note({ type: 'crashed', reason: 'memory access out of bounds' });
    h.tick(HANG_GAP_BACKGROUND_MS);
    expect(h.w.onMainVisible(), '停止と固まったを二重に言っている').toBeNull();
  });

  it('⚠ 停止しても生存通知は止まらない ── それでも黙る', () => {
    // 🔑 `host.html` は死んでも beat を止めない(止めると本体が 2 つ目の窓を開く)。
    //    つまり実機では通知が続くので gap で鳴ることは無いが、**通知が絶えても**黙る
    const h = harness();
    h.beat(true);
    h.w.note({ type: 'crashed', reason: 'Aborted()' });
    h.tick(HANG_GAP_FOREGROUND_MS);
    expect(h.w.onMainVisible()).toBeNull();
  });

  it('2 度は言わない(タブを行き来するたびに出さない)', () => {
    const h = harness();
    h.beat(true);
    h.tick(HANG_GAP_FOREGROUND_MS);
    expect(h.w.onMainVisible()).toBe(HANG_MESSAGE);
    h.tick(HANG_GAP_FOREGROUND_MS);
    expect(h.w.onMainVisible()).toBeNull();
  });

  it('🔑 生き返ったら、また言える', () => {
    const h = harness();
    h.beat(true);
    h.tick(HANG_GAP_FOREGROUND_MS);
    expect(h.w.onMainVisible()).toBe(HANG_MESSAGE);
    // 読み込み直した(= 生存通知が戻った)
    h.beat(true);
    expect(h.w.onMainVisible(), '戻った直後に鳴っている').toBeNull();
    h.tick(HANG_GAP_FOREGROUND_MS);
    expect(h.w.onMainVisible()).toBe(HANG_MESSAGE);
  });

  it('停止のあと読み込み直したら、また検知できる', () => {
    const h = harness();
    h.beat(true);
    h.w.note({ type: 'crashed', reason: 'x' });
    h.beat(true);
    h.tick(HANG_GAP_FOREGROUND_MS);
    expect(h.w.onMainVisible()).toBe(HANG_MESSAGE);
  });

  it('⚠ 文言は「固まった」と言い切らない(タブが落ちていた場合に嘘になる)', () => {
    expect(HANG_MESSAGE).toContain('応答していません');
    // 🔑 押す場所とやることが両方入っている(「応答していません」だけでは動けない)
    expect(HANG_MESSAGE).toContain('タブ');
    expect(HANG_MESSAGE).toContain('開き直して');
  });
});

/** 放送の口を模す。 */
function fakeSource(): {
  onEvent: (fn: (ev: OfficeWindowEvent) => void) => () => void;
  emit: (ev: OfficeWindowEvent) => void;
  readonly subscribers: number;
} {
  const fns = new Set<(ev: OfficeWindowEvent) => void>();
  return {
    onEvent: (fn) => { fns.add(fn); return () => { fns.delete(fn); }; },
    emit: (ev) => { for (const fn of fns) fn(ev); },
    get subscribers() { return fns.size; },
  };
}

describe('#135 配線(main.ts に判断を置かない)', () => {
  /** `document` を模す ── 表 / 裏を手で切り替えられる。 */
  function fakeDoc(): {
    doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
    fire: (state: DocumentVisibilityState) => void;
    readonly listeners: number;
  } {
    const fns = new Set<EventListenerOrEventListenerObject>();
    let state: DocumentVisibilityState = 'visible';
    const doc = {
      addEventListener: (t: string, fn: EventListenerOrEventListenerObject) => {
        if (t === 'visibilitychange') fns.add(fn);
      },
      removeEventListener: (t: string, fn: EventListenerOrEventListenerObject) => {
        if (t === 'visibilitychange') fns.delete(fn);
      },
      get visibilityState() { return state; },
    } as unknown as Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
    return {
      doc,
      fire: (s) => {
        state = s;
        for (const fn of fns) (fn as EventListener)(new Event('visibilitychange'));
      },
      get listeners() { return fns.size; },
    };
  }

  it('🔴 表に戻った瞬間に 1 回だけ知らせる', () => {
    const src = fakeSource();
    const d = fakeDoc();
    const said: string[] = [];
    const clock = { t: 0 };
    watchOfficeHang({
      onEvent: src.onEvent,
      doc: d.doc,
      notify: (t) => said.push(t),
      watch: new OfficeHangWatch({ now: () => clock.t }),
    });
    src.emit({ type: 'alive', visible: true });
    clock.t += HANG_GAP_FOREGROUND_MS;
    d.fire('hidden');
    expect(said, '裏へ落ちる側で鳴っている').toEqual([]);
    d.fire('visible');
    expect(said).toEqual([HANG_MESSAGE]);
  });

  it('⚠ 常駐タイマーを立てない(時間が経っても何も起きない)', () => {
    vi.useFakeTimers();
    try {
      const src = fakeSource();
      const d = fakeDoc();
      const said: string[] = [];
      const clock = { t: 0 };
      watchOfficeHang({
        onEvent: src.onEvent,
        doc: d.doc,
        notify: (t) => said.push(t),
        watch: new OfficeHangWatch({ now: () => clock.t }),
      });
      src.emit({ type: 'alive', visible: true });
      clock.t += HANG_GAP_BACKGROUND_MS * 10;
      // 🔑 **タイマーを全部進めても何も出ない** ── 出るのは visibilitychange だけ
      vi.advanceTimersByTime(HANG_GAP_BACKGROUND_MS * 10);
      expect(said, '常駐タイマーが立っている').toEqual([]);
      expect(vi.getTimerCount(), '生きたタイマーが在る').toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('外すと購読も listener も残らない', () => {
    const src = fakeSource();
    const d = fakeDoc();
    const stop = watchOfficeHang({ onEvent: src.onEvent, doc: d.doc, notify: () => {} });
    expect(src.subscribers).toBe(1);
    expect(d.listeners).toBe(1);
    stop();
    expect(src.subscribers).toBe(0);
    expect(d.listeners).toBe(0);
  });
});
