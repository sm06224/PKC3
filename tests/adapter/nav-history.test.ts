/**
 * 🔴 **マウスの戻る・進むボタンと PC のブラウザの「戻る」**(A1。user 裁定 2026-11-22)。
 * 守る主張:
 * - マウスの戻る(button 3)/ 進む(button 4)の `pointerup` で 1 回ずつ戻る・進む。`mouseup` の既定(ブラウザの戻る)は止める
 * - 🔴 **二重発火しない**: マウスの戻るで戻った直後に来た番兵の `popstate`(ブラウザ自身の戻る)では戻らない(番兵を置き直すだけ)
 * - ブラウザの「戻る」(番兵の消費)ではアプリの中で 1 つ戻り、番兵を置き直す。アドレスは変えない(`pushState` に URL を渡さない)
 * - アプリの中で戻れない間は番兵を置かない(閉じ込めない)。戻れなくなったら畳む(畳む戻りの popstate では戻らない)
 * - スマホの幅では何もしない(`phone-back.ts` が持つ)
 */
import { describe, expect, it } from 'vitest';
import { installNavHistory, MOUSE_NAV_SUPPRESS_MS } from '../../src/adapter/ui/actions/nav-history';

function rig(opts: { canBack?: boolean; phone?: boolean } = {}) {
  const win = new EventTarget() as EventTarget & { setTimeout: (fn: () => void, ms: number) => number };
  const timers: (() => void)[] = [];
  win.setTimeout = (fn) => {
    timers.push(fn);
    return timers.length;
  };
  const pushes: unknown[][] = [];
  let backs = 0;
  const hist = {
    pushState: (...a: unknown[]) => void pushes.push(a),
    back: () => {
      backs += 1;
    },
  };
  let t = 1_000;
  const calls: string[] = [];
  let canBack = opts.canBack ?? true;
  let phone = opts.phone ?? false;
  let listener: (() => void) | null = null;
  const off = installNavHistory({
    back: () => void calls.push('back'),
    forward: () => void calls.push('forward'),
    canBack: () => canBack,
    isPhone: () => phone,
    onChange: (cb) => {
      listener = cb;
      return () => (listener = null);
    },
    win: win as unknown as Window,
    hist,
    now: () => t,
  });
  const mouse = (type: string, button: number): Event => {
    const e = new Event(type, { cancelable: true });
    Object.defineProperty(e, 'button', { value: button });
    win.dispatchEvent(e);
    return e;
  };
  return {
    calls,
    pushes,
    backs: () => backs,
    pop: () => void win.dispatchEvent(new Event('popstate')),
    mouse,
    tick: (ms: number) => void (t += ms),
    setCanBack: (v: boolean) => {
      canBack = v;
      listener?.();
    },
    setPhone: (v: boolean) => {
      phone = v;
      listener?.();
    },
    off,
  };
}

describe('マウスの戻る・進むボタン / PC のブラウザの戻る(A1)', () => {
  it('マウスの戻る・進むボタンで 1 回ずつ戻る・進む / ブラウザ自身の戻る(mouseup の既定)を止める', () => {
    const r = rig();
    const up3 = r.mouse('pointerup', 3);
    expect(up3.defaultPrevented).toBe(true);
    expect(r.calls).toEqual(['back']);
    r.tick(MOUSE_NAV_SUPPRESS_MS + 1);
    r.mouse('pointerup', 4);
    expect(r.calls).toEqual(['back', 'forward']);
    expect(r.mouse('mouseup', 3).defaultPrevented, 'ブラウザの戻るを止めていない').toBe(true);
    expect(r.mouse('mouseup', 0).defaultPrevented, '左クリックまで止めた').toBe(false);
    r.mouse('pointerup', 0);
    r.mouse('pointerup', 2);
    expect(r.calls, '左・右クリックで戻った').toEqual(['back', 'forward']);
  });

  it('🔴 二重発火しない: マウスの戻るの直後に番兵の popstate が来ても、もう 1 度は戻らない(置き直すだけ)', () => {
    const r = rig();
    expect(r.pushes.length, '前提: 番兵を置いている').toBe(1);
    r.mouse('pointerup', 3);
    r.tick(50); // ブラウザ自身の戻るが止めきれずに走った
    r.pop();
    expect(r.calls, '1 クリックで 2 回戻った').toEqual(['back']);
    expect(r.pushes.length, '番兵を置き直していない').toBe(2);
    // 抑止は 1 回きり ── 次の本物の「戻る」(キー・ブラウザのボタン)は効く
    r.tick(MOUSE_NAV_SUPPRESS_MS + 1);
    r.pop();
    expect(r.calls).toEqual(['back', 'back']);
  });

  it('対照群: 抑止の時間を過ぎた popstate は戻る / 抑止は popstate 1 回で解ける', () => {
    const r = rig();
    r.mouse('pointerup', 3);
    r.tick(MOUSE_NAV_SUPPRESS_MS + 10);
    r.pop();
    expect(r.calls).toEqual(['back', 'back']);
    const q = rig();
    q.mouse('pointerup', 3);
    q.tick(10);
    q.pop(); // 抑止された
    q.tick(10);
    q.pop(); // 同じ時間の中でも 2 度目は本物の戻る
    expect(q.calls).toEqual(['back', 'back']);
  });

  it('ブラウザの「戻る」(番兵の消費)でアプリの中で 1 つ戻り、番兵を置き直す / アドレスは変えない', () => {
    const r = rig();
    r.pop();
    expect(r.calls).toEqual(['back']);
    expect(r.pushes.length).toBe(2);
    for (const p of r.pushes) expect(p.length, 'pushState に URL を渡した').toBe(2);
  });

  it('🔴 戻れない間は番兵を置かない(閉じ込めない)/ 戻れるようになったら置き、戻れなくなったら畳む(畳む戻りでは戻らない)', () => {
    const r = rig({ canBack: false });
    expect(r.pushes.length).toBe(0);
    r.pop(); // 番兵が無い ── ページを離れる戻り。アプリは何もしない
    expect(r.calls).toEqual([]);
    r.setCanBack(true);
    expect(r.pushes.length).toBe(1);
    r.setCanBack(false);
    expect(r.backs(), '畳んでいない').toBe(1);
    r.pop(); // 畳んだ戻りの popstate
    expect(r.calls, '畳んだ戻りでアプリが戻った').toEqual([]);
  });

  it('スマホの幅では何もしない(phone-back が持つ)/ スマホへ切り替わったら番兵を畳む', () => {
    const r = rig({ phone: true });
    expect(r.pushes.length).toBe(0);
    expect(r.mouse('pointerup', 3).defaultPrevented).toBe(false);
    expect(r.calls).toEqual([]);
    const q = rig();
    q.setPhone(true);
    expect(q.backs(), 'スマホへ切り替えて番兵を畳んでいない').toBe(1);
  });

  it('外すと何も聞かない', () => {
    const r = rig();
    r.off();
    r.mouse('pointerup', 3);
    r.pop();
    expect(r.calls).toEqual([]);
  });
});
