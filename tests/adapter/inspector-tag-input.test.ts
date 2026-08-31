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
  /** `queryScan` が何回呼ばれたか(「押すたびに全走査」を見るため)。 */
  let scans = 0;
  const scanKeys: (string | null)[] = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    /**
     * 🔴 **候補は集計と同じ口から来る**(#494 段②)── ここが呼ばれることまで見る。
     * ⚠ fake を「何でも返す」にしない ── `key` を見ずに返すと、
     *   `queryScan(null)`(目録)を頼む実装でも緑になる(§3「stub を甘くしない」)。
     */
    queryScan: async (key) => {
      scans += 1;
      scanKeys.push(key);
      if (key !== 'tags') return { keys: { keys: [], omittedKeys: 0, scanned: 0 }, groups: null };
      return {
        keys: { keys: [], omittedKeys: 0, scanned: 3 },
        groups: {
          groups: [
            { value: '請求済', total: 5, lids: [] },
            { value: '買い物', total: 2, lids: [] },
            // ⚠ 「未設定」の組 ── 候補に出してはいけない(押すと空の字が入る)
            { value: '', total: 9, lids: [] },
          ],
          omittedGroups: 0,
          scanned: 3,
        },
      };
    },
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
  return { root, d, disk, q, scans: (): number => scans, scanKeys: (): (string | null)[] => scanKeys };
}

/** 欄に焦点を当てる(実 UI と同じ event を通す)。 */
function focusTagInput(s: ReturnType<typeof setup>): void {
  s.q<HTMLInputElement>('[data-pkc-field="tag-add-input"]')!.dispatchEvent(
    new FocusEvent('focusin', { bubbles: true }),
  );
}

const options = (s: ReturnType<typeof setup>): string[] =>
  [...s.root.querySelectorAll<HTMLOptionElement>('#pkc-tag-candidates option')].map((o) => o.value);

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
   *
   * ⚠ **守っているのは `binder` の入口の 1 行**(`if (ke.isComposing) return;`)である ──
   *   タグの枝に `!ke.isComposing` を書き足しても **no-op** になる(変異試験 T2 が
   *   SURVIVED で教えた)。🔑 だからここは**振る舞いで留める** ── 入口の門を
   *   壊す変異はこの test が落とす(門の在り処が変わっても主張は変わらない)。
   */
  it('🔴 変換中の Enter では撃たない', async () => {
    const s = setup('本文\n');
    const input = s.q<HTMLInputElement>('[data-pkc-field="tag-add-input"]')!;
    // ⚠ **前提を確かめる** ── 台が `isComposing` を運べないなら、この test は
    //    「変換中を再現できていない」だけで、何も守っていない(§1 の空振り)
    const probe = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true });
    expect(probe.isComposing, '台が変換中を再現できていない(この test は空振り)').toBe(true);
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
    s.d.dispatch({ type: 'START_EDIT' });
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

/**
 * 🔴 **既にあるタグから選べる**(#494 段②)。
 *
 * > issue の求め:「**既にあるタグから選べる**(打ち間違いで別のタグを増やさない)」
 *
 * ⚠ 候補は**近道**であって、打てる語の一覧ではない ── `<datalist>` は打った字を
 *   そのまま通すので、新しいタグは今までどおり打てる。
 */
describe('タグの候補(#494 段②)', () => {
  it('⚠ 焦点が当たるまでは集めない(打たない人に払わせない)', () => {
    const s = setup('本文\n');
    expect(s.scans(), '開いただけで全走査した').toBe(0);
    expect(options(s), '集めていないのに候補が出ている').toEqual([]);
  });

  it('🔴 焦点が当たったら集めて、候補に出る', async () => {
    const s = setup('本文\n');
    focusTagInput(s);
    await tick();
    expect(s.scanKeys(), 'タグ以外の束ね方を頼んでいる').toEqual(['tags']);
    expect(options(s), '候補が出ていない').toEqual(['請求済', '買い物']);
  });

  /**
   * 🔴 **「未設定」の組を候補に出さない。** ⚠ `queryScan` は tags を持たない
   *   ノートを 1 つの組(空文字)にまとめて返す ── 押すと空の字がタグとして入る。
   */
  it('🔴 「未設定」の組は候補に出ない', async () => {
    const s = setup('本文\n');
    focusTagInput(s);
    await tick();
    expect(options(s).includes(''), '空の候補が出ている').toBe(false);
  });

  /** ⚠ 自分が既に持っているタグは候補の場所を食うだけ(押しても「既に付いています」)。 */
  it('自分が持っているタグは候補から外れる', async () => {
    const s = setup('---\ntags: [買い物]\n---\n本文\n');
    focusTagInput(s);
    await tick();
    expect(options(s), '既に付いているタグが候補に残っている').toEqual(['請求済']);
  });

  it('🔴 2 度目の焦点では集め直さない(押すたびに全走査しない)', async () => {
    const s = setup('本文\n');
    focusTagInput(s);
    await tick();
    focusTagInput(s);
    await tick();
    expect(s.scans(), '焦点が当たるたびに全走査している').toBe(1);
  });

  /**
   * 🔴 **タグを書いたら集め直す**(#494 段②)。⚠ 捨てないと、**付けたばかりの
   *   タグが候補に出ない** ── user は「効いていない」と読む。
   */
  it('🔴 タグを書いた後は、次の焦点で集め直す', async () => {
    const s = setup('本文\n');
    focusTagInput(s);
    await tick();
    expect(s.scans()).toBe(1);
    type(s, '新しいの');
    await tick();
    focusTagInput(s);
    await tick();
    expect(s.scans(), 'タグを書いたのに候補が古いまま').toBe(2);
  });

  /**
   * 🔴 **持っていない配線では、候補が出ないだけ**(打つことは動く)。
   * ⚠ そのとき「集めていない」に戻すと、焦点が当たるたびに頼み直して
   *   **毎回 reject を待つ**ことになる ── 空を答えとして憶える。
   */
  it('🔴 集計の口が無い配線でも打てる(候補が出ないだけ)', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const inspector = new InspectorRenderer(regions.inspector);
    d.onState((st) => inspector.render(st));
    bindActions(root, d);
    const disk: Record<string, string> = { n1: '本文\n' };
    let asks = 0;
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      // ⚠ `queryScan` を**渡さない**(古い worker が残っている端末の再現)
      getBody: async (lid) => disk[lid] ?? null,
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      renameEntry: async () => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('使わない')),
      reorderEntry: async () => stubStamps(),
      persistEntry: async (e) => {
        asks += 1;
        disk[e.lid] = e.body;
        return stubStamps();
      },
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文\n' });
    const input = root.querySelector<HTMLInputElement>('[data-pkc-field="tag-add-input"]')!;
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await tick();
    expect(
      [...root.querySelectorAll('#pkc-tag-candidates option')].length,
      '口が無いのに候補が出ている',
    ).toBe(0);
    /**
     * 🔴 **「空」を答えとして憶えている**(変異試験 T10 が SURVIVED で教えた)。
     *
     * ⚠ `null`(まだ集めていない)のままだと、**焦点が当たるたびに頼み直す** ──
     *   口が無い配線では毎回 reject を待つことになる。⚠ 画面は「候補 0 件」で
     *   **どちらも同じ顔**なので、state を直に見るしかない。
     * ⚠ **タグを書く前に見る** ── 書くと候補は意図どおり `null` へ捨てられる。
     */
    expect(
      d.getState().tagSuggestions,
      '答えを憶えていない(焦点のたびに頼み直す形)',
    ).toEqual([]);
    // 🔑 **打つことは動く**(機能が減る側へ落ちている)
    input.value = '手打ち';
    root.querySelector<HTMLElement>('[data-pkc-action="add-tag"]')!.click();
    await tick();
    expect(asks, '候補が無いと打てなくなっている').toBe(1);
    expect(readTags(disk['n1']!)).toEqual(['手打ち']);
  });
});

/**
 * 🔴 **`#買い物 #家事` と打てば 2 つ付く**(#637。user 裁定 2026-08-31)。
 *
 * > 「**複数のタグを本文に入れたいけど、どうすればいいか?一つになってしまう**」
 * > 「**#tag1 #tag2 ってすればいいやん**」
 *
 * ⚠ 直す前の実測:この欄に `#買い物 #家事` と打つと、frontmatter には
 *   **`tags: ["#買い物 #家事"]`** と 1 つの名前が quote 付きで書かれていた ──
 *   quote されるので**読み直しても割れない**(user の言う「一つになってしまう」)。
 *
 * 🔑 観測点は **disk に着いた本文**である ── dispatch を数えると、
 *   frontmatter の組み直しが割れたままでも緑になる(§4)。
 */
describe('複数のタグを 1 度に打つ(#637)', () => {
  it('🔴 `#買い物 #家事` と打つと、本文に 2 つ入る', async () => {
    const s = setup('本文\n');
    type(s, '#買い物 #家事');
    await tick();
    expect(readTags(s.disk['n1']!), '1 つの名前になっている').toEqual(['買い物', '家事']);
  });

  /**
   * 🔴 **書き戻した字を、もう一度読んでも 2 つのまま**(往復)。
   * ⚠ ここが要るのは、直す前の壊れ方が **「書けてはいる」形**だったからである
   *   ── 名前に空白が入っただけなので、書込は成功し、画面にも札が 1 枚出ていた。
   * ⚠ **原文を見る** ── `readTags` だけを見ると、`splitTags` が読む側で
   *   割り直しているだけの実装(= 書いた字は 1 つのまま)でも緑になる。
   */
  it('🔴 書き戻した原文が、割れた形になっている', async () => {
    const s = setup('本文\n');
    type(s, '#買い物 #家事');
    await tick();
    expect(s.disk['n1'], '1 つの名前として quote されている').toContain('tags: [買い物, 家事]');
    expect(s.disk['n1'], '打った字がそのまま入っている').not.toContain('#買い物 #家事');
  });

  /**
   * 🔴 **対照群 ── 井桁が無ければ、空白入りの 1 つのまま。**
   * ⚠ 空白入りのタグ名は意図である(`bulk-tag.test.ts` の `請求 済`)。
   *   この対照群が無いと、「空白で割る」だけの実装と見分けが付かない。
   */
  it('🔴 対照群: `買い物 家事` は空白入りの 1 つ', async () => {
    const s = setup('本文\n');
    type(s, '買い物 家事');
    await tick();
    expect(readTags(s.disk['n1']!), '意図した空白入りの名前を割った').toEqual(['買い物 家事']);
  });

  /** ⚠ 通ったら欄は空になる(1 つのときと同じ ── 2 つ目を打つ前に消す手間を作らない)。 */
  it('⚠ 2 つ打った後も欄は空になる', async () => {
    const s = setup('本文\n');
    type(s, '#買い物 #家事');
    await tick();
    expect(s.q<HTMLInputElement>('[data-pkc-field="tag-add-input"]')!.value).toBe('');
  });
});
