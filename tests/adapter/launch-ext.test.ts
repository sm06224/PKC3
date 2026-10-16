/** @vitest-environment node */
/**
 * 🔴 **アプリを起動するときの「拡張の口」── 入口が 2 つ(詳細 / 一覧のタイル)で同じ配線**(L2 / L3)。
 *
 * 守る主張:
 * 1. 🔴 **許可済みのアプリは、一覧のタイルから開いても港が繋がる**(直す前は詳細からだけだった)
 * 2. 🔴 **タイルは許可を新しく出さない**(許可が無ければ繋がず、聞きもしない)
 * 3. 🔴 **`main.ts` の 2 つの入口がどちらも同じ組み立て口を通っている**(`main.ts` は走らないので原文で pin)
 * 4. 🔴 **登録済みかは本文の frontmatter から引く**(タイル一覧が空のままでも当たる)
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { launchTile } from '../../src/adapter/ui/launch-tile';
import { buildLaunchExt } from '../../src/adapter/platform/launch-ext';
import { createExtLinkRegistry } from '../../src/adapter/platform/extension-links';
import { isRegisteredApp, type LauncherTile } from '../../src/features/launcher/tiles';

const appTile: LauncherTile = {
  lid: 'a1',
  title: '見積ツール',
  group: '',
  kind: 'app',
  assetKey: 'ast-1',
  mime: 'text/html',
};

function rig(granted: boolean) {
  const links = createExtLinkRegistry();
  const asked: string[] = [];
  const keys = new Set<string>(granted ? ['ast-1'] : []);
  let release: (() => void) | null = null;
  const win = {
    closed: false,
    opener: {} as unknown,
    location: { href: '', replace: (u: string) => void (win.location.href = u) },
    close: () => void (win.closed = true),
    postMessage: () => {},
  };
  const ext = buildLaunchExt({
    grants: {
      isGranted: (k) => keys.has(k ?? ''),
      grant: (k) => (keys.add(k ?? ''), true),
    },
    links,
    metas: () => [],
    onWrite: async () => ({ ok: false as const, why: 'この台では書かない' }),
    nonce: () => 'n-1',
    // 🔑 タイルの入口と同じ: 聞かない(常に断る)
    confirm: async (t) => (asked.push(t), false),
  });
  const deps: Parameters<typeof launchTile>[1] = {
    readBlob: () => Promise.resolve(new Blob(['<p>app</p>'], { type: 'text/html' })),
    open: () => win as unknown as Window,
    createUrl: () => 'blob:fake',
    revokeUrl: () => {},
    whenClosed: () => new Promise<void>((r) => void (release = r)),
    baseUrl: 'http://x.test/',
    readSeed: () => ({}),
    openTarget: () => 'tab' as const,
    fail: () => {},
    downloadSelfhost: () => {},
    openOffice: () => {},
    openView: () => {},
    openManual: () => {},
    ext,
  };
  return { deps, links, asked, close: () => release?.() };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

describe('タイルから開いたときの拡張の口 (L2)', () => {
  it('🔴 許可済みなら、普通の起動(= タイルの入口)でも台帳に載る', async () => {
    const r = rig(true);
    await launchTile(appTile, r.deps); // ⚠ `extension: true` を渡さない = タイルの開き方
    await settle();
    expect(r.links.list().map((l) => l.appId), '許可済みなのに港が繋がっていない').toEqual(['a1']);
    r.close();
    await settle();
    expect(r.links.list(), '窓が閉じても台帳に残っている').toEqual([]);
  });

  it('🔴 許可が無ければ繋がず、聞きもしない(タイルは許可を新しく出さない)', async () => {
    const r = rig(false);
    await launchTile(appTile, r.deps);
    await settle();
    expect(r.links.list()).toEqual([]);
    expect(r.asked, 'タイルから許可を聞いた').toEqual([]);
    r.close();
  });
});

const mainText = readFileSync('src/main.ts', 'utf-8');
const noComments = (t: string): string =>
  t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
// ⚠ 範囲は「その関数の中」だけ(注釈や別の入口に満たされない)
const slice = (from: string, to: string): string => {
  const a = mainText.indexOf(from);
  const b = mainText.indexOf(to, a);
  expect(a, `${from} が見つからない`).toBeGreaterThan(-1);
  expect(b, `${to} が見つからない`).toBeGreaterThan(a);
  return noComments(mainText.slice(a, b));
};

describe('main.ts の 2 つの入口が同じ組み立て口を通る (L2)', () => {
  it('🔴 一覧のタイルの入口が `ext:` を渡す', () => {
    const tile = slice('const launchLauncherTile = ', '章の別ウィンドウ');
    expect(tile).toMatch(/ext:\s*buildExtDeps\(/);
  });

  it('🔴 添付の詳細の入口も、同じ組み立て口を通る(2 つ目の配線を書かない)', () => {
    const detail = slice('launchAsset: (lid, launchOpts)', 'openOffice: (target)');
    expect(detail).toMatch(/ext:\s*buildExtDeps\(/);
    expect(detail, '詳細の入口に配線が書き写されている').not.toContain('connectExtension(');
  });
});

describe('登録済みかは本文から引く (L3)', () => {
  const reg = (): string =>
    '---\nattachment.registered_as_app: true\nattachment.asset_key: ast-1\nattachment.mime: text/html\n---\n';

  it('🔴 登録済みの本文は true(タイル一覧を開いていなくても当たる)', () => {
    expect(isRegisteredApp({ lid: 'a1', title: 't', body: reg() })).toBe(true);
  });

  it('対照群: 登録していない添付 / 開けない形式は false', () => {
    expect(
      isRegisteredApp({ lid: 'a1', title: 't', body: '---\nattachment.asset_key: ast-1\n---\n' }),
    ).toBe(false);
    expect(
      isRegisteredApp({
        lid: 'a1',
        title: 't',
        body: '---\nattachment.registered_as_app: true\nattachment.asset_key: ast-1\nattachment.mime: application/pdf\n---\n',
      }),
    ).toBe(false);
  });

  it('🔴 添付の詳細の入口は、タイル一覧(launcherTiles)から登録済みかを引かない', () => {
    const code = slice('launchAsset: (lid, launchOpts)', 'openOffice: (target)');
    expect(code).toContain('isRegisteredApp(');
    expect(code, '一覧のタイルから登録済みかを引いている').not.toContain('launcherTiles');
  });
});
