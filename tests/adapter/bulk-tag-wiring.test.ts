/** @vitest-environment happy-dom */
/**
 * #402 ①: **まとめてタグを付ける / 外す**(押した所から disk まで)。
 *
 * > user の物語: フォルダで 12 件選んだ。全部に `#請求済` を付けたい。
 * > いま一括でできるのは「ゴミ箱へ」だけで、**12 回開いて 12 回書く**。
 *
 * 🔴 **配線の test を別に置く** ── 規則は `bulk-tag.test.ts` が見るが、
 *   それが**画面から届くか**は 1 行も見ていない(#397 で踏んだばかりの穴)。
 *
 * 観測点は **disk に着いた本文**と**画面に出た知らせ**。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { FilerRenderer } from '../../src/adapter/ui/render/filer';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';
import { MAX_TAGS, readTags } from '../../src/features/flavor/tags';
import { contentHash64Hex } from '../../src/adapter/platform/storage/content-hash';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: Number(lid.slice(1)),
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.textContent = '';
});

function setup(bodies: Record<string, string>, titles: Record<string, string> = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  buildShell(root);
  /**
   * ⚠ **ファイラの器は `buildShell` が持たない**(左の列は `browse.ts` が組む)。
   *   test は自分で器を作って `FilerRenderer` に渡す ── `multi-select.test.ts` と
   *   同じ作法である。
   */
  const filerHost = document.createElement('div');
  root.append(filerHost);
  const filer = new FilerRenderer(filerHost);
  d.onState((s) => filer.render(s));
  bindActions(root, d);
  const disk = { ...bodies };
  /** ⚠ 書いた回数を数える(「変わらないのに書いた」を見るため)。 */
  let writes = 0;
  /** 書込ごとに渡された `expectHash`(門が生きているかを見る)。 */
  const guards: (string | null)[] = [];
  /** この lid の書込は「別の窓に先を越された」ことにする。 */
  const conflictOn = new Set<string>();
  /** この lid の書込は例外で落ちる(値は投げる理由)。 */
  const throwOn = new Map<string, string>();
  /**
   * 🔴 **disk 上の題名**(#1087)。worker の本物の意味論を写す ── `keepMeta: true` のときだけ、
   *   既に在る行の題名は disk の値を保つ。⚠ fake が `keepMeta` を無視すると、守る test が空振りする。
   */
  const diskTitle: Record<string, string> = {};
  for (const lid of Object.keys(bodies)) diskTitle[lid] = titles[lid] ?? 't-' + lid;
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
      writes++;
      /**
       * 🔴 **`expectHash` を観測する**(2 稿目。変異試験が拾った)。
       * ⚠ 1 稿目の fake は `opts` を見ていなかったので、**門ごと外しても緑**だった
       *   ── 守っていたのは「書けたこと」であって「**別の窓を踏まないこと**」では
       *   なかった(#178 と同じ形の穴を、自分の test に作っていた)。
       */
      guards.push(opts?.expectHash ?? null);
      if (conflictOn.has(e.lid)) return { ...stubStamps(), conflict: true };
      if (throwOn.has(e.lid)) throw new Error(throwOn.get(e.lid));
      disk[e.lid] = e.body;
      diskTitle[e.lid] = opts?.keepMeta === true ? (diskTitle[e.lid] ?? e.title) : e.title;
      return stubStamps();
    },
  });
  d.dispatch({
    type: 'SYS_BOOTED',
    cid: 'c1',
    metas: Object.keys(bodies).map((lid) => ({
      ...meta(lid),
      ...(titles[lid] === undefined ? {} : { title: titles[lid]! }),
    })),
    relations: [],
  });
  const q = <T extends HTMLElement>(s: string): T | null => root.querySelector<T>(s);
  return { root, d, disk, q, guards, conflictOn, throwOn, diskTitle, writes: (): number => writes };
}

/** 印を付ける(実 UI と同じ action を通す)。 */
function mark(s: ReturnType<typeof setup>, lids: string[]): void {
  for (const lid of lids) s.d.dispatch({ type: 'TOGGLE_SELECT', lid });
}

function press(s: ReturnType<typeof setup>, tag: string, which: 'add' | 'remove'): void {
  s.q<HTMLInputElement>('[data-pkc-field="bulk-tag"]')!.value = tag;
  s.q(`[data-pkc-action="bulk-tag-${which === 'add' ? 'add' : 'remove'}"]`)!.click();
}

describe('#402 ① まとめてタグを付ける', () => {
  it('🔴 選んだ全部の本文に届く(1 件ずつ開かない)', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n', e3: 'う\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '請求済', 'add');
    await tick();
    expect(readTags(s.disk['e1']!), 'e1 に付いていない').toEqual(['請求済']);
    expect(readTags(s.disk['e2']!), 'e2 に付いていない').toEqual(['請求済']);
    // 🔴 選んでいないものは触らない
    expect(s.disk['e3'], '選んでいないものを書き換えた').toBe('う\n');
  });

  it('🔴 既に付いているものは書かない(更新日時を動かさない)', async () => {
    const s = setup({ e1: '---\ntags: [請求済]\n---\nあ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '請求済', 'add');
    await tick();
    expect(s.writes(), '変わらないものまで書いた').toBe(1);
  });

  it('🔴 内訳を 1 通で言う(既に付いていた件を失敗にしない)', async () => {
    const s = setup({ e1: '---\ntags: [請求済]\n---\nあ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '請求済', 'add');
    await tick();
    const st = s.d.getState();
    expect(st.notice ?? '', '知らせが出ていない').toContain('1 件に付けました');
    expect(st.notice ?? '').toContain('1 件は既に付いていました');
    // 🔴 **赤い帯にしない**(成功の内訳である)
    expect(st.error, '既に付いていただけでエラーにした').toBeNull();
  });
});

/**
 * 🔴 **打ち終えて Enter を押したら足せる**(#639)。
 *
 * ⚠ タグを打つ欄は 3 つあるのに、**Enter が効くのは情報ペインの欄だけ**だった ──
 *   帯の欄と条件の欄では**無音で捨てられて**いた(押しても何も起きず理由も出ない)。
 * 🔑 いまは欄と操作の対を `TAG_INPUT_ADD` 1 か所が持つ(候補の口も同じ表から引く)。
 */
describe('タグの欄で Enter(#639)', () => {
  it('🔴 まとめて付ける帯の欄で Enter を押すと、disk まで届く', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    const input = s.q<HTMLInputElement>('[data-pkc-field="bulk-tag"]')!;
    input.value = '請求済';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    expect(readTags(s.disk['e1']!), 'Enter で届いていない').toEqual(['請求済']);
    expect(readTags(s.disk['e2']!), '選んだ全部に届いていない').toEqual(['請求済']);
    // 🔑 通ったら欄は空になる(押したときと同じ作法 ── 次の 1 つをすぐ打てる)
    expect(input.value, '通ったのに欄が残っている').toBe('');
  });

  /**
   * ⚠ **変換中の Enter では撃たない** ── 日本語のタグを打つ人は毎回踏む。
   * 🔑 対照群は上の test(変換中でない Enter は通る)。
   * ⚠ 守っているのは `binder` の入口の 1 行(`if (ke.isComposing) return;`)なので、
   *   **振る舞いで留める**(門の在り処が変わっても主張は変わらない)。
   */
  it('🔴 変換中の Enter では撃たない', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    // ⚠ **前提を確かめる** ── 台が `isComposing` を運べないなら、この test は空振り
    const probe = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true });
    expect(probe.isComposing, '台が変換中を再現できていない(この test は空振り)').toBe(true);
    const input = s.q<HTMLInputElement>('[data-pkc-field="bulk-tag"]')!;
    input.value = 'せいきゅう';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
    );
    await tick();
    expect(readTags(s.disk['e1']!), '変換中に確定してしまった').toEqual([]);
  });

  /**
   * ⚠ **対照群** ── 帯の欄の候補は**前から出ていた**(壊れていたのは条件の欄で、
   *   そちらは `tests/adapter/smart-folder.test.ts` が見る)。
   * 🔑 ここが守るのは「**表へ寄せたときに、前から在ったものを落としていない**」
   *   ことである ── 判定を 1 か所へ寄せる直しは、寄せ損ねると静かに機能が減る。
   */
  it('⚠ 対照群: 帯の欄に触ると、候補を集める頼みが飛ぶ(前から在った)', async () => {
    const s = setup({ e1: '---\ntags: [請求済]\n---\nあ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    /**
     * ⚠ **前提を assert する**(§1)── まだ集めていない印は `null` である。
     *   ここが最初から埋まっていたら、この test は何も見ていない。
     */
    expect(s.d.getState().tagSuggestions, '前提が崩れている: 最初から集まっている').toBeNull();
    const input = s.q<HTMLInputElement>('[data-pkc-field="bulk-tag"]')!;
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await tick();
    /**
     * 🔑 触った結果、**答えを持った**(`null` = まだ集めていない、から動いた)。
     * ⚠ 中身の件数までは見ない ── この台の store は本文の走査を持たないので、
     *   答えは空でよい。見たいのは「**頼みが飛んで、答えを憶えた**」ことである。
     */
    expect(s.d.getState().tagSuggestions, '候補を集めていない(頼みが飛んでいない)').not.toBeNull();
  });
});

/**
 * 🔴 **上限で入らなかったノートに「既に付いていました」と言わない**(#640)。
 *
 * ⚠ 直す前は効果層が 1 タグずつ `applyBodyRewrite` を呼び、返る **`null`** を
 *   「既に付いている」として数えていた ── その `null` には
 *   「**上限に当たって付かなかった**」も含まれるので、画面には
 *   **付いていないのに「既に付いていました」**という字が出ていた。
 */
describe('タグの上限に当たったとき(#640)', () => {
  const FULL = Array.from({ length: MAX_TAGS }, (_, i) => `t${String(i)}`).join(', ');

  it('🔴 上限で付かなかったことを、別の字で言う', async () => {
    // ⚠ 台は既存の test と同じ形にする ── 一括の帯は選んだものが在るときに出る
    const s = setup({ e1: `---\ntags: [${FULL}]\n---\nあ\n`, e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    // ⚠ 前提 ── この本文は上限に達している(達していなければ何も検めていない)
    expect(readTags(s.disk['e1']!).length, '前提が崩れている: 上限に達していない').toBe(MAX_TAGS);
    press(s, '新しい', 'add');
    await tick();
    const msg = s.d.getState().notice ?? '';
    expect(msg, '上限のことを言っていない').toContain('付きませんでした');
    expect(msg, '何個で止まるのかを言っていない').toContain(String(MAX_TAGS));
    // 🔴 **嘘を言わない** ── 付いていないのに「既に付いていました」と言わない
    expect(msg, '付いていないのに「既に付いていました」と言った').not.toContain(
      '既に付いていました',
    );
    // ⚠ 本文は 1 バイトも動かない(黙って古いタグを落としていない)
    expect(readTags(s.disk['e1']!).length, '上限を超えて書いた').toBe(MAX_TAGS);
  });

  /**
   * ⚠ **対照群** ── 「既に付いている」側の字は今までどおり出る
   *   (上の `not.toContain` が、いつでも真になる形になっていないこと)。
   */
  it('⚠ 対照群: 既に付いているときは、これまでどおりの字が出る', async () => {
    const s = setup({ e1: '---\ntags: [請求済]\n---\nあ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '請求済', 'add');
    await tick();
    const msg = s.d.getState().notice ?? '';
    expect(msg, '既に付いている話が消えた').toContain('既に付いていました');
    expect(msg, '上限でもないのに上限と言った').not.toContain('付きませんでした');
  });
});

describe('#402 ① まとめてタグを外す(片道にしない)', () => {
  it('🔴 付けたものを、同じ帯から外せる', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '請求済', 'add');
    await tick();
    expect(readTags(s.disk['e1']!)).toEqual(['請求済']);
    press(s, '請求済', 'remove');
    await tick();
    expect(readTags(s.disk['e1']!), '外せていない').toEqual([]);
    expect(readTags(s.disk['e2']!)).toEqual([]);
  });

  it('⚠ 他のタグは巻き添えにしない', async () => {
    // ⚠ **2 件用意する** ── 帯は 2 件以上でしか出ない(意図どおりの規則)。
    //    1 件の fixture で書いた 1 稿目は、押す物が無くて落ちた
    const s = setup({
      e1: '---\ntags: [家事, 請求済]\n---\nあ\n',
      e2: '---\ntags: [請求済, 買い物]\n---\nい\n',
    });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '請求済', 'remove');
    await tick();
    expect(readTags(s.disk['e1']!), '前に在ったタグが消えた').toEqual(['家事']);
    expect(readTags(s.disk['e2']!), '後ろに在ったタグが消えた').toEqual(['買い物']);
  });
});

describe('#402 ① 別の窓を踏まない', () => {
  it('🔴 読んだ本文の指紋を添えて書く(門が生きている)', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '請求済', 'add');
    await tick();
    expect(s.guards, '書込に指紋を添えていない(別の窓を黙って上書きする)').toEqual([
      contentHash64Hex('あ\n'),
      contentHash64Hex('い\n'),
    ]);
  });

  it('🔴 先を越されていたら、その 1 件は書かずに数に出す', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    s.conflictOn.add('e1');
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '請求済', 'add');
    await tick();
    expect(readTags(s.disk['e1']!), '踏み潰した').toEqual([]);
    expect(readTags(s.disk['e2']!), '巻き添えで止まった').toEqual(['請求済']);
    expect(s.d.getState().notice ?? '', '黙って落とした').toContain('1 件は書けませんでした');
    // 🔴 書けなかった 1 件を「付けました」に数えない(#1087)── 直す前は 2 件に付けたと言っていた
    expect(s.d.getState().notice ?? '', '書けなかったノートも「付けた」に数えた').toContain('1 件に付けました');
    expect(s.d.getState().notice ?? '').not.toContain('2 件に付けました');
  });

  it('🔴 書けなかった理由を取り違えない: 書込が例外で落ちたら、その理由を言い、別のタブのせいにしない(#1087)', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    s.throwOn.set('e1', 'QuotaExceededError');
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '請求済', 'add');
    await tick();
    const msg = s.d.getState().notice ?? '';
    expect(msg, '例外の理由を言っていない').toContain('1 件は書けませんでした(');
    expect(msg, '空き不足の案内が出ていない').toContain('空き容量が足りません');
    expect(msg, '空き不足を別のタブのせいにした').not.toContain('別のタブ');
  });

  it('🔴 理由は件数ごとに分ける: 衝突と例外が混ざっても、衝突の字に例外の理由を載せない(#1087)', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n', e3: 'う\n' });
    s.conflictOn.add('e1');
    s.throwOn.set('e2', 'QuotaExceededError');
    mark(s, ['e1', 'e2', 'e3']);
    await tick();
    press(s, '請求済', 'add');
    await tick();
    const msg = s.d.getState().notice ?? '';
    expect(msg).toContain('1 件は書けませんでした(別のタブまたはウィンドウが書き換えたためです)');
    expect(msg).toContain('1 件は書けませんでした(保存できる空き容量が足りません');
  });

  it('🔴 名前の変更の 2 回目は、1 回目の知らせ(外せなかった件数)を消さずに続けて言う(#1087)', async () => {
    const s = setup({ e1: '---\ntags: [旧]\n---\nあ\n', e2: '---\ntags: [旧]\n---\nい\n' });
    s.conflictOn.add('e1');
    s.d.dispatch({ type: 'BULK_TAG', lids: ['e1', 'e2'], tags: ['旧'], mode: 'remove' });
    await tick();
    // 2 回目(付ける)は書ける ── 2 回目の知らせだけを見ると「全部うまくいった」に見える場面
    s.conflictOn.clear();
    s.d.dispatch({ type: 'BULK_TAG', lids: ['e1', 'e2'], tags: ['新'], mode: 'add', afterPrevious: true });
    await tick();
    const msg = s.d.getState().notice ?? '';
    expect(msg, '前提: 2 回目は 2 件とも付いた').toContain('2 件に付けました');
    expect(msg, '1 回目の「書けなかった」が消えた').toContain('1 件は書けませんでした');
  });
});

describe('#1087 本文だけの書込は、別のタブの改名を巻き戻さない', () => {
  it('🔴 書く前に別のタブが題名を変えていても、タグ付けの書込は変えた題名を保つ', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    // 押した時点(画面の写し)は 't-e1'。その後、別のタブが disk の題名を変えた
    s.diskTitle['e1'] = '別のタブで付けた題名';
    press(s, '請求済', 'add');
    await tick();
    expect(readTags(s.disk['e1']!), '前提: タグは付いた').toEqual(['請求済']);
    expect(s.diskTitle['e1'], '別のタブの改名を古い題名へ戻した').toBe('別のタブで付けた題名');
  });
});

describe('#402 ① 画面に無いものは触らない', () => {
  it('🔴 絞り込みで消えた行には書かない(消す側と同じ規則)', async () => {
    /**
     * ⚠ **絞った後も 2 件は残す** ── 帯は 2 件以上でしか出ない(意図どおりの規則)。
     *   1 件まで絞った 1 稿目は、押す物が無くて落ちた。
     */
    const s = setup(
      { e1: 'あ\n', e2: 'い\n', e3: 'う\n' },
      { e1: '請求 A', e2: '請求 B', e3: 'よそ' },
    );
    mark(s, ['e1', 'e2', 'e3']);
    await tick();
    // ⚠ 印は残るが、表からは消える ── ここが `delete-selected` と同じ規則の要点
    s.d.dispatch({ type: 'SET_ENTRY_FILTER', query: '請求' });
    await tick();
    press(s, '請求済', 'add');
    await tick();
    expect(readTags(s.disk['e1']!), '見えている行に書けていない').toEqual(['請求済']);
    expect(readTags(s.disk['e2']!), '見えている行に書けていない').toEqual(['請求済']);
    expect(readTags(s.disk['e3']!), '画面に無い行に書いた').toEqual([]);
  });
});

describe('#402 ① 断り方', () => {
  it('🔴 タグが空なら理由を出す(押して無反応にしない)', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '   ', 'add');
    await tick();
    expect(s.d.getState().error ?? '', '無言で終わった').toContain('タグを入力');
    expect(s.disk['e1'], '断ったのに書いた').toBe('あ\n');
  });

  it('⚠ 断ったときは打った字を残す(打ち直させない)', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    const field = s.q<HTMLInputElement>('[data-pkc-field="bulk-tag"]')!;
    field.value = '  ';
    s.q('[data-pkc-action="bulk-tag-add"]')!.click();
    await tick();
    expect(field.value, '断ったのに欄を空にした').toBe('  ');
  });

  it('🔑 通ったら欄を空にする(次の 1 つを打てる)', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '請求済', 'add');
    await tick();
    expect(s.q<HTMLInputElement>('[data-pkc-field="bulk-tag"]')!.value).toBe('');
  });

  it('⚠ 1 件でもタグの欄は出る(#1087 流れ 29 Q5)。2 件以上で件数は複数になる', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    mark(s, ['e1']);
    await tick();
    expect(s.q('[data-pkc-field="bulk-tag"]'), '1 件でタグの欄が出ない').not.toBeNull();
    expect(s.q('[data-pkc-field="filer-bulk-count"]')?.textContent).toContain('1 件');
    mark(s, ['e2']);
    await tick();
    expect(s.q('[data-pkc-field="bulk-tag"]')).not.toBeNull();
  });
});

/**
 * 🔴 **まとめて付ける帯でも `#買い物 #家事` で 2 つ付く**(#637)。
 *
 * ⚠ 欄は 3 か所ある(この帯 / 情報ペイン / スマートフォルダの条件)ので、
 *   **欄ごとに 1 件ずつ**見る ── 1 か所だけ直しても、同じ字が場所によって
 *   別の個数になる形は残る(§7「同じ判定が複数の場所にある」)。
 * 🔑 ここは**相手が 2 件**なので、「2 件 × 2 タグ」が全部届くことまで見る
 *   ── 1 つ目のタグを書いた本文の上に 2 つ目が乗る(書込は直列である)。
 */
describe('まとめて付ける帯で複数のタグ(#637)', () => {
  it('🔴 `#買い物 #家事` で、選んだ 2 件それぞれに 2 つ付く', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '#買い物 #家事', 'add');
    await tick(60);
    expect(readTags(s.disk['e1']!), '1 件目が割れていない').toEqual(['買い物', '家事']);
    expect(readTags(s.disk['e2']!), '2 件目が割れていない').toEqual(['買い物', '家事']);
  });

  it('🔴 外すときも 2 つまとめて外れる(片道の操作を作らない)', async () => {
    const s = setup({ e1: '---\ntags: [買い物, 家事, 他]\n---\nあ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '#買い物 #家事', 'remove');
    await tick(60);
    expect(readTags(s.disk['e1']!), '2 つとも外れていない').toEqual(['他']);
  });

  /** 🔴 対照群: 井桁が無ければ空白入りの 1 つのまま(意図した名前を割らない)。 */
  it('🔴 対照群: `買い物 家事` は空白入りの 1 つ', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '買い物 家事', 'add');
    await tick(60);
    expect(readTags(s.disk['e1']!), '意図した空白入りの名前を割った').toEqual(['買い物 家事']);
  });
});

/**
 * 🔴 **押したのに入らなかった名前は、欄に残る**(#640 案 A。user 裁定 2026-09-04)。
 *
 * > user の物語: `#請求 #未払 #今月` と打って押した。3 つ目だけ上限で付かなかった。
 * > ⚠ 直す前は欄が**空**で、知らせに名前が出るだけ ── 直すには 3 つとも打ち直し。
 *
 * 🔑 観測点は**欄の字そのもの**(`<input>` の value)── 「知らせに名前が出る」は
 *   #658 が既に見ている。ここは**押し直せる形で戻ること**を見る。
 */
describe('入らなかったタグは欄に残る(#640 案 A)', () => {
  /** 上限まで埋めた本文。⚠ `keep` を先頭に含めて MAX_TAGS 個(既に付いている側の対照)。 */
  function fullWith(keep: readonly string[]): string {
    const rest = Array.from({ length: MAX_TAGS - keep.length }, (_, i) => `t${String(i)}`);
    return `---\ntags: [${[...keep, ...rest].join(', ')}]\n---\nあ\n`;
  }
  const field = (s: ReturnType<typeof setup>): HTMLInputElement =>
    s.q<HTMLInputElement>('[data-pkc-field="bulk-tag"]')!;

  it('🔴 3 つ打って 3 つ目だけ上限で付かなかったら、欄は `#今月` になる', async () => {
    const s = setup({ e1: fullWith(['請求', '未払']), e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    expect(readTags(s.disk['e1']!).length, '前提: 上限に達していない').toBe(MAX_TAGS);
    press(s, '#請求 #未払 #今月', 'add');
    expect(field(s).value, '押した瞬間に欄が空になっていない').toBe('');
    await tick(40);
    // ⚠ 前提 ── e2 には 3 つとも付き、e1 では「今月」だけが上限に当たった
    expect(readTags(s.disk['e2']!), '前提: e2 に 3 つ付いていない').toEqual(['請求', '未払', '今月']);
    expect(readTags(s.disk['e1']!), '前提: e1 に今月が入った').not.toContain('今月');
    expect(field(s).value, '入らなかった名前が欄に戻っていない').toBe('#今月');
  });

  it('🔴 全部通ったら欄は空のまま(これまでどおり)', async () => {
    const s = setup({ e1: 'あ\n', e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '#請求 #未払', 'add');
    await tick(40);
    expect(readTags(s.disk['e1']!), '前提: 付いていない').toEqual(['請求', '未払']);
    expect(field(s).value, '通ったのに欄に字が残った').toBe('');
  });

  it('🔴 2 つ断られたら 2 つ、打った順に残る', async () => {
    const s = setup({ e1: fullWith(['請求']), e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '#今月 #請求 #未払', 'add');
    await tick(40);
    expect(field(s).value, '順序か個数が違う').toBe('#今月 #未払');
  });

  it('🔑 直して押し直すと、前の回の名前は混ざらない', async () => {
    const s = setup({ e1: fullWith(['請求']), e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '#今月', 'add');
    await tick(40);
    expect(field(s).value, '前提: 戻っていない').toBe('#今月');
    press(s, '#来月', 'add');
    await tick(40);
    expect(field(s).value, '前の回の名前が混ざった').toBe('#来月');
  });

  it('⚠ 断りが届く前に打ち始めていたら、その字を奪わない', async () => {
    const s = setup({ e1: fullWith(['請求']), e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    press(s, '#今月', 'add');
    field(s).value = '#来';
    await tick(40);
    expect(field(s).value, '打ちかけを上書きした').toBe('#来');
  });

  it('対照群 ── 欄を持たない呼び手(情報ペインの札を外す等)は欄へ戻さない', async () => {
    const s = setup({ e1: fullWith(['請求']), e2: 'い\n' });
    mark(s, ['e1', 'e2']);
    await tick();
    // ⚠ `field` を渡さない BULK_TAG(= 欄の無い経路)── 断られても欄は空のまま
    s.d.dispatch({ type: 'BULK_TAG', lids: ['e1'], tags: ['今月'], mode: 'add' });
    await tick(40);
    expect(readTags(s.disk['e1']!), '前提: 上限に当たっていない').not.toContain('今月');
    expect(field(s).value, '欄の無い経路の断りを欄へ戻した').toBe('');
  });
});

describe('#1087 書けないノートには書かない(前書きが読めない / 字下げした入れ子のタグ)', () => {
  /** 前書きが読めない 3 形。⚠ どれも `tags:` を持つ ── 書くと既存のタグが消える形である。 */
  const UNREADABLE: Record<string, string> = {
    '閉じの --- が無い': '---\ntags: [買い物, 家事]\n本文です\n',
    '閉じの --- が無い(CRLF)': '---\r\ntags: [買い物, 家事]\r\n本文です\r\n',
    '前書きが 16KB を超える': `---\ntags: [買い物, 家事]\nmemo: ${'あ'.repeat(17000)}\n---\n本文です\n`,
  };

  for (const [label, body] of Object.entries(UNREADABLE)) {
    it(`🔴 ${label}ノートに付けても、既存のタグを消さず・書かず・知らせで言う`, async () => {
      const s = setup({ e1: body, e2: 'い\n' });
      mark(s, ['e1', 'e2']);
      await tick();
      press(s, '請求', 'add');
      await tick();
      expect(s.disk['e1'], '読めないノートの本文が書き換わった').toBe(body);
      // 対照群: 読めるノートには付く(門が全部を止めていない)
      expect(readTags(s.disk['e2']!)).toEqual(['請求']);
      const said = s.d.getState().notice ?? '';
      expect(said).toContain('1 件に付けました');
      expect(said).toContain('前書きが読めないノート 1 件には付けませんでした');
    });
  }

  it('🔴 外す側も同じ(読めないノートから外せたと言わない)', async () => {
    const body = UNREADABLE['閉じの --- が無い']!;
    const s = setup({ e1: body });
    mark(s, ['e1']);
    await tick();
    press(s, '買い物', 'remove');
    await tick();
    expect(s.disk['e1']).toBe(body);
    const said = s.d.getState().notice ?? '';
    expect(said).toContain('前書きが読めないノート 1 件には外しませんでした');
    expect(said, '外していないのに「付いていませんでした」と言っている').not.toContain('付いていませんでした');
  });

  it('🔴 字下げした入れ子の `tags:` は、外せたと言わず・本文も動かさない(A5)', async () => {
    const nested = '---\nmeta:\n  tags: [zz]\n---\n本文\n';
    const s = setup({ e1: nested });
    mark(s, ['e1']);
    await tick();
    press(s, 'zz', 'remove');
    await tick();
    expect(s.disk['e1']).toBe(nested);
    const said = s.d.getState().notice ?? '';
    expect(said, '本文が 1 バイトも変わらないのに外したと言っている').not.toContain('1 件から外しました');
    expect(said).toContain('1 件は字下げした行のタグなので、ここからは外せませんでした');
  });

  it('🔴 入れ子のタグに他のタグが残っていても、最上位に同じ鍵を増やさない', async () => {
    const nested = '---\nmeta:\n  tags: [zz, y]\n---\n本文\n';
    const s = setup({ e1: nested });
    mark(s, ['e1']);
    await tick();
    press(s, 'zz', 'remove');
    await tick();
    expect(s.disk['e1']).toBe(nested);
  });
});
