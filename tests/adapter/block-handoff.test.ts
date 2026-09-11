/** @vitest-environment happy-dom */
/**
 * 🔴 **本文の塊を、別のノートへ持っていく**(#684 段③)。
 *
 * > user 要望 2026-09-03:「**本文の行 / 塊を、別のノートへ**」🔴 0 件
 *
 * ## 守る主張
 *
 * 1. 🔴 **入れてから切る** ── 行き先へ入らなかった回は、元の本文が **1 バイトも変わらない**
 * 2. 🔴 切る単位は段① と**同じ 1 本**(実体 + 隣の空行 1 本)。落とした所へ入る
 * 3. 🔴 一覧の行へ落としたら、そのノートの**末尾**へ
 * 4. 🔴 掴んだ時点の行と **byte 一致**しなければ切らない(別の窓が書き替えていたら断る)
 * 5. 🔴 行き先の**目印**が合わなければ入れない ── そのとき元は無傷
 * 6. 🔴 どこへ行ったかを**名指しで**言う(画面は動かないので字だけが手がかり)
 * 7. 🔴 **「元に戻す」の材料は入れない** ── 行き先で押すと、元から切れた塊が
 *    どこにも無くなる(戻し方は「掴んで持ち帰る」)
 * 8. 編集中は声に出して断る / 本文に入れられない種類へは持っていかない
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stubStamps } from '../helpers/store-stamps';
import { stubRevisionOps } from '../helpers/revision-stub';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { contentHash64Hex } from '../../src/adapter/platform/storage/content-hash';

const A = ['# もと', '', '段落 A', '', '段落 B', ''].join('\n');
const B = ['# さき', '', '牛乳', '', 'パン', ''].join('\n');
const tick = (): Promise<unknown> => new Promise((r) => setTimeout(r, 10));

function meta(lid: string, title: string, archetype = 'text'): EntryMeta {
  return {
    lid,
    title,
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

/**
 * 2 つのノートの本文を disk に持つ台。
 *
 * ⚠ **保存を disk に返す**(返さないと、2 本目の書込が 1 本目の前を読む ── 本物より甘い台)。
 * 🔴 **錠(`expectHash`)を本物と同じ意味で見る**(2026-09-09、変異試験 H2 が SURVIVED で教えた)──
 *   「この lid は必ず競合する」という stub にすると、**錠を渡さなくなる変異が生き延びる**
 *   (競合は stub の都合で起きるので、錠の有無が結果に出ない)。
 *   🔑 だから `conflictOn` は「**書く直前に別の窓がその本文を書き替える**」を模し、
 *   競合は**読んだ時の hash と合わないこと**から出す(本物と同じ因果)。
 */
function harness(over: { conflictOn?: string } = {}) {
  const disk = new Map<string, string>([
    ['a', A],
    ['b', B],
    // ⚠ フォルダにも本文を持たせる ── 持たせないと「ノートが見つかりません」で
    //   止まってしまい、**種類の門を外す変異が生き延びる**(H7)
    ['f', '# 入れ物\n'],
  ]);
  const d = new Dispatcher();
  const notices: Array<{ message: string; open?: string }> = [];
  const errors: string[] = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid: string) => disk.get(lid) ?? null,
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (
      e: { lid: string; body: string },
      opts?: { expectHash?: string },
    ) => {
      // ⚠ 別の窓が**書く直前に**書き替えた形(本物の競合と同じ因果)
      if (over.conflictOn === e.lid) disk.set(e.lid, `${disk.get(e.lid) ?? ''}割り込み\n`);
      if (opts?.expectHash !== undefined && opts.expectHash !== contentHash64Hex(disk.get(e.lid) ?? ''))
        return { ...stubStamps(), conflict: true };
      disk.set(e.lid, e.body);
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  } as never);
  d.onState((s) => {
    if (s.error !== null && !errors.includes(s.error)) errors.push(s.error);
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: [meta('a', 'もと'), meta('b', 'さき'), meta('f', '入れ物', 'folder')],
    relations: [],
  });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'a' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'a', body: A });
  return { d, disk, notices, errors };
}

/** 「段落 A」= 生の 2 行目(この fixture に frontmatter は無い)。 */
const PARA_A = { start: 2, end: 2 };

describe('本文の塊を別のノートへ持っていく(#684 段③)', () => {
  it('🔴 ② 落とした所へ入り、元からは切れる(切る単位は段① と同じ)', async () => {
    const h = harness();
    h.d.dispatch({
      type: 'HANDOFF_BLOCK',
      fromLid: 'a',
      ...PARA_A,
      toLid: 'b',
      toBefore: 3,
      anchor: { line: 2, text: '牛乳' },
    });
    await tick();
    const to = h.disk.get('b')!.split('\n');
    expect(to.indexOf('段落 A'), '行き先に入っていない').toBeGreaterThan(-1);
    expect(to.indexOf('牛乳'), '「牛乳」の下に入っていない').toBeLessThan(to.indexOf('段落 A'));
    expect(to.indexOf('パン'), '「パン」の下(= 末尾)へ落ちた').toBeGreaterThan(to.indexOf('段落 A'));
    // 元は塊 + 隣の空行 1 本だけが消え、他は 1 バイトも変わらない
    expect(h.disk.get('a')).toBe(['# もと', '', '段落 B', ''].join('\n'));
  });

  it('🔴 ③ 一覧の行へ落としたら、そのノートの末尾へ(終端の改行は失わない)', async () => {
    const h = harness();
    h.d.dispatch({ type: 'HANDOFF_BLOCK', fromLid: 'a', ...PARA_A, toLid: 'b', toBefore: null });
    await tick();
    /**
     * 🔴 **等値で見る**(着地前レビュー D / 変異 3)。
     * ⚠ 「パンより下」だけでは、**末尾**と**末尾のひとつ手前**を区別できない ──
     *   しかも行数をそのまま渡すと**終端の改行が消える**(`appendBlock` は必ず閉じる)。
     */
    expect(h.disk.get('b')).toBe(['# さき', '', '牛乳', '', 'パン', '', '段落 A', ''].join('\n'));
    expect(h.disk.get('a')).toBe(['# もと', '', '段落 B', ''].join('\n'));
  });

  /**
   * 🔴 **掴んだ塊が(別の窓の書込で)囲いの中へ移っていたら切らない**(変異 1)。
   * ⚠ 段① には同じ検査が在る(`body-rewrite.test.ts`)が、段③ には無かった ──
   *   無いと、**コードの中身を切り出して**別のノートへ運ぶ。
   */
  it('🔴 掴んだ塊が囲いの中へ移っていたら、切らない・持っていかない', async () => {
    const h = harness();
    // ⚠ **disk だけ**動かす ── 別の窓が段落の上に閉じていない ``` を足した形
    h.disk.set('a', ['# もと', '```js', '段落 A', '', '段落 B', ''].join('\n'));
    h.d.dispatch({ type: 'HANDOFF_BLOCK', fromLid: 'a', ...PARA_A, toLid: 'b', toBefore: null });
    await tick();
    expect(h.disk.get('b'), '囲いの中の行を持っていった').toBe(B);
    expect(h.errors.join(' / ')).toContain('本文が変わっている');
    // ⚠ 対照群 ── 囲いの外なら同じ座標で持っていける(この test が「常に断る」で緑になっていない)
    const ok = harness();
    ok.d.dispatch({ type: 'HANDOFF_BLOCK', fromLid: 'a', ...PARA_A, toLid: 'b', toBefore: null });
    await tick();
    expect(ok.disk.get('b')).toContain('段落 A');
  });

  /**
   * 🔴 **read→write を 1 op で回す**(`enqueue`)── 着地前レビュー 変異 4。
   * ⚠ 外すと、書き出しや別の書換が**持っていきの途中の本文**を読む
   *   (CLAUDE.md §7「直列化されているのは片側だけかもしれない」の再発経路)。
   * ⚠ 振る舞いでは割れない(1 op しか撃たない test では順番が出ない)ので、
   *   **配線そのもの**を字で留める ── 弱いと自覚して使う pin である。
   */
  it('🔴 持っていきは直列の 1 op に載っている(配線の pin)', () => {
    const src = readFileSync('src/adapter/state/store-effects.ts', 'utf8');
    const at = src.indexOf("case 'REQUEST_BLOCK_HANDOFF':");
    expect(at, '受け口が無い(この検査は空振り)').toBeGreaterThan(-1);
    expect(
      src.slice(at, at + 200),
      '直列の queue に載せていない(書き出しが途中の本文を読む)',
    ).toContain('enqueue(async () =>');
  });

  it('🔴 ① 行き先へ入らなかったら、元は 1 バイトも変わらない', async () => {
    const h = harness({ conflictOn: 'b' });
    h.d.dispatch({ type: 'HANDOFF_BLOCK', fromLid: 'a', ...PARA_A, toLid: 'b', toBefore: null });
    await tick();
    expect(h.disk.get('a'), '入らなかったのに元から消えた(どこにも無くなる)').toBe(A);
    expect(h.disk.get('b'), '行き先に塊が入った').not.toContain('段落 A');
    expect(h.errors.join(' / '), '黙って諦めた').toContain('持っていけませんでした');
  });

  it('🔴 ① 切れなかったら二重になる ── そう言う(消えるより良い側)', async () => {
    const h = harness({ conflictOn: 'a' });
    h.d.dispatch({ type: 'HANDOFF_BLOCK', fromLid: 'a', ...PARA_A, toLid: 'b', toBefore: null });
    await tick();
    expect(h.disk.get('b'), '行き先に入っていない').toContain('段落 A');
    expect(h.disk.get('a'), '錠が無いまま元を書き替えた(別の窓の書込が消える)').toContain('段落 A');
    expect(h.disk.get('a'), '割り込んだ別の窓の書込が消えた').toContain('割り込み');
    expect(h.errors.join(' / '), '二重になったことを言っていない').toContain('元の本文からは消せません');
  });

  it('🔴 ④ 掴んだ時点の行と合わなければ切らない(行き先も変えない)', async () => {
    const h = harness();
    // ⚠ **disk だけ**動かす(画面は据え置き)── 別の窓が上へ 1 行足した形
    h.disk.set('a', `別の窓が足した行\n${A}`);
    h.d.dispatch({ type: 'HANDOFF_BLOCK', fromLid: 'a', ...PARA_A, toLid: 'b', toBefore: null });
    await tick();
    expect(h.disk.get('b'), '当てずっぽうな塊を持っていった').toBe(B);
    expect(h.errors.join(' / ')).toContain('本文が変わっている');
  });

  it('🔴 ⑤ 行き先の目印が合わなければ入れない ── 元は無傷', async () => {
    const h = harness();
    h.d.dispatch({
      type: 'HANDOFF_BLOCK',
      fromLid: 'a',
      ...PARA_A,
      toLid: 'b',
      toBefore: 3,
      anchor: { line: 2, text: '牛乳ではない字' },
    });
    await tick();
    expect(h.disk.get('b'), '目印が合わないのに入れた').toBe(B);
    expect(h.disk.get('a'), '入っていないのに元から消えた').toBe(A);
  });

  it('🔴 ⑥ ⑦ どこへ行ったかを名指しで言い、「元に戻す」の材料は入れない', async () => {
    const h = harness();
    h.d.dispatch({ type: 'HANDOFF_BLOCK', fromLid: 'a', ...PARA_A, toLid: 'b', toBefore: null });
    await tick();
    expect(h.d.getState().notice ?? '', 'どこへ行ったかを言っていない').toBe(
      // ⚠ #809-3 でノートの名前を『』へ揃えた(file を落とした回の知らせと同じ括弧)
      '本文の塊を『さき』のいちばん下へ持っていきました(戻すには、そこで同じ ⠿ を掴んで持ち帰ってください)',
    );
    expect(h.d.getState().noticeOpen, '行ける口が添えられていない').toBe('b');
    expect(
      h.d.getState().lastAppend,
      '「元に戻す」の材料が入った(押すと塊がどこにも無くなる)',
    ).toBeNull();
  });

  /**
   * 🔴 **行き先の本文が閉じていない囲みで終わっていたら、直せると分かる字で断る**
   * (2026-09-09 の UX レビュー)。⚠ 一覧の行へ落とした user は**所を選んでいない**ので、
   *   「落とした所が本文から無くなっていた」では何を直せばよいか分からない
   *   (しかも開き直しても直らない ── 末尾は必ず囲いの中である)。
   */
  it('🔴 行き先が閉じていない囲みで終わっていたら、そう言う(元は無傷)', async () => {
    const h = harness();
    h.disk.set('b', '# さき\n\n```js\ncode\n');
    h.d.dispatch({ type: 'HANDOFF_BLOCK', fromLid: 'a', ...PARA_A, toLid: 'b', toBefore: null });
    await tick();
    expect(h.disk.get('a'), '入っていないのに元から消えた').toBe(A);
    expect(h.errors.join(' / '), '何を直せばよいか分からない字で断った').toContain(
      '閉じていない囲み',
    );
    // ⚠ 対照群 ── 落とした所を選んだ回は、これまでどおりの字(押した場所と文言が対)
    const h2 = harness();
    h2.d.dispatch({
      type: 'HANDOFF_BLOCK',
      fromLid: 'a',
      ...PARA_A,
      toLid: 'b',
      toBefore: 3,
      anchor: { line: 2, text: '合わない字' },
    });
    await tick();
    expect(h2.errors.join(' / ')).toContain('落とした所');
  });

  it('🔴 ⑧ 編集中は声に出して断る / 入れられない種類・同じノートへは撃たない', async () => {
    const h = harness();
    h.d.dispatch({ type: 'START_EDIT' });
    h.d.dispatch({ type: 'HANDOFF_BLOCK', fromLid: 'a', ...PARA_A, toLid: 'b', toBefore: null });
    await tick();
    expect(h.d.getState().error ?? '').toContain('編集を終了');
    expect(h.d.getState().error ?? '', '押した場所と文言が合っていない').toContain('別のノート');
    expect(h.disk.get('b'), '編集中なのに書いた').toBe(B);
    h.d.dispatch({ type: 'CANCEL_EDIT' });
    // 入れられない種類(フォルダ)へは撃たない
    h.d.dispatch({ type: 'HANDOFF_BLOCK', fromLid: 'a', ...PARA_A, toLid: 'f', toBefore: null });
    await tick();
    expect(h.disk.get('a'), 'フォルダへ持っていって元から消えた').toBe(A);
    // 同じノートは段① の仕事(ここでは撃たない)
    h.d.dispatch({ type: 'HANDOFF_BLOCK', fromLid: 'a', ...PARA_A, toLid: 'a', toBefore: 4 });
    await tick();
    expect(h.disk.get('a')).toBe(A);
  });
});
