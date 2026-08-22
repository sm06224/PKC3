/** @vitest-environment node */
/**
 * P7b review H-1 / M-5 / M-6 / M-8: ランチャーの**起動の作法**。
 *
 * 🔴 ここは変異試験で 2 件生き残った場所である ──
 * `noopener,noreferrer` を消しても、`dispose` を丸ごと消しても、
 * unit 1089 件 + smoke 24 件が全部 green だった。どちらも user への約束
 * (マニュアルの「参照を渡していません」/ 不可侵指示「ライフサイクル終端での
 * 即破棄」)なので、**依存を注入して直接見る**。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { launchTile, EXTERNAL_WINDOW_FEATURES } from '../../src/adapter/ui/launch-tile';
import { LAUNCHER_APP_SANDBOX } from '../../src/features/launcher/app-shell';
import { officeTile, type LauncherTile } from '../../src/features/launcher/tiles';

interface FakeWin {
  closed: boolean;
  opener: unknown;
  location: { replace: (url: string) => void; href: string };
  close: () => void;
}

function fakeWindow(): FakeWin {
  const win: FakeWin = {
    closed: false,
    opener: {},
    location: {
      href: '',
      replace(url: string) {
        win.location.href = url;
      },
    },
    close() {
      win.closed = true;
    },
  };
  return win;
}

interface Harness {
  opened: Array<{ url: string; features: string }>;
  created: string[];
  revoked: string[];
  failures: string[];
  win: FakeWin;
  /** `readSeed` に渡った appId(P8 段⑭ の観測点)。 */
  seedFor: string[];
  /** `openOffice` が呼ばれた回数(#148 の観測点)。 */
  officeOpens: { n: number };
  /** `openDual` が呼ばれた回数(#241 の観測点)。 */
  dualOpens: { n: number };
  /** ⚠ どの面へ切り替えたか(#276 で口が 1 本になった)。 */
  viewOpens: string[];
  closeWindow: () => void;
  deps: Parameters<typeof launchTile>[1];
}

function harness(
  body: string | null,
  opts: { blocked?: boolean; seed?: Record<string, string> } = {},
): Harness {
  const opened: Array<{ url: string; features: string }> = [];
  const created: string[] = [];
  const revoked: string[] = [];
  const failures: string[] = [];
  const seedFor: string[] = [];
  const officeOpens = { n: 0 };
  const dualOpens = { n: 0 };
  const viewOpens: string[] = [];
  const win = fakeWindow();
  let release: (() => void) | null = null;
  let seq = 0;
  const h: Harness = {
    opened,
    created,
    revoked,
    failures,
    win,
    seedFor,
    officeOpens,
    dualOpens,
    viewOpens,
    closeWindow: () => {
      win.closed = true;
      release?.();
    },
    deps: {
      readBlob: (key) =>
        Promise.resolve(body === null ? null : new Blob([body + key], { type: 'text/html' })),
      open: (url, features) => {
        opened.push({ url, features });
        return opts.blocked === true ? null : (win as unknown as Window);
      },
      createUrl: (blob) => {
        created.push(blob.type);
        return `blob:fake-${++seq}`;
      },
      revokeUrl: (url) => revoked.push(url),
      whenClosed: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      baseUrl: 'http://x.test/',
      readSeed: (appId) => {
        seedFor.push(appId);
        return opts.seed ?? {};
      },
      fail: (m) => failures.push(m),
      openOffice: () => {
        officeOpens.n += 1;
      },
      openView: (view) => {
        viewOpens.push(view);
        if (view === 'dual') dualOpens.n += 1;
      },
    },
  };
  return h;
}

const appTile: LauncherTile = {
  lid: 'a1',
  title: '見積ツール',
  group: '',
  kind: 'app',
  assetKey: 'ast-1',
  mime: 'text/html',
};

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe('タイルの起動', () => {
  it('🔴 外部 URL は **opener も referrer も渡さない**', () => {
    const h = harness(null);
    launchTile(
      { lid: 'u1', title: 'サイト', group: '', kind: 'url', url: 'https://example.com/x' },
      h.deps,
    );
    expect(h.opened).toEqual([
      { url: 'https://example.com/x', features: 'noopener,noreferrer' },
    ]);
    // 文言そのものが約束 ── 定数の側も固定する
    expect(EXTERNAL_WINDOW_FEATURES).toBe('noopener,noreferrer');
  });

  it('🔴 取り込んだ HTML は **隔離した外殻**に載せて開く(同じ origin で走らせない)', async () => {
    const h = harness('<script>parent.steal()</scr' + 'ipt>');
    const blobs: Blob[] = [];
    h.deps.createUrl = (b) => {
      blobs.push(b);
      return 'blob:shell';
    };
    launchTile(appTile, h.deps);
    await settle();
    expect(blobs).toHaveLength(1);
    const html = await blobs[0]!.text();
    // ⚠ **sandbox が付いていること**と、**`allow-same-origin` が無いこと**は
    // 別の主張である(前者だけ見ると、後で権限を足されても気づかない)
    expect(html).toContain(`sandbox="${LAUNCHER_APP_SANDBOX}"`);
    expect(html).not.toContain('allow-same-origin');
    // 添付の中身は **srcdoc の中に escape されて**入る(素の script として出ない)
    expect(html).toContain('srcdoc="');
    expect(html).not.toContain('<script>parent.steal()');
    expect(html).toContain('&lt;script&gt;');
    expect(blobs[0]!.type).toBe('text/html');
    // 開いたのは外殻であって、添付そのものではない
    expect(h.win.location.href).toBe('blob:shell');
  });

  it('🔴 開いた先から `window.opener` で本体を触れない', async () => {
    const h = harness('<p>hi</p>');
    launchTile(appTile, h.deps);
    expect(h.win.opener).toBeNull(); // ⚠ **await の前に**切れている
    await settle();
  });

  it('🔴 blob は **タブが閉じるまで生きて、閉じたら捨てる**', async () => {
    const h = harness('<p>hi</p>');
    launchTile(appTile, h.deps);
    await settle();
    expect(h.created).toHaveLength(1);
    // まだ開いている ── ここで revoke すると再読込で `ERR_FILE_NOT_FOUND` になる
    expect(h.revoked).toEqual([]);
    h.closeWindow();
    await settle();
    expect(h.revoked).toEqual(['blob:fake-1']);
  });

  it('🔴 ポップアップが塞がれたら **黙って終わらない**', () => {
    const h = harness('<p>hi</p>', { blocked: true });
    launchTile(appTile, h.deps);
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toContain('ポップアップ');
  });

  it('中身が消えていたら窓を閉じて知らせる', async () => {
    const h = harness(null);
    launchTile(appTile, h.deps);
    await settle();
    expect(h.win.closed).toBe(true);
    expect(h.failures[0]).toContain('見つかりません');
    expect(h.created).toEqual([]);
  });

  it('⚠ 窓は **await より前に**開く(gesture を切らさない)', () => {
    const h = harness('<p>hi</p>');
    launchTile(appTile, h.deps);
    // await を 1 度も回していない時点で open 済み
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]!.features).toBe(''); // ⚠ noopener を付けると null が返る
  });

  it('assetKey が無いタイルは何も開かない', () => {
    const h = harness('<p>hi</p>');
    launchTile({ lid: 'x', title: 'x', group: '', kind: 'app' }, h.deps);
    expect(h.opened).toEqual([]);
  });
});

/**
 * 🔴 **素のまま(同一オリジン)で開く**(P10、user 指示 2026-08-05
 * 「同一ドメインで動かしたい HTML アセットが javascript が動かなくて死ぬ」)。
 *
 * 診断: JS は動いていた。死因は**不透明オリジン**で、`indexedDB.open()` /
 * `document.cookie` / `caches` が**プロパティを読むだけで同期に throw** する ──
 * `try/catch` の無い普通のアプリは 1 行目で止まって真っ白になる。
 *
 * ⚠ ここで見るのは「開いた」ではなく **判断の作法**である:
 * 確認を通らなければ開かない / 素のままでは shim を入れない / 既定は今のまま。
 */
describe('素のまま起動(P10)', () => {
  /**
   * 🔴 **`await` を忘れると、この検査は何も見なくなる**(#299 段⑤。着地前レビュー R1)。
   *
   * ⚠ 段③ で `launchTile` が `async` になり、`confirmSameOrigin` の `await` が
   *   `deps.open` **より前**に来た ── つまり同期の `it` から呼ぶと、assert の時点では
   *   答えが `true` でも `false` でも `h.opened` は必ず `[]` である。
   *   **12 時間ほど、この fail closed は空振りだった。**
   * 🔑 だから **`await` する**うえに、**対照群(`true` なら 1 枚開く)を同じ it に置く** ──
   *   置かないと「await を足したのに、別の理由で空だった」を次に見抜けない。
   */
  it('🔴 確認が false を返したら **窓すら開けない**(fail closed)', async () => {
    const no = harness('<p>x</p>');
    const asked: string[] = [];
    no.deps.confirmSameOrigin = async (title) => {
      asked.push(title);
      return false;
    };
    await launchTile(appTile, no.deps, { sameOrigin: true });
    // ⚠ 聞いたことと、**開いていないこと**の両方を見る ── 断ったのに空のタブが
    //    残る実装(window.open のあとで聞く形)を落とす
    expect(asked).toEqual(['見積ツール']);
    expect(no.opened, '断ったのに開いた(同一オリジン = 保存領域に手が届く)').toEqual([]);
    expect(no.created).toEqual([]);

    // 🔑 対照群 ── 承諾したら**実際に 1 枚開く**(空振りなら、こちらも空になる)
    const yes = harness('<p>x</p>');
    yes.deps.confirmSameOrigin = async () => true;
    await launchTile(appTile, yes.deps, { sameOrigin: true });
    expect(yes.opened, '対照群が届いていない ── 上の空は検査になっていない').toHaveLength(1);
  });

  it('🔴 囲いの中で開くときは **確認しない**', async () => {
    const h = harness('<p>x</p>');
    let asked = 0;
    h.deps.confirmSameOrigin = async () => {
      asked += 1;
      return true;
    };
    launchTile(appTile, h.deps);
    await settle();
    expect(asked, '囲いの中なのに確認している').toBe(0);
    expect(h.opened).toHaveLength(1);
  });

  it('🔴 素のままの外殻には allow-same-origin が入り、囲いの中には入らない', async () => {
    const shellFor = async (sameOrigin: boolean): Promise<string> => {
      const h = harness('<p>x</p>');
      const blobs: Blob[] = [];
      h.deps.createUrl = (b) => {
        blobs.push(b);
        return 'blob:shell';
      };
      h.deps.confirmSameOrigin = async () => true;
      launchTile(appTile, h.deps, { sameOrigin });
      await settle();
      expect(blobs).toHaveLength(1);
      return blobs[0]!.text();
    };

    const raw = await shellFor(true);
    expect(raw, '素のままなのに同一オリジンになっていない').toContain('allow-same-origin');
    expect(raw).toContain('data-pkc-launcher-mode="same-origin"');

    const boxed = await shellFor(false);
    // ⚠ **逆向きも見る** ── 既定が素のままに変わる退行を落とす
    expect(boxed, '既定が同一オリジンになっている').not.toContain('allow-same-origin');
    expect(boxed).toContain('data-pkc-launcher-mode="sandboxed"');
    expect(boxed).toContain(LAUNCHER_APP_SANDBOX);
  });

  it('🔴 素のままでは保管庫の shim を入れない(本物が生きているから)', async () => {
    const shellFor = async (sameOrigin: boolean): Promise<string> => {
      const h = harness('<p>x</p>', { seed: { memo: 'あ' } });
      const blobs: Blob[] = [];
      h.deps.createUrl = (b) => {
        blobs.push(b);
        return 'blob:shell';
      };
      h.deps.confirmSameOrigin = async () => true;
      launchTile(appTile, h.deps, { sameOrigin });
      await settle();
      return blobs[0]!.text();
    };
    const raw = await shellFor(true);
    const boxed = await shellFor(false);
    // 囲いの中では貸す(= shim が入る)。⚠ この対照が無いと「shim が無い」だけでは
    //    「shim の仕組みが壊れた」と区別できない
    expect(boxed, '囲いの中で shim が入っていない(対照が崩れている)').toContain(
      'localStorage',
    );
    expect(raw, '素のままなのに shim を入れている').not.toContain(
      "Object.defineProperty(window, 'localStorage'",
    );
  });
});

describe('組み込み Office タイル (#148)', () => {
  it('openOffice を 1 回呼び、窓もブロブも自分では触らない', () => {
    const h = harness(null);
    launchTile(officeTile(), h.deps);
    expect(h.officeOpens.n).toBe(1);
    // ⚠ 窓の生成・使い回しは OfficeWindow の責務 ── ここで window.open すると
    //    既に開いている Office と別に 2 つ目の窓が生える
    expect(h.opened).toHaveLength(0);
    expect(h.created).toHaveLength(0);
    expect(h.failures).toHaveLength(0);
  });

  it('app / url のタイルでは openOffice を呼ばない(対称の反対側)', async () => {
    const h = harness('<p>hi</p>');
    launchTile(appTile, h.deps);
    await settle();
    launchTile(
      { lid: 'u1', title: 'サイト', group: '', kind: 'url', url: 'https://example.com/x' },
      h.deps,
    );
    expect(h.officeOpens.n).toBe(0);
  });
});

/**
 * 🔴 **`main.ts` は原文でしか pin できない**(弱いと自覚して使う)── #174:
 * 既存窓への focus-request は無反応に見える(レポート #11)ので一言を出す。
 */
describe('main.ts の配線(原文 pin ── #174)', () => {
  /**
   * ⚠ **コメントを落としてから見る**(2026-08-19 のレビュー W-11)。
   * 「**在る**」ことを主張する検査に生テキストを使うと、**解説コメントに
   * 同じ字を書いた瞬間に、配線を落としても緑になる**(この repo が 5 回踏んだ型)。
   * ⚠ 落とし過ぎの空振り防止に、落とした後も本文が十分残っていることを見る。
   */
  const MAIN = readFileSync('src/main.ts', 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  it('既存窓へ focus したとき「既に開いています」を出す', () => {
    expect(MAIN).toContain("if (r.kind === 'already-open')");
    expect(MAIN).toContain('Office は既に開いています(そのタブをご覧ください)');
  });

  /**
   * 🔴 **組み込みタイルは「もう一度押したら本文へ戻る」**(#277 段②-b)。
   *
   * ⚠ 直す前は `SET_VIEW_MODE` を素で投げていたので、カンバン / カレンダー /
   *   2 ペインは**開いたボタンをもう一度押しても閉じなかった**(上の帯の
   *   `set-view` にはその規約が在ったのに、タイルだけ素通りしていた)。
   * ⚠ **2026-08-20 に前提が変わった** ── かつてここには「左の探し方のタブを押せば
   *   `setBrowse` が本文へ戻す」と書いてあった(当時は事実)。しかし**その一律の
   *   畳みがカレンダーの閉ループの正体**だったので、`setBrowse` は `isAsidePane`
   *   だけを畳む形へ直した。よって **カレンダー / カンバン / 集計では、タブを押しても
   *   もう帰れない** ── 帰り道はこの規則(タイルの再押下)と `Alt+1` の 2 本である。
   * ⚠ この配線は `main.ts` に在るので原文でしか pin できない。**規則そのもの**は
   *   `nextViewMode` の unit(`tests/adapter/state.test.ts`)が守る ── ここは
   *   「main.ts がその関数を通しているか」だけを見る(弱いと自覚して使う)。
   */
  it('⚠ コメントを落としても本文が残っている(空振り防止)', () => {
    expect(MAIN.length, 'コメントを落としすぎて本文が消えた').toBeGreaterThan(20_000);
    expect(MAIN, '配線が読めていない').toContain('dispatcher.dispatch');
  });

  /**
   * 🔴 **組み込みタイルは別窓を開く**(#300 段③、2026-08-22 に主張を書き換えた)。
   *
   * ⚠ 直す前の主張は「`nextViewMode` を通る(もう一度押すと戻る)」だった ──
   *   それは**中央の面を占有していた頃**の話である。user 指摘
   *   「メインの PKC の機能を阻害する方向で PKC のセンターペインを占有するな」で
   *   **仕様の側が不合格**になったので、pin もそれに合わせて書き換える。
   * 🔑 いまの主張は「**タイルの押下は `openViewTile`(別窓)へ行く**」。
   *   `nextViewMode` は**退避先**(窓が塞がれたときだけ通る中央の面)に残っている。
   */
  it('🔴 組み込みタイルの押下が別窓へ行く(中央の面を占有しない)', () => {
    const opens = [...MAIN.matchAll(/openView: \(view\) => void openViewTile\(/g)].length;
    expect(opens, 'タイルが別窓へ行っていない(中央の面を占有する)').toBe(2);
    /**
     * 🔴 **退避は「開く」であってトグルではない**(着地前レビュー 1、2026-08-22)。
     *
     * ⚠ 直す前ここは `openInPane: (v) => openView(dispatcher, nextViewMode(` を
     *   **等値で pin** していた ── つまり **不具合のほうを固定していた**。
     *   `nextViewMode` は「タイル再押下で閉じる」ための規則なので、退避に通すと:
     *   押す(塞がれる)→ 2.5 秒無反応 → もう一度押す → 1 本目が開く →
     *   **2 本目がそれを閉じる**(しかも「この画面で開きました」と言う)。
     * 🔑 いまの主張は「**退避に `nextViewMode` を通さない**」である。
     *   ⚠ 振る舞いのほうは `tests/adapter/view-window.test.ts` が見ている
     *   (ここは原文 pin なので、**弱いと自覚して**使う)。
     */
    expect(
      MAIN.includes('openInPane: (v) => openView(dispatcher, v)'),
      '退避が「開く」になっていない',
    ).toBe(true);
    expect(
      MAIN.includes('openInPane: (v) => openView(dispatcher, nextViewMode('),
      '退避がトグルに戻っている(2 回押すと開いた面が閉じる)',
    ).toBe(false);
  });

  /**
   * 🔴 **組み込みの 3 つは、どれも別窓の口へ行く**(着地前レビュー 2、2026-08-22)。
   *
   * ⚠ 直す前、`calendar` / `kanban` のタイルを `launchTile` に渡す unit は
   *   **0 件**だった(`harness` は `viewOpens` を作っていたのに、どの `it` からも
   *   assert していなかった)。⚠ smoke も押すのをやめていたので、
   *   `if (tile.kind === 'dual' || tile.kind === 'calendar')` と削る変異は
   *   **全部緑のまま**通る ── `kanbanTile()` は `assetKey` を持たないので
   *   下の `if (tile.assetKey === undefined) return;` に落ちて**無言で return**、
   *   「やることの板」が**完全な dead click** になる。
   */
  it('🔴 組み込みの 3 つは、どれも別窓の口(openView)へ行く', () => {
    for (const kind of ['dual', 'calendar', 'kanban'] as const) {
      const h = harness(null);
      void launchTile({ lid: `builtin:${kind}`, title: kind, group: '', kind }, h.deps);
      expect(h.viewOpens, `${kind} が別窓の口へ行かない(無言の dead click)`).toEqual([kind]);
      expect(h.opened, 'ここで直に窓を開いてはいけない(判断は view-window)').toEqual([]);
      expect(h.failures, `${kind} で理由が出た`).toEqual([]);
    }
  });

  /**
   * 🔴 **組み込みは `await` をまたがずに口を叩く**(着地前レビュー 4)。
   * ⚠ `window.open` は gesture の中でしか通らない ── 1 マイクロタスクでも
   *   遅れると Safari は塞ぐ(Chromium は猶予に救われるので**手元では露見しない**)。
   */
  it('🔴 組み込みタイルは同期に口を叩く(gesture を切らない)', () => {
    const h = harness(null);
    void launchTile({ lid: 'builtin:calendar', title: 'c', group: '', kind: 'calendar' }, h.deps);
    expect(h.viewOpens, 'await をまたいでから開いている(Safari で塞がれる)').toEqual([
      'calendar',
    ]);
  });
});
