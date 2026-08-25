/** @vitest-environment happy-dom */
/**
 * 本文 markdown の `asset:` 参照の hydrate(P4b)pin:
 * - 同一 key の複数参照は **1 lend / 1 URL** を共有
 * - URL は選択遷移(表示の寿命終端)で必ず dispose(即破棄規律)
 * - 不在 key は data-pkc-asset-missing(黙って空にしない)
 * - 解決前に選択が移ったら結果を捨てて即 dispose(stale 注入なし)
 */
import { stubStamps } from '../helpers/store-stamps';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    bodyChars: null,
  };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** 条件が満たされるまで待つ(⚠ 固定の待ちは静穏の畳み込みで空振りする)。 */
async function waitFor(ok: () => boolean, why: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return;
    await tick(10);
  }
  throw new Error(why);
}

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
    /**
     * ⚠ **題名だけの口**(#178)── 本物は本文に触らない。
     *   だから fake も本文を持たない(触らないものは持たない)。
     */
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () =>
      Promise.reject(new Error('この test では添付の差し替えを使わない')),
    reorderEntry: async () => stubStamps(),
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
      /**
       * ⚠ **題名だけの口**(#178)── 本物は本文に触らない。
       *   だから fake も本文を持たない(触らないものは持たない)。
       */
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () =>
        Promise.reject(new Error('この test では添付の差し替えを使わない')),
      reorderEntry: async () => stubStamps(),
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
      /**
       * ⚠ **題名だけの口**(#178)── 本物は本文に触らない。
       *   だから fake も本文を持たない(触らないものは持たない)。
       */
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () =>
        Promise.reject(new Error('この test では添付の差し替えを使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
      deleteEntry: async () => {},
    setEntryParent: async () => {},
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await new Promise((r) => setTimeout(r, 20));
    // 前提: 2 つの参照が **1 本**の貸出を共有している(段⑪ の規約)
    const first = [...root.querySelectorAll<HTMLImageElement>('img[data-pkc-asset-key]')];
    expect(first, '参照が 2 つ出ていない').toHaveLength(2);
    expect(n, '同じ key を 2 回借りている').toBe(1);

    // 上の段落だけ差し替える(下の `<img>` はそのまま残る)
    d.dispatch({ type: 'ENTRY_RESTORED', mode: 'revision', meta: meta('e1'), body: body('(直した)') });
    await new Promise((r) => setTimeout(r, 20));
    // 本文を変えない再描画も 1 回通す(勝手に返していないか)
    d.dispatch({ type: 'RENAME_ENTRY_TITLE', lid: 'e1', title: '題名を変えた' });
    await new Promise((r) => setTimeout(r, 20));

    const imgs = [...root.querySelectorAll<HTMLImageElement>('img[data-pkc-asset-key]')];
    expect(imgs.length, '画面から参照が消えた').toBe(2);
    /**
     * 前提: **塊が実際に差し替わった**(この次元を測れている)。
     *
     * ⚠ 以前はここを「借り直しが増えたか(`n > 1`)」で見ていたが、2026-08-18 に
     * **生きている貸出を使い回す**ようにしたので、差し替わっても借り直しは増えない
     * ── 観測点を「**node が入れ替わったか**」へ移す(そちらが本来の次元である)。
     */
    expect(
      first.some((img) => !img.isConnected),
      '差し替えが起きていない(この次元を測れていない)',
    ).toBe(true);
    // 🔑 使い回しているので、借りた数は増えない(IDB 読みも URL も 1 本のまま)
    expect(n, '生きている貸出を使い回していない(tick ごとに借り直す)').toBe(1);
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
  // ⚠ **`afterEach` で消す**(2026-08-18、着地前レビュー)── test の末尾に置くと
  //   assert が落ちた回に走らず、後続 test へ `'split'` が漏れる
  afterEach(() => localStorage.removeItem('pkc3.editor-mode'));

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
    });
  }
});

/**
 * 🔴 **編集中の面でも、借りた URL が積もらない**(#250 の着地前レビュー)。
 *
 * ⚠ 既存の寿命 test(上)は**読む面だけ**を見ており、今回足した 2 面の hydrate は
 * 「1 回描いて 1 本借りた」しか測っていなかった ── `pruneLends()` を消す変異が
 * **全 test 緑のまま通る**状態だった(実測)。
 * 🔑 打鍵で塊が作り直される次元(= 積もる次元)を、繰り返しで測る。
 */
describe('編集中の面の URL の寿命(#250)', () => {
  afterEach(() => localStorage.removeItem('pkc3.editor-mode'));

  it('🔴 打つたびに塊が作り直されても、生きているぶんしか残らない', async () => {
    localStorage.setItem('pkc3.editor-mode', 'split');
    let made = 0;
    let freed = 0;
    const lender: AssetLender = {
      lend: async (key) => {
        made += 1;
        return { url: `blob:${key}#${made}`, dispose: () => (freed += 1) };
      },
      getBlob: async () => null,
    };
    const root = document.createElement('div');
    document.body.append(root);
    const detail = new DetailRenderer(buildShell(root).detail, lender, new MarkdownClient());

    let s = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('e1')],
      relations: [],
    }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'e1' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'e1', body: '![絵](asset:k1)' }).state;
    s = reduce(s, { type: 'START_EDIT' }).state;
    detail.render(s);
    await tick(30);
    expect(made, '前提: 1 本も借りていない(この次元を測れていない)').toBe(1);

    /**
     * ⚠ **key を毎回変える。** 同じ key なら使い回されて借り直しが起きないので、
     * 「積もらない」が**自明に**成立してしまう(= 測っていない)。別の添付へ
     * 差し替えていく編集が、いちばん積もる形である。
     */
    // ⚠ **打鍵で駆動する** ── 編集中の面は state の再描画では動かない
    //   (`detail.ts` 冒頭「編集中は DOM を一切触らない」)。プレビューは
    //   textarea の `input` が回している ── そこを叩かないと 1 度も描き直らない。
    const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]');
    expect(ta, '前提: 2 列の編集欄が出ていない').not.toBeNull();
    const ROUNDS = 5;
    for (let i = 1; i <= ROUNDS; i += 1) {
      ta!.value = `![絵](asset:k${i + 1})`;
      ta!.dispatchEvent(new Event('input', { bubbles: true }));
      // 🔴 **この回の絵が実際に画面へ出るまで待つ**(follower は静穏で畳むので、
      //    固定の待ちだと 5 回の打鍵が 1 回に潰れて「積もらない」が自明に通る)
      await waitFor(
        () =>
          root.querySelector(`img[data-pkc-asset-key="k${i + 1}"]`) !== null,
        `${i} 回目の絵が出ない`,
      );
    }

    const imgs = [...root.querySelectorAll<HTMLImageElement>('img[data-pkc-asset-key]')];
    expect(imgs, '画面から画像が消えた').toHaveLength(1);
    expect(imgs[0]!.getAttribute('src'), 'src が差されていない').toMatch(/^blob:/);
    // 前提: 毎回借り直している(この次元を測れている)
    expect(made, '借り直しが起きていない').toBe(ROUNDS + 1);
    // 🔑 **借りたまま残っているのは、画面に出ている 1 本だけ**
    expect(
      made - freed,
      `借りたまま ${made - freed} 本残っている(made=${made} freed=${freed})`,
    ).toBe(1);
  });
});

/**
 * 🔴 **1 面で行を開いて閉じても、画像が消えない**(#250 の着地前レビュー)。
 *
 * ⚠ `RowSwap` 側は「入り直した要素を外へ渡す」ところまで pin されているが、
 * **受け取った `detail` が実際に差し直しているか**は誰も見ていなかった ──
 * `onInserted` の中身を空にする変異が**全 test 緑のまま通った**(実測)。
 * 🔑 壊れる当の振る舞い(`<img>` の `src` が戻るか)を、この面で直接見る。
 */
describe('1 面で行を閉じたあとの asset hydrate(#250)', () => {
  afterEach(() => localStorage.removeItem('pkc3.editor-mode'));

  it('🔴 画像の行を開いて閉じると、src が差し直される', async () => {
    localStorage.setItem('pkc3.editor-mode', 'live');
    let made = 0;
    const lender: AssetLender = {
      lend: async (key) => {
        made += 1;
        return { url: `blob:${key}#${made}`, dispose: () => {} };
      },
      getBlob: async () => null,
    };
    const root = document.createElement('div');
    document.body.append(root);
    const detail = new DetailRenderer(buildShell(root).detail, lender, new MarkdownClient());

    let st = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('e1')],
      relations: [],
    }).state;
    st = reduce(st, { type: 'SELECT_ENTRY', lid: 'e1' }).state;
    st = reduce(st, {
      type: 'BODY_LOADED',
      lid: 'e1',
      body: '上の段落。\n\n![絵](asset:k1)\n\n下の段落。\n',
    }).state;
    st = reduce(st, { type: 'START_EDIT' }).state;
    detail.render(st);
    await tick(30);

    const img = () => root.querySelector<HTMLImageElement>('img[data-pkc-asset-key="k1"]');
    expect(img(), '前提: 1 面に画像が描かれていない').not.toBeNull();
    await waitFor(() => (img()?.getAttribute('src') ?? '') !== '', '前提: src が差されない');

    // 画像の塊そのものを押して開く(= その塊が原文の入力欄に化ける)
    img()!.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]');
    expect(ta, '前提: 画像の行が開かない(この次元を測れていない)').not.toBeNull();

    // ⚠ **何も打たずに**閉じる ── 本文が変わらないので描き直しは来ない
    ta!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(30);

    expect(img(), '閉じたら画像そのものが消えた').not.toBeNull();
    await waitFor(
      () => (img()?.getAttribute('src') ?? '').startsWith('blob:'),
      '閉じたら src が空になった(画面から画像が消える)',
    );
  });
});
