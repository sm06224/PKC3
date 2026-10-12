/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleNumberFormatWarmup, warmNumberFormat } from '@adapter/ui/render/locale-warmup';
import { formatBodyStats } from '@features/stats/body-stats';

afterEach(() => vi.restoreAllMocks());

describe('数字の整形の読み込みを手が空いた時へ(#878)', () => {
  it('手が空くまでは整形しない(起動を遅くしない)/ 空いたら 1 回だけ整形する', () => {
    const spy = vi.spyOn(Number.prototype, 'toLocaleString');
    let idle: (() => void) | undefined;
    const setTimeout = vi.fn();
    scheduleNumberFormatWarmup({
      requestIdleCallback: (cb) => {
        idle = cb;
      },
      setTimeout,
    });
    expect(idle, '手が空いた時に走らせる口を渡していない').toBeTypeOf('function');
    expect(spy).not.toHaveBeenCalled();
    expect(setTimeout).not.toHaveBeenCalled();
    idle!();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('requestIdleCallback が無い環境では、短い待ちで代える', () => {
    const spy = vi.spyOn(Number.prototype, 'toLocaleString');
    let timer: (() => void) | undefined;
    scheduleNumberFormatWarmup({
      setTimeout: (cb) => {
        timer = cb;
      },
    });
    expect(timer).toBeTypeOf('function');
    expect(spy).not.toHaveBeenCalled();
    timer!();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('読み込ませる言語指定は、右の列の文字数(formatBodyStats)が使うものと同じ', () => {
    // ⚠ 別の言語指定を温めても、右の列の初回は軽くならない。両方の呼び出しを同じ spy で見て等値で突き合わせる
    const spy = vi.spyOn(Number.prototype, 'toLocaleString');
    warmNumberFormat();
    formatBodyStats(1234, null);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]).toEqual(spy.mock.calls[1]);
    expect(spy.mock.calls[0]?.[0]).toBe('ja-JP');
  });

  it('起動が済んだ後に配線されている(main.ts は test から実行されないので原文で pin)', () => {
    const src = readFileSync('src/main.ts', 'utf8');
    const booted = src.indexOf("root.setAttribute('data-pkc-boot', 'ready');");
    const call = src.indexOf('scheduleNumberFormatWarmup(window);');
    expect(booted, 'boot の刻印が見つからない').toBeGreaterThan(0);
    expect(call, '手が空いた時の読み込みが配線されていない').toBeGreaterThan(booted);
    // 刻印の直後の数行の中(別の関数へ紛れていない)
    expect(call - booted).toBeLessThan(600);
  });
});
