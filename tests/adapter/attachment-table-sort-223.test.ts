/** @vitest-environment happy-dom */
/** #1163 依頼 223: 添付の説明の表も、見出しを押して並べ替えられる(本文と同じ 1 本)。 */
import { beforeEach, describe, expect, it } from 'vitest';
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
const TRANSCRIPT = '\n\n| 品 | 金額 |\n|---|---|\n| あ | 9 |\n| い | 100 |\n';

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
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a1'), meta('a2')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
  await tick(30);
  return { root, d };
}

describe('添付の説明の表の並べ替え(依頼 223)', () => {
  it('🔴 見出しを押すと、数として昇順に並ぶ', async () => {
    const { root } = await open('application/pdf', 'doc.pdf');
    const th = root.querySelectorAll<HTMLElement>('[data-pkc-field="detail-body"] thead th');
    expect(th, '前提: 説明の表が描かれていない').toHaveLength(2);
    th[1]!.click();
    const col = Array.from(root.querySelectorAll('[data-pkc-field="detail-body"] tbody tr')).map((tr) => tr.children[1]?.textContent);
    expect(col, '並べ替えが付いていない(9 が 100 より後ろ)').toEqual(['9', '100']);
    expect(th[1]!.getAttribute('aria-sort')).toBe('ascending');
  });
});
