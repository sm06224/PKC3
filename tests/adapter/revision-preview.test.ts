/** @vitest-environment happy-dom */
/**
 * #398: **戻す前に中身を見る**(押した所から画面まで)。
 *
 * > user の物語: 履歴を開くと `#7 / #6 / #5` が並び、**題名は 3 つとも同じ**。
 * > 日時しか手がかりが無く、**どれが目当てか押すまで分からない**。
 *
 * ⚠ 復元は前進変異なので**データは失われない** ── だから「軽い」と読まない。
 *   試すたびに履歴へ 1 件積まれ、**次に探すときの手がかりをさらに埋める**。
 *   これは「消える」問題ではなく「**探せなくなっていく**」問題である。
 *
 * 観測点は **画面に出た差分**(state に載っただけ、を合格にしない)。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';

const NOW = 'いまの本文\n2 行目\n3 行目\n';
const OLD = 'むかしの本文\n2 行目\n3 行目\n';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: '会議メモ',
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.textContent = '';
});

function setup(opts: { stats?: { id: string; added: number | null; removed: number | null }[] } = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const detail = new DetailRenderer(buildShell(root).detail);
  d.onState((s) => detail.render(s));
  bindActions(root, d);
  /** ⚠ **本文を読んだ回数**を数える(要求駆動であることを test 側から見る)。 */
  let bodyReads = 0;
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async () => NOW,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async () => stubStamps(),
    listRevisionMetas: async () => [
      {
        id: 'r7',
        rev_order: 7,
        created_at: '2026-08-22 10:31',
        title: '会議メモ',
        archetype: 'text',
      },
      {
        id: 'r6',
        rev_order: 6,
        created_at: '2026-08-22 09:02',
        title: '会議メモ',
        archetype: 'text',
      },
    ],
    revisionDiffStats: async () =>
      opts.stats ?? [
        { id: 'r7', added: 12, removed: 3 },
        // ⚠ 全文で持っている版 ── 数えられない(0 と潰さない)
        { id: 'r6', added: null, removed: null },
      ],
    getRevision: async (revId) => {
      bodyReads++;
      return revId === 'r7' ? { body: OLD, title: '会議メモ', archetype: 'text' } : null;
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  const q = <T extends HTMLElement>(s: string): T | null => root.querySelector<T>(s);
  const qa = (s: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(s)];
  return { root, d, q, qa, reads: (): number => bodyReads };
}

async function openHistory(s: ReturnType<typeof setup>): Promise<void> {
  s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  await tick();
  s.d.dispatch({ type: 'SHOW_HISTORY' });
  await tick();
}

describe('#398 段① 見分けがつく', () => {
  it('🔴 行に増減が出る(日時と題名しか無い、を終わらせる)', async () => {
    const s = setup();
    await openHistory(s);
    const badges = s.qa('[data-pkc-field="revision-delta"]').map((e) => e.textContent);
    expect(badges, '増減が 1 つも出ていない').toEqual(['+12 −3']);
  });

  it('🔴 数えられない版には何も出さない(0 と書くと「変わっていない」という嘘になる)', async () => {
    const s = setup();
    await openHistory(s);
    // #6 は null なので札が無い ── 一覧の行は 2 つ、札は 1 つ
    expect(s.qa('[data-pkc-action="preview-revision"]')).toHaveLength(2);
    expect(s.qa('[data-pkc-field="revision-delta"]')).toHaveLength(1);
  });

  it('⚠ 何との比較かが書いてある(数字だけだと今の本文との差だと読まれる)', async () => {
    const s = setup();
    await openHistory(s);
    expect(s.q('[data-pkc-field="revision-delta"]')!.title).toContain('1 つ新しい版');
  });

  it('⚠ 増減が引けなくても履歴は開ける(片方の失敗でもう片方を殺さない)', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const detail = new DetailRenderer(buildShell(root).detail);
    d.onState((st) => detail.render(st));
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async () => NOW,
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async () => stubStamps(),
      listRevisionMetas: async () => [
        { id: 'r7', rev_order: 7, created_at: 'x', title: 'y', archetype: 'text' },
      ],
      revisionDiffStats: () => Promise.reject(new Error('worker が古い')),
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await tick();
    d.dispatch({ type: 'SHOW_HISTORY' });
    await tick();
    expect(
      root.querySelectorAll('[data-pkc-action="restore-revision"]'),
      '数が引けなかっただけで履歴ごと出ていない',
    ).toHaveLength(1);
  });
});

describe('#398 段② 戻す前に中身を見る', () => {
  it('🔴 行を押すと、いまの本文とのちがいが出る(1 バイトも書かない)', async () => {
    const s = setup();
    await openHistory(s);
    expect(s.q('[data-pkc-field="revision-diff"]'), 'まだ押していないのに出ている').toBeNull();
    s.q('[data-pkc-action="preview-revision"]')!.click();
    await tick();
    const diff = s.q('[data-pkc-field="revision-diff"]');
    expect(diff, '押しても差分が出ない').not.toBeNull();
    const texts = [...diff!.querySelectorAll('li')].map((li) => li.textContent);
    expect(texts, '消えた行が出ていない').toContain('− むかしの本文');
    expect(texts, '足した行が出ていない').toContain('+ いまの本文');
  });

  it('🔴 総量が出る(「いまの本文との」ちがいだと分かる)', async () => {
    const s = setup();
    await openHistory(s);
    s.q('[data-pkc-action="preview-revision"]')!.click();
    await tick();
    const sum = s.q('[data-pkc-field="revision-diff-summary"]')!.textContent;
    expect(sum).toContain('いまの本文とのちがい');
    expect(sum).toContain('+1 −1');
  });

  it('🔴 本文は押したときだけ読む(履歴を開いただけでは 1 件も読まない)', async () => {
    const s = setup();
    await openHistory(s);
    expect(s.reads(), '開いただけで本文を読んでいる').toBe(0);
    s.q('[data-pkc-action="preview-revision"]')!.click();
    await tick();
    expect(s.reads()).toBe(1);
  });

  it('🔴 もう一度押すと畳む(閉じる道が「別の版を押す」だけ、を作らない)', async () => {
    const s = setup();
    await openHistory(s);
    const open = (): HTMLElement => s.q('[data-pkc-action="preview-revision"]')!;
    open().click();
    await tick();
    expect(s.q('[data-pkc-field="revision-diff"]')).not.toBeNull();
    open().click();
    await tick();
    expect(s.q('[data-pkc-field="revision-diff"]'), '2 度目で畳んでいない').toBeNull();
  });

  it('🔴 「閉じる」でも畳む', async () => {
    const s = setup();
    await openHistory(s);
    s.q('[data-pkc-action="preview-revision"]')!.click();
    await tick();
    s.q('[data-pkc-action="hide-revision-preview"]')!.click();
    await tick();
    expect(s.q('[data-pkc-field="revision-diff"]')).toBeNull();
  });

  it('🔴 履歴を閉じたら差分も畳む(どの版の物か分からない孤児を残さない)', async () => {
    const s = setup();
    await openHistory(s);
    s.q('[data-pkc-action="preview-revision"]')!.click();
    await tick();
    s.q('[data-pkc-action="hide-history"]')!.click();
    await tick();
    expect(s.q('[data-pkc-field="revision-diff"]')).toBeNull();
    expect(s.d.getState().revisionPreview, 'state に残っている').toBeNull();
  });

  it('⚠ 開いている版に印が付く(どれを見ているか分かる)', async () => {
    const s = setup();
    await openHistory(s);
    s.q('[data-pkc-action="preview-revision"]')!.click();
    await tick();
    const opens = s.qa('[data-pkc-action="preview-revision"]');
    expect(opens.map((e) => e.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
  });

  it('🔴 読めなかったら理由が出る(押して無反応にしない)', async () => {
    const s = setup();
    await openHistory(s);
    // #6 は `getRevision` が null を返す
    s.qa('[data-pkc-action="preview-revision"]')[1]!.click();
    await tick();
    expect(s.d.getState().error ?? '', '無言で終わった').toContain('読めませんでした');
  });
});
