/**
 * 🔴 **「探す」から開いた窓へ、探した語を運ぶ道**(#1102 段①)。
 *
 * ## user から見た物語
 *
 * 「探す」の行を押す → 別のウィンドウでノートが開く → **本文の当たった所へ送られて塗られる**。
 * ⚠ 窓は開くので、**語が途中で落ちても画面は正しく見える**(ただ塗られない)── 運ぶ道の
 * どの継ぎ目が切れても気づけない形である。だから**継ぎ目ごと**に、本物どうしを繋いで見る。
 *
 * ## 継ぎ目
 *
 * ① 行 → `open-note-window`(`data-pkc-find`)→ `services.openNoteWindow(lid, find)`
 * ② 新しい窓: `formatViewDeepLink` の `find` → 開いた窓の `connectViewDeepLink` が
 *    `selectEntry` の**後**に `searchJump` を撃ち、**使ったらアドレスから外す**
 * ③ 開いている窓: `NoteRegistry.raise(lid, find)` → 相手の `onRaise(find)`
 * ④ 🔴 語を持たない口(一覧の ⋯ など)は今までどおり(語を運ばない)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  connectViewDeepLink,
  type DeepLinkTarget,
} from '../../src/adapter/platform/deep-link';
import {
  createNoteRegistry,
  type NoteRegistry,
} from '../../src/adapter/platform/note-window-registry';
import { openViewInWindow, type ViewWindowDeps } from '../../src/adapter/platform/view-window';
import type { Broadcaster } from '../../src/adapter/platform/storage/store-proxy';
import {
  dropViewFindFromHash,
  dropViewFromHash,
  dropViewWindowToken,
  formatViewDeepLink,
  parseViewDeepLinkEntry,
  parseViewDeepLinkFind,
  setHashEntry,
} from '../../src/features/link/permalink';

describe('permalink: find の綴り', () => {
  const BASE = 'https://pkc.test/app/';

  it('🔴 ノートと一緒に運ぶ(日本語・空白・記号も往復する)', () => {
    const url = formatViewDeepLink(BASE, null, {
      containerId: 'c1',
      entry: 'e1',
      token: 'tok',
      find: '会議 "来週 の" -中止&=',
    })!;
    expect(url).toContain('find=');
    const hash = url.slice(url.indexOf('#'));
    expect(parseViewDeepLinkFind(hash)).toBe('会議 "来週 の" -中止&=');
    // 他の key を巻き込まない
    expect(parseViewDeepLinkEntry(hash)).toEqual({ containerId: 'c1', lid: 'e1' });
  });

  it('🔴 ノートが載らなかったとき(綴りが通らない)は、語だけ運ばない(行き先の無い語)', () => {
    const url = formatViewDeepLink(BASE, 'search', {
      containerId: 'bad id',
      entry: 'e1',
      find: '会議',
    })!;
    expect(url).not.toContain('find=');
  });

  it('空の語は載せない / 無ければ従来どおり(対照群)', () => {
    const none = formatViewDeepLink(BASE, null, { containerId: 'c1', entry: 'e1' })!;
    const empty = formatViewDeepLink(BASE, null, { containerId: 'c1', entry: 'e1', find: '' })!;
    expect(none).toBe(empty);
    expect(none).not.toContain('find');
  });

  it('🔴 `find` だけ落とす(container / entry / view / w は残す)', () => {
    const raw = '#pkc?container=c1&entry=e1&view=search&w=tok&find=%E4%BC%9A%E8%AD%B0';
    const dropped = dropViewFindFromHash(raw);
    expect(parseViewDeepLinkFind(dropped)).toBeNull();
    expect(dropped).toBe('#pkc?container=c1&entry=e1&view=search&w=tok');
  });

  it('住所の追随(`setHashEntry`)は find を勝手に消さない ── 消すのは使った側(取り出した直後)', () => {
    const raw = '#pkc?container=c1&entry=e1&find=x';
    expect(parseViewDeepLinkFind(setHashEntry(raw, 'c1', 'e2'))).toBe('x');
  });
});

/** `connectViewDeepLink` の試験台(本物の `dropFind` の意味論を写す)。 */
function bench(hash: string) {
  const log: string[] = [];
  const target: DeepLinkTarget & { hash: string } = {
    hash,
    clearHash: () => {
      target.hash = dropViewFromHash(target.hash);
    },
    dropToken: () => {
      target.hash = dropViewWindowToken(target.hash);
    },
    dropFind: () => {
      log.push('dropFind');
      target.hash = dropViewFindFromHash(target.hash);
    },
    setEntry: (containerId, lid) => {
      target.hash = setHashEntry(target.hash, containerId, lid);
    },
    restoreHash: (h) => {
      target.hash = h;
    },
  };
  const off = connectViewDeepLink({
    openView: (m) => log.push(`open:${m}`),
    selectEntry: (_c, lid) => log.push(`select:${lid}`),
    searchJump: (lid, find) => log.push(`jump:${lid}:${find}`),
    fail: (m) => log.push(`fail:${m}`),
    onViewChange: () => () => {},
    onSelectedEntry: () => () => {},
    target,
  });
  return { log, target, off };
}

describe('deep-link: 開いた窓が語を受ける', () => {
  it('🔴 ノートを選んだ「後」に searchJump を撃ち、すぐアドレスから外す', () => {
    const { log, target } = bench('#pkc?container=c1&entry=e1&w=tok&find=%E4%BC%9A%E8%AD%B0');
    expect(log).toEqual(['select:e1', 'jump:e1:会議', 'dropFind']);
    // 栞 / F5 に語が焼き付かない。ノートの住所は残る
    expect(parseViewDeepLinkFind(target.hash)).toBeNull();
    expect(parseViewDeepLinkEntry(target.hash)).toEqual({ containerId: 'c1', lid: 'e1' });
  });

  it('🔴 対照群: find が無い断片では撃たない・落とさない(これまでどおり)', () => {
    const { log } = bench('#pkc?container=c1&entry=e1&w=tok');
    expect(log).toEqual(['select:e1']);
  });

  it('🔴 面を指す断片(`view=`)には塗る本文が無いので撃たない', () => {
    const { log } = bench('#pkc?container=c1&entry=e1&view=search&find=%E4%BC%9A%E8%AD%B0');
    expect(log.some((l) => l.startsWith('jump'))).toBe(false);
  });
});

describe('view-window: 新しい窓の URL に語が載る', () => {
  function deps(find?: string): { deps: ViewWindowDeps; opened: string[] } {
    const opened: string[] = [];
    return {
      opened,
      deps: {
        open: (url) => opened.push(url),
        baseUrl: () => 'https://pkc.test/app/',
        selected: () => ({ containerId: 'c1', lid: 'e1' }),
        newToken: () => 'tok',
        waitForOpen: async () => true,
        openInPane: () => false,
        fail: () => {},
        ...(find === undefined ? {} : { find }),
      },
    };
  }

  it('🔴 find を渡すと、開く URL の断片に載る(ノート・合図と一緒に)', async () => {
    const d = deps('会議');
    await openViewInWindow(null, d.deps);
    expect(d.opened).toHaveLength(1);
    const hash = d.opened[0]!.slice(d.opened[0]!.indexOf('#'));
    expect(parseViewDeepLinkFind(hash)).toBe('会議');
    expect(parseViewDeepLinkEntry(hash)).toEqual({ containerId: 'c1', lid: 'e1' });
  });

  it('🔴 対照群: find を渡さなければ載らない', async () => {
    const d = deps();
    await openViewInWindow(null, d.deps);
    expect(d.opened[0]).not.toContain('find');
  });
});

describe('note-window-registry: 開いている窓へ頼むときも語を運ぶ', () => {
  function bus(): () => Broadcaster {
    const live: Broadcaster[] = [];
    return () => {
      const ch: Broadcaster = {
        onmessage: null,
        postMessage: (data) => {
          for (const other of [...live]) if (other !== ch) other.onmessage?.({ data } as MessageEvent);
        },
        close: () => {
          const i = live.indexOf(ch);
          if (i >= 0) live.splice(i, 1);
        },
      };
      live.push(ch);
      return ch;
    };
  }
  const win = (make: () => Broadcaster, id: string, onRaise: (f?: string) => void): NoteRegistry =>
    createNoteRegistry({ channel: make(), id, onRaise });

  it('🔴 raise(lid, find) は、その付箋の窓の onRaise(find) に届く', () => {
    const make = bus();
    const got: Array<string | undefined> = [];
    const a = win(make, 'A', (f) => got.push(f));
    const b = win(make, 'B', () => {});
    a.announce('e1');
    b.raise('e1', '会議');
    expect(got).toEqual(['会議']);
  });

  it('🔴 対照群: 語なしの raise は、これまでどおり語なしで届く', () => {
    const make = bus();
    const got: Array<string | undefined> = [];
    const a = win(make, 'A', (f) => got.push(f));
    const b = win(make, 'B', () => {});
    a.announce('e1');
    b.raise('e1');
    b.raise('e1', '');
    expect(got).toEqual([undefined, undefined]);
  });

  it('🔴 無関係な窓には届かない(語を撒き散らさない)', () => {
    const make = bus();
    const other = vi.fn();
    const a = win(make, 'A', () => {});
    win(make, 'C', other);
    const b = win(make, 'B', () => {});
    a.announce('e1');
    b.raise('e1', '会議');
    expect(other).not.toHaveBeenCalled();
  });
});
