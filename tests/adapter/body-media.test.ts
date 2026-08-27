/** @vitest-environment happy-dom */
/**
 * 🔴 **本文に書いた音・動画が、その場で聞ける / 見られる**(#413 段②)。
 *
 * > user 要望 2026-07-16(PKC2 #922):
 * > 「録音と画面収録を**マルチメディアで埋め込め**るようにする」
 *
 * ## この test が守る主張
 *
 * ① 🔴 音・動画なら**リンクの隣に再生機**が出る(リンクは**残る** ── 保存の道)
 * ② 🔴 **それ以外は何も置かない**(PDF / 種類不明 / 読めない添付)
 * ③ 🔴 **同じ添付を 2 回書いても、借りるのは 1 本**(URL を 2 本作らない)
 * ④ 🔴 **表示の寿命終端で返す**(2026-07-27「速やかな破棄」)
 * ⑤ ⚠ **描き直しても 2 枚目を置かない**
 *
 * ⚠ ここは「**リンクの隣**」という置き方そのものを見る ── 器を置き換える実装だと
 *   ①の後半(保存の道)が黙って消える(user 指示 2026-08-23「片道の操作を作らない」)。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer, type AssetLender } from '../../src/adapter/ui/render/detail';
import {
  BODY_MEDIA_CLASS,
  BODY_MEDIA_FIELD,
} from '../../src/features/asset/asset-preview-kind';
import { stubRevisionOps } from '../helpers/revision-stub';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.slice(1)) || 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const tick = (ms = 20): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.textContent = '';
});

/** 種類ごとの添付を持つ lender。⚠ **種類は中身の MIME で決まる**(名前ではない)。 */
function lenderOf(mimes: Record<string, string>): {
  lender: AssetLender;
  lends: () => number;
  disposed: () => number;
} {
  let lends = 0;
  let disposed = 0;
  return {
    lends: () => lends,
    disposed: () => disposed,
    lender: {
      lend: async (key) => {
        if (!(key in mimes)) return null;
        lends += 1;
        return { url: `blob:${key}`, dispose: () => (disposed += 1) };
      },
      getBlob: async (key) =>
        key in mimes ? new Blob([], { type: mimes[key]! }) : null,
    },
  };
}

function setup(bodies: Record<string, string>, lender: AssetLender) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail, lender);
  d.onState((s) => detail.render(s));
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => bodies[lid] ?? null,
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1'), meta('e2')], relations: [] });
  const qa = (sel: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(sel)];
  return { d, qa };
}

const MEDIA = `[data-pkc-field="${BODY_MEDIA_FIELD}"]`;

describe('本文の音・動画は、その場で聞ける(#413 段②)', () => {
  it('🔴 ① 音はリンクの隣に再生機が出て、リンクは残る', async () => {
    const { lender } = lenderOf({ k1: 'audio/webm;codecs=opus' });
    /**
     * ⚠ **リンクの後ろにも字を置く**(2026-08-27、変異試験 R6 が教えた)──
     *   リンクだけの段落だと「親の末尾に足す」実装でも**同じ DOM** になり、
     *   置き場所を壊す変異が生き延びる(fixture が単純すぎた)。
     */
    const { d, qa } = setup({ e1: '前 [録音-2026.webm](asset:k1) 後ろ', e2: 'plain' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();

    const media = qa(MEDIA);
    expect(media, '再生機が出ていない').toHaveLength(1);
    expect(media[0]!.tagName, '音なのに音の器ではない').toBe('AUDIO');
    expect(media[0]!.getAttribute('src'), '借りた URL を差していない').toBe('blob:k1');
    expect((media[0] as HTMLAudioElement).controls, '押す口が無い').toBe(true);
    /**
     * ⚠ **飾りの印も見る** ── 見た目は class で当てている(器の印
     * `data-pkc-field` は書き出し CSS の検品が 1 件も通さない)。
     * 🔑 ここを見ないと、class を落とす変異が**書き出した HTML でだけ**
     *   素の器になる形で生き延びる。
     */
    expect(media[0]!.classList.contains(BODY_MEDIA_CLASS), '飾りの印が付いていない').toBe(true);
    // 🔴 **保存の道が消えていない**(器を置き換える実装だと消える)
    const link = qa('a[data-pkc-asset-key="k1"]');
    expect(link, 'リンクを消した').toHaveLength(1);
    expect(link[0]!.textContent, '字が変わっている').toBe('録音-2026.webm');
    /**
     * ⚠ **隣に置く**(リンクの**すぐ次の節点**)── 場所まで見ないと
     *   「どこかに在る」で通る。
     * 🔑 **`nextElementSibling` では足りない**(変異試験 R6 が 2 度目に教えた)──
     *   あれは字の節点を飛ばすので、**段落の末尾に足す**実装でも真になる。
     */
    expect(link[0]!.nextSibling, 'リンクのすぐ隣に置いていない').toBe(media[0]);
  });

  it('🔴 動画は動画の器になる', async () => {
    const { lender } = lenderOf({ k1: 'video/webm' });
    const { d, qa } = setup({ e1: '[画面収録.webm](asset:k1)', e2: 'plain' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    expect(qa(MEDIA)[0]?.tagName, '動画なのに動画の器ではない').toBe('VIDEO');
  });

  it('🔴 ② 音・動画でなければ何も置かない(対照群)', async () => {
    const { lender, lends } = lenderOf({
      k1: 'application/pdf',
      k2: 'application/octet-stream',
      k3: 'image/png',
    });
    const { d, qa } = setup(
      { e1: '[a](asset:k1)\n\n[b](asset:k2)\n\n[c](asset:k3)\n\n[d](asset:k404)', e2: 'plain' },
      lender,
    );
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    expect(qa(MEDIA), '音・動画でないものに再生機を置いた').toHaveLength(0);
    // ⚠ **借りてもいない**(URL を作って捨てる無駄をしていない)
    expect(lends(), '再生しないのに借りている').toBe(0);
    expect(qa('a[data-pkc-asset-key]'), 'リンクまで消した').toHaveLength(4);
  });

  it('🔴 ③ 同じ添付を 2 回書いても、借りるのは 1 本', async () => {
    const { lender, lends, disposed } = lenderOf({ k1: 'audio/webm' });
    const { d, qa } = setup({ e1: '[1](asset:k1)\n\n[2](asset:k1)', e2: 'plain' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    const media = qa(MEDIA);
    expect(media, '2 か所に出ていない').toHaveLength(2);
    expect(media.map((m) => m.getAttribute('src')), 'URL を共有していない').toEqual([
      'blob:k1',
      'blob:k1',
    ]);
    expect(lends(), '同じ添付を 2 回借りた').toBe(1);

    // 🔴 ④ 表示の寿命終端で返す(URL は 1 本なので 1 回)
    expect(disposed(), '見ている最中に返した').toBe(0);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e2' });
    await tick();
    expect(disposed(), '離れたのに返していない').toBe(1);
  });

  it('🔴 借りている間に選択が移ったら、借りた瞬間に返す(注入しない)', async () => {
    let disposed = 0;
    let release: (v: { url: string; dispose: () => void } | null) => void = () => {};
    const lender: AssetLender = {
      lend: () =>
        new Promise((r) => {
          release = r;
        }),
      getBlob: async () => new Blob([], { type: 'audio/webm' }),
    };
    const { d, qa } = setup({ e1: '[音](asset:k1)', e2: 'plain' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e2' });
    await tick();
    release({ url: 'blob:late', dispose: () => (disposed += 1) });
    await tick();
    expect(disposed, '離れた後に借りたものを返していない').toBe(1);
    expect(qa(MEDIA), '別のノートへ器を注入した').toHaveLength(0);
  });

  it('⚠ ⑤ 描き直しても 2 枚目を置かない', async () => {
    const { lender, lends } = lenderOf({ k1: 'audio/webm' });
    const { d, qa } = setup({ e1: '[音](asset:k1)', e2: 'plain' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    expect(qa(MEDIA), '前提が崩れている').toHaveLength(1);
    // 同じノートをもう一度描く(印の付け直し等で普通に起きる)
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    expect(qa(MEDIA), '描き直しで再生機が増えた').toHaveLength(1);
    expect(lends(), '描き直しで借り直した').toBe(1);
  });
});
