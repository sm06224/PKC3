/** @vitest-environment happy-dom */
/**
 * 🔴 **リンク先の印を取り込む、押し所から本文まで**(#856 段②)。
 *
 * 意味論(何を取りに行くか)は `tests/adapter/adopt-favicon.test.ts` /
 * `tests/features/favicon.test.ts`。**ここが見るのは繋がり**である:
 *
 * 1. 🔴 **アドレスの在るノートにだけ**押し所が出る
 * 2. 🔴 設定で「常にオフ」なら**取りに行かない**。⚠ そして**黙って終わらない**
 * 3. 🔴 取れたら**鍵が本文に着地する**
 * 4. 🔴 取れなかったら**理由が出る**
 * 5. 🔴 **字を選んだら鍵が消える**(消さないと「選んだのに変わらない」)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer, type AssetLender } from '../../src/adapter/ui/render/detail';
import { appExternalImages } from '../../src/adapter/ui/render/external-images';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';

const tick = (ms = 20): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string, title: string): EntryMeta {
  return {
    lid,
    title,
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

/** アドレスの在るノート(URL タイル)。 */
const urlBody = (extra: readonly string[] = []): string =>
  ['---', 'attachment.launcher_url: https://e.test/', ...extra, '---', '説明', ''].join('\n');

/** 添付の HTML(対照群 ── 取りに行く先が無い)。 */
const appBody = (): string =>
  [
    '---',
    'attachment.name: 電卓.html',
    'attachment.mime: text/html',
    'attachment.asset_key: k',
    'attachment.registered_as_app: true',
    '---',
    '説明',
    '',
  ].join('\n');

const lender: AssetLender = {
  lend: async () => ({ url: 'blob:x', dispose: () => {} }),
  getBlob: async () => null,
};

beforeEach(() => {
  document.body.textContent = '';
  appExternalImages.setMode('ask');
});
afterEach(() => {
  appExternalImages.setMode('ask');
});

function setup(
  body: string,
  adopt?: (url: string) => Promise<{ ok: true; assetKey: string } | { ok: false; why: string }>,
) {
  const root = document.createElement('div');
  document.body.append(root);
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail, lender);
  const d = new Dispatcher();
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  d.onState((s) => detail.render(s));
  bindActions(root, d, adopt === undefined ? {} : { adoptLinkIcon: adopt });
  const bodies: Record<string, string> = { a1: body };
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => bodies[lid] ?? null,
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      bodies[e.lid] = e.body;
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a1', 'サイト')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a1' });
  const q = <T extends HTMLElement>(sel: string): T | null => root.querySelector<T>(sel);
  return { root, d, sent, bodies, q, btn: () => q<HTMLButtonElement>('[data-pkc-field="adopt-link-icon"]') };
}

/** いまの帯に出ている断り文。 */
const errorOf = (h: { d: Dispatcher }): string | null => h.d.getState().error;

describe('押し所の出し分け(#856 段②)', () => {
  it('🔴 アドレスの在るノートには出る', async () => {
    const h = setup(urlBody());
    await tick();
    expect(h.btn(), '押し所が出ていない').not.toBeNull();
    expect(h.btn()!.getAttribute('data-pkc-url'), '飛び先を器が持っていない').toBe('https://e.test/');
  });

  it('⚠ 添付の HTML には出ない(取りに行く先が無い)', async () => {
    const h = setup(appBody());
    await tick();
    // ⚠ 空振り防止 ── そもそも設定の器が出ていないなら、この test は何も見ていない
    expect(h.q('[data-pkc-field="app-icon"]'), '前提が崩れている(設定が出ていない)').not.toBeNull();
    expect(h.btn(), '取りに行く先が無いのに押し所が出た').toBeNull();
  });
});

describe('押したときに何が起きるか(#856 段②)', () => {
  it('🔴 設定が「常にオフ」なら、取りに行かない ── そして理由を出す', async () => {
    appExternalImages.setMode('never');
    const adopt = vi.fn(async () => ({ ok: true as const, assetKey: 'k1' }));
    const h = setup(urlBody(), adopt);
    await tick();
    h.btn()!.click();
    await tick();
    expect(adopt, '設定で止めているのに取りに行った').not.toHaveBeenCalled();
    expect(errorOf(h) ?? '', '黙って終わった(押して何も起きない)').toContain('常にオフ');
  });

  it('⚠ 対照群 ── 「常に確認」なら取りに行く(押したこと自体が、その 1 回の同意)', async () => {
    const adopt = vi.fn(async () => ({ ok: true as const, assetKey: 'k1' }));
    const h = setup(urlBody(), adopt);
    await tick();
    h.btn()!.click();
    await tick();
    expect(adopt, '止める理由が無いのに取りに行かなかった').toHaveBeenCalledWith('https://e.test/');
  });

  it('🔴 取れたら、鍵が本文に着地する', async () => {
    const h = setup(urlBody(), async () => ({ ok: true as const, assetKey: 'k1' }));
    await tick();
    h.btn()!.click();
    await tick(40);
    expect(h.bodies.a1, '鍵が本文に書かれていない').toContain('attachment.app_icon_asset_key: k1');
  });

  it('🔴 取れなかったら、理由を出す(黙って終わらない)', async () => {
    const h = setup(urlBody(), async () => ({
      ok: false as const,
      why: 'そのサイトは印を置いていませんでした',
    }));
    await tick();
    h.btn()!.click();
    await tick(40);
    expect(errorOf(h) ?? '', '理由が出ていない').toContain('印を置いていません');
    expect(h.bodies.a1, '取れていないのに鍵を書いた').not.toContain('app_icon_asset_key');
  });

  it('⚠ 押している間は押せない(連打で同じサイトへ何度も出ない)', async () => {
    /**
     * ⚠ **箱に入れて受ける** ── 素の変数に入れると、tsc は「閉包が走った」ことを
     *   見ないので `null` に絞り、呼べなくなる(`Type 'never' has no call signatures`)。
     */
    const held: { release: (() => void) | null } = { release: null };
    const adopt = vi.fn(
      () =>
        new Promise<{ ok: true; assetKey: string }>((r) => {
          held.release = () => r({ ok: true, assetKey: 'k1' });
        }),
    );
    const h = setup(urlBody(), adopt);
    await tick();
    const b = h.btn()!;
    b.click();
    await tick();
    expect(b.disabled, '飛んでいる間も押せる').toBe(true);
    b.click();
    expect(adopt, '連打で 2 度出た').toHaveBeenCalledTimes(1);
    held.release?.();
  });
});

describe('字を選んだら、取り込んだ絵は外れる(#856 段②)', () => {
  it('🔴 字を選ぶと鍵が消える(選んだのに変わらない、を作らない)', async () => {
    const h = setup(urlBody(['attachment.app_icon_asset_key: k1']));
    await tick();
    // 前提 ── 鍵が本文に在る(ここが崩れると以降は何も見ていない)
    expect(h.bodies.a1, '前提が崩れている').toContain('app_icon_asset_key: k1');
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', icon: '🍎' });
    await tick(40);
    expect(h.bodies.a1, '字を選んだのに絵の鍵が残った').not.toContain('app_icon_asset_key');
    expect(h.bodies.a1, '選んだ字が入っていない').toContain('attachment.app_icon: 🍎');
  });

  it('🔴 「なし」でも鍵が消える(印を出さない、が user の求め)', async () => {
    const h = setup(urlBody(['attachment.app_icon_asset_key: k1']));
    await tick();
    h.d.dispatch({ type: 'SET_APP_TILE', lid: 'a1', icon: '' });
    await tick(40);
    expect(h.bodies.a1, '「なし」を押したのに絵が残った').not.toContain('app_icon_asset_key');
  });
});
