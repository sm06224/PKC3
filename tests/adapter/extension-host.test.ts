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

/** この test の中で使う合図。⚠ 外殻役はこれと合わない港を**捨てる**(本物と同じ)。 */
const NONCE = 'n-test';

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
 *
 * 🔴 **本物の意味論を真似る ── 合図が合わない港は掴まない**(2026-08-25 に踏んだ)。
 * ⚠ 初稿の外殻役は `tag` も `nonce` も見ずに、渡された港を無条件で握っていた ──
 *   だから**ホストが合図を 1 つも渡していない**のに緑だった。実物の外殻は
 *   `m.nonce !== NONCE` で捨てるので、smoke まで行って初めて分かった
 *   (CLAUDE.md §3「stub が実装より甘いとバグが隠れる」)。
 */
function fakeWin() {
  const win = {
    [EXT_READY_FLAG]: undefined as unknown,
    port: null as MessagePort | null,
    tags: [] as string[],
    /** ⚠ 掴まなかった理由を残す(「渡っていない」と「捨てた」を見分ける)。 */
    dropped: [] as string[],
    /**
     * 🔴 **港を受け取った瞬間から控える**(2026-08-25)。
     * ⚠ test の中で後から `onmessage` を張ると、**繋いだ時点の押し出し**を
     *   取りこぼす ── 「押していない」と読み違える(実際に 1 度読み違えた)。
     */
    got: [] as unknown[],
    postMessage(data: unknown, _origin: string, transfer?: readonly MessagePort[]) {
      const m = data as { tag?: string; nonce?: string };
      win.tags.push(m.tag ?? '');
      if (!transfer || !transfer[0]) return;
      // 🔴 実物の外殻と同じ検め方(`app-shell.ts` の中継 script)
      if (m.tag !== EXT_PORT_TAG || m.nonce !== NONCE) {
        win.dropped.push(`tag=${String(m.tag)} nonce=${String(m.nonce)}`);
        return;
      }
      win.port = transfer[0];
      win.port.onmessage = (e: MessageEvent): void => void win.got.push(e.data);
      win.port.start?.();
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
    const link = connectExtension({
      win: win as unknown as Window,
      metas: () => [meta('a')],
      nonce: NONCE,
      pollMs: 0,
    });
    for (let i = 0; i < 5; i += 1) await tick();
    expect(win.port, '印が立つ前に渡している').toBeNull();
    expect(link.connected()).toBe(false);
    // ⚠ 対照群 ── 印を立てれば渡る(「そもそも渡らない」実装と区別する)
    await connected(win, { win: win as unknown as Window, metas: () => [], nonce: NONCE });
    expect(win.port, '印を立てても渡らない').not.toBeNull();
    expect(win.tags, '合図の綴りが違う').toEqual([EXT_PORT_TAG]);
    link.close();
  });

  /**
   * 🔴 **繋いだ時点で押す**(2026-08-25、実ブラウザの smoke が拾った)。
   *
   * ⚠ アプリの `hello` は**港より先に**投げられる(アプリは `srcdoc` が読み込まれた
   *   瞬間に走るが、港は本体タブが印を読んでから渡す)── 外殻は港が無い間の言葉を
   *   捨てるので、**1 回しか挨拶しないアプリには永久に何も届かなかった**。
   * 🔑 押す側から始めれば、遅れて読み込まれたアプリは `hello` で拾える。
   */
  it('🔴 `hello` を待たずに、繋いだ時点で押す', async () => {
    const win = fakeWin();
    const link = connectExtension({
      win: win as unknown as Window,
      metas: () => [meta('a')],
      nonce: NONCE,
      pollMs: 0,
    });
    (win as Record<string, unknown>)[EXT_READY_FLAG] = 1;
    // ⚠ **こちらからは 1 度も `hello` を送らない**(押されることを見る)
    for (let i = 0; i < 20 && win.got.length === 0; i += 1) await tick();
    expect(
      win.got,
      '繋いだのに押していない(1 回しか挨拶しないアプリへ何も届かない)',
    ).toHaveLength(1);
    expect((win.got[0] as { t: string }).t).toBe('projection');
    link.close();
  });

  /**
   * 🔴 **港には合図を添えて渡す**(2026-08-25、smoke が拾った)。
   *
   * ⚠ 実物の外殻は `m.tag !== TAG || m.nonce !== NONCE` で港を**黙って捨てる**。
   *   ここが抜けていたので、繋がった気でいて**アプリには 1 バイトも届かなかった**。
   * 🔑 対照群を同じ it に置く ── 「合図が違えば捨てられる」ことまで見ないと、
   *   外殻役が甘いだけ(何でも掴む stub)と区別がつかない。
   */
  it('🔴 港には合図を添えて渡す(合わない港は外殻に捨てられる)', async () => {
    const win = fakeWin();
    const link = connectExtension({
      win: win as unknown as Window,
      metas: () => [meta('a')],
      nonce: NONCE,
      pollMs: 0,
    });
    await connected(win, { win: win as unknown as Window, metas: () => [], nonce: NONCE });
    expect(win.dropped, '合図が合わずに捨てられている').toEqual([]);
    expect(win.port, '港が渡っていない').not.toBeNull();
    link.close();

    // ⚠ 対照群 ── 別の合図で繋ぐと、外殻役は掴まない(捨てた理由が残る)
    const other = fakeWin();
    const link2 = connectExtension({
      win: other as unknown as Window,
      metas: () => [meta('a')],
      nonce: 'n-ちがう',
      pollMs: 0,
    });
    (other as Record<string, unknown>)[EXT_READY_FLAG] = 1;
    for (let i = 0; i < 20 && other.dropped.length === 0; i += 1) await tick();
    expect(other.dropped, '合図が違うのに掴んでいる').toHaveLength(1);
    expect(other.port).toBeNull();
    link2.close();
  });

  it('🔴 `hello` に見取り図で答える(本文は入らない)', async () => {
    const win = fakeWin();
    const link = connectExtension({
      win: win as unknown as Window,
      metas: () => [meta('a'), meta('b')],
      nonce: NONCE,
      pollMs: 0,
    });
    await connected(win, { win: win as unknown as Window, metas: () => [], nonce: NONCE });
    // ⚠ 繋いだ時点の押し出しが 1 件在る ── `hello` の返事は**その次**である
    for (let i = 0; i < 20 && win.got.length === 0; i += 1) await tick();
    expect(win.got, '前提が崩れている(繋いだ時点で押していない)').toHaveLength(1);
    win.port!.postMessage({ t: 'hello' });
    for (let i = 0; i < 20 && win.got.length < 2; i += 1) await tick();
    expect(win.got, '`hello` に答えていない').toHaveLength(2);
    const msg = win.got[1] as { t: string; projection: { entries: Record<string, unknown>[] } };
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
      nonce: NONCE,
      pollMs: 0,
      onReject,
    });
    await connected(win, { win: win as unknown as Window, metas: () => [], nonce: NONCE });
    for (let i = 0; i < 20 && win.got.length === 0; i += 1) await tick();
    const before = win.got.length; // ⚠ 繋いだ時点の押し出し(1 件)
    win.port!.postMessage({ t: 'updateBody', lid: 'a', body: 'x' });
    for (let i = 0; i < 10; i += 1) await tick();
    expect(onReject, '断った理由が出ていない').toHaveBeenCalledWith(
      expect.stringContaining('updateBody'),
    );
    expect(win.got, '知らない種別に答えている').toHaveLength(before);
    link.close();
  });

  /** 🔴 **手を切ったら投げない** ── 閉じた窓へ押し続けない。 */
  it('🔴 close の後は押し出さない', async () => {
    const win = fakeWin();
    const link = connectExtension({
      win: win as unknown as Window,
      metas: () => [meta('a')],
      nonce: NONCE,
      pollMs: 0,
    });
    await connected(win, { win: win as unknown as Window, metas: () => [], nonce: NONCE });
    // ⚠ 対照群 ── 切る前は届く(「そもそも押していない」実装と区別する)
    link.push();
    for (let i = 0; i < 20 && win.got.length < 2; i += 1) await tick();
    expect(win.got, '切る前も押していない(前提が崩れた)').toHaveLength(2);
    const before = win.got.length;
    link.close();
    link.push();
    for (let i = 0; i < 10; i += 1) await tick();
    expect(win.got, '切った後も押している').toHaveLength(before);
    expect(link.connected()).toBe(false);
  });

  /** ⚠ 印が立たないまま時間切れ ── **そう言う**(無言で終わらない)。 */
  it('⚠ 印が立たなければ、諦めたと言う', async () => {
    const win = fakeWin();
    const onGiveUp = vi.fn();
    connectExtension({
      win: win as unknown as Window,
      metas: () => [],
      nonce: NONCE,
      pollMs: 0,
      timeoutMs: 0,
      onGiveUp,
    });
    for (let i = 0; i < 10 && onGiveUp.mock.calls.length === 0; i += 1) await tick();
    expect(onGiveUp, '諦めたのに黙っている').toHaveBeenCalled();
    expect(win.port, '諦めたのに渡している').toBeNull();
  });
});
