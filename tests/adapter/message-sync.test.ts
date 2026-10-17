/**
 * 🔴 メッセージの書込 / 既読を他のタブへ伝える(#1087)。
 *
 * 守るもの:①別タブの書込の合図が**実物どうし**で届く(fake hub の両端に本物)②1 秒に 1 回までにまとめる
 * ③自分の合図は自分で拾わない ④別タブの既読(`storage` event の READ_AT)で数え直す ⑤他の key では数え直さない
 * ⑥ストアの放送路(`NOT_BROADCAST`)に `appendMessage` が居続ける(処理の記録を全タブへ放送しない)。
 * 守っていないもの:`main.ts` の繋ぎ(原文の pin だけ)・実ブラウザの BroadcastChannel / storage event。
 */
/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectMessageSync,
  MESSAGES_CHANNEL,
  MESSAGES_SYNC_MS,
  messagesMessage,
  readMessages,
  type MessagesChannelPort,
  type StorageEventTarget,
} from '../../src/adapter/platform/message-sync';
import { READ_AT_KEY } from '../../src/adapter/platform/message-post';
import { NOT_BROADCAST } from '../../src/adapter/platform/storage/store-proxy';

/** 同名の路で繋がった端の集まり(自分には返らない = 本物の BroadcastChannel と同じ)。 */
class Hub {
  ends: Port[] = [];
  port(): Port {
    const p = new Port(this);
    this.ends.push(p);
    return p;
  }
}
class Port implements MessagesChannelPort {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  sent = 0;
  constructor(private readonly hub: Hub) {}
  postMessage(data: unknown): void {
    this.sent += 1;
    for (const e of this.hub.ends) if (e !== this) e.onmessage?.({ data } as MessageEvent);
  }
}
class FakeWin implements StorageEventTarget {
  fns = new Set<(ev: StorageEvent) => void>();
  addEventListener(_t: 'storage', fn: (ev: StorageEvent) => void): void {
    this.fns.add(fn);
  }
  removeEventListener(_t: 'storage', fn: (ev: StorageEvent) => void): void {
    this.fns.delete(fn);
  }
  fire(key: string | null): void {
    for (const f of [...this.fns]) f({ key } as StorageEvent);
  }
}

function tab(hub: Hub, id: string) {
  const written: string[][] = [];
  const win = new FakeWin();
  let reads = 0;
  const port = hub.port();
  const sync = connectMessageSync({
    channel: port,
    id,
    win,
    readAtKey: READ_AT_KEY,
    onRemoteWritten: (l) => written.push([...l]),
    onReadElsewhere: () => {
      reads += 1;
    },
  });
  return { sync, written, win, port, reads: () => reads };
}

describe('メッセージの他タブ連携', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('🔴 別タブの書込の合図が届く(実物どうし)。自分の分は拾わない', () => {
    const hub = new Hub();
    const a = tab(hub, 'A');
    const b = tab(hub, 'B');
    a.sync.changed('sys-messages');
    expect(b.written, '1 秒待つ前に送った(まとめていない)').toEqual([]);
    vi.advanceTimersByTime(MESSAGES_SYNC_MS);
    expect(b.written).toEqual([['sys-messages']]);
    expect(a.written, '自分の合図を自分で拾った').toEqual([]);
  });

  it('🔴 1 秒に 1 回までにまとめ、lid は重ねない(処理の記録を書くたびに送らない)', () => {
    const hub = new Hub();
    const a = tab(hub, 'A');
    const b = tab(hub, 'B');
    for (let i = 0; i < 40; i += 1) {
      a.sync.changed(i % 2 === 0 ? 'sys-jobs' : 'sys-messages');
      vi.advanceTimersByTime(20);
    }
    vi.advanceTimersByTime(MESSAGES_SYNC_MS);
    expect(a.port.sent, '40 回書いたのに合図が複数回').toBe(1);
    expect(b.written).toHaveLength(1);
    expect([...b.written[0]!].sort()).toEqual(['sys-jobs', 'sys-messages']);
    // 次の窓では次の 1 回
    a.sync.changed('sys-jobs');
    vi.advanceTimersByTime(MESSAGES_SYNC_MS);
    expect(a.port.sent).toBe(2);
  });

  it('🔴 送る間隔は 1 秒以上あく(窓をまたいで書いても詰めて送らない)', () => {
    const hub = new Hub();
    const a = tab(hub, 'A');
    const stamps: number[] = [];
    const orig = a.port.postMessage.bind(a.port);
    a.port.postMessage = (d: unknown): void => {
      stamps.push(Date.now());
      orig(d);
    };
    a.sync.changed('sys-messages'); // t=0
    vi.advanceTimersByTime(500);
    a.sync.changed('sys-messages'); // t=500
    vi.advanceTimersByTime(500); // t=1000: 1 回目
    a.sync.changed('sys-jobs'); // t=1000
    vi.advanceTimersByTime(3000);
    expect(stamps).toHaveLength(2);
    expect(stamps[1]! - stamps[0]!, '1 秒未満で続けて送った').toBeGreaterThanOrEqual(MESSAGES_SYNC_MS);
  });

  it('🔴 別タブの既読(storage event の READ_AT)で数え直す。他の key では数え直さない', () => {
    const hub = new Hub();
    const a = tab(hub, 'A');
    a.win.fire('pkc3.messages.cap');
    a.win.fire('somethingelse');
    expect(a.reads(), '関係ない key で数え直した').toBe(0);
    a.win.fire(READ_AT_KEY);
    expect(a.reads()).toBe(1);
    a.win.fire(null); // localStorage.clear()
    expect(a.reads()).toBe(2);
  });

  it('路が無い箱では何もしない / dispose で聞くのをやめる', () => {
    const win = new FakeWin();
    const reads = vi.fn();
    const s = connectMessageSync({
      channel: null,
      id: 'X',
      win,
      readAtKey: READ_AT_KEY,
      onRemoteWritten: () => {},
      onReadElsewhere: reads,
    });
    s.changed('sys-messages');
    vi.advanceTimersByTime(MESSAGES_SYNC_MS * 2);
    s.dispose();
    win.fire(READ_AT_KEY);
    expect(reads).not.toHaveBeenCalled();
    expect(win.fns.size).toBe(0);
  });

  it('封筒: tag が違う物 / 壊れた物は掴まない', () => {
    expect(readMessages(messagesMessage('A', ['x']), 'B')).toEqual(['x']);
    expect(readMessages(messagesMessage('A', ['x']), 'A')).toBeNull();
    expect(readMessages({ tag: 'pkc3-wiped', from: 'A', cid: 'c' }, 'B')).toBeNull();
    expect(readMessages({ tag: 'pkc3-messages', from: 'A', lids: 'x' }, 'B')).toBeNull();
    expect(readMessages(null, 'B')).toBeNull();
  });

  it('ストアの放送路は変えない: appendMessage は NOT_BROADCAST のまま', () => {
    expect(NOT_BROADCAST.has('appendMessage')).toBe(true);
  });

  it('main.ts の繋ぎ: 書けたら合図を出し、READ_AT の key で聞いている(原文の pin。弱い)', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    const at = main.indexOf('connectMessageSync({');
    expect(at, 'main.ts に繋ぎが無い').toBeGreaterThan(0);
    const blk = main.slice(at, at + 1800);
    expect(blk).toContain('readAtKey: READ_AT_KEY');
    expect(blk).toContain('onReadElsewhere: recountUnread');
    expect(blk).toContain('appMessagePost.onWritten((lid) => sync.changed(lid))');
    expect(MESSAGES_CHANNEL).toBe('pkc3-messages-changed');
  });
});
