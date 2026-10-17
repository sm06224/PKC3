/**
 * 🔴 メッセージの保管件数: 保存が使えない端末でも、選んだ値はその session の中で効く(#1087)。
 * 直す前は `setMessageCap` が失敗を握りつぶすだけで、読む側に控えが無く、件数を選んでも何も起きなかった。
 */
/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentMessageCap,
  resetMessageCapFallbackForTest,
  setMessageCap,
} from '../../src/adapter/platform/message-post';
import { MESSAGE_CAP_DEFAULT, MESSAGE_CAP_OPTIONS } from '../../src/features/message/message-log';

const PICK = MESSAGE_CAP_OPTIONS.find((n) => n !== MESSAGE_CAP_DEFAULT)!;

describe('メッセージの保管件数の控え', () => {
  beforeEach(() => resetMessageCapFallbackForTest());
  afterEach(() => {
    vi.unstubAllGlobals();
    resetMessageCapFallbackForTest();
  });

  it('前提: 選ぶ値は既定と違う', () => {
    expect(PICK).not.toBe(MESSAGE_CAP_DEFAULT);
  });

  it('localStorage が一切使えない端末でも、選んだ件数が読める', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(currentMessageCap()).toBe(MESSAGE_CAP_DEFAULT);
    setMessageCap(PICK);
    expect(currentMessageCap(), '選んだのに既定のまま(無言の dead click)').toBe(PICK);
  });

  it('書き込みだけ失敗する(容量不足)ときは、古い保存値でなく選んだ値を返す', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => String(MESSAGE_CAP_DEFAULT),
      setItem: () => {
        throw new Error('quota');
      },
    });
    setMessageCap(PICK);
    expect(currentMessageCap()).toBe(PICK);
  });

  it('対照群: 保存が使えるときは保存が正本(控えより別タブの書込を優先)', () => {
    setMessageCap(PICK);
    expect(currentMessageCap()).toBe(PICK);
    localStorage.setItem('pkc3.messages.cap', String(MESSAGE_CAP_DEFAULT));
    expect(currentMessageCap()).toBe(MESSAGE_CAP_DEFAULT);
  });

  it('選べない値は無視する', () => {
    setMessageCap(12345);
    expect(currentMessageCap()).toBe(MESSAGE_CAP_DEFAULT);
  });
});
