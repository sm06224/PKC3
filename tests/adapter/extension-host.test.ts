/** @vitest-environment happy-dom */
/**
 * 🔴 **拡張へ港を渡し、見取り図を押し出す**(#195 / C-5 段①)。
 *
 * 🔑 守る主張:
 * 1. 🔴 **印が立つまで渡さない**(早すぎる受け渡しは届かない ── 実測で決めた形)
 * 2. 🔴 **`hello` に見取り図で答える**(本文は 1 バイトも入らない)
 * 3. 🔴 **知らない種別は理由を添えて断る**(無言で捨てない)
 * 4. 🔴 **手を切ったら投げない**(閉じた窓へ投げ続けない)
 * 5. ⚠ 印が立たないまま時間切れなら**そう言う**
 */
import { describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { connectExtension } from '../../src/adapter/platform/extension-host';
import { EXT_PORT_TAG, EXT_READY_FLAG } from '../../src/features/extension/ext-wire';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: 99,
  };
}

/**
 * 外殻の窓を模す。⚠ **印は後から立てられる**(本物と同じ ── 開いた瞬間は無い)。
 * 受け取った港はそのまま持って、拡張の代わりに投げられるようにする。
 */
function fakeWin() {
  const win = {
    [EXT_READY_FLAG]: undefined as unknown,
    port: null as MessagePort | null,
    tags: [] as string[],
    postMessage(data: unknown, _origin: string, transfer?: readonly MessagePort[]) {
      win.tags.push((data as { tag?: string }).tag ?? '');
      if (transfer && transfer[0]) {
        win.port = transfer[0];
        win.port.start?.();
      }
    },
  };
  return win;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 港が繋がるまで進める(印を立ててから)。 */
async function connected(win: ReturnType<typeof fakeWin>, opts: Parameters<typeof connectExtension>[0]) {
  (win as Record<string, unknown>)[EXT_READY_FLAG] = 1;
  for (let i = 0; i < 20 && win.port === null; i += 1) await tick();
  return opts;
}

describe('拡張へ港を渡す (#195 / C-5 段①)', () => {
  /**
   * 🔴 **印が立つまで渡さない。**
   * ⚠ ここが逆だと、外殻がまだ聴いていないうちに投げて**永久に繋がらない**
   *   (実測で `readyState` を印にすると 0/10 だった形)。
   */
  it('🔴 印が立つまで港を渡さない', async () => {
    const win = fakeWin();
    const link = connectExtension({ win: win as unknown as Window, metas: () => [meta('a')], pollMs: 0 });
    for (let i = 0; i < 5; i += 1) await tick();
    expect(win.port, '印が立つ前に渡している').toBeNull();
    expect(link.connected()).toBe(false);
    // ⚠ 対照群 ── 印を立てれば渡る(「そもそも渡らない」実装と区別する)
    await connected(win, { win: win as unknown as Window, metas: () => [] });
    expect(win.port, '印を立てても渡らない').not.toBeNull();
    expect(win.tags, '合図の綴りが違う').toEqual([EXT_PORT_TAG]);
    link.close();
  });

  it('🔴 `hello` に見取り図で答える(本文は入らない)', async () => {
    const win = fakeWin();
    const link = connectExtension({
      win: win as unknown as Window,
      metas: () => [meta('a'), meta('b')],
      pollMs: 0,
    });
    await connected(win, { win: win as unknown as Window, metas: () => [] });
    const got: unknown[] = [];
    win.port!.onmessage = (e) => void got.push(e.data);
    win.port!.postMessage({ t: 'hello' });
    for (let i = 0; i < 20 && got.length === 0; i += 1) await tick();
    expect(got, '見取り図が返っていない').toHaveLength(1);
    const msg = got[0] as { t: string; projection: { entries: Record<string, unknown>[] } };
    expect(msg.t).toBe('projection');
    expect(msg.projection.entries.map((e) => e['lid'])).toEqual(['a', 'b']);
    // 🔴 本文にも、その長さにも繋がらない
    expect(Object.keys(msg.projection.entries[0]!), '本文の長さが漏れている').not.toContain(
      'bodyChars',
    );
    expect(JSON.stringify(msg), '本文が漏れている').not.toContain('bodyChars');
    link.close();
  });

  it('🔴 知らない種別は理由を添えて断る(無言で捨てない)', async () => {
    const win = fakeWin();
    const onReject = vi.fn();
    const link = connectExtension({
      win: win as unknown as Window,
      metas: () => [],
      pollMs: 0,
      onReject,
    });
    await connected(win, { win: win as unknown as Window, metas: () => [] });
    const got: unknown[] = [];
    win.port!.onmessage = (e) => void got.push(e.data);
    win.port!.postMessage({ t: 'updateBody', lid: 'a', body: 'x' });
    for (let i = 0; i < 10; i += 1) await tick();
    expect(onReject, '断った理由が出ていない').toHaveBeenCalledWith(
      expect.stringContaining('updateBody'),
    );
    expect(got, '知らない種別に答えている').toHaveLength(0);
    link.close();
  });

  /** 🔴 **手を切ったら投げない** ── 閉じた窓へ押し続けない。 */
  it('🔴 close の後は押し出さない', async () => {
    const win = fakeWin();
    const link = connectExtension({ win: win as unknown as Window, metas: () => [meta('a')], pollMs: 0 });
    await connected(win, { win: win as unknown as Window, metas: () => [] });
    const got: unknown[] = [];
    win.port!.onmessage = (e) => void got.push(e.data);
    // ⚠ 対照群 ── 切る前は届く(「そもそも押していない」実装と区別する)
    link.push();
    for (let i = 0; i < 20 && got.length === 0; i += 1) await tick();
    expect(got, '切る前も押していない(前提が崩れた)').toHaveLength(1);
    link.close();
    link.push();
    for (let i = 0; i < 10; i += 1) await tick();
    expect(got, '切った後も押している').toHaveLength(1);
    expect(link.connected()).toBe(false);
  });

  /** ⚠ 印が立たないまま時間切れ ── **そう言う**(無言で終わらない)。 */
  it('⚠ 印が立たなければ、諦めたと言う', async () => {
    const win = fakeWin();
    const onGiveUp = vi.fn();
    connectExtension({
      win: win as unknown as Window,
      metas: () => [],
      pollMs: 0,
      timeoutMs: 0,
      onGiveUp,
    });
    for (let i = 0; i < 10 && onGiveUp.mock.calls.length === 0; i += 1) await tick();
    expect(onGiveUp, '諦めたのに黙っている').toHaveBeenCalled();
    expect(win.port, '諦めたのに渡している').toBeNull();
  });
});
