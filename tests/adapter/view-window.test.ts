/**
 * 🔴 **組み込みアプリを別窓で開く**(#300 段③、2026-08-22)。
 *
 * > 「**組み込みのアプリに関しては全て別窓で作業したい Office みたいに!**」
 * > 「**メインの PKC の機能を阻害する方向で PKC のセンターペインを占有するな**」
 *
 * ## user から見た物語
 *
 * ノートを読んでいる。2 ペインで整理のタイルを押す。
 * ⇒ **別の窓に 2 ペインが出る。本文はそのまま。しかも読んでいたノートが選ばれている。**
 * 直す前は中央の面が入れ替わり、**本文が消えていた**。
 *
 * ⚠ **物語の主役は入れ替わった**(#292 段⑤、2026-08-23)── 当時の例はカレンダー
 *   だったが、あれは「アプリ」ではなく**ノートの見方**だったので左の列の
 *   「予定」タブへ引っ越した。ここが守るのは**組み込みを別窓で開く作法**であって、
 *   カレンダーそのものではない。
 *
 * ## この test が守る主張
 *
 * ① 🔴 **成功したら中央の面を触らない** ── これが user の要望そのもの
 * ② 🔴 **読んでいたノートを連れて行く** ── 連れて行かないと、別窓は
 *    「ノートを選んでください」で立ち上がる(= その窓では手が付けられない)
 * ③ 🔴 **窓が塞がれたら中央の面へ退避し、理由を出す**(段⑤ の退避先)。
 *    ⚠ 退避は**開く**であってトグルではない ── 2 回押しても閉じない
 * ④ 🔴 **`window.open` は待つ前に撃つ** ── gesture の中でしか通らない
 * ⑤ 🔴 **開けたかは「自分が渡した合図」でしか判定しない**(誤爆させない)
 * ⑥ 🔴 **アプリの窓の `× 閉じる` は窓ごと閉じる**(閉じられなければ理由を出す)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CLOSE_VIEW_WINDOW_REFUSED,
  VIEW_WINDOW_ANNOUNCE_MS,
  VIEW_WINDOW_CHANNEL,
  VIEW_WINDOW_FEATURES,
  VIEW_WINDOW_OPEN,
  VIEW_WINDOW_OPENING,
  announceViewWindow,
  closeViewWindow,
  openViewInWindow,
  openViewWindowUrl,
  waitForViewWindow,
  type ViewWindowDeps,
} from '../../src/adapter/platform/view-window';
import type { Broadcaster } from '../../src/adapter/platform/storage/store-proxy';
import { isViewMode, type ViewMode } from '../../src/adapter/state/app-state';
import { withBuiltinTiles } from '../../src/features/launcher/tiles';

interface BenchOpts {
  readonly answered?: boolean;
  readonly base?: string;
  readonly selected?: { containerId: string; lid: string } | null;
  /** ⚠ **本物の意味論を真似る** ── 編集中は面が開かない(CLAUDE.md §3)。 */
  readonly editing?: boolean;
  readonly startMode?: ViewMode;
}

/**
 * ⚠ **`openInPane` は本物の意味論を真似る**(CLAUDE.md §3「stub は本物の意味論を
 * 真似る」)── 「積むだけ」の stub にすると、**退避がトグルになっている**欠陥
 * (着地前レビュー 1)が緑のまま通る。だから**いまの面**を持ち、編集中は断る。
 */
function bench(opts: BenchOpts = {}) {
  const opened: string[] = [];
  /** 退避を頼まれた面(頼まれた順)。 */
  const panes: ViewMode[] = [];
  const fails: string[] = [];
  /** 押した瞬間に出た字と、消した字(#685 動線レビュー 欠陥 7)。 */
  const notices: string[] = [];
  /** `waitForOpen` に渡った猶予(⑤ の観測点)。 */
  const waits: Array<{ token: string; ms: number }> = [];
  /** ⚠ 「待つ前に開いたか」を見るための記録(④ の観測点)。 */
  let openedBeforeWait: boolean | null = null;
  let mode: ViewMode = opts.startMode ?? 'detail';
  let tokens = 0;
  const deps: ViewWindowDeps = {
    open: (url) => opened.push(url),
    baseUrl: () => opts.base ?? 'https://xn--r8j.test/pkc/',
    selected: () => opts.selected ?? null,
    newToken: () => `tok-${++tokens}`,
    waitForOpen: async (token, ms) => {
      // ⚠ **最初の 1 回だけ**記録する ── 毎回上書きすると、
      //   「先に空振りで待ってから開く」変異が**後の呼び出しに救われて**生き延びる
      if (openedBeforeWait === null) openedBeforeWait = opened.length > 0;
      waits.push({ token, ms });
      return opts.answered ?? true;
    },
    openInPane: (v) => {
      panes.push(v);
      if (opts.editing === true) return false; // 本物と同じく断られる
      mode = v;
      return true;
    },
    fail: (m) => fails.push(m),
    notify: (m) => notices.push(m),
  };
  return {
    deps,
    opened,
    panes,
    fails,
    notices,
    waits,
    mode: () => mode,
    openedBeforeWait: () => openedBeforeWait,
  };
}

/** 差し替えの放送路。⚠ `postMessage` は**自分にも**配らない(本物と同じ)。 */
function fakeChannel(): { ch: Broadcaster; sent: unknown[]; closed: () => number; fire: (data: unknown) => void } {
  let closes = 0;
  const sent: unknown[] = [];
  const ch: Broadcaster = {
    postMessage: (d) => sent.push(d),
    close: () => {
      closes += 1;
    },
    onmessage: null,
  };
  return {
    ch,
    sent,
    closed: () => closes,
    fire: (data) => ch.onmessage?.({ data } as MessageEvent),
  };
}

describe('組み込みアプリを別窓で開く(#300 段③)', () => {
  it('🔴 窓が出たら、中央の面は 1 ミリも触らない(本文が消えない)', async () => {
    const b = bench();
    expect(await openViewInWindow('dual', b.deps)).toBe('window');
    expect(b.opened, 'ディープリンク付きで開いていない').toEqual([
      'https://xn--r8j.test/pkc/#pkc?view=dual&w=tok-1',
    ]);
    expect(b.panes, '中央の面を占有した(user の要望と正面から逆)').toEqual([]);
    expect(b.fails, '成功したのに理由を出した').toEqual([]);
  });

  /**
   * 🔴 **②:読んでいたノートを連れて行く。**
   * ⚠ 直す前の別窓は `selectedLid === null` で立ち上がり、帯に
   *   「左の一覧からノートを選んでください」と出ていた ──
   *   user は**さっきまで読んでいたノートを探し直す**ことになる。
   */
  it('🔴 読んでいたノートを連れて行く(別窓で「選んでください」にならない)', async () => {
    const b = bench({ selected: { containerId: 'c1', lid: 'e7' } });
    await openViewInWindow('dual', b.deps);
    expect(b.opened[0], 'ノートを置いてきた').toBe(
      'https://xn--r8j.test/pkc/#pkc?container=c1&entry=e7&view=dual&w=tok-1',
    );
  });

  it('⚠ 何も選んでいなければ、連れて行くものは付けない', async () => {
    const b = bench({ selected: null });
    await openViewInWindow('dual', b.deps);
    expect(b.opened[0]).toBe('https://xn--r8j.test/pkc/#pkc?view=dual&w=tok-1');
  });

  /**
   * 🔴 **別窓で開く組み込みは、いま 2 ペインだけ**(#292 段⑤、2026-08-23)。
   *
   * ⚠ カレンダー / やることの板はここから外れた ── あれは「アプリ」ではなく
   *   **ノートの見方**だったので、左の列の「予定」タブへ引っ越した。
   * 🔑 だから一覧を**名指しで書かない** ── `launch-tile.ts` が別窓へ渡す
   *   組み込みタイルを**全数**当てる(タイルを足したのにここへ足し忘れると、
   *   その組み込みだけ別窓の作法から外れたまま出荷される)。
   */
  it('🔴 別窓で開く組み込みタイルが、どれも別窓で開く', async () => {
    // 🔑 **「面の名前を持つ組み込みタイル」が別窓で開く物**である ── その規則を
    //    そのまま引く(名指しの一覧を書かない)
    const views: ViewMode[] = [];
    for (const tile of withBuiltinTiles([], { office: true })) {
      if (isViewMode(tile.kind)) views.push(tile.kind);
    }
    expect(views.length, '別窓で開く組み込みが 1 つも無い(空振り)').toBeGreaterThan(0);
    for (const view of views) {
      const b = bench();
      await openViewInWindow(view, b.deps);
      expect(b.opened, `${view} が別窓で開かない`).toEqual([
        `https://xn--r8j.test/pkc/#pkc?view=${view}&w=tok-1`,
      ]);
      expect(b.panes, `${view} が中央の面を占有した`).toEqual([]);
    }
  });

  /**
   * 🔴 **③:窓が塞がれたら退避する**(段⑤)。
   * ⚠ `noopener` は戻り値が常に `null` なので、**合図が返ったかどうか**でしか
   *   見分けられない ── だから返らなかったときが「塞がれた」である。
   */
  it('🔴 窓が塞がれたら中央の面へ退避し、理由を出す', async () => {
    const b = bench({ answered: false });
    expect(await openViewInWindow('dual', b.deps)).toBe('pane');
    expect(b.opened, '開こうとすらしていない').toHaveLength(1);
    expect(b.panes, '退避していない(押しても何も起きない)').toEqual(['dual']);
    expect(b.fails, '黙って退避した(user は窓が出ない理由を知れない)').toHaveLength(1);
    // 🔑 **次に何をすればよいか**が書いてある(「ポップアップの許可」)
    expect(b.fails[0]).toContain('ポップアップ');
    expect(b.fails[0], '開いた先を言っていない').toContain('この画面で開きました');
  });

  /**
   * 🔴 **退避は「開く」であってトグルではない**(着地前レビュー 1)。
   *
   * ⚠ 直す前は退避を `nextViewMode` に通していたので:
   *   押す(塞がれる)→ 2.5 秒無反応 → **もう一度押す** → 1 本目が開く →
   *   2 本目が**それを閉じる**、しかも「この画面で開きました」と言う。
   */
  it('🔴 塞がれた回に 2 回押しても、面は開いたままになる', async () => {
    const b = bench({ answered: false });
    await openViewInWindow('dual', b.deps);
    await openViewInWindow('dual', b.deps);
    expect(b.panes, '2 回目で閉じた(退避がトグルになっている)').toEqual([
      'dual',
      'dual',
    ]);
    expect(b.mode(), '2 回押したら本文へ戻ってしまった').toBe('dual');
  });

  /** ⚠ 既にその面を開いている(`Alt+6` 等)ときも、退避で閉じない。 */
  it('🔴 既にその面を開いていても、退避で閉じない', async () => {
    const b = bench({ answered: false, startMode: 'dual' });
    await openViewInWindow('dual', b.deps);
    expect(b.mode(), '開いていた 2 ペインが閉じた').toBe('dual');
  });

  /**
   * 🔴 **面が開かなかった回に「この画面で開きました」と言わない**
   * (着地前レビュー 6)。⚠ 編集中は `SET_VIEW_MODE` が断られるので、
   *   直す前は**どこにも開いていないのに**開いたと言っていた。
   */
  it('🔴 編集中で面が開けなかったら、文言もそう言う', async () => {
    const b = bench({ answered: false, editing: true });
    await openViewInWindow('dual', b.deps);
    expect(b.fails, '理由を出していない').toHaveLength(1);
    expect(b.fails[0], '開いていないのに「開きました」と言った').not.toContain(
      'この画面で開きました',
    );
    expect(b.fails[0], '次に何をすればよいか書いていない').toContain('編集を終えて');
  });

  /**
   * 🔴 **④:`window.open` は待つ前に撃つ。**
   * ⚠ `await` の後ろへ回すと **gesture が切れて必ず塞がれる** ── しかも
   *   「塞がれた」と見分けがつかないので、**常に中央の面へ退避する**ようになる。
   * 🔑 観測点は「**同期に撃ったか**」である ── `waitForOpen` を呼んだ時点で
   *   見ると、`open` の直前に `await` を 1 つ挟む変異が生き延びる。
   */
  it('🔴 gesture の中で撃つ(await の後ろへ落ちていない)', async () => {
    const b = bench();
    const p = openViewInWindow('dual', b.deps);
    expect(b.opened, 'await をまたいでから開いている(Safari で塞がれる)').toHaveLength(1);
    await p;
  });

  /** ⚠ 聞く耳は**開くより前**に張る(速い窓の合図を取りこぼさない)。 */
  it('🔴 合図を待ち始めてから窓を開く(取りこぼさない)', async () => {
    const b = bench();
    await openViewInWindow('dual', b.deps);
    expect(b.openedBeforeWait(), '開いてから待ち始めている(合図を取りこぼす)').toBe(false);
  });

  /**
   * 🔴 **⑤:待つ猶予は定数のまま渡す。**
   * ⚠ ここを見ないと、`250_000` を渡す変異が全部緑で通る ──
   *   塞がれた user は**4 分間まったくの無反応**になる。
   */
  it('🔴 待つ猶予は VIEW_WINDOW_ANNOUNCE_MS(勝手に延ばさない)', async () => {
    const b = bench();
    await openViewInWindow('dual', b.deps);
    expect(b.waits).toEqual([{ token: 'tok-1', ms: VIEW_WINDOW_ANNOUNCE_MS }]);
    // 🔑 URL に載せた合図と、待っている合図が**同じ**であること
    expect(b.opened[0]).toContain('w=tok-1');
  });

  /**
   * ⚠ アドレスが組めないとき(base に `#` が残っている)も**黙って本文で開かない**。
   * 🔑 `currentBaseUrl` が断片を落とすので普通は起きないが、
   *   落とし忘れた日に**無言の dead click** にならないよう、口を閉じておく。
   */
  it('⚠ アドレスが組めないときも、理由を出してから退避する', async () => {
    const b = bench({ base: 'https://xn--r8j.test/pkc/#some-heading' });
    expect(await openViewInWindow('dual', b.deps)).toBe('pane');
    expect(b.opened, '組めていないのに開こうとした').toEqual([]);
    expect(b.panes).toEqual(['dual']);
    expect(b.fails, '黙って退避した').toHaveLength(1);
  });

  /** ⚠ 窓は使い回さない(#300 段③ の裁定)── 2 回押したら 2 枚開く。 */
  it('⚠ 同じタイルを 2 回押すと 2 枚開く(使い回さない)', async () => {
    const b = bench();
    await openViewInWindow('dual', b.deps);
    await openViewInWindow('dual', b.deps);
    expect(b.opened).toHaveLength(2);
    // ⚠ 合図は 1 回限り ── 使い回すと 1 枚目の返事で 2 枚目を「開いた」と読む
    expect(new Set(b.opened).size, '合図を使い回している').toBe(2);
    expect(b.panes).toEqual([]);
  });

  /** ⚠ 撃つ先を広げていないこと。 */
  it('⚠ 成功した回は fail も openInPane も呼ばない', async () => {
    const openInPane = vi.fn(() => true);
    const fail = vi.fn();
    await openViewInWindow('dual', {
      open: () => {},
      baseUrl: () => 'https://xn--r8j.test/',
      selected: () => null,
      newToken: () => 'tok',
      waitForOpen: async () => true,
      openInPane,
      fail,
    });
    expect(openInPane).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 **合図のやり取り**(#300 段③ の直し)。
 *
 * ⚠ 直す前ここは **test が 1 件も無く**、しかも「PKC が起動時に撒く名乗りを聞く」
 * という**誤爆する**やり方だった(着地前レビュー 3 / 5)。
 */
describe('窓が出たかは「自分が渡した合図」で判定する', () => {
  it('🔴 自分の合図が返ったら true', async () => {
    const f = fakeChannel();
    const p = waitForViewWindow('tok-1', 50, () => f.ch);
    f.fire({ kind: VIEW_WINDOW_OPEN, token: 'tok-1' });
    expect(await p).toBe(true);
    expect(f.closed(), '放送路を閉じていない(押すたびに 1 本積む)').toBe(1);
  });

  /** 🔴 **別の窓の合図では真にしない** ── 2 枚同時に押したときの取り違え防止。 */
  it('🔴 別の合図では真にしない(時間切れになる)', async () => {
    const f = fakeChannel();
    const p = waitForViewWindow('tok-1', 20, () => f.ch);
    f.fire({ kind: VIEW_WINDOW_OPEN, token: 'tok-2' });
    expect(await p, '他人の合図で「開いた」と読んだ').toBe(false);
  });

  /**
   * 🔴 **store の放送では真にしない。**
   * ⚠ 直す前は `hello` / `holder-here` を聞いていたので、
   *   ⑴ 別のタブの起動 ⑵ その返答 ⑶ **自タブの昇格**
   *   ⑷ **待機画面の 2 秒ごとの再接続** で誤爆した。
   */
  it('🔴 別の種類の便りでは真にしない', async () => {
    const f = fakeChannel();
    const p = waitForViewWindow('tok-1', 20, () => f.ch);
    f.fire({ kind: 'hello', from: 'tab-9' });
    f.fire({ kind: 'holder-here', holder: 'tab-9' });
    f.fire({ kind: 'changed', origin: 'tab-9' });
    f.fire(null);
    expect(await p, 'store の放送で「開いた」と読んだ').toBe(false);
  });

  it('⚠ 時間切れなら false(そのとき初めて退避する)', async () => {
    const f = fakeChannel();
    expect(await waitForViewWindow('tok-1', 10, () => f.ch)).toBe(false);
    expect(f.closed(), '時間切れでも放送路を閉じる').toBe(1);
  });

  /**
   * 🔴 **開いた窓が、起動のいちばん最初に返す。**
   * ⚠ 種別を載せる ── 載せないと、この路に別の便りが乗った日に取り違える。
   */
  it('🔴 開いた窓は合図をそのまま返し、路を閉じる', () => {
    const f = fakeChannel();
    announceViewWindow('tok-9', () => f.ch);
    expect(f.sent).toEqual([{ kind: VIEW_WINDOW_OPEN, token: 'tok-9' }]);
    expect(f.closed()).toBe(1);
  });

  it('⚠ 路の名前は 1 つ(開く側と返す側で食い違わない)', () => {
    const names: string[] = [];
    const f = fakeChannel();
    const make = (n: string): Broadcaster => {
      names.push(n);
      return f.ch;
    };
    void waitForViewWindow('t', 5, make);
    announceViewWindow('t', make);
    expect(new Set(names)).toEqual(new Set([VIEW_WINDOW_CHANNEL]));
  });
});

/**
 * 🔴 **アプリの窓の `× 閉じる` は窓ごと閉じる**(動線レビュー §7)。
 *
 * ⚠ 直す前は `SET_VIEW_MODE 'detail'` が飛ぶだけで、**窓は残り、そこに本文が
 * 出た** ── user から見ると「アプリを閉じたら PKC がもう 1 つ増えた」である。
 */
describe('アプリの窓の × 閉じる', () => {
  it('🔴 断片を握っている窓は、窓ごと閉じる', () => {
    const close = vi.fn();
    expect(
      closeViewWindow({ holding: () => true, close, isClosed: () => true }),
    ).toBe('closed');
    expect(close).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **ふつうの窓では閉じない。**
   * ⚠ 面から離れた窓(user が `Alt+1` で本文へ行った後)は、もう**ふつうの PKC**
   *   である ── そこで窓を閉じたら、本文の作業ごと失う。
   */
  it('🔴 断片から離れた窓では、窓に触らない', () => {
    const close = vi.fn();
    expect(
      closeViewWindow({ holding: () => false, close, isClosed: () => true }),
    ).toBe('not-a-window');
    expect(close, 'ふつうの窓を閉じた(本文の作業ごと消える)').not.toHaveBeenCalled();
  });

  /**
   * 🔴 **閉じられなかったら「閉じた」と言わない。**
   * ⚠ user がブックマークから開いた窓は script では閉じられない(実測。
   *   `view-window.ts` の表)── そのときは理由を出して本文へ畳む。
   */
  it('🔴 閉じられなかったら refused(黙って何もしない、にしない)', () => {
    expect(
      closeViewWindow({ holding: () => true, close: () => {}, isClosed: () => false }),
    ).toBe('refused');
    expect(CLOSE_VIEW_WINDOW_REFUSED, '次に何をすればよいか書いていない').toContain('× で閉じてください');
  });
});

/**
 * 🔴 **付箋の窓 ── 面ではなく「そのノート」を開く**(#685 段②、2026-09-04)。
 *
 * > 「**マルチで付箋開けるといいかもね**」(利用者の感想 2026-09-04)
 *
 * ⚠ **同じ仕掛けに乗せる**(合図 / 退避 / `noopener`)── 2 か所に別々の
 *   「窓を開く作法」を作らない(CLAUDE.md §7)。違うのは 2 点だけ:
 *   ① URL に `view=` を載せない ② **退避先が無い**(そのノートはもう画面に在る)。
 */
describe('付箋の窓(view を指さない)', () => {
  it('🔴 読んでいたノートを載せた、面を指さない URL で開く', async () => {
    const b = bench({ selected: { containerId: 'c1', lid: 'e1' } });
    const where = await openViewInWindow(null, b.deps);
    expect(where, '窓で開いていない').toBe('window');
    expect(b.opened, '開いた URL が 1 つではない').toHaveLength(1);
    const url = b.opened[0]!;
    expect(url, 'ノートを連れて行っていない').toContain('container=c1&entry=e1');
    expect(url, '面を指している(付箋なのに面が開く)').not.toContain('view=');
    expect(url, '合図が載っていない(開いたか分からない)').toMatch(/[?&]w=/);
  });

  /**
   * 🔴 **中央の面を触らない**(面のときと同じ ── user 要望の本体)。
   */
  it('🔴 開けたら中央の面を触らない', async () => {
    const b = bench({ selected: { containerId: 'c1', lid: 'e1' } });
    await openViewInWindow(null, b.deps);
    expect(b.panes, '面を動かした(本文が消える)').toEqual([]);
    expect(b.fails, '開けたのに理由を出した').toEqual([]);
  });

  /**
   * 🔴 **塞がれたら、理由を出すだけ**(#685 段②)。
   *
   * ⚠ 面のときは「中央の面で開きました」と退避できるが、付箋が開こうとして
   *   いるのは**いま読んでいるそのノート**である ── **もう画面に出ている**ので
   *   退避先が無い。🔑 「この画面で開きました」と言うと**嘘**になる。
   */
  it('🔴 塞がれたら理由だけ出す(面へ退避しない・嘘を言わない)', async () => {
    const b = bench({ answered: false, selected: { containerId: 'c1', lid: 'e1' } });
    const where = await openViewInWindow(null, b.deps);
    expect(where, '面へ退避した(付箋に退避先は無い)').toBe('pane');
    expect(b.panes, '面を動かした').toEqual([]);
    expect(b.fails, '理由を出していない').toHaveLength(1);
    expect(b.fails[0], 'ポップアップの許可に触れていない').toContain('ポップアップ');
    expect(b.fails[0], '開いてもいないのに「この画面で開きました」と言っている').not.toContain(
      'この画面で開きました',
    );
  });

  /**
   * 🔴 **ノートが無ければ開かない**(対照群)。⚠ 組めてしまうと、開いた窓は
   *   **何も選ばずに立ち上がる**(付箋のつもりが空の PKC になる)。
   */
  it('🔴 ノートを選んでいなければ、窓を開かずに理由を出す', async () => {
    const b = bench({ selected: null });
    const where = await openViewInWindow(null, b.deps);
    expect(where, '窓を開いてしまった').toBe('pane');
    expect(b.opened, '行き先の無い窓を開いた').toEqual([]);
    expect(b.fails, '理由を出していない').toHaveLength(1);
  });

  /**
   * ⚠ **対照群 ── 面のときは今までどおり退避する**(片方だけ直していない)。
   */
  it('⚠ 面のときは、塞がれたら中央の面で開く', async () => {
    const b = bench({ answered: false });
    const where = await openViewInWindow('dual', b.deps);
    expect(where).toBe('pane');
    expect(b.panes, '面へ退避していない').toEqual(['dual']);
    expect(b.fails[0], '「この画面で開きました」と言っていない').toContain('この画面で開きました');
  });
});

/**
 * 🔴 **`noopener` で開くこと自体を守る**(#685 着地前レビュー M2、2026-09-04)。
 *
 * ⚠ 直す前、`tests/` に `noopener` は **1 件も無かった**(probe だけ ── あれは
 *   CI で走らない)。開き方は `main.ts` の 2 か所に手で書かれていたので、
 *   **片方から落としても全 test が緑**だった。
 * 🔴 落ちたときの症状は**いちばん気づけない形**である ── 窓は開くので画面は
 *   正しく見え、変わるのは「**閉じても常駐が還らない**」ことだけ
 *   (この file 冒頭の実測表:−32.2 MB → **−4.6 MB**)。
 *   マニュアルの「閉じたぶんのメモリも戻ります」が静かに嘘になる。
 */
describe('別窓の開き方(#685 着地前レビュー M2)', () => {
  it('🔴 `noopener` を渡して開く', () => {
    const calls: Array<[string, string, string | undefined]> = [];
    const spy = vi
      .spyOn(window, 'open')
      .mockImplementation((url?: string | URL, name?: string, features?: string) => {
        calls.push([String(url), String(name), features]);
        return null;
      });
    try {
      openViewWindowUrl('https://example.test/#pkc?container=c1&entry=e1');
    } finally {
      spy.mockRestore();
    }
    expect(calls, '窓を開いていない').toHaveLength(1);
    expect(calls[0]![0]).toBe('https://example.test/#pkc?container=c1&entry=e1');
    expect(calls[0]![1], '別窓ではなく同じ場所へ開いている').toBe('_blank');
    expect(
      calls[0]![2],
      '`noopener` が落ちている ── 同じ renderer プロセスに残り、閉じても常駐が還らない',
    ).toBe('noopener');
  });

  /** ⚠ **値そのものも pin する** ── 呼び側 2 つが同じ物を使うことの錨。 */
  it('⚠ 開き方の値は 1 か所に在る', () => {
    expect(VIEW_WINDOW_FEATURES).toBe('noopener');
  });
});

/**
 * 🔴 **押した瞬間に返事をする**(#685 動線レビュー 欠陥 7、2026-09-04)。
 *
 * ⚠ 直す前は、押してから **2.5 秒**(`VIEW_WINDOW_ANNOUNCE_MS`)画面が
 *   1 ドットも動かなかった。ポップアップを止めている人には「効いていない」に
 *   見えるので**もう一度押す** ⇒ 許可を出した後に**2 枚開く**。
 * ⚠ 付箋には退避先が無いので、失敗した回に残るのは**無反応 2.5 秒だけ**である。
 */
describe('押した瞬間の返事(#685 動線レビュー 欠陥 7)', () => {
  it('🔴 押したら「開いています…」が出て、開けたら消える', async () => {
    const b = bench({ answered: true });
    await openViewInWindow(null, { ...b.deps, selected: () => ({ containerId: 'c1', lid: 'e1' }) });
    expect(b.notices, '押しても何も出ない(2.5 秒の無反応に戻っている)').toEqual([
      VIEW_WINDOW_OPENING,
      '',
    ]);
  });

  /**
   * 🔴 **塞がれた回も消す** ── 理由(`fail`)は別の行に出るので、
   *   「開いています…」を残すと**2 つの文が並んで矛盾する**。
   */
  it('🔴 塞がれたら「開いています…」を消して、理由に譲る', async () => {
    const b = bench({ answered: false });
    await openViewInWindow(null, { ...b.deps, selected: () => ({ containerId: 'c1', lid: 'e1' }) });
    expect(b.notices.at(-1), '「開いています…」が出たまま理由が出ている').toBe('');
    expect(b.fails[0], '理由が出ていない').toContain('ポップアップの許可');
  });

  /** ⚠ **面の窓でも同じ** ── 無反応 2.5 秒は付箋だけの話ではない。 */
  it('⚠ 面を別窓で開くときも返事をする', async () => {
    const b = bench({ answered: true });
    await openViewInWindow('dual', b.deps);
    expect(b.notices).toEqual([VIEW_WINDOW_OPENING, '']);
  });

  /** ⚠ **URL が組めなかった回は出さない** ── 開こうとしていないので「開いています」は嘘。 */
  it('⚠ 組めなかった回は「開いています…」を出さない', async () => {
    const b = bench({ base: 'https://x.test/#already' });
    await openViewInWindow(null, b.deps);
    expect(b.opened, '前提が崩れた(組めているのに開いていない)').toEqual([]);
    expect(b.notices, '開いていないのに「開いています…」と言った').toEqual([]);
  });
});
