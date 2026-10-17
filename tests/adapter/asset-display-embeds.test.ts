/** @vitest-environment happy-dom */
/**
 * 🔴 添付の表示の不具合(#1087 A3 / A4)── 本文の画像の理由の 1 行 / 埋め込みの中の「添付から読む囲み」。
 *
 * - A3: 本文に貼った画像 `![](asset:K)` が読めない形式・壊れた画像・0 バイトのとき、壊れた画像アイコンで
 *   終わらず「このブラウザでは表示できません」の 1 行になる(章の別窓は `chapter-windows.test.ts`)。
 * - A4: 付箋の板(place-embed)と章の埋め込み(section-embed)の中の ```` ```csv asset:K ```` が、
 *   案内のまま残らず中身(表)に置き換わる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer, type AssetLender } from '../../src/adapter/ui/render/detail';
import { PlaceEmbeds, type PlaceEmbedDeps } from '../../src/adapter/ui/render/place-embed';
import { SectionEmbeds, type SectionEmbedDeps } from '../../src/adapter/ui/render/section-embed';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function waitFor(ok: () => boolean, why: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return;
    await tick(10);
  }
  throw new Error(why);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  // ⚠ happy-dom の IntersectionObserver は何も通知しない ── 板の枠が「近づかない」ままになる(place-embed.test.ts と同じ退避)
  vi.stubGlobal('IntersectionObserver', undefined);
  document.body.textContent = '';
});

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

describe('#1087 A3 本文の画像が読めないとき、理由の 1 行になる', () => {
  it('🔴 error が来たら壊れた画像ではなく「このブラウザでは表示できません」の行に差し替わる', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const lender: AssetLender = {
      lend: async (key) => ({ url: `blob:${key}`, dispose: () => {} }),
      getBlob: async () => null,
    };
    const d = new Dispatcher();
    const detail = new DetailRenderer(buildShell(root).detail, lender);
    d.onState((s) => detail.render(s));
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => '![絵](asset:k1)',
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
      deleteEntry: async () => {},
      setEntryParent: async () => {},
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'e1' });
    await waitFor(() => root.querySelector('img[data-pkc-asset-key="k1"][src]') !== null, '画像に src が入らない');
    const img = root.querySelector<HTMLImageElement>('img[data-pkc-asset-key="k1"]')!;
    // 対照群:error が来るまでは画像のまま
    expect(root.querySelector('[data-pkc-field="attachment-undecodable"]')).toBeNull();
    img.dispatchEvent(new Event('error'));
    expect(root.querySelector('img[data-pkc-asset-key="k1"]'), '壊れた画像が残っている').toBeNull();
    const why = root.querySelector('[data-pkc-field="attachment-undecodable"]');
    expect(why?.textContent ?? '').toContain('このブラウザでは表示できません');
  });

  it('🔴 同じ添付の画像を後から足した回(生きている貸出の使い回し)でも、新しい画像が理由の行になる', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    let lends = 0;
    const detail = new DetailRenderer(buildShell(root).detail, {
      lend: async (k) => {
        lends++;
        return { url: `blob:${k}`, dispose: () => {} };
      },
      getBlob: async () => null,
    });
    let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('e1')], relations: [] }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'e1' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'e1', body: '![a](asset:k1)' }).state;
    detail.render(s);
    await tick(30);
    s = reduce(s, { type: 'BODY_LOADED', lid: 'e1', body: '![a](asset:k1)\n\n![b](asset:k1)' }).state;
    detail.render(s);
    await tick(30);
    const imgs = [...root.querySelectorAll<HTMLImageElement>('img[data-pkc-asset-key="k1"]')];
    // 前提:2 枚とも src が入り、借りたのは 1 回(= 使い回しの道を通った)
    expect(imgs).toHaveLength(2);
    expect(imgs.every((i) => i.getAttribute('src') === 'blob:k1')).toBe(true);
    expect(lends, '前提が崩れている(使い回しの道を通っていない)').toBe(1);
    imgs[1]!.dispatchEvent(new Event('error'));
    expect(root.querySelectorAll('[data-pkc-field="attachment-undecodable"]')).toHaveLength(1);
    expect(root.querySelectorAll('img[data-pkc-asset-key="k1"]')).toHaveLength(1);
  });
});

const CSV_FENCE = '```csv asset:ast-k1\n```';
const blobOf = (text: string): Blob => new Blob([text], { type: 'text/plain' });

describe('#1087 A4 埋め込みの中の「添付から読む囲み」が中身になる', () => {
  it('🔴 章の埋め込み(section-embed)の中の囲みが、案内のままでなく表になる', async () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<div class="pkc-transclusion-placeholder" data-pkc-embed-ref="entry:src#h/plan"></div>';
    document.body.append(host);
    const embeds = new SectionEmbeds();
    const deps: SectionEmbedDeps = {
      selfLid: 'host',
      excerptOf: () => ({ text: `## Plan\n${CSV_FENCE}`, cut: false }),
      metaOf: (l) => (l === 'src' || l === 'host' ? { title: 't-' + l, archetype: 'text' } : undefined),
      render: (t) => Promise.resolve(renderMarkdown(t)),
      wanted: () => {},
      lender: { lend: async () => null, getBlob: async () => blobOf('あ,い\n1,2') },
      figures: () => [],
      currentContainerId: 'c1',
    };
    embeds.sync(host, deps);
    await waitFor(() => host.querySelector('.pkc-section-embed table') !== null, '囲みが表にならない');
    const el = host.querySelector('.pkc-section-embed')!;
    expect(el.querySelector('[data-pkc-fence-asset-key]'), '器が残っている').toBeNull();
    expect(el.textContent).not.toContain('中身は添付');
    // 読み取り専用の掃除を通る(コピーの帯・原文の面は外れる)
    expect(el.querySelector('.pkc-md-copy-btn, .pkc-render-source'), '掃除を通っていない').toBeNull();
    embeds.release();
  });

  it('🔴 付箋の板(place-embed)の中の囲みが、案内のままでなく表になる', async () => {
    const host = document.createElement('div');
    host.innerHTML = '<div class="pkc-format-block pkc-place" data-pkc-place-entry="src"></div>';
    document.body.append(host);
    const embeds = new PlaceEmbeds();
    const deps: PlaceEmbedDeps = {
      selfLid: 'board',
      excerptOf: () => ({ text: CSV_FENCE, cut: false }),
      metaOf: (l) => (l === 'src' ? { title: 't-src', archetype: 'text' } : undefined),
      render: (t) => Promise.resolve(renderMarkdown(t)),
      wanted: () => {},
      lender: { lend: async () => null, getBlob: async () => blobOf('あ,い\n1,2') },
      figures: () => [],
      viewRoot: null,
      currentContainerId: 'c1',
    };
    embeds.sync(host, deps);
    await waitFor(() => host.querySelector('[data-pkc-field="place-body"] table') !== null, '囲みが表にならない');
    const slot = host.querySelector('[data-pkc-field="place-body"]')!;
    expect(slot.querySelector('[data-pkc-fence-asset-key]'), '器が残っている').toBeNull();
    expect(slot.textContent).not.toContain('中身は添付');
    expect(slot.querySelector('.pkc-md-copy-btn, .pkc-render-source'), '掃除を通っていない').toBeNull();
    embeds.release();
  });

  it('🔴 読めない添付は理由が出る(黙って案内のままにしない)', async () => {
    const host = document.createElement('div');
    host.innerHTML = '<div class="pkc-format-block pkc-place" data-pkc-place-entry="src"></div>';
    document.body.append(host);
    const embeds = new PlaceEmbeds();
    embeds.sync(host, {
      selfLid: 'board',
      excerptOf: () => ({ text: CSV_FENCE, cut: false }),
      metaOf: (l) => (l === 'src' ? { title: 't-src', archetype: 'text' } : undefined),
      render: (t) => Promise.resolve(renderMarkdown(t)),
      wanted: () => {},
      lender: { lend: async () => null, getBlob: async () => null },
      figures: () => [],
      viewRoot: null,
      currentContainerId: 'c1',
    });
    await waitFor(
      () => host.querySelector('[data-pkc-fence-asset-error]') !== null,
      '読めない理由が出ない',
    );
    embeds.release();
  });

  it('🔴 面を捨てたあとに読み込みが終わっても、何も差し込まない(寿命の終端)', async () => {
    const host = document.createElement('div');
    host.innerHTML = '<div class="pkc-format-block pkc-place" data-pkc-place-entry="src"></div>';
    document.body.append(host);
    const embeds = new PlaceEmbeds();
    let open: (b: Blob) => void = () => {};
    const gate = new Promise<Blob>((r) => {
      open = r;
    });
    embeds.sync(host, {
      selfLid: 'board',
      excerptOf: () => ({ text: CSV_FENCE, cut: false }),
      metaOf: (l) => (l === 'src' ? { title: 't-src', archetype: 'text' } : undefined),
      render: (t) => Promise.resolve(renderMarkdown(t)),
      wanted: () => {},
      lender: { lend: async () => null, getBlob: () => gate },
      figures: () => [],
      viewRoot: null,
      currentContainerId: 'c1',
    });
    await waitFor(() => host.querySelector('[data-pkc-fence-asset-key]') !== null, '前提が崩れている(器が無い)');
    embeds.release();
    open(blobOf('あ,い\n1,2'));
    await tick(50);
    expect(host.querySelector('table'), '捨てた面へ差し込んだ').toBeNull();
    expect(host.querySelector('[data-pkc-fence-asset-key]')).not.toBeNull();
  });

  it('🔴 章の埋め込みも、面を捨てたあとに読み込みが終わっても何も差し込まない', async () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<div class="pkc-transclusion-placeholder" data-pkc-embed-ref="entry:src#h/plan"></div>';
    document.body.append(host);
    const embeds = new SectionEmbeds();
    let open: (b: Blob) => void = () => {};
    const gate = new Promise<Blob>((r) => {
      open = r;
    });
    embeds.sync(host, {
      selfLid: 'host',
      excerptOf: () => ({ text: `## Plan\n${CSV_FENCE}`, cut: false }),
      metaOf: (l) => (l === 'src' || l === 'host' ? { title: 't-' + l, archetype: 'text' } : undefined),
      render: (t) => Promise.resolve(renderMarkdown(t)),
      wanted: () => {},
      lender: { lend: async () => null, getBlob: () => gate },
      figures: () => [],
      currentContainerId: 'c1',
    });
    await waitFor(() => host.querySelector('[data-pkc-fence-asset-key]') !== null, '前提が崩れている(器が無い)');
    embeds.release();
    open(blobOf('あ,い\n1,2'));
    await tick(50);
    expect(host.querySelector('table'), '捨てた面へ差し込んだ').toBeNull();
    expect(host.querySelector('[data-pkc-fence-asset-key]')).not.toBeNull();
  });
});
