/** @vitest-environment happy-dom */
/**
 * 🔴 **囲みの中身を添付から取る**の配線(#444 段①)。
 *
 * 純関数(`takeFenceAsset` / `renderFenceFromAsset`)は
 * `tests/features/fence-asset.test.ts` が見ている。⚠ **その間の配線**は
 * 誰も通らない(CLAUDE.md §7「A と B が合意していることは、A の test にも
 * B の test にも書けない」)── ここがその 1 本である。
 *
 * 見るのは 6 点:
 * ① 添付の字で**器が中身に置き換わる**(csv なら表になる)
 * ② 🔴 **読めなかったら理由が出る** ── 黙って器のままにしない
 * ③ 🔴 **大きすぎるものは読まない**(大きさを言う)
 * ④ 位置の印(`data-pkc-source-line`)を**差し替えた要素へ写す**
 * ⑤ 🔴 **同じ添付を 2 回読まない**(打鍵のたびに IDB を読まない)
 * ⑥ 🔴 **ノートを移ったら憶えた字を手放す**(別のノートの本文を握り続けない)
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
import { initialState, reduce } from '../../src/adapter/state/app-state';

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
  const detail = new DetailRenderer(buildShell(root).detail, lender);
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
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  return { d, q, root };
}

/** ⚠ happy-dom の `Blob.text()` は使える。⚠ 大きさは `size` を見るので嘘をつけない。 */
const blobOf = (text: string): Blob => new Blob([text], { type: 'text/plain' });

describe('#444 段① 囲みの中身を添付から取る', () => {
  it('🔴 添付の字で器が中身に置き換わる(csv なら表になる)', async () => {
    const r = setup(
      { e1: '```csv asset:ast-k1\n```' },
      { lend: async () => null, getBlob: async () => blobOf('あ,い\n1,2') },
    );
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await waitFor(() => r.q('[data-pkc-field="detail-body"] table') !== null, '表にならない');
    const table = r.q('[data-pkc-field="detail-body"] table')!;
    expect(table.textContent, '添付の字が出ていない').toContain('あ');
    expect(table.textContent).toContain('1');
    // 器は消えている(二重に残さない)
    expect(r.q('[data-pkc-fence-asset-key]'), '器が残っている').toBeNull();
  });

  it('🔴 見つからなければ理由が出る(黙って器のままにしない)', async () => {
    const r = setup(
      { e1: '```csv asset:ast-none\n```' },
      { lend: async () => null, getBlob: async () => null },
    );
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await waitFor(() => r.q('[data-pkc-fence-asset-error]') !== null, '理由が出ない');
    expect(r.q('[data-pkc-fence-asset-error]')!.textContent).toContain('見つかりません');
    // ⚠ 「読み込んでいます」のまま残らない(そこが直っていることまで見る)
    expect(r.q('[data-pkc-fence-asset-pending]'), '器の字が残っている').toBeNull();
  });

  /**
   * 🔴 **大きくても読む**(#492。user 指示 2026-08-27)。
   * ⚠ かつて 2MB を超えると**読まずに**「大きすぎます」を出していた。
   */
  it('🔴 2MB を超えるものでも読む(旧上限を撤廃した)', async () => {
    const OLD_CAP = 2 * 1024 * 1024; // ⚠ 旧 `MAX_FENCE_ASSET_BYTES`(いまは存在しない)
    let read = 0;
    const big = {
      size: OLD_CAP + 1,
      text: async () => {
        read++;
        return 'あ,い\n1,2';
      },
    };
    const r = setup(
      { e1: '```csv asset:ast-big\n```' },
      { lend: async () => null, getBlob: async () => big as unknown as Blob },
    );
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await waitFor(() => read > 0, '大きいだけで読まなかった');
    expect(read, '読んでいない').toBe(1);
    expect(r.q('[data-pkc-fence-asset-error]'), '大きさで断った').toBeNull();
  });

  it('⚠ 位置の印を、差し替えた要素へ写す(押した行の対応を失わない)', async () => {
    const r = setup(
      { e1: '# 題\n\n```csv asset:ast-k1\n```' },
      { lend: async () => null, getBlob: async () => blobOf('あ,い') },
    );
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await waitFor(() => r.q('[data-pkc-field="detail-body"] table') !== null, '表にならない');
    const block = r.q('[data-pkc-field="detail-body"] .pkc-md-block[data-pkc-source-line]');
    expect(block, '位置の印が落ちている').not.toBeNull();
    expect(block!.querySelector('table'), '印を持つ塊が表でない').not.toBeNull();
  });

  it('🔴 同じ添付は 2 回読まない(打鍵のたびに IDB を読まない)', async () => {
    let reads = 0;
    const r = setup(
      { e1: '```csv asset:ast-k1\n```\n\n```tsv asset:ast-k1\n```' },
      {
        lend: async () => null,
        getBlob: async () => {
          reads++;
          return blobOf('あ,い');
        },
      },
    );
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await waitFor(
      () => r.root.querySelectorAll('[data-pkc-field="detail-body"] table').length === 2,
      '2 つとも描けていない',
    );
    expect(reads, '同じ鍵を 2 回読んだ').toBe(1);
  });

  it('🔴 ノートを移ったら憶えた字を手放す(別のノートの本文を握り続けない)', async () => {
    let reads = 0;
    const r = setup(
      { e1: '```csv asset:ast-k1\n```', e2: '```csv asset:ast-k1\n```' },
      {
        lend: async () => null,
        getBlob: async () => {
          reads++;
          return blobOf('あ,い');
        },
      },
    );
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await waitFor(() => r.q('[data-pkc-field="detail-body"] table') !== null, 'e1 が描けない');
    expect(reads).toBe(1);
    r.d.dispatch({ type: 'SELECT_ENTRY', lid: 'e2' });
    await waitFor(() => reads === 2, '別のノートで読み直していない(字を握ったまま)');
    // 🔑 対照群 ── 読み直した結果もちゃんと描けている(reads が増えただけではない)
    await waitFor(() => r.q('[data-pkc-field="detail-body"] table') !== null, 'e2 が描けない');
  });
});

/**
 * 🔴 **打鍵のたびに IDB を読まない**(#444 段①。変異試験 M13 が SURVIVED で教えた)。
 *
 * ⚠ 1 稿目は「同じ本文に同じ鍵を 2 つ書く」で測っていたが、**1 回の hydrate の中で
 *   鍵を畳んでいる**ので、憶えを消しても読みは 1 回のままだった ── 守っていたのは
 *   `new Set(...)` のほうで、憶えではなかった(CLAUDE.md §1「救い手が別に在った」)。
 * 🔑 憶えが効くのは**塊が作り直されたとき**である ── 編集中の面は打鍵ごとに
 *   作り直すので、そこで測る。
 * ⚠ **作り直されたことを対照群で見る**(表の node が別物になっていること)──
 *   見ないと「読みが 1 回」は**そもそも 1 度しか描いていない**だけかもしれない。
 */
describe('#444 段① 憶えが効いているか(編集中)', () => {
  afterEach(() => localStorage.removeItem('pkc3.editor-mode'));

  it('🔴 打鍵で塊が作り直されても、添付は 1 回しか読まない', async () => {
    localStorage.setItem('pkc3.editor-mode', 'split');
    let reads = 0;
    const lender: AssetLender = {
      lend: async () => null,
      getBlob: async () => {
        reads += 1;
        return blobOf('あ,い\n1,2');
      },
    };
    const root = document.createElement('div');
    document.body.append(root);
    const detail = new DetailRenderer(buildShell(root).detail, lender, new MarkdownClient());
    const FENCE = '```csv asset:ast-k1\n```';
    let st = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('e1')],
      relations: [],
    }).state;
    st = reduce(st, { type: 'SELECT_ENTRY', lid: 'e1' }).state;
    st = reduce(st, { type: 'BODY_LOADED', lid: 'e1', body: FENCE }).state;
    st = reduce(st, { type: 'START_EDIT' }).state;
    detail.render(st);

    const tableNow = (): HTMLElement | null =>
      root.querySelector<HTMLElement>('[data-pkc-region="detail"] table');
    await waitFor(() => tableNow() !== null, '前提: プレビューに表が出ていない');
    expect(reads, '前提: 1 回も読んでいない').toBe(1);
    const first = tableNow();

    const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]');
    expect(ta, '前提: 2 列の編集欄が出ていない').not.toBeNull();
    /**
     * ⚠ **囲みの上に行を足す** ── 囲みそのものを変えると別の塊になるので、
     *   「同じ囲みが作り直された」を測れない。位置がずれるだけで塊は作り直される。
     */
    for (let i = 1; i <= 3; i += 1) {
      ta!.value = `${'# 題\n\n'.repeat(i)}${FENCE}`;
      ta!.dispatchEvent(new Event('input', { bubbles: true }));
      await waitFor(
        () => root.querySelectorAll('[data-pkc-region="detail"] h1').length === i,
        `${i} 回目の打鍵がプレビューに届いていない`,
      );
    }
    await waitFor(() => tableNow() !== null, '打鍵のあと表が消えた');
    // 🔑 **対照群** ── 塊は本当に作り直されている(でなければ下の主張は自明)
    expect(tableNow(), '塊が 1 度も作り直されていない(この次元を測れていない)').not.toBe(first);
    // 🔴 それでも読みは 1 回きり
    expect(reads, '打鍵のたびに添付を読んでいる').toBe(1);
  });
});
