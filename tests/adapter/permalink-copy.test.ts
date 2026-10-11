/** @vitest-environment happy-dom */
/**
 * 🔴 **外から開けるリンクをコピーする口と、そのリンクを開く口**(2026-10-11)。
 *
 * ## 物語
 *
 * 利用者の報告「ノートやアセットに対するパーマネントリンク発行が移植忘れ」。PKC2 は
 * 「Copy link」を主導線にしていたが、PKC3 は**作る口が 0 件**で、読む側もノート(`entry`)だけだった。
 * ブラウザやメールに貼ると、この PKC のこのノート / 添付が開く ── 共有で使う口。
 *
 * ## 守る主張
 *
 * ① 作った URL を、読む側が読んで**同じノート / 添付**を選ぶ(往復)
 * ② 右クリック・右の情報・「操作を探す」の 3 面で**字が同じ**(正本は `entry-actions.ts` の 1 か所)
 * ③ 押すと、その URL がクリップボードへ渡る(配線)。組めないときは**理由を出す**
 * ④ 別の PKC を指すリンク / 居ないノート / 居ない添付を開いたとき、**黙らず理由が出る**
 * ⑤ 開けるリンクを開いたときは理由を出さない(対照群)
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import {
  FOREIGN_ASSET_LINK_MESSAGE,
  FOREIGN_ENTRY_LINK_MESSAGE,
  MISSING_ENTRY_LINK_MESSAGE,
  NOT_READY_LINK_MESSAGE,
  assetPermalink,
  linkOpenerFor,
  resolveAssetOwner,
  connectViewDeepLink,
  entryPermalink,
  type DeepLinkTarget,
} from '../../src/adapter/platform/deep-link';
import {
  dropAssetFromHash,
  dropViewFromHash,
  parseExternalPermalink,
  parseViewDeepLinkAsset,
  setHashEntry,
} from '../../src/features/link/permalink';
import {
  ENTRY_ACTION_LABELS,
  ENTRY_MENU_ACTIONS,
  entryMenuActions,
} from '../../src/features/entry-actions';
import { KEY_COMMANDS } from '../../src/features/keymap';

function meta(lid: string, archetype: EntryMeta['archetype'] = 'text'): EntryMeta {
  return {
    lid,
    title: `題名 ${lid}`,
    archetype,
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

beforeEach(() => {
  document.body.textContent = '';
});

const hashOf = (url: string): string => url.slice(url.indexOf('#'));

/** 読む側の試験台(実物の `connectViewDeepLink` を、本物と同じ意味論の的で動かす)。 */
function opener(hash: string, own: { cid: string | null; lids: string[] }) {
  const log: string[] = [];
  const target: DeepLinkTarget & { hash: string } = {
    hash,
    clearHash: () => {
      target.hash = dropViewFromHash(target.hash);
    },
    dropToken: () => {},
    dropAsset: () => {
      log.push('dropAsset');
      target.hash = dropAssetFromHash(target.hash);
    },
    setEntry: (c, l) => {
      target.hash = setHashEntry(target.hash, c, l);
    },
    restoreHash: (h) => {
      target.hash = h;
    },
  };
  connectViewDeepLink({
    openView: () => log.push('open-view'),
    selectEntry: (c, l) => log.push(`select:${c}:${l}`),
    ownContainerId: () => own.cid,
    hasEntry: (l) => own.lids.includes(l),
    selectAsset: (k, owner) => log.push(`asset:${k}:${owner ?? '-'}`),
    fail: (m) => log.push(`fail:${m}`),
    onViewChange: () => () => {},
    onSelectedEntry: () => () => {},
    target,
  });
  return { log, target };
}

describe('作った URL を、読む側が読んで同じ物を開く(往復)', () => {
  it('🔴 ノート: 作った URL の断片が、同じ入れ物の同じノートを選ぶ', () => {
    const url = entryPermalink('c1', 'n42');
    expect(url, 'URL が組めない').not.toBeNull();
    // 形そのものも pin する(PKC2 と同じ綴りであること)
    expect(url).toMatch(/#pkc\?container=c1&entry=n42$/);
    expect(parseExternalPermalink(url!)).toMatchObject({ kind: 'entry', containerId: 'c1', targetId: 'n42' });
    const o = opener(hashOf(url!), { cid: 'c1', lids: ['n42'] });
    expect(o.log).toEqual(['select:c1:n42']);
  });

  it('🔴 添付: 作った URL の断片が、同じ入れ物の同じ添付を開き、断片から asset を落とす', () => {
    const url = assetPermalink('c1', 'a_k-9', 'n7');
    expect(url).toMatch(/#pkc\?container=c1&asset=a_k-9&owner=n7$/);
    expect(parseExternalPermalink(url!)).toMatchObject({ kind: 'asset', containerId: 'c1', targetId: 'a_k-9' });
    expect(parseViewDeepLinkAsset(hashOf(url!))).toEqual({ containerId: 'c1', assetKey: 'a_k-9', ownerLid: 'n7' });
    const o = opener(hashOf(url!), { cid: 'c1', lids: [] });
    expect(o.log).toEqual(['asset:a_k-9:n7', 'dropAsset']);
    // 本文に貼ったリンクとしても読める(entry と asset の併記ではない)
    expect(parseExternalPermalink(url!)?.kind).toBe('asset');
    // owner は落とす(F5 のたびに持ち主へ戻さない)
    expect(o.target.hash).not.toContain('owner');
    // 残すと F5 のたびに同じ添付へ引き戻される
    expect(parseViewDeepLinkAsset(o.target.hash)).toBeNull();
  });

  it('組めないとき(入れ物が無い / 綴りが通らない)は null', () => {
    expect(entryPermalink(null, 'n1')).toBeNull();
    expect(entryPermalink('c1', 'a b')).toBeNull();
    expect(assetPermalink(null, 'k')).toBeNull();
    expect(assetPermalink('c1', '日本語')).toBeNull();
  });
});

describe('開けないリンクは理由を言う(無言の dead click を作らない)', () => {
  it('🔴 別の PKC のノート', () => {
    const o = opener('#pkc?container=other&entry=n1', { cid: 'c1', lids: ['n1'] });
    expect(o.log).toEqual([`fail:${FOREIGN_ENTRY_LINK_MESSAGE}`]);
    expect(FOREIGN_ENTRY_LINK_MESSAGE).toContain('別の PKC');
  });

  it('🔴 居ないノート(同じ入れ物)', () => {
    const o = opener('#pkc?container=c1&entry=gone', { cid: 'c1', lids: ['n1'] });
    expect(o.log).toEqual([`fail:${MISSING_ENTRY_LINK_MESSAGE}`]);
  });

  it('🔴 別の PKC の添付(開きに行かない)', () => {
    const o = opener('#pkc?container=other&asset=k1', { cid: 'c1', lids: [] });
    expect(o.log).toEqual([`fail:${FOREIGN_ASSET_LINK_MESSAGE}`, 'dropAsset']);
    expect(o.log.some((l) => l.startsWith('asset:'))).toBe(false);
  });

  it('対照群: 開けるリンクでは理由を出さない', () => {
    const o = opener('#pkc?container=c1&entry=n1', { cid: 'c1', lids: ['n1'] });
    expect(o.log.some((l) => l.startsWith('fail:'))).toBe(false);
    expect(o.log).toEqual(['select:c1:n1']);
  });
});

describe('字は 3 つの面で同じ', () => {
  it('🔴 右クリック・右の情報・「操作を探す」が同じ「リンクをコピー」', () => {
    const fromMenu = ENTRY_MENU_ACTIONS.find((a) => a.action === 'copy-entry-link');
    expect(fromMenu, '右クリックの表に無い').toBeDefined();
    expect(fromMenu!.menuOnly, '右の情報にも出す').not.toBe(true);
    const root = document.createElement('div');
    document.body.append(root);
    const inspector = new InspectorRenderer(buildShell(root).inspector);
    const s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] }).state;
    inspector.render(reduce(s, { type: 'SELECT_ENTRY', lid: 'n1' }).state);
    const btn = root.querySelector('[data-pkc-region="inspector"] [data-pkc-action="copy-entry-link"]');
    expect(btn, '右の情報に出ていない').not.toBeNull();
    const cmd = KEY_COMMANDS.find((k) => k.id === 'copy-entry-link');
    expect(cmd, '「操作を探す」の表に無い').toBeDefined();
    expect(cmd!.defaults).toEqual([]);
    const label = ENTRY_ACTION_LABELS['copy-entry-link'];
    expect(label).toBe('リンクをコピー');
    expect(fromMenu!.label).toBe(label);
    expect(btn!.textContent).toContain(label);
    expect(cmd!.label).toBe(label);
    // 「参照をコピー」との違いが説明で読める
    const rows = entryMenuActions({ archetype: 'text', linkedFile: null });
    const hint = rows.find((a) => a.action === 'copy-entry-link')!.hint;
    expect(hint).toContain('ブラウザやメールに貼る');
    const refHint = rows.find((a) => a.action === 'copy-entry-ref')!.hint;
    expect(refHint).toContain('本文に貼る');
    expect(refHint).not.toContain('リンク');
  });

  it('添付のリンクは添付のノートでだけ右クリックに出る', () => {
    const has = (archetype: string): boolean =>
      entryMenuActions({ archetype, linkedFile: null }).some((a) => a.action === 'copy-asset-link');
    expect(has('attachment')).toBe(true);
    expect(has('text')).toBe(false);
    expect(has('folder')).toBe(false);
  });
});

describe('押すと URL がクリップボードへ渡る(配線)', () => {
  function rig(opts: { metas?: EntryMeta[] } = {}) {
    const root = document.createElement('div');
    document.body.append(root);
    const inspector = new InspectorRenderer(buildShell(root).inspector);
    const d = new Dispatcher();
    const copied: Array<{ text: string; done?: string }> = [];
    bindActions(root, d, { copyText: (text: string, done?: string) => copied.push({ text, done }) });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: opts.metas ?? [meta('n1'), meta('n2')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    inspector.render(d.getState());
    return { root, d, copied };
  }

  it('🔴 右の情報の「リンクをコピー」で、選んでいるノートの URL が渡る', () => {
    const r = rig();
    r.root.querySelector<HTMLElement>('[data-pkc-action="copy-entry-link"]')!.click();
    expect(r.copied).toHaveLength(1);
    expect(r.copied[0]!.text).toBe(entryPermalink('c1', 'n1'));
    expect(r.copied[0]!.text).toMatch(/#pkc\?container=c1&entry=n1$/);
    // 本文に貼る参照(entry:)ではない
    expect(r.copied[0]!.text).not.toContain('entry:n1');
    expect(r.copied[0]!.done).toContain('リンクをコピーしました');
  });

  it('🔴 添付のリンク: ボタンが持つ key の URL が渡る(選択が別でも別の添付にならない)', () => {
    const r = rig();
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'copy-asset-link');
    b.setAttribute('data-pkc-asset-key', 'ak1');
    r.root.append(b);
    b.click();
    expect(r.copied.map((c) => c.text)).toEqual([assetPermalink('c1', 'ak1', null)]);
  });

  it('🔴 添付のリンク(右クリック): key を持たない押し口は、開いている添付ノートの本文から引く', () => {
    const r = rig({ metas: [meta('n1', 'attachment')] });
    r.d.dispatch({
      type: 'BODY_LOADED',
      lid: 'n1',
      body: '---\nattachment.asset_key: ak7\nattachment.name: a.png\nattachment.mime: image/png\n---\n',
    });
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'copy-asset-link');
    r.root.append(b);
    b.click();
    expect(r.copied.map((c) => c.text)).toEqual([assetPermalink('c1', 'ak7', 'n1')]);
    expect(r.copied[0]!.text, '持ち主が載っていない').toMatch(/&owner=n1$/);
  });

  it('🔴 組めないときは黙らず理由を出す(本文が開いていない)', () => {
    const r = rig({ metas: [meta('n1', 'attachment')] });
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'copy-asset-link');
    r.root.append(b);
    b.click();
    expect(r.copied).toEqual([]);
    expect(JSON.stringify(r.d.getState()), '理由が出ていない').toContain('ノートを開き終わってからもう一度押してください');
  });
});

describe('リンクの base は ?query を運ばない(送り主の切替を渡さない)', () => {
  const setUrl = (u: string): void => {
    (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(u);
  };
  it('🔴 ?x=1 で開いていても、コピーするリンクは ? を含まない', () => {
    setUrl('http://localhost:8080/app/index.html?x=1&pkc-flag=y#pkc?container=c1&entry=n1');
    expect(window.location.search, '前提: query が付いている').toBe('?x=1&pkc-flag=y');
    const e = entryPermalink('c1', 'n1')!;
    const a = assetPermalink('c1', 'k1', 'n1')!;
    expect(e).toBe('http://localhost:8080/app/index.html#pkc?container=c1&entry=n1');
    expect(a.slice(0, a.indexOf('#')), '添付のリンクに ? が入っている').not.toContain('?');
  });
  it('file:// は pathname のまま', () => {
    setUrl('file:///home/u/pkc3.html?x=1');
    expect(entryPermalink('c1', 'n1')).toBe('file:///home/u/pkc3.html#pkc?container=c1&entry=n1');
  });
});

describe('添付の持ち主(同じ file を 2 つのノートに付けた場合)', () => {
  const find = async (): Promise<string | null> => 'other';
  it('🔴 運ばれた持ち主がその添付を持っていれば、逆引きより優先する', async () => {
    const lid = await resolveAssetOwner({ assetKey: 'k', ownerLid: 'mine', assetKeyOf: async () => 'k', findOwner: find });
    expect(lid).toBe('mine');
  });
  it('🔴 持っていない / 読めない / 運ばれていないときは逆引きへ落ちる', async () => {
    expect(await resolveAssetOwner({ assetKey: 'k', ownerLid: 'mine', assetKeyOf: async () => 'zzz', findOwner: find })).toBe('other');
    expect(await resolveAssetOwner({ assetKey: 'k', ownerLid: 'mine', assetKeyOf: async () => null, findOwner: find })).toBe('other');
    expect(
      await resolveAssetOwner({ assetKey: 'k', ownerLid: 'mine', assetKeyOf: () => Promise.reject(new Error('x')), findOwner: find }),
    ).toBe('other');
    expect(await resolveAssetOwner({ assetKey: 'k', ownerLid: null, assetKeyOf: async () => 'k', findOwner: find })).toBe('other');
  });
});

describe('起動の途中(入れ物がまだ無い)でも、リンクを黙って捨てない', () => {
  it('🔴 ノート・添付どちらも理由が出る', () => {
    expect(opener('#pkc?container=c1&entry=n1', { cid: null, lids: [] }).log).toEqual([`fail:${NOT_READY_LINK_MESSAGE}`]);
    expect(opener('#pkc?container=c1&asset=k', { cid: null, lids: [] }).log).toEqual([`fail:${NOT_READY_LINK_MESSAGE}`, 'dropAsset']);
  });
});

describe('実配線(main.ts が渡す 3 つ)', () => {
  it('🔴 入れ物の id・居るノート・添付を開くときの断りの字(リンク)が、この PKC の状態から決まる', () => {
    const navigate = vi.fn();
    const metas = new Map<string, unknown>([['n1', {}]]);
    const w = linkOpenerFor({
      dispatcher: { getState: () => ({ cid: 'c9', entryMetas: metas }) },
      navigateAssetRef: navigate,
    });
    expect(w.ownContainerId!()).toBe('c9');
    expect(w.hasEntry!('n1')).toBe(true);
    expect(w.hasEntry!('zz'), '居ないノートを居ると言っている').toBe(false);
    w.selectAsset!('k1', 'n1');
    expect(navigate).toHaveBeenCalledWith('k1', 'リンク', 'n1');
  });
  it('🔴 main.ts は connectViewDeepLink にそれを広げて渡している(原文 pin)', () => {
    const code = readFileSync('src/main.ts', 'utf-8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join('\n');
    const at = code.indexOf('connectViewDeepLink({');
    expect(at, 'connectViewDeepLink の呼び出しが見つからない').toBeGreaterThan(0);
    expect(code.slice(at, at + 2500)).toContain('...linkOpenerFor(app),');
  });
});
