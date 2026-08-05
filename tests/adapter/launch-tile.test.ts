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
import { launchTile, EXTERNAL_WINDOW_FEATURES } from '../../src/adapter/ui/launch-tile';
import { LAUNCHER_APP_SANDBOX } from '../../src/features/launcher/app-shell';
import type { LauncherTile } from '../../src/features/launcher/tiles';

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
      origin: 'http://x.test',
      readSeed: (appId) => {
        seedFor.push(appId);
        return opts.seed ?? {};
      },
      fail: (m) => failures.push(m),
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
  it('🔴 確認が false を返したら **窓すら開けない**(fail closed)', () => {
    const h = harness('<p>x</p>');
    const asked: string[] = [];
    h.deps.confirmSameOrigin = (title) => {
      asked.push(title);
      return false;
    };
    launchTile(appTile, h.deps, { sameOrigin: true });
    // ⚠ 聞いたことと、**開いていないこと**の両方を見る ── 断ったのに空のタブが
    //    残る実装(window.open のあとで聞く形)を落とす
    expect(asked).toEqual(['見積ツール']);
    expect(h.opened).toEqual([]);
    expect(h.created).toEqual([]);
  });

  it('🔴 囲いの中で開くときは **確認しない**', async () => {
    const h = harness('<p>x</p>');
    let asked = 0;
    h.deps.confirmSameOrigin = () => {
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
      h.deps.confirmSameOrigin = () => true;
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
      h.deps.confirmSameOrigin = () => true;
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
