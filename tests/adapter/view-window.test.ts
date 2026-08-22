/**
 * 🔴 **組み込みアプリを別窓で開く**(#300 段③、2026-08-22)。
 *
 * > 「**組み込みのアプリに関しては全て別窓で作業したい Office みたいに!**」
 * > 「**メインの PKC の機能を阻害する方向で PKC のセンターペインを占有するな**」
 *
 * ## user から見た物語
 *
 * ノートを読んでいる。カレンダーのタイルを押す。
 * ⇒ **別の窓にカレンダーが出る。本文はそのまま。**
 * 直す前は中央の面が入れ替わり、**本文が消えていた**。
 *
 * ## この test が守る主張
 *
 * ① 🔴 **成功したら中央の面を触らない** ── これが user の要望そのもの
 * ② 🔴 **窓が塞がれたら中央の面へ退避し、理由を出す**(段⑤ の退避先)
 * ③ 🔴 **`window.open` は待つ前に撃つ** ── gesture の中でしか通らない
 * ④ ⚠ アドレスが組めないときも黙って本文で開かない
 */
import { describe, expect, it, vi } from 'vitest';
import { openViewInWindow, type ViewWindowDeps } from '../../src/adapter/platform/view-window';

function bench(opts: { announced: boolean; base?: string }) {
  const opened: string[] = [];
  const panes: string[] = [];
  const fails: string[] = [];
  /** ⚠ 「待つ前に開いたか」を見るための記録(③ の観測点)。 */
  let openedBeforeWait: boolean | null = null;
  const deps: ViewWindowDeps = {
    open: (url) => opened.push(url),
    baseUrl: () => opts.base ?? 'https://例.test/pkc/',
    waitForAnnounce: async () => {
      // ⚠ **最初の 1 回だけ**記録する ── 毎回上書きすると、
      //   「先に空振りで待ってから開く」変異が**後の呼び出しに救われて**生き延びる
      //   (実際に M4 がそれで SURVIVED した)
      if (openedBeforeWait === null) openedBeforeWait = opened.length > 0;
      return opts.announced;
    },
    openInPane: (v) => panes.push(v),
    fail: (m) => fails.push(m),
  };
  return { deps, opened, panes, fails, openedBeforeWait: () => openedBeforeWait };
}

describe('組み込みアプリを別窓で開く(#300 段③)', () => {
  it('🔴 窓が出たら、中央の面は 1 ミリも触らない(本文が消えない)', async () => {
    const b = bench({ announced: true });
    expect(await openViewInWindow('calendar', b.deps)).toBe('window');
    expect(b.opened, 'ディープリンク付きで開いていない').toEqual([
      'https://例.test/pkc/#pkc?view=calendar',
    ]);
    expect(b.panes, '中央の面を占有した(user の要望と正面から逆)').toEqual([]);
    expect(b.fails, '成功したのに理由を出した').toEqual([]);
  });

  it('🔴 3 つの組み込みアプリが、どれも別窓で開く', async () => {
    for (const view of ['dual', 'calendar', 'kanban'] as const) {
      const b = bench({ announced: true });
      await openViewInWindow(view, b.deps);
      expect(b.opened, `${view} が別窓で開かない`).toEqual([
        `https://例.test/pkc/#pkc?view=${view}`,
      ]);
      expect(b.panes, `${view} が中央の面を占有した`).toEqual([]);
    }
  });

  /**
   * 🔴 **窓が塞がれたら退避する**(段⑤)。
   * ⚠ `noopener` は戻り値が常に `null` なので、**名乗りが来たかどうか**でしか
   *   見分けられない ── だから来なかったときが「塞がれた」である。
   */
  it('🔴 窓が塞がれたら中央の面へ退避し、理由を出す', async () => {
    const b = bench({ announced: false });
    expect(await openViewInWindow('kanban', b.deps)).toBe('pane');
    expect(b.opened, '開こうとすらしていない').toHaveLength(1);
    expect(b.panes, '退避していない(押しても何も起きない)').toEqual(['kanban']);
    expect(b.fails, '黙って退避した(user は窓が出ない理由を知れない)').toHaveLength(1);
    // 🔑 **次に何をすればよいか**が書いてある(「ポップアップの許可」)
    expect(b.fails[0]).toContain('ポップアップ');
  });

  /**
   * 🔴 **`window.open` は待つ前に撃つ。**
   * ⚠ `await` の後ろへ回すと **gesture が切れて必ず塞がれる** ── しかも
   *   「塞がれた」と見分けがつかないので、**常に中央の面へ退避する**ようになる
   *   (= 直す前と同じ挙動に戻り、しかも 2.5 秒待たされる)。
   */
  it('🔴 名乗りを待つ前に窓を開いている(gesture を切らない)', async () => {
    const b = bench({ announced: true });
    await openViewInWindow('dual', b.deps);
    expect(b.openedBeforeWait(), '待ってから開いている(gesture が切れる)').toBe(true);
  });

  /**
   * ⚠ アドレスが組めないとき(base に `#` が残っている)も**黙って本文で開かない**。
   * 🔑 `currentBaseUrl` が断片を落とすので普通は起きないが、
   *   落とし忘れた日に**無言の dead click** にならないよう、口を閉じておく。
   */
  it('⚠ アドレスが組めないときも、理由を出してから退避する', async () => {
    const b = bench({ announced: true, base: 'https://例.test/pkc/#some-heading' });
    expect(await openViewInWindow('calendar', b.deps)).toBe('pane');
    expect(b.opened, '組めていないのに開こうとした').toEqual([]);
    expect(b.panes).toEqual(['calendar']);
    expect(b.fails, '黙って退避した').toHaveLength(1);
  });

  /** ⚠ 窓は使い回さない(#300 段③ の裁定)── 2 回押したら 2 枚開く。 */
  it('⚠ 同じタイルを 2 回押すと 2 枚開く(使い回さない)', async () => {
    const b = bench({ announced: true });
    await openViewInWindow('calendar', b.deps);
    await openViewInWindow('calendar', b.deps);
    expect(b.opened).toHaveLength(2);
    expect(b.panes).toEqual([]);
  });

  /** ⚠ 撃つ先を広げていないこと。 */
  it('⚠ 成功した回は fail も openInPane も呼ばない', async () => {
    const openInPane = vi.fn();
    const fail = vi.fn();
    await openViewInWindow('calendar', {
      open: () => {},
      baseUrl: () => 'https://例.test/',
      waitForAnnounce: async () => true,
      openInPane,
      fail,
    });
    expect(openInPane).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });
});
