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
