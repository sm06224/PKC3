/** @vitest-environment happy-dom */
/**
 * 🔴 **章の保存が、別の窓の書込を巻き戻さない**(#1044 段2 3巡目の修理、S1)。
 *
 * ## user から見た物語
 *
 * 章の欄で「決定事項」を開いて打っている。⚠ **その間、別の窓が同じノートの
 * どこかを書いている**ことがある(#300 段③ で組み込みアプリが既定で別窓に
 * なったので、これは特殊な使い方ではない)。
 *
 * ## 直す前に何が起きていたか
 *
 * 章の保存(`SAVE_SECTION_DRAFT`)は **`state.openBody.body`**(章の欄が開いて
 * いる間ずっと更新されない、画面の古い写し)を土台に差し替えていた ── 別の窓が
 * その間に書いた分は、この土台に乗っていないので**保存すると黙って消える**
 * (disk へは反映されるが、こちらの書込が丸ごと上書きする)。
 *
 * ## この test が守る主張(`REQUEST_APPEND` の `append-conflict.test.ts` と同じ形)
 *
 * ① 🔴 **保存は disk から読み直す** ── 別経路が足した行は保存後も残る
 * ② 🔴 **その章自身が別の場所で書き換えられていたら断る** ── disk は 1 バイトも
 *    変わらず、箱(書きかけ)も残る
 * ③ 🔴 **見出しは名前で探し直す** ── 章より上に見出しが増えても正しい章が差し替わる
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects, type StorePort } from '../../src/adapter/state/store-effects';
import { contentHash64Hex } from '../../src/adapter/platform/storage/content-hash';
import { stubRevisionOps } from '../helpers/revision-stub';
import { stubStamps } from '../helpers/store-stamps';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert, EntryStamps } from '../../src/adapter/platform/storage/schema';

const tick = (ms = 10): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

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

const DOC = ['# 議事録', '', '前置き。', '', '## 決定事項', '', '- 牛乳を買う', '', '## 次回', '', '来週。', ''].join(
  '\n',
);

/**
 * ⚠ **本物の意味論を真似る**(CLAUDE.md §3)── `persistEntry` が受け取った本文を
 * `disk` に直に書く(fake だが「読んで書く」の意味論は本物どおり)。
 */
function bench(initial: Record<string, string>) {
  const disk: Record<string, string> = { ...initial };
  const reads: string[] = [];
  const persisted: EntryUpsert[] = [];
  const port = {
    ...stubRevisionOps(),
    getBody: async (lid: string) => {
      reads.push(lid);
      return disk[lid] ?? null;
    },
    renameEntry: async (): Promise<EntryStamps> => stubStamps(),
    persistEntry: async (e: EntryUpsert): Promise<EntryStamps> => {
      persisted.push(e);
      disk[e.lid] = e.body;
      return stubStamps();
    },
    deleteEntry: async () => {},
    setEntryParent: async () => {},
  } as unknown as StorePort;

  const d = new Dispatcher();
  const errors: string[] = [];
  d.onState((s) => {
    if (s.error !== null && !errors.includes(s.error)) errors.push(s.error);
  });
  connectStoreEffects(d, port);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  return { d, disk, reads, persisted, errors };
}

/**
 * SELECT_ENTRY → BODY_LOADED → OPEN_SECTION_DRAFT(line 4 = 「## 決定事項」)まで進める。
 *
 * 🔴 **`await tick(20)` で、この場で撃った以外の queue を先に空にする**
 *   (#1044 段2 4巡目の修理、T4。変異試験 S1a が SURVIVED で教えた)。
 *
 * ⚠ 直す前は同期のまま返していた ── `SELECT_ENTRY` は `openBody: null` にして
 *   `REQUEST_BODY` を出す(effect の `enqueue` に載る)。この test は続けて
 *   **手で** `BODY_LOADED` を撃つので画面はすぐ正しくなるが、`REQUEST_BODY` 自身の
 *   非同期の `store.getBody('n1')` は**まだ queue に残っている**。
 * 🔴 各 it はこの直後に `disk['n1']` を**外から**書き換えてから
 *   `SAVE_SECTION_DRAFT` を撃つ ── その残っていた `REQUEST_BODY` が、外部の
 *   書込より**後**に解決すると、`store.getBody` が**もう書き換わった disk**を
 *   読んで `BODY_LOADED` を撃ち、`openBody.body` を**外部の書込を含んだ最新形**
 *   へこっそり揺らす。`REQUEST_SECTION_SAVE` は同じ `enqueue` 列の**次**に積まれる
 *   ので、そのときにはもう `openBody` が disk と同じ ── 「`openBody` を土台に
 *   する」へ戻す変異でも①②③が緑のまま通っていた(disk 読み直しと
 *   openBody 読みが**たまたま同じ値**になっていたため、綴りの選択自体が
 *   test から見えなくなっていた)。
 * 🔑 直しは**この関数を出る前に、先に積まれた `REQUEST_BODY` を空にする**こと ──
 *   そうすれば `openBody` は各 it の外部書込より**前**の値で確定し、以後の
 *   `SAVE_SECTION_DRAFT` は「disk を読み直すか / 古い openBody で済ませるか」で
 *   結果が本当に分かれる。
 */
async function openDraft(d: Dispatcher, body: string, line = 4): Promise<void> {
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
  d.dispatch({ type: 'OPEN_SECTION_DRAFT', lid: 'n1', line });
  await tick(20);
}

describe('章の保存が別の窓の書込を消さない(#1044 段2 3巡目の修理、S1)', () => {
  it('🔴 ① 別経路が本文の末尾に足した行は、章を保存した後も残る(disk から読み直す)', async () => {
    const b = bench({ n1: DOC });
    await openDraft(b.d, DOC);
    expect(b.d.getState().sectionDraft?.heading, '前提が崩れている(開けていない)').toBe(
      '決定事項',
    );
    // 🔴 別経路(小窓・別タブ等)が本文の末尾に 1 行足した(disk に直接。openBody は動かさない)
    b.disk['n1'] = DOC + '別経路が足した行\n';
    b.d.dispatch({
      type: 'SAVE_SECTION_DRAFT',
      text: '## 決定事項\n\n- 牛乳を買う\n- パンを買う',
    });
    await tick(30);
    expect(b.errors, '保存できたのに理由が出た').toEqual([]);
    expect(b.d.getState().sectionDraft, '保存後も箱が残っている').toBeNull();
    // ① 本丸:章の変更と、別経路が足した行の両方が disk に在る
    expect(b.disk['n1'], '自分の章の変更が入っていない').toContain('パンを買う');
    expect(b.disk['n1'], '別経路が足した行を消した').toContain('別経路が足した行');
    // ⚠ ほかの章も無事
    expect(b.disk['n1']).toContain('前置き。');
    expect(b.disk['n1']).toContain('## 次回');
  });

  it('🔴 ② その章自身が別の場所で書き換えられていたら断る(disk は 1 バイトも変わらない・箱は残る)', async () => {
    const b = bench({ n1: DOC });
    await openDraft(b.d, DOC);
    // 🔴 別経路が「決定事項」章そのものを書き換えた
    const rewritten = DOC.replace('- 牛乳を買う', '- 牛乳と卵を買う');
    b.disk['n1'] = rewritten;
    b.d.dispatch({
      type: 'SAVE_SECTION_DRAFT',
      text: '## 決定事項\n\n打ちかけ',
    });
    await tick(30);
    expect(b.disk['n1'], '断ったのに disk が書き換わった').toBe(rewritten);
    expect(b.persisted, '断ったのに persistEntry が呼ばれた').toEqual([]);
    expect(b.d.getState().sectionDraft, '断ったのに箱が消えた').not.toBeNull();
    expect(b.d.getState().sectionDraft!.saving, '保存中の印が解けていない').toBe(false);
    expect(b.errors.at(-1) ?? '').toContain('別の場所で書き換えられました');
  });

  it('🔴 ③ 章より上に見出しが増えていても、名前で追えて正しい章が差し替わる', async () => {
    const b = bench({ n1: DOC });
    await openDraft(b.d, DOC);
    // 🔴 別経路が「決定事項」より上に見出しを 1 つ足した(章の位置がずれる)
    const withNewHeading = DOC.replace('前置き。', '## 前置き\n\n前置き。');
    b.disk['n1'] = withNewHeading;
    b.d.dispatch({
      type: 'SAVE_SECTION_DRAFT',
      text: '## 決定事項\n\n- 牛乳を買う\n- パンを買う',
    });
    await tick(30);
    expect(b.errors, '名前で追えず断られた').toEqual([]);
    expect(b.d.getState().sectionDraft).toBeNull();
    // 🔑 増えた見出しは無事、章の差し替えも正しい所に入っている
    expect(b.disk['n1']).toContain('## 前置き');
    expect(b.disk['n1']).toContain('パンを買う');
    expect(b.disk['n1']).toContain('## 次回');
    expect(b.disk['n1']).toContain('来週。');
  });

  /** ⚠ **対照群** ── 別経路の書込が無ければ、いつもどおり 1 回で保存できる。 */
  it('⚠ 対照群:別経路の書込が無ければ、いつもどおり保存できる', async () => {
    const b = bench({ n1: DOC });
    await openDraft(b.d, DOC);
    b.d.dispatch({
      type: 'SAVE_SECTION_DRAFT',
      text: '## 決定事項\n\n- 牛乳を買う\n- パンを買う',
    });
    await tick(30);
    expect(b.errors).toEqual([]);
    expect(b.d.getState().sectionDraft).toBeNull();
    expect(b.disk['n1']).toContain('パンを買う');
    expect(b.persisted[0]?.body).toBe(b.disk['n1']);
  });
});

/**
 * 🔴 **章の保存が `persistEntry` の楽観衝突(`conflict: true`)を受けたら、
 *   1 回だけ読み直して当て直す**(#1044 段2 4巡目の修理、T6)。
 *
 * ⚠ 直す前は 0 件 ── `store-effects.ts` の `REQUEST_SECTION_SAVE` に書いてある
 *   「読んでから書くまでの間に、別の窓が書いていたら読み直してもう一度当て直す」
 *   という枝を、どの test も 1 度も通していなかった(上のテストは disk を
 *   `getBody` の**外**で直接書き換えるので `persistEntry` は常に `conflict` を
 *   持たない ── `append-conflict.test.ts` と**同じ手法**(`persistEntry` の
 *   1 回目の直前に割り込む fake)で初めて、この枝を実際に走らせる。
 */
describe('章の保存の楽観衝突は 1 回だけ読み直して当て直す(#1044 段2 4巡目の修理、T6)', () => {
  /**
   * ⚠ **本物の意味論を真似る**(CLAUDE.md §3)── `expectHash` を**実際に見て**
   *   楽観衝突を判定する(`append-conflict.test.ts` の `bench` と同じ作り)。
   */
  function benchConflict(
    initial: Record<string, string>,
    opts: { interleave?: (disk: Record<string, string>) => void } = {},
  ) {
    const disk: Record<string, string> = { ...initial };
    const reads: string[] = [];
    const attempts: Array<{ body: string; expectHash?: string; conflict: boolean }> = [];
    let interleaved = false;
    const port = {
      ...stubRevisionOps(),
      getBody: async (lid: string) => {
        reads.push(lid);
        return disk[lid] ?? null;
      },
      renameEntry: async (): Promise<EntryStamps> => stubStamps(),
      persistEntry: async (
        e: EntryUpsert,
        o?: { expectHash?: string },
      ): Promise<EntryStamps> => {
        // 🔴 **1 回目の書込の直前に、別の窓が書く**(= 直したかった当の窓)
        if (!interleaved && opts.interleave) {
          interleaved = true;
          opts.interleave(disk);
        }
        const conflict =
          o?.expectHash !== undefined && contentHash64Hex(disk[e.lid] ?? '') !== o.expectHash;
        attempts.push({
          body: e.body,
          ...(o?.expectHash !== undefined ? { expectHash: o.expectHash } : {}),
          conflict,
        });
        if (conflict) return { createdAt: null, updatedAt: null, conflict: true };
        disk[e.lid] = e.body;
        return stubStamps();
      },
      deleteEntry: async () => {},
      setEntryParent: async () => {},
    } as unknown as StorePort;

    const d = new Dispatcher();
    const errors: string[] = [];
    d.onState((s) => {
      if (s.error !== null && !errors.includes(s.error)) errors.push(s.error);
    });
    connectStoreEffects(d, port);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
    return { d, disk, reads, attempts, errors };
  }

  it('🔴 楽観衝突が起きたら、読み直した本文へ当て直して保存できる(disk は両方の変更を持つ)', async () => {
    const b = benchConflict(
      { n1: DOC },
      {
        // 🔴 「保存」を撃った**後**(読んでから書くまでの間)に、別の窓が書いた体
        interleave: (disk) => {
          disk['n1'] = DOC + '別経路が足した行\n';
        },
      },
    );
    await openDraft(b.d, DOC);
    const readsBeforeSave = b.reads.length;
    b.d.dispatch({
      type: 'SAVE_SECTION_DRAFT',
      text: '## 決定事項\n\n- 牛乳を買う\n- パンを買う',
    });
    await tick(30);

    // ① 2 回試している(1 回目は楽観衝突で断られ、2 回目が通る)
    expect(b.attempts.map((a) => a.conflict), 'やり直していない(枝を 1 度も通っていない)').toEqual([
      true,
      false,
    ]);
    // ④ **読み直している**(古い基底のまま再送していない)── 保存の要求だけで 2 回読む
    expect(b.reads.length - readsBeforeSave, '衝突後に読み直していない').toBe(2);
    expect(b.errors, '成功したのに理由を出した').toEqual([]);
    expect(b.d.getState().sectionDraft, '保存後も箱が残っている').toBeNull();
    // ② 🔴 **本丸** ── 別の窓が書いた行も、自分の章の変更も、両方 disk に在る
    expect(b.disk['n1'], '別の窓が書いた行を消した').toContain('別経路が足した行');
    expect(b.disk['n1'], '自分の章の変更が入っていない').toContain('パンを買う');
  });

  /**
   * 🔴 **やり直しは 1 回だけ。それでも重なったら黙らない**
   *   (`append-conflict.test.ts` の③と同じ形)。
   * ⚠ 無限に回すと、書き続けている別の窓がいる間ずっと戻らない。
   */
  it('🔴 やり直しても重なったら(2 回とも衝突)、理由を出して断る(saving は解ける)', async () => {
    const disk: Record<string, string> = { n1: DOC };
    let n = 0;
    const port = {
      ...stubRevisionOps(),
      getBody: async (lid: string) => disk[lid] ?? null,
      renameEntry: async (): Promise<EntryStamps> => stubStamps(),
      /**
       * ⚠ **毎回**別の窓が先に書く(= 何度やっても重なる)。⚠ 触るのは
       *   「決定事項」章の**外**(末尾)── そこを触ると `replaceSectionByHeading`
       *   の原文一致(`mismatch`)で先に断られ、`persistEntry` が 2 回目を
       *   1 度も試さないまま `n` が増えなくなる(この枝は §1「別の理由で空振り」
       *   を実際に踏んで直した)。
       */
      persistEntry: async (
        _e: EntryUpsert,
        o?: { expectHash?: string },
      ): Promise<EntryStamps> => {
        n += 1;
        disk['n1'] = `${DOC}別の窓が書いた行(${n} 回目)\n`;
        return o?.expectHash !== undefined
          ? { createdAt: null, updatedAt: null, conflict: true }
          : stubStamps();
      },
      deleteEntry: async () => {},
      setEntryParent: async () => {},
    } as unknown as StorePort;
    const d = new Dispatcher();
    const errors: string[] = [];
    d.onState((s) => {
      if (s.error !== null && !errors.includes(s.error)) errors.push(s.error);
    });
    connectStoreEffects(d, port);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
    await openDraft(d, DOC);
    d.dispatch({
      type: 'SAVE_SECTION_DRAFT',
      text: '## 決定事項\n\n- 牛乳を買う\n- パンを買う',
    });
    await tick(30);

    expect(n, 'やり直しが 1 回で止まっていない(無限に回る)').toBe(2);
    expect(errors, '黙って断った(user は書きかけが消えたとしか見えない)').toHaveLength(1);
    expect(errors[0], '何が起きたか書いていない').toContain('別のウィンドウ');
    expect(errors[0], '次にどうすればよいか書いていない').toContain('もう一度');
    // 🔑 **保存中の錠が解けている** ── 解かないと user は永久に章を保存できない
    expect(d.getState().sectionDraft?.saving, '保存中の印が残っている').toBe(false);
    expect(d.getState().sectionDraft, '断ったのに箱が消えた').not.toBeNull();
  });
});
