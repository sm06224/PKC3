/** @vitest-environment happy-dom */
/**
 * 🔴 **外殻の「拡張の中継」**(#195 / C-5 段①)。
 *
 * ⚠ **字面を pin しない。走らせる。** 外殻の script は文字列で組むので、
 *   「その語が入っているか」を見る test は**書き換えても意味が変わらない**変異を
 *   1 つも殺さない。ここでは器を作って **script を実際に実行**し、
 *   ホスト役とアプリ役から投げて振る舞いを見る。
 *
 * 🔑 守る主張:
 * 1. 🔴 **許されていない起動には焼かない**(全アプリに死んだコードを配らない)
 * 2. 🔴 **印は、聴き始めた後に立つ**(先に立てると、まだ聴いていないのに渡される)
 * 3. 🔴 **`nonce` が合わない港は掴まない**(中のアプリが偽の港を渡せてしまう)
 * 4. 🔴 **港は 1 度だけ**(2 本目で差し替えない ── 横取りの窓を作らない)
 * 5. アプリ ↔ ホストの言葉が**両方向に通る**
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildLauncherAppShell } from '../../src/features/launcher/app-shell';
import { EXT_PORT_TAG, EXT_READY_FLAG } from '../../src/features/extension/ext-wire';
import { connectExtension } from '../../src/adapter/platform/extension-host';
import { deliveredEntryOf } from '../../src/features/extension/ext-delivery';
import type { EntryMeta } from '../../src/core/model/entry-meta';

/** 外殻の script だけを取り出して走らせる(器は自分で組む)。 */
function runShell(opts: { nonce?: string } = {}) {
  const html = buildLauncherAppShell(
    'app',
    '<p>app</p>',
    opts.nonce === undefined ? {} : { extension: { nonce: opts.nonce } },
  );
  // ⚠ 中継の script は**最後の `<script>`**(保存の script と混ぜていない)
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const relay = blocks.filter((b) => b.includes(EXT_PORT_TAG));
  document.body.innerHTML = '<iframe></iframe>';
  const frame = document.querySelector('iframe')!;
  // アプリ役の窓(`contentWindow`)へ届いた物を控える
  const toApp: unknown[] = [];
  const appWin = {
    postMessage: (data: unknown) => void toApp.push(data),
  };
  Object.defineProperty(frame, 'contentWindow', { value: appWin, configurable: true });
  for (const code of relay) new Function(code)();
  return { relay, frame, appWin, toApp };
}

/** ホスト役として港を渡す。 */
function hand(nonce: string): { host: MessagePort; got: unknown[] } {
  const ch = new MessageChannel();
  const got: unknown[] = [];
  ch.port1.onmessage = (e) => void got.push(e.data);
  ch.port1.start?.();
  window.dispatchEvent(
    Object.assign(new MessageEvent('message', { data: { tag: EXT_PORT_TAG, nonce } }), {
      // ⚠ happy-dom の MessageEvent は ports を引数から採らないので直に置く
      ports: [ch.port2],
    }),
  );
  return { host: ch.port1, got };
}

/** アプリ役として投げる(`event.source` を frame の窓にする)。 */
function fromApp(frame: HTMLIFrameElement, body: unknown): void {
  window.dispatchEvent(
    Object.assign(new MessageEvent('message', { data: { tag: EXT_PORT_TAG, body } }), {
      source: (frame as unknown as { contentWindow: unknown }).contentWindow,
    }),
  );
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('外殻の拡張中継 (#195 / C-5 段①)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    delete (window as unknown as Record<string, unknown>)[EXT_READY_FLAG];
  });

  /** 🔴 許されていない起動には**焼かない**(死んだコードを全アプリに配らない)。 */
  it('🔴 許されていなければ、中継の script が入らない', () => {
    const html = buildLauncherAppShell('app', '<p>app</p>', {});
    expect(html, '許していないのに中継が入っている').not.toContain(EXT_PORT_TAG);
    expect(html, '印まで立てている').not.toContain(EXT_READY_FLAG);
    // ⚠ 空振り防止 ── 許せば入る
    expect(
      buildLauncherAppShell('app', '<p>app</p>', { extension: { nonce: 'n1' } }),
    ).toContain(EXT_PORT_TAG);
  });

  it('🔴 印が立ち、nonce が合う港を掴んで両方向に通る', async () => {
    const { frame, toApp } = runShell({ nonce: 'n1' });
    expect(
      (window as unknown as Record<string, unknown>)[EXT_READY_FLAG],
      '印が立っていない(本体タブは永久に待つ)',
    ).toBe(1);
    const { host, got } = hand('n1');
    await tick();
    // ① アプリ → ホスト
    fromApp(frame, { t: 'hello' });
    await tick();
    expect(got, 'アプリの言葉がホストへ届いていない').toEqual([{ t: 'hello' }]);
    // ② ホスト → アプリ
    host.postMessage({ t: 'projection', projection: { entries: [], total: 0, truncated: false } });
    await tick();
    expect(toApp, 'ホストの言葉がアプリへ届いていない').toEqual([
      { tag: EXT_PORT_TAG, body: { t: 'projection', projection: { entries: [], total: 0, truncated: false } } },
    ]);
  });

  /**
   * 🔴 **`nonce` が合わない港は掴まない。**
   * ⚠ 中のアプリも外殻へ投げられるので、合図だけで信じると**偽の港**を掴む。
   */
  it('🔴 nonce が違う港は掴まない', async () => {
    const { frame } = runShell({ nonce: 'n1' });
    const { got } = hand('n2-ちがう');
    await tick();
    fromApp(frame, { t: 'hello' });
    await tick();
    expect(got, '偽の港を掴んでいる').toEqual([]);
  });

  /**
   * 🔴 **港は 1 度だけ**(2 本目で差し替えない)。
   * ⚠ 差し替えを許すと、後から投げた方が横取りできる。
   */
  it('🔴 2 本目の港では差し替えない', async () => {
    const { frame } = runShell({ nonce: 'n1' });
    const first = hand('n1');
    await tick();
    const second = hand('n1');
    await tick();
    fromApp(frame, { t: 'hello' });
    await tick();
    expect(first.got, '1 本目が繋がっていない(前提が崩れた)').toEqual([{ t: 'hello' }]);
    expect(second.got, '2 本目に差し替わっている').toEqual([]);
  });

  /**
   * 🔴 **本物のホストと本物の外殻を繋ぐ**(2026-08-25、smoke が拾った欠陥の回帰)。
   *
   * ⚠ **この test が無かったせいで、繋がらない実装が両側とも緑だった。**
   *   ホストは `{ tag }` だけを投げ、外殻は `m.nonce !== NONCE` でそれを
   *   **黙って捨てて**いた ── ところが `extension-host.test.ts` の外殻役は
   *   何でも掴む stub、`launcher-ext-relay` のホスト役は手で封筒を組む形だったので、
   *   **どちらの unit も相手の綴りを 1 度も見ていなかった**(CLAUDE.md §7)。
   * 🔑 だからここでは**どちらも実物**にする ── 窓役は「投げられた物をそのまま
   *   外殻へ流す」だけの通り道で、封筒を 1 バイトも作らない。
   * 🔑 観測点は**アプリ役に届いた見取り図**(港が繋がったか、ではない)。
   */
  it('🔴 本物のホストが渡す港を、本物の外殻が掴んでアプリまで届く', async () => {
    const nonce = 'n-cross';
    const { frame, toApp } = runShell({ nonce });
    const meta: EntryMeta = {
      lid: 'a',
      title: '見取り図に出るノート',
      archetype: 'text',
      createdAt: null,
      updatedAt: null,
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
      bodyChars: 99,
    };
    /** 外殻の窓役 ── **通り道でしかない**(封筒はホストが組んだ物をそのまま流す)。 */
    const win = {
      [EXT_READY_FLAG]: 1,
      postMessage(data: unknown, _origin: string, transfer?: readonly MessagePort[]) {
        window.dispatchEvent(
          Object.assign(new MessageEvent('message', { data }), { ports: transfer ?? [] }),
        );
      },
    };
    const link = connectExtension({
      win: win as unknown as Window,
      metas: () => [meta],
      nonce,
      pollMs: 0,
    });
    for (let i = 0; i < 20 && toApp.length === 0; i += 1) await tick();
    expect(toApp, 'アプリまで届いていない(外殻が港を捨てた可能性)').toHaveLength(1);
    const body = (toApp[0] as { tag: string; body: { t: string; projection: { entries: { title: string }[] } } });
    expect(body.tag).toBe(EXT_PORT_TAG);
    expect(body.body.t).toBe('projection');
    expect(body.body.projection.entries.map((e) => e.title)).toEqual(['見取り図に出るノート']);

    // ⚠ 対照群 ── アプリの `hello` も本物のホストまで通り、押し直される
    fromApp(frame, { t: 'hello' });
    for (let i = 0; i < 20 && toApp.length < 2; i += 1) await tick();
    expect(toApp, '`hello` が本物のホストへ通っていない').toHaveLength(2);
    link.close();
  });

  /**
   * 🔴 **段② も、本物どうしで 1 本通す**(#195 / C-5 段②)。
   *
   * ⚠ 段① で踏んだ穴(封筒を 2 か所で組んで綴りがずれ、外殻が**黙って捨てた**)は、
   *   **語を足すたびに繰り返せる** ── `deliveredMessage` を新しく足した以上、
   *   その封筒が外殻を通ることを**実物どうし**で見る必要がある。
   * 🔑 中継役(外殻の script)は**そのまま流す通り道**なので、段② で 1 行も
   *   変えていない ── ⚠ それを**確かめる**のがこの test である
   *   (「変えなくても通るはず」は推測であって、観測ではない)。
   * 🔑 観測点は**アプリ役に届いた本文**(港が繋がったか、ではない)。
   */
  it('🔴 本物のホストが渡す実体 1 件が、本物の外殻を通ってアプリまで届く', async () => {
    const nonce = 'n-deliver';
    const { toApp } = runShell({ nonce });
    const meta: EntryMeta = {
      lid: 'n1',
      title: '渡すノート',
      archetype: 'text',
      createdAt: null,
      updatedAt: null,
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
      bodyChars: 5,
    };
    const win = {
      [EXT_READY_FLAG]: 1,
      postMessage(data: unknown, _origin: string, transfer?: readonly MessagePort[]) {
        window.dispatchEvent(
          Object.assign(new MessageEvent('message', { data }), { ports: transfer ?? [] }),
        );
      },
    };
    const link = connectExtension({
      win: win as unknown as Window,
      metas: () => [meta],
      nonce,
      pollMs: 0,
    });
    // ⚠ **対照群を先に置く** ── 見取り図が届いていない回は、以降の判定が無意味である
    for (let i = 0; i < 20 && toApp.length === 0; i += 1) await tick();
    expect(toApp, '見取り図すら届いていない(前提が崩れた)').toHaveLength(1);

    expect(link.deliver(deliveredEntryOf(meta, '本文だよ')), '港が無い').toBe(true);
    for (let i = 0; i < 20 && toApp.length < 2; i += 1) await tick();
    expect(toApp, '実体がアプリまで届いていない(外殻が捨てた可能性)').toHaveLength(2);

    const sent = toApp[1] as { tag: string; body: { t: string; entry: { body: string; title: string } } };
    expect(sent.tag, '外殻の合図が違う').toBe(EXT_PORT_TAG);
    expect(sent.body.t).toBe('entry');
    expect(sent.body.entry.title).toBe('渡すノート');
    expect(sent.body.entry.body, '本文が乗っていない').toBe('本文だよ');
    link.close();
  });

  /**
   * 🔴 **繋がる前に押したら、押せなかったと分かる**(黙って握り潰さない)。
   * ⚠ これが `true` を返すと、user は「送った」と思ったまま何も起きない。
   */
  it('🔴 港が繋がる前の `deliver` は false を返す', () => {
    const meta: EntryMeta = {
      lid: 'n1',
      title: 'まだ',
      archetype: 'text',
      createdAt: null,
      updatedAt: null,
      entryOrder: 1,
      status: null,
      date: null,
      archived: false,
      bodyChars: 0,
    };
    // ⚠ 印を立てない窓 ── 港は永久に渡らない
    const link = connectExtension({
      win: { postMessage: () => undefined } as unknown as Window,
      metas: () => [meta],
      nonce: 'n-never',
      pollMs: 0,
      timeoutMs: 0,
    });
    expect(link.deliver(deliveredEntryOf(meta, 'x'))).toBe(false);
    link.close();
  });

  /** ⚠ 港が来る前のアプリの言葉は**捨てる**(溜めない ── 段① は溜める理由が無い)。 */
  it('⚠ 港が来る前に投げられても落ちない', async () => {
    const { frame } = runShell({ nonce: 'n1' });
    expect(() => fromApp(frame, { t: 'hello' })).not.toThrow();
    const { got } = hand('n1');
    await tick();
    expect(got, '港が来る前の物まで流している').toEqual([]);
  });
});
