/** @vitest-environment happy-dom */
/**
 * #1163 依頼 314 / 321 / 319(束 H1):タグの名前の変更と、全部外したときの知らせ、「関連」の逆向き。
 *
 * 観測点は disk に着いた本文と、画面に出た知らせ。
 * ⚠ 台の `persistEntry` は本物の worker と同じく、`expectHash` が食い違えば conflict を返す。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, reduce, hasReverseOnlyRelation, hasSameRelation } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';
import { readTags } from '../../src/features/flavor/tags';
import { contentHash64Hex } from '../../src/adapter/platform/storage/content-hash';

const meta = (lid: string, order: number, archetype: string): EntryMeta => ({
  lid,
  title: 't-' + lid,
  archetype,
  createdAt: null,
  updatedAt: null,
  entryOrder: order,
  status: null,
  date: null,
  archived: false,
  bodyChars: 10,
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

function rig(bodies: Record<string, string>, archetypes: Record<string, string> = {}) {
  const disk = { ...bodies };
  const d = new Dispatcher();
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => disk[lid] ?? null,
    getBodies: async (lids) =>
      lids.filter((l) => disk[l] !== undefined).map((l) => ({ lid: l, body: disk[l]! })),
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e, opts) => {
      if (opts?.expectHash !== undefined && opts.expectHash !== contentHash64Hex(disk[e.lid] ?? ''))
        return { ...stubStamps(), conflict: true };
      disk[e.lid] = e.body;
      return stubStamps();
    },
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: Object.keys(bodies).map((lid, i) => meta(lid, i + 1, archetypes[lid] ?? 'text')),
    relations: [],
  });
  return { d, disk };
}

/** タグの名前の変更と同じ 2 通(外す → 付ける。`binder.ts` の `queryTagBulk` と同じ並びと印)。 */
function rename(s: ReturnType<typeof rig>, lids: string[], from: string, to: string): void {
  s.d.dispatch({ type: 'BULK_TAG', lids, tags: [from], mode: 'remove', renameFirst: true });
  s.d.dispatch({ type: 'BULK_TAG', lids, tags: [to], mode: 'add', afterPrevious: true });
}

describe('依頼 314:タグの名前の変更は、本文にしか書いていないノートを相手から外す', () => {
  it('🔴 前書きに書いたノートは新しい名前に変わり、本文の行にしか無いノートは新しい名前も足されない。外した件数を言う', async () => {
    const s = rig({
      fm: '---\ntags: [旧]\n---\n本文\n',
      body: '本文\n\n#旧\n',
    });
    rename(s, ['fm', 'body'], '旧', '新');
    await flush();
    expect(readTags(s.disk['fm']!)).toEqual(['新']);
    // 本文しか書いていないノート ── 1 バイトも触らない(新しい名前を足さない)
    expect(s.disk['body'], '本文だけのノートを書き換えた').toBe('本文\n\n#旧\n');
    const notice = s.d.getState().notice ?? '';
    expect(notice).toContain('1 件は本文の中にだけ書いてあるので、名前を変えませんでした');
  });

  it('🔴 前書きと本文の両方に書いたノートは、今までどおり(前書きは新しい名前・本文の旧い名前が残る旨を言う)', async () => {
    const s = rig({ both: '---\ntags: [旧]\n---\n本文\n\n#旧\n' });
    rename(s, ['both'], '旧', '新');
    await flush();
    expect(readTags(s.disk['both']!)).toEqual(['新']);
    const notice = s.d.getState().notice ?? '';
    expect(notice).toContain('1 件は本文の中にも書いてあるので、まだそのタグが付いています');
    expect(notice, '前書きにも書いたノートまで外した扱いにした').not.toContain('名前を変えませんでした');
  });

  it('対照群: 名前の変更でない「外す」(renameFirst なし)は、本文にしか無いノートを数えない', async () => {
    const s = rig({ body: '本文\n\n#旧\n' });
    s.d.dispatch({ type: 'BULK_TAG', lids: ['body'], tags: ['旧'], mode: 'remove' });
    await flush();
    expect(s.d.getState().notice ?? '').not.toContain('名前を変えませんでした');
  });

  it('🔴 外した相手は次の名前の変更に持ち越さない(2 回目の変更では対象になる)', async () => {
    const s = rig({ fm: '---\ntags: [旧]\n---\n本文\n', body: '本文\n\n#旧\n' });
    rename(s, ['body'], '旧', '新');
    await flush();
    expect(s.disk['body']).toBe('本文\n\n#旧\n');
    // 本文に書いた物を前書きへ移した後の名前の変更は、普通に変わる
    s.disk['body'] = '---\ntags: [旧]\n---\n本文\n';
    rename(s, ['body'], '旧', '新');
    await flush();
    expect(readTags(s.disk['body']!)).toEqual(['新']);
  });
});

const smart = (tags: string): string => `---\nsmart-tags: [${tags}]\n---\n説明\n`;

describe('依頼 321:タグを全部外したとき、そのタグを条件にしたスマートフォルダの件数を言う', () => {
  it('🔴 件数を言い、条件は書き換えない', async () => {
    const s = rig({ s1: smart('旧, 別'), s2: smart('別'), s3: smart('旧') }, { s1: 'smart', s2: 'smart', s3: 'smart' });
    s.d.dispatch({ type: 'OP_NOTICE', message: '3 件から外しました' });
    s.d.dispatch({ type: 'RENAME_SMART_TAG', from: '旧', to: null });
    await flush();
    expect(s.d.getState().notice ?? '').toBe(
      '3 件から外しました / このタグを条件にしたスマートフォルダが 2 件あります(条件はそのままです。タグを付け直すと、また集まります)',
    );
    expect(s.disk['s1'], '条件を書き換えた').toBe(smart('旧, 別'));
    expect(s.disk['s3']).toBe(smart('旧'));
  });

  it('対照群: 条件に当たるスマートフォルダが無ければ何も言わない', async () => {
    const s = rig({ s2: smart('別') }, { s2: 'smart' });
    s.d.dispatch({ type: 'RENAME_SMART_TAG', from: '旧', to: null });
    await flush();
    expect(s.d.getState().notice ?? '').toBe('');
  });
});

describe('依頼 319:「関連」は逆向きを同じつながりとして断る', () => {
  const rel = (id: string, from: string, to: string, kind: string) => ({
    id,
    fromLid: from,
    toLid: to,
    kind,
    createdAt: null,
    updatedAt: null,
  });
  const base = [rel('r1', 'a', 'b', 'semantic'), rel('r2', 'a', 'b', 'provenance')];

  it('🔴 関連(向きに意味が無い)は反対向きも同じつながり', () => {
    expect(hasSameRelation(base, 'b', 'a', 'semantic')).toBe(true);
    expect(hasReverseOnlyRelation(base, 'b', 'a', 'semantic')).toBe(true);
    // 同じ向きは「向きだけが逆」ではない(別の断り文を出すため)
    expect(hasSameRelation(base, 'a', 'b', 'semantic')).toBe(true);
    expect(hasReverseOnlyRelation(base, 'a', 'b', 'semantic')).toBe(false);
  });

  it('🔴 対照群: 向きに意味がある種類(出典)は、逆向きを今までどおり足せる', () => {
    expect(hasSameRelation(base, 'b', 'a', 'provenance')).toBe(false);
    expect(hasReverseOnlyRelation(base, 'b', 'a', 'provenance')).toBe(false);
  });

  it('reducer も同じ門 ── 反対向きの「関連」は足されず、出典なら足される', () => {
    const booted = reduce(initialState, {
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [meta('a', 1, 'text'), meta('b', 2, 'text')],
      relations: base,
    }).state;
    const rejected = reduce(booted, { type: 'ADD_RELATION', id: 'x1', fromLid: 'b', toLid: 'a', kind: 'semantic' });
    expect(rejected.events).toEqual([]);
    expect(rejected.state.relations).toHaveLength(2);
    const allowed = reduce(booted, { type: 'ADD_RELATION', id: 'x2', fromLid: 'b', toLid: 'a', kind: 'provenance' });
    expect(allowed.state.relations).toHaveLength(3);
  });
});
