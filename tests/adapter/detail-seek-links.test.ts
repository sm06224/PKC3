/** @vitest-environment happy-dom */
/**
 * 🔴 **音・動画の添付の説明だけが、行頭の時刻を押せる字にする**(#1232 段 b)。
 *
 * 描画そのものは `tests/features/markdown-seek-link.test.ts`、押した後は
 * `tests/adapter/seek-media-actions.test.ts`。**ここが見るのは 2 つ**:
 *   ① どの面が旗を立てるか(再生機が居る面だけ。PDF の説明の `12:30 会議` を押せる字にしない)
 *   ② 🔴 **本物どうしを繋ぐ** ── 実物の詳細が組んだ DOM を、実物の受け口が読んで再生機を動かすか
 *      (片端ずつ模した test は、綴りの食い違いを両方緑のまま通す)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer, type AssetLender } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { ExtensionGrants } from '../../src/adapter/platform/extension-grants';
import { attachmentBody } from '../../src/features/flavor/attachment-flavor';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'attachment',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const TRANSCRIPT = '\n\n## 文字起こし 2026-10-02 12:34\n0:15 はじめに\n0:20 つぎに\n';

beforeEach(() => {
  document.body.textContent = '';
});

async function open(mime: string, name: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const lender: AssetLender = {
    lend: async () => ({ url: 'blob:fake', dispose: () => {} }),
    getBlob: async () => null,
  };
  const detail = new DetailRenderer(
    regions.detail,
    lender,
    undefined,
    undefined,
    undefined,
    undefined,
    new ExtensionGrants(null),
  );
  d.onState((s) => detail.render(s));
  const body = attachmentBody({ name, mime, size: 3, assetKey: 'ast-1' }) + TRANSCRIPT;
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => body,
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  bindActions(root, d, {});
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
  await tick(30);
  return { root, d };
}

describe('音・動画の添付の説明(#1232 段 b)', () => {
  it('🔴 音の添付の説明は、行頭の時刻が押せる字で出る', async () => {
    const { root } = await open('audio/webm', 'rec.webm');
    const links = root.querySelectorAll('[data-pkc-action="seek-media"]');
    expect(links, '行ごとに 1 つずつ出るはず').toHaveLength(2);
    expect(links[0]!.getAttribute('data-pkc-seek-ms')).toBe('15000');
    expect(links[1]!.getAttribute('data-pkc-seek-ms')).toBe('20000');
  });

  it('🔴 動画の添付の説明も同じ ── 押すと詳細が差した本物の <video> が動く', async () => {
    const { root } = await open('video/webm', 'rec.webm');
    expect(root.querySelectorAll('[data-pkc-action="seek-media"]')).toHaveLength(2);
    // ⚠ 受け口が audio しか探さないと、動画では常に「再生機がまだ出ていません」になる
    const video = root.querySelector<HTMLVideoElement>('video[data-pkc-field="attachment-media"]');
    expect(video, '前提: 動画の再生機が差さっていない').not.toBeNull();
    let t = 0;
    Object.defineProperty(video!, 'currentTime', { get: () => t, set: (v: number) => (t = v), configurable: true });
    Object.defineProperty(video!, 'readyState', { value: 4, configurable: true });
    Object.defineProperty(video!, 'duration', { value: 600, configurable: true });
    const play = vi.fn(() => Promise.resolve());
    Object.defineProperty(video!, 'play', { value: play, configurable: true });
    root.querySelectorAll<HTMLElement>('[data-pkc-action="seek-media"]')[0]!.click();
    expect(t, '動画の再生機が 0:15 へ動いていない').toBe(15);
    expect(play).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **再生機の居ない添付では押せる字にしない** ── 押しても何も起きない dead click になる。
   * ⚠ 空振り防止に、同じ説明で音なら出ることを上の 2 本が見ている。
   */
  it('🔴 PDF の添付の説明に `0:15 …` と書いても、押せる字にしない(字は残る)', async () => {
    const { root } = await open('application/pdf', 'doc.pdf');
    expect(root.querySelector('[data-pkc-action="seek-media"]'), '再生機の無い所で押せる字になっている').toBeNull();
    expect(root.textContent, '字が消えている').toContain('0:15 はじめに');
  });

  /**
   * 🔴 **実物どうしを繋ぐ** ── 詳細が組んだ DOM(説明の器と再生機の器の並び)を、
   * 受け口が実際に引けるか。`seekMedia` が器を引く綴り(`data-pkc-prose` の親 →
   * `attachment-media`)と、`renderAttachment` が組む形が食い違うと、片端ずつの test は両方緑のまま通る。
   */
  it('🔴 押すと、詳細が差した本物の再生機がその位置へ動いて鳴る', async () => {
    const { root } = await open('audio/webm', 'rec.webm');
    const audio = root.querySelector<HTMLAudioElement>('audio[data-pkc-field="attachment-media"]');
    expect(audio, '前提: 再生機が差さっていない').not.toBeNull();
    let t = 0;
    Object.defineProperty(audio!, 'currentTime', { get: () => t, set: (v: number) => (t = v), configurable: true });
    Object.defineProperty(audio!, 'readyState', { value: 4, configurable: true });
    Object.defineProperty(audio!, 'duration', { value: 600, configurable: true });
    const play = vi.fn(() => Promise.resolve());
    Object.defineProperty(audio!, 'play', { value: play, configurable: true });

    root
      .querySelectorAll<HTMLElement>('[data-pkc-action="seek-media"]')[1]!
      .click();
    expect(t, '2 行目の時刻(0:20)へ動いていない').toBe(20);
    expect(play).toHaveBeenCalledTimes(1);
  });
  /**
   * 🔴 **音の再生機が貼り付く条件(`app.css`)を、詳細が組む形が満たしている**(#1232 段 b、Gemini 裁定 Q3 = B)。
   * 貼り付くのは `attachment-preview` の器で、条件は「**直下の子に `<audio>` が居る**」(動画は貼らない)。
   * ⚠ `<audio>` を別の入れ物へ包み直すと、CSS は何も言わずに外れる ── 配置は happy-dom では測れないので、
   *   **形**をここで pin し、貼り付くこと自体は smoke(`media-capture.smoke.spec.ts`)が実ブラウザで見る。
   */
  it('🔴 音の再生機は attachment-preview の直下に居る / 動画も同じ器だが <video> である', async () => {
    const { root } = await open('audio/webm', 'rec.webm');
    const audio = root.querySelector<HTMLElement>('audio[data-pkc-field="attachment-media"]');
    expect(audio?.parentElement?.getAttribute('data-pkc-field'), '音の再生機の親が attachment-preview でない').toBe(
      'attachment-preview',
    );
    document.body.textContent = '';
    const v = await open('video/webm', 'rec.webm');
    expect(v.root.querySelector('audio'), '前提: 動画の添付に <audio> が居る').toBeNull();
    expect(
      v.root.querySelector('video[data-pkc-field="attachment-media"]')?.parentElement?.getAttribute('data-pkc-field'),
    ).toBe('attachment-preview');
  });

  /**
   * 🔴 **帯の高さを器へ下ろす**(`--pkc-detail-bar-h`)── 再生機は帯の直下に貼り付くので、帯が 2 段に折れて
   * 高くなっても(実測 53px)重ならない。⚠ 実ブラウザの smoke は帯が 34px の窓で走るので、
   * 「測った値が器へ届く」ことは**ここが唯一の門**(測らずに 34px 固定でも smoke は緑になる)。
   */
  it('🔴 操作の帯の高さを測って、詳細の器の --pkc-detail-bar-h へ書く(高さが変われば追従する)', async () => {
    const watches: Array<{ cb: () => void; target: Element | null; gone: boolean }> = [];
    class FakeResizeObserver {
      private readonly rec: { cb: () => void; target: Element | null; gone: boolean };
      constructor(cb: () => void) {
        this.rec = { cb, target: null, gone: false };
        watches.push(this.rec);
      }
      observe(el: Element): void {
        this.rec.target = el;
      }
      disconnect(): void {
        this.rec.gone = true;
      }
      unobserve(): void {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    let height = 53;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const h = this.getAttribute('data-pkc-field') === 'detail-bar-slot' ? height : 0;
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: h, width: 0, height: h, toJSON: () => ({}) } as DOMRect;
    });
    try {
      const { root } = await open('audio/webm', 'rec.webm');
      const bar = root.querySelector<HTMLElement>('[data-pkc-field="detail-bar-slot"]');
      expect(bar, '前提: 操作の帯が無い').not.toBeNull();
      const region = bar!.parentElement!;
      const live = watches.filter((w) => !w.gone && w.target === bar);
      expect(live, '帯を見張っていない').toHaveLength(1);
      live[0]!.cb();
      expect(region.style.getPropertyValue('--pkc-detail-bar-h'), '帯の高さが器へ届いていない').toBe('53px');
      height = 34;
      live[0]!.cb();
      expect(region.style.getPropertyValue('--pkc-detail-bar-h'), '帯が低くなったのに追従しない').toBe('34px');
    } finally {
      spy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
