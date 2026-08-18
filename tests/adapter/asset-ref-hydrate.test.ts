/** @vitest-environment happy-dom */
/**
 * 本文 markdown の `asset:` 参照の hydrate(P4b)pin:
 * - 同一 key の複数参照は **1 lend / 1 URL** を共有
 * - URL は選択遷移(表示の寿命終端)で必ず dispose(即破棄規律)
 * - 不在 key は data-pkc-asset-missing(黙って空にしない)
 * - 解決前に選択が移ったら結果を捨てて即 dispose(stale 注入なし)
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer, type AssetLender } from '../../src/adapter/ui/render/detail';
import { stubRevisionOps } from '../helpers/revision-stub';
import { MarkdownClient } from '../../src/adapter/platform/render/markdown-client';
import { initialState, reduce, type AppState } from '../../src/adapter/state/app-state';

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
  };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.textContent = '';
});

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
    persistEntry: async () => stubStamps(),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('e1'), meta('e2')],
    relations: [],
  });
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const qa = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
  return { d, q, qa };
}

const BODY_WITH_REFS = [
  '![一枚目](asset:k1)',
  '',
  '![二枚目(同じ asset)](asset:k1)',
  '',
  '![消えた](asset:k404)',
  '',
  '[添付をDL](asset:k1)',
].join('\n');

describe('asset ref hydrate (P4b)', () => {
  it('同一 key は 1 lend を共有し、選択遷移で 1 回だけ dispose される', async () => {
    let lends = 0;
    let disposed = 0;
    const lender: AssetLender = {
      lend: async (key) => {
        if (key === 'k404') return null;
        lends++;
        return { url: `blob:${key}`, dispose: () => disposed++ };
      },
      getBlob: async () => null,
    };
    const { d, q, qa } = setup({ e1: BODY_WITH_REFS, e2: 'plain' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick(20);

    const imgs = qa('img[data-pkc-asset-key="k1"]');
    expect(imgs).toHaveLength(2);
    expect(imgs[0]!.getAttribute('src')).toBe('blob:k1');
    expect(imgs[1]!.getAttribute('src')).toBe('blob:k1'); // URL 共有
    expect(lends).toBe(1); // 同一 key は 1 回だけ借りる

    // 不在 key は missing 印(alt が可視 fallback)
    const gone = q('img[data-pkc-asset-key="k404"]')!;
    expect(gone.hasAttribute('data-pkc-asset-missing')).toBe(true);
    expect(gone.hasAttribute('src')).toBe(false);

    // DL link は binder の download-asset に載る形
    const a = q('a[data-pkc-action="download-asset"]')!;
    expect(a.getAttribute('data-pkc-asset-key')).toBe('k1');
    expect(a.getAttribute('data-pkc-asset-name')).toBe('添付をDL');

    expect(disposed).toBe(0); // 表示中は生きている
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e2' });
    await tick(20);
    expect(disposed).toBe(1); // 表示の寿命終端で dispose(URL は 1 本なので 1 回)
  });

  it('stale hydrate: 解決前に選択が移ったら借りた瞬間に返す(注入なし)', async () => {
    let disposed = 0;
    let release: (v: { url: string; dispose: () => void } | null) => void = () => {};
    const lender: AssetLender = {
      lend: () =>
        new Promise((r) => {
          release = r;
        }),
      getBlob: async () => null,
    };
    const { d, qa } = setup({ e1: '![x](asset:k1)', e2: 'plain' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick();
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e2' }); // 解決前に離脱
    await tick();
    release({ url: 'blob:late', dispose: () => disposed++ });
    await tick();
    expect(disposed).toBe(1); // 即返却
    expect(qa('img[src]')).toHaveLength(0); // stale 注入なし
  });

  it('lend が throw しても missing 印で終える(unhandled rejection にしない)', async () => {
    const lender: AssetLender = {
      lend: async () => {
        throw new Error('idb down');
      },
      getBlob: async () => null,
    };
    const { d, q } = setup({ e1: '![x](asset:k1)' }, lender);
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await tick(20);
    expect(q('img[data-pkc-asset-key="k1"]')!.hasAttribute('data-pkc-asset-missing')).toBe(
      true,
    );
  });
});

/**
 * P8 段⑲: 🔴 **同じノートのまま本文が差し替わっても、借りた URL が積もらない**。
 *
 * 🔴 段⑪ で骨組みを使い回すようにして以来、`disposeLends()` は
 * **選択が別のノートへ移ったときにしか走らない**。本文の差分描画で
 * `<img>` を含む塊が差し替わると、古い `<img>` は DOM から外れるのに
 * 貸し出しは残り続けた ── 実測: 履歴復元を 5 回で **lend 6 / dispose 0**、
 * 画面の `<img>` は 1 枚。長い編集・履歴の往復ほど常駐が増える
 * (user 指示 2026-07-27「生成とライフサイクル後の速やかな破棄」の違反)。
 *
 * ⚠ 観測点は「画面の `<img>` が 1 枚か」ではない ── それは壊れた実装でも通る。
 *   **借りた数と返した数の差**を見る。
 */
describe('借りた URL の寿命(同一ノートの差し替え)', () => {
  it('🔴 本文が差し替わるたびに、画面から消えたぶんを返す', async () => {
    let lends = 0;
    let disposed = 0;
    const lender: AssetLender = {
      lend: async () => {
        lends += 1;
        return { url: `blob:k1#${lends}`, dispose: () => (disposed += 1) };
      },
      getBlob: async () => null,
    };
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const detail = new DetailRenderer(regions.detail, lender);
    d.onState((s) => detail.render(s));
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => '一行目\n\n![画像](asset:k1)\n',
      persistEntry: async () => stubStamps(),
      deleteEntry: async () => {},
    setEntryParent: async () => {},
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await new Promise((r) => setTimeout(r, 20));

    const ROUNDS = 5;
    for (let i = 1; i <= ROUNDS; i++) {
      d.dispatch({
        type: 'ENTRY_RESTORED',
        mode: 'revision',
        meta: meta('e1'),
        // 上に行が増えるので、画像を含む塊が作り直される
        body: `一行目\n${Array.from({ length: i }, (_, n) => `追加${n}`).join('\n')}\n\n![画像](asset:k1)\n`,
      });
      await new Promise((r) => setTimeout(r, 20));
    }

    // ① 🔴 **測る次元が非ゼロ**(空振り防止)── 借り直しが起きていなければ
    //    「積もらない」は自明に通る
    expect(lends, `借り直しが起きていない(lend=${lends})`).toBeGreaterThan(ROUNDS);
    // ② 画面に出ているのは 1 枚
    expect(root.querySelectorAll('img[data-pkc-asset-key]')).toHaveLength(1);
    // ③ 残高は 1 本(いま画面に出ているぶんだけ)
    expect(lends - disposed, `借りた URL が積もっている(借 ${lends} / 返 ${disposed})`).toBe(1);
  });

  /**
   * 🔴 **使っている URL は返さない**。
   *
   * ⚠ 上の test だけでは「返しすぎ」を捕まえられない ── 借りた直後に全部返す
   * 実装でも残高は 1 に見える(最後の貸出は prune の**後**に積まれるため)。
   * 同じ key を 2 つの塊が参照している状態で**片方だけ**差し替え、
   * 画面に残っている `<img>` の URL が返されていないことを直接見る。
   */
  it('🔴 まだ画面に出ている `<img>` の URL を返してしまわない', async () => {
    const freed = new Set<string>();
    let n = 0;
    const lender: AssetLender = {
      lend: async () => {
        n += 1;
        const url = `blob:k1#${n}`;
        return { url, dispose: () => freed.add(url) };
      },
      getBlob: async () => null,
    };
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const detail = new DetailRenderer(regions.detail, lender);
    d.onState((s) => detail.render(s));
    // 同じ key を**2 つの塊**が参照する
    // ⚠ 差し替えるのは**2 枚目の塊そのもの**(alt を変える)── 別の段落を
    //    いじるだけだと 2 枚とも画面に残ってしまい、この次元を測れない
    const body = (extra: string): string =>
      `上の段落\n\n![画像](asset:k1)\n\n下の段落\n\n![同じ画像${extra}](asset:k1)\n`;
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => body(''),
      persistEntry: async () => stubStamps(),
      deleteEntry: async () => {},
    setEntryParent: async () => {},
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await new Promise((r) => setTimeout(r, 20));
    // 前提: 2 つの参照が **1 本**の貸出を共有している(段⑪ の規約)
    expect(root.querySelectorAll('img[data-pkc-asset-key]'), '参照が 2 つ出ていない').toHaveLength(2);
    expect(n, '同じ key を 2 回借りている').toBe(1);

    // 上の段落だけ差し替える(下の `<img>` はそのまま残る)
    d.dispatch({ type: 'ENTRY_RESTORED', mode: 'revision', meta: meta('e1'), body: body('(直した)') });
    await new Promise((r) => setTimeout(r, 20));
    // 本文を変えない再描画も 1 回通す(勝手に返していないか)
    d.dispatch({ type: 'RENAME_ENTRY_TITLE', lid: 'e1', title: '題名を変えた' });
    await new Promise((r) => setTimeout(r, 20));

    const imgs = [...root.querySelectorAll<HTMLImageElement>('img[data-pkc-asset-key]')];
    expect(imgs.length, '画面から参照が消えた').toBe(2);
    // 前提: 片方だけが borrowed し直された(= 差し替えが起きている)
    expect(n, '差し替えが起きていない(この次元を測れていない)').toBeGreaterThan(1);
    for (const img of imgs) {
      expect(
        freed.has(img.getAttribute('src') ?? ''),
        `画面に出ている URL を返してしまった(${img.getAttribute('src')})`,
      ).toBe(false);
    }
  });
});


/**
 * 🔴 **編集中の面でも `asset:` の画像が出る**(#250 で判明・同時に直した)。
 *
 * ⚠ これは貼付の bug ではない ── **前から在った穴**である。読む面(`paint`)は
 * `hydrateAssetRefs` を呼んでいたのに、**2 面のプレビューと 1 面のライブ
 * エディタは呼んでいなかった**(`hydrateFigures` だけ)。本文に
 * `![…](asset:…)` と書いても、**書いている間は src の無い `<img>`** ──
 * 何も出ない枠のままで、確定するまで見えない。
 * 🔑 露見したのは #250 の実ブラウザ smoke である(貼った直後に出ない)。
 * CLAUDE.md §7「片側を直したら、対称の反対側を必ず疑う」の実例。
 *
 * ⚠ **2 面と 1 面の両方**を見る ── 片方だけ直すのが、まさにこの穴の作られ方。
 */
describe('編集中の面の asset hydrate(#250)', () => {
  const editing = (body: string): AppState => {
    let s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('e1')],
      relations: [],
    }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'e1' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'e1', body }).state;
    return reduce(s, { type: 'START_EDIT' }).state;
  };

  for (const mode of ['split', 'live'] as const) {
    it(`🔴 ${mode} の面でも、貸し出した URL が <img> に差される`, async () => {
      localStorage.setItem('pkc3.editor-mode', mode);
      let lends = 0;
      let disposed = 0;
      const lender: AssetLender = {
        lend: async (key) => {
          lends += 1;
          return { url: `blob:${key}`, dispose: () => (disposed += 1) };
        },
        getBlob: async () => null,
      };
      const root = document.createElement('div');
      // ⚠ **document へ繋ぐ** ── `follower` は `isConnected` で早期 return する
      document.body.append(root);
      const detail = new DetailRenderer(buildShell(root).detail, lender, new MarkdownClient());
      detail.render(editing('本文の上\n\n![貼った絵](asset:k1)\n'));
      await tick(30);

      const img = root.querySelector<HTMLImageElement>('img[data-pkc-asset-key="k1"]');
      expect(img, `${mode}: 参照が描かれていない(この次元を測れていない)`).not.toBeNull();
      expect(img!.getAttribute('src'), `${mode}: src が差されていない(空の枠になる)`).toBe(
        'blob:k1',
      );
      expect(lends, `${mode}: 借りていない`).toBe(1);
      expect(disposed, `${mode}: 画面に出ているのに返してしまった`).toBe(0);
      localStorage.removeItem('pkc3.editor-mode');
    });
  }
});
