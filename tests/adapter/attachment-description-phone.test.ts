/** @vitest-environment happy-dom */
/**
 * 🔴 **添付の説明も、読む面と同じ「電話番号を押せる字にする」設定に従う**(#1087)。
 * ⚠ 説明は読む面と別の経路で描くので、`phoneLinks` を渡し忘れると設定を入れた人の添付だけ押せない。
 * 以下の詳細ハーネスは detail-seek-links.test.ts(#1232)の写し。
 *
 * 描画そのものは `tests/features/markdown-seek-link.test.ts`、押した後は
 * `tests/adapter/seek-media-actions.test.ts`。**ここが見るのは 2 つ**:
 *   ① どの面が旗を立てるか(再生機が居る面だけ。PDF の説明の `12:30 会議` を押せる字にしない)
 *   ② 🔴 **本物どうしを繋ぐ** ── 実物の詳細が組んだ DOM を、実物の受け口が読んで再生機を動かすか
 *      (片端ずつ模した test は、綴りの食い違いを両方緑のまま通す)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appPhoneLinks } from '../../src/adapter/ui/render/phone-links';
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
const TRANSCRIPT = '\n\n連絡先 090-1234-5678 まで\n';

beforeEach(() => {
  document.body.textContent = '';
});
afterEach(() => appPhoneLinks.setEnabled(false));

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

describe('添付の説明の電話番号(#1087)', () => {
  it('🔴 設定を入れていると、説明の電話番号が tel: のリンクになる', async () => {
    appPhoneLinks.setEnabled(true);
    const { root } = await open('application/pdf', 'doc.pdf');
    const a = root.querySelector('a[href^="tel:"]');
    expect(a, '説明の電話番号が押せる字になっていない').not.toBeNull();
    expect(a!.getAttribute('href')).toBe('tel:09012345678');
  });

  it('対照群 ── 設定が切(既定)なら押せる字にしない(字は残る)', async () => {
    const { root } = await open('application/pdf', 'doc.pdf');
    expect(root.querySelector('a[href^="tel:"]')).toBeNull();
    expect(root.textContent).toContain('090-1234-5678');
  });
});
