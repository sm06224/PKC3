/** @vitest-environment node */
/**
 * 🔴 **「目次を見せて起動」の動線**(#195 / C-5 段①-b)。
 *
 * 🔑 守る主張:
 * 1. 🔴 **聞くのは窓を開ける前**(断ったのに空のタブが残る形を作らない)
 * 2. 🔴 **断ったら開かない**(fail closed)
 * 3. 🔴 **許してあれば、普通の起動でも口が開く**(憶えた許可が死に札にならない)
 * 4. 🔴 **許していない普通の起動では口が開かない**(勝手に繋がない)
 * 5. 🔴 **窓が閉じたら手を切る**(閉じた窓へ押し続けない)
 * 6. 🔴 **合図は起動ごとに作り直す**(使い回すと偽の港を掴む鍵が漏れる)
 */
import { describe, expect, it } from 'vitest';
import { launchTile } from '../../src/adapter/ui/launch-tile';
import type { LauncherTile } from '../../src/features/launcher/tiles';
import { EXT_PORT_TAG } from '../../src/features/extension/ext-wire';

const appTile: LauncherTile = {
  lid: 'a1',
  title: '見積ツール',
  group: '',
  kind: 'app',
  assetKey: 'ast-1',
  mime: 'text/html',
};

function harness(opts: { granted?: boolean; answer?: boolean } = {}) {
  const shells: string[] = [];
  const asked: string[] = [];
  const granted = new Set<string>(opts.granted === true ? ['ast-1'] : []);
  const connects: string[] = [];
  /** 港に添えて渡された合図(外殻に焼いた物と突き合わせる)。 */
  const handed: string[] = [];
  const closes: string[] = [];
  const nonces: string[] = [];
  let release: (() => void) | null = null;
  let seq = 0;
  const win = {
    closed: false,
    opener: {} as unknown,
    location: { href: '', replace: (u: string) => void (win.location.href = u) },
    close: () => void (win.closed = true),
  };
  const deps: Parameters<typeof launchTile>[1] = {
    readBlob: () => Promise.resolve(new Blob(['<p>app</p>'], { type: 'text/html' })),
    open: () => win as unknown as Window,
    createUrl: (blob) => {
      // ⚠ **外殻の中身を控える**(中継が焼かれたかを、字ではなく**組んだ物**で見る)
      void blob.text().then((t) => void shells.push(t));
      return `blob:fake-${++seq}`;
    },
    revokeUrl: () => {},
    whenClosed: () => new Promise<void>((r) => void (release = r)),
    baseUrl: 'http://x.test/',
    readSeed: () => ({}),
    fail: () => {},
    openOffice: () => {},
    openView: () => {},
    openManual: () => {},
    ext: {
      granted: (key) => granted.has(key ?? ''),
      grant: (key) => {
        granted.add(key ?? '');
        return true;
      },
      confirm: async (title) => {
        asked.push(title);
        return opts.answer !== false;
      },
      connect: (w, nonce) => {
        connects.push(w === (win as unknown as Window) ? 'same-window' : 'other');
        // 🔴 **港に添える合図を控える** ── 外殻に焼いた物と一致しなければ、
        //    実物の外殻は港を**黙って捨てる**(2026-08-25 に踏んだ)
        handed.push(nonce);
        return { close: () => void closes.push('closed') };
      },
      nonce: () => {
        nonces.push(`n${nonces.length + 1}`);
        return `n${nonces.length}`;
      },
    },
  };
  return {
    deps,
    shells,
    asked,
    granted,
    connects,
    handed,
    closes,
    nonces,
    win,
    closeWindow: () => {
      win.closed = true;
      release?.();
    },
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe('目次を見せて起動 (#195 / C-5 段①-b)', () => {
  it('🔴 まだ許していなければ聞き、許して開き、港を渡す', async () => {
    const h = harness();
    await launchTile(appTile, h.deps, { extension: true });
    await settle();
    expect(h.asked, '聞いていない').toEqual(['見積ツール']);
    expect(h.granted.has('ast-1'), '許可を憶えていない').toBe(true);
    expect(h.connects, '港を渡していない(渡した窓も違う)').toEqual(['same-window']);
    expect(h.shells[0], '外殻に中継が焼かれていない').toContain(EXT_PORT_TAG);
    /**
     * 🔴 **外殻に焼いた合図と、港に添えた合図が同じ**(2026-08-25、smoke が拾った)。
     * ⚠ ここが割れていると、外殻は `m.nonce !== NONCE` で港を**黙って捨てる** ──
     *   繋がった顔をして、アプリには 1 バイトも届かない。
     */
    expect(h.nonces, '合図を作っていない').toHaveLength(1);
    expect(h.handed, '港に合図を添えていない').toEqual(h.nonces);
    expect(h.shells[0], '焼いた合図が違う').toContain(h.nonces[0]!);
  });

  /** 🔴 **断ったら開かない**(fail closed)。⚠ 空のタブも残さない。 */
  it('🔴 断ったら窓も開かない', async () => {
    const h = harness({ answer: false });
    await launchTile(appTile, h.deps, { extension: true });
    await settle();
    expect(h.asked).toHaveLength(1);
    expect(h.win.location.href, '断ったのに開いている').toBe('');
    expect(h.connects, '断ったのに港を渡している').toEqual([]);
    expect(h.granted.has('ast-1'), '断ったのに憶えている').toBe(false);
  });

  /**
   * 🔴 **許してあれば、普通の起動でも口が開く。**
   * ⚠ ここが繋がっていないと、憶えた許可は「特別なボタンを毎回探す」ことになり、
   *   憶えた意味が無くなる。
   */
  it('🔴 許してあれば、普通の起動でも口が開く(聞き直さない)', async () => {
    const h = harness({ granted: true });
    await launchTile(appTile, h.deps, {});
    await settle();
    expect(h.asked, '許してあるのに聞いている').toEqual([]);
    expect(h.connects, '許してあるのに港を渡していない').toEqual(['same-window']);
    expect(h.shells[0]).toContain(EXT_PORT_TAG);
  });

  /** 🔴 **許していない普通の起動では繋がない**(対照群)。 */
  it('🔴 許していない普通の起動では口が開かない', async () => {
    const h = harness();
    await launchTile(appTile, h.deps, {});
    await settle();
    expect(h.asked, '押していないのに聞いている').toEqual([]);
    expect(h.connects, '許していないのに港を渡している').toEqual([]);
    expect(h.shells[0], '許していないのに中継が焼かれている').not.toContain(EXT_PORT_TAG);
  });

  /** 🔴 **窓が閉じたら手を切る**(閉じた窓へ押し続けない)。 */
  it('🔴 窓が閉じたら手を切る', async () => {
    const h = harness({ granted: true });
    const done = launchTile(appTile, h.deps, {});
    await settle();
    expect(h.closes, '閉じる前に切っている').toEqual([]);
    h.closeWindow();
    await done;
    await settle();
    expect(h.closes, '窓が閉じても手を切っていない').toEqual(['closed']);
  });

  /**
   * 🔴 **合図は起動ごとに作り直す。**
   * ⚠ 使い回すと、1 度でも漏れた鍵で**以後ずっと偽の港を掴ませられる**。
   */
  it('🔴 起動ごとに違う合図を焼く', async () => {
    const h = harness({ granted: true });
    await launchTile(appTile, h.deps, {});
    await settle();
    await launchTile(appTile, h.deps, {});
    await settle();
    expect(h.nonces.length, '合図を作っていない').toBe(2);
    expect(new Set(h.nonces).size, '同じ合図を使い回している').toBe(2);
    // ⚠ 焼かれた外殻にも別の合図が入っている(作っただけで渡していない、を防ぐ)
    expect(h.shells[0]).toContain(h.nonces[0]!);
    expect(h.shells[1]).toContain(h.nonces[1]!);
    // 🔴 港に添えた合図も**起動ごとに、その回の外殻と同じ物**である
    expect(h.handed, '港の合図が外殻とずれている').toEqual(h.nonces);
  });

  /** ⚠ 拡張の配線が無い器では、旗を立てても何も起きない(機構ごと存在しない)。 */
  it('⚠ ext を渡していなければ、旗を立てても繋がない', async () => {
    const h = harness();
    const deps = { ...h.deps };
    delete (deps as { ext?: unknown }).ext;
    await launchTile(appTile, deps, { extension: true });
    await settle();
    expect(h.connects).toEqual([]);
    expect(h.shells[0], '配線が無いのに中継が焼かれている').not.toContain(EXT_PORT_TAG);
  });
});
