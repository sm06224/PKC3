/** @vitest-environment happy-dom */
/**
 * 🔴 **タグを「その場で打つ」**(#494)── 押した所から disk まで。
 *
 * > user 指摘 2026-08-27:「**タグの設定が Apple のメモアプリと違い、直感的に
 * > ここにタグを打つ!って感じの動作じゃなくて yamlfrontmatter なのは問題だ。
 * > しかも設定動線がよくわからん**」
 *
 * ## ⚠ 「無い」のではなく「ここに無い」だった(着手前に全数で数えた)
 *
 * | # | 打つ導線 | どこに在るか |
 * |---|---|---|
 * | ① | 本文の frontmatter に `tags: [...]` と書く | 本文 |
 * | ② | フォルダの面で行に印を付けて「タグを付ける」(#402) | **別の面** |
 * | ③ | スマートフォルダへ掴んで落とす(#421) | **入れ物が要る** |
 * | ④ | 情報ペインのタグ行 | 🔴 **読み取り専用**(押すと「探す」だけ) |
 *
 * 🔑 だから直すのは「作る」ではなく **④を双方向にする**こと
 *   (裁定 2026-08-23「面は『映すだけ』にしない」)。
 *
 * ## 🔴 観測点は **disk に着いた本文**
 *
 * ⚠ 「dispatch した」を見ると、reducer が弾く形(編集中 / 空のタグ)や、
 *   frontmatter の組み直しが壊れている形を**全部素通り**する。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';
import { readTags } from '../../src/features/flavor/tags';

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
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

beforeEach(() => {
  document.body.textContent = '';
});

function setup(body: string) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const inspector = new InspectorRenderer(regions.inspector);
  d.onState((s) => inspector.render(s));
  bindActions(root, d);
  const disk: Record<string, string> = { n1: body };
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => disk[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      disk[e.lid] = e.body;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  const q = <T extends HTMLElement>(sel: string): T | null => root.querySelector<T>(sel);
  return { root, d, disk, q };
}

/** 欄に打って、ボタンを押す(実 UI と同じ action を通す)。 */
function type(s: ReturnType<typeof setup>, tag: string): void {
  s.q<HTMLInputElement>('[data-pkc-field="tag-add-input"]')!.value = tag;
  s.q('[data-pkc-action="add-tag"]')!.click();
}

describe('タグをその場で打つ(#494)', () => {
  it('🔴 打って押すと、本文の frontmatter に入る', async () => {
    const s = setup('本文だけ\n');
    type(s, '買い物');
    await tick();
    expect(readTags(s.disk['n1']!), '本文に届いていない').toEqual(['買い物']);
    // ⚠ **本文を踏み潰さない**(frontmatter を足すだけ)
    expect(s.disk['n1'], '本文が消えた').toContain('本文だけ');
  });

  it('🔴 通ったら欄が空になる(次の 1 つを打てる)', async () => {
    const s = setup('本文\n');
    type(s, '家事');
    await tick();
    expect(
      s.q<HTMLInputElement>('[data-pkc-field="tag-add-input"]')!.value,
      '打った字が残っている(2 つ目を打つ前に消す手間が要る)',
    ).toBe('');
  });

  /**
   * 🔴 **Enter で足せる**(#494 の肝)。⚠ 打った後に押すボタンを探させるのでは、
   *   user 指摘「ここに打つ!って感じの動作」は**1 手も減っていない**。
   */
  it('🔴 Enter でも足せる', async () => {
    const s = setup('本文\n');
    const input = s.q<HTMLInputElement>('[data-pkc-field="tag-add-input"]')!;
    input.value = '請求済';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    expect(readTags(s.disk['n1']!), 'Enter で届いていない').toEqual(['請求済']);
  });

  /**
   * ⚠ **変換中の Enter では撃たない** ── 日本語のタグを打つ人は毎回踏む。
   * 🔑 対照群は上の test(変換中でない Enter は通る)。
   */
  it('🔴 変換中の Enter では撃たない', async () => {
    const s = setup('本文\n');
    const input = s.q<HTMLInputElement>('[data-pkc-field="tag-add-input"]')!;
    input.value = 'かいもの';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
    );
    await tick();
    expect(readTags(s.disk['n1']!), '変換中に確定してしまった').toEqual([]);
  });

  /**
   * 🔴 **片道の操作を作らない**(裁定 2026-08-23)。⚠ 打てるのに外せないと、
   *   間違えたタグを消すために**本文を開いて frontmatter を直す**ことになる。
   */
  it('🔴 札の × で外れる', async () => {
    const s = setup('---\ntags: [買い物, 家事]\n---\n本文\n');
    const off = s.root.querySelectorAll<HTMLElement>('[data-pkc-field="inspector-tag-off"]');
    expect(off.length, '外す口が出ていない').toBe(2);
    expect(off[0]!.getAttribute('data-pkc-tag'), '外す相手が札に載っていない').toBe('買い物');
    off[0]!.click();
    await tick();
    expect(readTags(s.disk['n1']!), '外れていない').toEqual(['家事']);
  });

  /** ⚠ 外す相手は**押した札**が持つ(打ちかけの別の語を消さない)。 */
  it('🔴 打ちかけの語が在っても、外れるのは押した札のほう', async () => {
    const s = setup('---\ntags: [買い物, 家事]\n---\n本文\n');
    s.q<HTMLInputElement>('[data-pkc-field="tag-add-input"]')!.value = '家事';
    s.root
      .querySelectorAll<HTMLElement>('[data-pkc-field="inspector-tag-off"]')[0]!
      .click();
    await tick();
    expect(readTags(s.disk['n1']!), '打ちかけの語のほうを消した').toEqual(['家事']);
  });

  it('🔴 探す口は残っている(× を足して壊していない)', () => {
    const s = setup('---\ntags: [買い物]\n---\n本文\n');
    const find = s.q('[data-pkc-action="filter-by-tag"]');
    expect(find, 'タグを押して探せなくなった').not.toBeNull();
    find!.click();
    expect(s.d.getState().filterQuery).toBe('買い物');
  });

  it('⚠ 空のまま押したら理由を出す(無言の dead click にしない)', async () => {
    const s = setup('本文\n');
    type(s, '   ');
    // ⚠ **押した直後に見る** ── 帯は次の描画で消えることがあるので、`tick` を
    //    挟むと「出ていない」に見える(観測点は「出したこと」である)
    expect(s.d.getState().error ?? '', '押しても何も起きない').toContain('タグ');
    await tick();
    expect(readTags(s.disk['n1']!), '空なのに書いた').toEqual([]);
  });
});

/**
 * 🔴 **打てない状況では欄ごと畳む**(#494)。
 *
 * ⚠ 出したまま押せない形にすると、**無言の dead click** になる ── #300 で
 *   user が叱った「押しても何も起きない」の小さい版である。
 * 🔑 3 つとも **1 か所の判定**(`canWriteTags`)で決める ── 札の × と欄で
 *   別々に数えると、片方だけ出る形が生まれる(§7)。
 */
describe('打てない状況(#494)', () => {
  const formShown = (s: ReturnType<typeof setup>): boolean =>
    s.q<HTMLElement>('[data-pkc-field="tag-add"]')!.hidden === false;

  it('⚠ 対照群 ── ふつうのノートでは出ている', () => {
    expect(formShown(setup('本文\n')), '出ていない(以下が全部空振りする)').toBe(true);
  });

  it('🔴 本文が読めていないときは出さない', () => {
    const s = setup('本文\n');
    // 本文を持たない別のノートを選ぶ = 一覧を眺めているだけの状態
    s.d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1'), meta('n2')], relations: [] });
    s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    expect(formShown(s), '本文が読めていないのに打てる形になっている').toBe(false);
  });

  it('🔴 編集中は出さない(reducer が弾くので押しても何も起きない)', () => {
    const s = setup('本文\n');
    s.d.dispatch({ type: 'START_EDIT', lid: 'n1' });
    expect(formShown(s), '編集中に打てる形になっている').toBe(false);
    expect(
      s.root.querySelectorAll('[data-pkc-field="inspector-tag-off"]').length,
      '編集中に外す口が出ている',
    ).toBe(0);
  });

  /**
   * 🔴 **frontmatter が壊れている本文には書き足さない**(#284 系)。
   * ⚠ 閉じの `---` を失った本文に組み直しを当てると、実害を広げる。
   */
  it('🔴 閉じの --- を失った本文では出さない', () => {
    const s = setup('---\ntags: [買い物]\n本文\n');
    expect(formShown(s), '読めていない frontmatter に書き足せる形になっている').toBe(false);
  });
});
