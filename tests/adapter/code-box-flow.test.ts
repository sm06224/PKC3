/** @vitest-environment happy-dom */
/**
 * 🔴 **コード枠だけの下書き ── 押してから disk まで(#1044 段3)**。
 *
 * 純粋な reducer は `tests/adapter/code-draft.test.ts` が見る。ここは
 * **画面から届くか**(✎ を押す → 箱が出る → 打つ → 「コードを保存する」→
 * disk へ着く / 履歴が動く)と、**段2 の仕組みを共有していること**
 * (同じノートで章の欄とコード枠の欄が競合したら 3 択を通す)を、実物の
 * `DetailRenderer` + `bindActions` + `connectStoreEffects` を繋いで見る。
 *
 * ⚠ ハーネスは `tests/adapter/section-box-flow.test.ts` と**同じ形**
 *   (2 つ目の書き方を作らない)。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert, EntryStamps } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { bindEditLockRelease } from '../../src/adapter/state/edit-lock-release';
import type { CodeDraft } from '../../src/adapter/state/app-state';
import { isCodeDraft } from '../../src/adapter/state/app-state';
import { frontmatterLineCount } from '../../src/features/markdown/frontmatter';

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** このファイルはコード枠の下書きだけを組む。 */
function codeDraft(d: Dispatcher): CodeDraft | null {
  const s = d.getState().sectionDraft;
  return s !== null && isCodeDraft(s) ? s : null;
}

function meta(lid: string, title = 't-' + lid): EntryMeta {
  return {
    lid,
    title,
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

/**
 * ⚠ **枠は見出しの外(冒頭)に置く**(#1044 段3)── 「この章を編集する」で
 * 章の欄が開くと、その章の範囲の塊は箱に差し替わって DOM から外れる。枠が
 * 章 A の範囲の中(A 〜 B の手前)に在ると、A を開いた瞬間に枠(と ✎)が
 * 画面から消える ── それは正しい動きだが、「章の外のコード枠」を試すこの test
 * の前提が崩れる。だから枠は**どの章にも属さない冒頭**に置く。
 */
const DOC = [
  '# note',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '## A',
  '',
  '内容 A。',
  '',
  '## B',
  '',
  '内容 B。',
  '',
].join('\n');

/**
 * 🔴 **frontmatter つき**(#1044 段3 2巡目の修理、V1)。
 *
 * ⚠ 二重加算は frontmatter の行数が **0** だと足し算そのものが 0 になり、
 *   `DOC`(frontmatter 無し)では**発火しない** ── だからこの fixture が要る
 *   (fixture のゼロ件の次元。CLAUDE.md §2)。
 */
const DOC_FM = '---\ntags: [x]\n---\n\n' + DOC;

/**
 * 🔴 **引用(`>`)の中の枠、かつ前に地の文が在る**(#1044 段3 2巡目の修理、V2)。
 *
 * ⚠ 「枠だけの引用」(地の文が無い)では、`<blockquote>` 自身が(枠と同じ行番号を
 *   たまたま持つので)偶然当たっていた ── 地の文を **1 行でも**挟むと、枠の
 *   開きの行と `<blockquote>` の開きの行が食い違い、直す前は**箱が 1 バイトも
 *   DOM に出なかった**(V2 の実物の再現には地の文が要る)。
 */
const DOC_QUOTE = [
  '# note',
  '',
  '> 引用の説明文。',
  '>',
  '> ```js',
  '> const a = 1;',
  '> ```',
  '',
  '内容',
].join('\n');

/** 🔴 **枠が 2 つ**(#1044 段3 2巡目の修理、V4)── A を開いたまま B へ切り替える。 */
const DOC_TWO_FENCES = [
  '# note',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '```py',
  'b = 2',
  '```',
  '',
  '内容',
].join('\n');

/** 🔴 `DOC_TWO_FENCES` の frontmatter つき(#1044 段3 2巡目の修理、V4)。 */
const DOC_TWO_FENCES_FM = '---\ntags: [x]\n---\n\n' + DOC_TWO_FENCES;

const MENU = '[data-pkc-region="context-menu"]';

function rightClick(el: Element): void {
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
  );
}

beforeEach(() => {
  document.body.textContent = '';
  resetAppDialogForTest();
});

function setup(overrides: Partial<BinderServices> = {}, doc: string = DOC) {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const shell = buildShell(root);
  const d = new Dispatcher();
  const detail = new DetailRenderer(shell.detail);
  d.onState((s) => detail.render(s));
  const locks: string[] = [];
  const releases: string[] = [];
  const statuses: string[] = [];
  let lockAnswer: 'granted' | 'denied' | 'unreachable' = 'granted';
  const services: BinderServices = {
    acquireEditLock: async (lid: string) => {
      locks.push(lid);
      return lockAnswer;
    },
    releaseEditLock: (lid: string) => {
      releases.push(lid);
    },
    showStatus: (t) => void statuses.push(t),
    ...overrides,
  };
  bindActions(root, d, services);
  bindEditLockRelease(d, () => ({ releaseEdit: (_cid, lid) => releases.push(lid) }), 'c1');
  const disk: Record<string, string> = { n1: doc, n2: 'べつのノート\n' };
  const persisted: { entry: EntryUpsert; checkpoint?: boolean }[] = [];
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid: string) => disk[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async (): Promise<EntryStamps> => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async (): Promise<EntryStamps> => stubStamps(),
    persistEntry: async (e: EntryUpsert, opts?: { checkpoint?: boolean }): Promise<EntryStamps> => {
      persisted.push({ entry: e, checkpoint: opts?.checkpoint });
      disk[e.lid] = e.body;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1'), meta('n2')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  return {
    root,
    d,
    locks,
    releases,
    statuses,
    disk,
    persisted,
    setLockAnswer: (a: typeof lockAnswer) => (lockAnswer = a),
  };
}

function codeInput(root: HTMLElement): HTMLTextAreaElement | null {
  return root.querySelector<HTMLTextAreaElement>('[data-pkc-field="code-draft-input"]');
}

/** 本文の唯一のコード枠の ✎ を押す。 */
async function clickEditCodeBlock(root: HTMLElement): Promise<void> {
  await tick();
  const btn = root.querySelector<HTMLElement>('[data-pkc-action="edit-code-block"]');
  if (btn === null) throw new Error('前提が崩れている: ✎ が出ていない');
  btn.click();
  await tick();
}

describe('コード枠の ✎ を押し、打って保存する(#1044 段3)', () => {
  it('🔴 ✎ で、枠の中身だけが入力欄になる(打ちかけの原文が入る)', async () => {
    const { root, d } = setup();
    await clickEditCodeBlock(root);
    expect(codeDraft(d)?.original).toBe('const a = 1;');
    const ta = codeInput(root);
    expect(ta, '箱が出ていない').not.toBeNull();
    expect(ta!.value).toBe('const a = 1;');
    // 🔴 アプリ全体は編集中にならない
    expect(d.getState().phase).toBe('ready');
    // ⚠ 他の見出しは読む面のまま
    expect(root.querySelector('[data-pkc-field="detail-body"]')?.textContent).toContain('内容 A。');
    expect(root.querySelector('[data-pkc-field="detail-body"]')?.textContent).toContain('内容 B。');
  });

  it('🔴 「コードを保存する」で、disk へ届き履歴に 1 版積まれる(``` の行は変わらない)', async () => {
    const { root, d, persisted, disk } = setup();
    await clickEditCodeBlock(root);
    codeInput(root)!.value = 'const a = 2;\nconst b = 3;';
    root.querySelector<HTMLElement>('[data-pkc-action="save-code-draft"]')!.click();
    await tick();
    expect(d.getState().sectionDraft, '保存後も箱が残っている').toBeNull();
    expect(disk.n1).toContain('const a = 2;');
    expect(disk.n1).toContain('const b = 3;');
    expect(disk.n1).toContain('```js');
    expect(disk.n1).toContain('内容 A。'); // ほかは無事
    expect(persisted.length, '書込が届いていない').toBe(1);
    expect(persisted[0]!.checkpoint, '履歴に積んでいない').toBe(true);
    await tick();
    expect(root.querySelector('[data-pkc-field="detail-body"]')?.textContent).toContain('const b = 3;');
    expect(codeInput(root), '保存後も箱が残っている(DOM)').toBeNull();
  });

  it('🔴 「コードの編集をやめる」で、聞かずに閉じる(disk は無傷)', async () => {
    const { root, d, disk } = setup();
    await clickEditCodeBlock(root);
    codeInput(root)!.value = '打ちかけ';
    root.querySelector<HTMLElement>('[data-pkc-action="cancel-code-draft"]')!.click();
    await tick();
    expect(d.getState().sectionDraft).toBeNull();
    expect(disk.n1).toBe(DOC);
  });

  it('🔴 別の場所で書き換えられていたら、1 文字も書かずに断る(箱は残る)', async () => {
    const { root, d, disk } = setup();
    await clickEditCodeBlock(root);
    // 別経路(別タブ等)が disk 上の枠の中身を直接変えた
    disk.n1 = disk.n1!.replace('const a = 1;', 'const a = 999; // 別経路が書いた');
    codeInput(root)!.value = 'const a = 2;';
    root.querySelector<HTMLElement>('[data-pkc-action="save-code-draft"]')!.click();
    await tick();
    expect(d.getState().sectionDraft, '断られたのに箱が消えた').not.toBeNull();
    expect(codeInput(root), '断られたのに箱が消えた(DOM)').not.toBeNull();
    expect(codeInput(root)!.value, '打ちかけが消えた').toBe('const a = 2;');
    expect(disk.n1, '断ったのに disk が動いた').toContain('999');
    expect(d.getState().error ?? '').toContain('別の場所で書き換えられました');
  });
});

describe('章の欄とコード枠の欄は、同じ 1 本の機構(段2 の共有)を通る(#1044 段3)', () => {
  /** 見出し「A」を右クリックし「この章を編集する」を押す。 */
  function clickEditSectionOnA(root: HTMLElement): void {
    const heads = [...root.querySelectorAll<HTMLElement>('[data-pkc-field="detail-body"] h2')];
    const head = heads.find((h) => h.textContent === 'A');
    if (head === undefined) throw new Error('前提が崩れている: 見出し A が描けていない');
    rightClick(head);
    root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="edit-section"]`)!.click();
  }

  function pressRow(root: HTMLElement, label: string): void {
    const rows = [...root.querySelectorAll<HTMLButtonElement>('[data-pkc-field="pick-section-leave"]')];
    const b = rows.find((r) => r.textContent === label);
    if (b === undefined) throw new Error(`前提が崩れている: 「${label}」が出ていない`);
    b.click();
  }

  it('🔴 コード枠の欄が書きかけのまま「この章を編集する」を押すと、コードの字で 3 択を出す', async () => {
    const { root, d } = setup();
    await clickEditCodeBlock(root);
    codeInput(root)!.value = '打ちかけ';

    clickEditSectionOnA(root);
    await tick();

    expect(
      document.querySelector('[data-pkc-field="dialog-title"]')?.textContent,
      '設問が出ていない、または字が章のまま(コードの字になっていない)',
    ).toBe('書きかけのコードがあります');
    pressRow(root, '書きかけを消して移る');
    await tick();

    expect(d.getState().sectionDraft, 'コードの欄が残っている').not.toBeNull();
    const draft = d.getState().sectionDraft!;
    expect(isCodeDraft(draft), '章の欄が開いていない(切り替わっていない)').toBe(false);
  });

  it('🔴 章の欄が書きかけのまま ✎ を押すと、章の字で 3 択を出す', async () => {
    const { root, d } = setup();
    await tick();
    clickEditSectionOnA(root);
    await tick();
    const sectionTa = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="section-draft-input"]')!;
    sectionTa.value = '## A\n\n打ちかけ';

    const btn = root.querySelector<HTMLElement>('[data-pkc-action="edit-code-block"]');
    // ⚠ 章の欄が本文の一部を箱で差し替えている間、コード枠は読む面のまま
    //   なので ✎ はまだ在るはず(章の範囲の外)
    expect(btn, '前提が崩れている(✎ が見えていない)').not.toBeNull();
    btn!.click();
    await tick();

    expect(
      document.querySelector('[data-pkc-field="dialog-title"]')?.textContent,
      '設問が出ていない、または字が章のまま',
    ).toBe('書きかけの章があります');
    pressRow(root, '書きかけを消して移る');
    await tick();

    expect(d.getState().sectionDraft, 'コードの欄が開いていない').not.toBeNull();
    expect(isCodeDraft(d.getState().sectionDraft!), '章の欄のまま(切り替わっていない)').toBe(true);
  });
});

/**
 * 🔴 **コード枠の欄が書きかけのまま、章ではなく別のノートを選ぶと、先に聞く**
 * (#1044 段3。section-box-flow.test.ts の同名 describe(裁定 Q2 = A)を
 * コード枠で当て直す ── 章の見出しとの切替は上の describe が見ているので、
 * ここは「章でも枠でもない、丸ごと別のノート」だけを見る)。
 */
describe('書きかけのままコード枠を残して別のノートを選ぶと、先に聞く(#1044 段3)', () => {
  function rows(root: HTMLElement): HTMLButtonElement[] {
    return [...root.querySelectorAll<HTMLButtonElement>('[data-pkc-field="pick-section-leave"]')];
  }
  function pressRow(root: HTMLElement, label: string): void {
    const b = rows(root).find((r) => r.textContent === label);
    if (b === undefined) throw new Error(`前提が崩れている: 「${label}」が出ていない`);
    b.click();
  }
  function selectN2Button(root: HTMLElement): HTMLElement {
    const target = document.createElement('button');
    target.setAttribute('data-pkc-action', 'select-entry');
    target.setAttribute('data-pkc-entry', 'n2');
    root.append(target);
    return target;
  }

  it('🔴 変更が無ければ、聞かずに移る(箱を閉じるだけ)', async () => {
    const { root, d } = setup();
    await clickEditCodeBlock(root);
    selectN2Button(root).click();
    await tick();
    expect(rows(root).length, '聞かずに移るはずが、聞いている').toBe(0);
    expect(d.getState().sectionDraft).toBeNull();
    expect(d.getState().selectedLid).toBe('n2');
  });

  it('🔴 変更があれば「コード」の字で聞く ──「移らない」を押すと、選択も箱も打った字もそのまま', async () => {
    const { root, d } = setup();
    await clickEditCodeBlock(root);
    codeInput(root)!.value = 'const a = 2;';
    selectN2Button(root).click();
    await tick();
    expect(
      document.querySelector('[data-pkc-field="dialog-title"]')?.textContent,
      '設問の題名が出ていない、またはコードの字になっていない',
    ).toBe('書きかけのコードがあります');
    expect(rows(root).map((r) => r.textContent)).toEqual([
      'コードを保存して移る',
      '書きかけを消して移る',
      '移らない',
    ]);
    pressRow(root, '移らない');
    await tick();
    expect(d.getState().selectedLid, '移ってしまった').toBe('n1');
    expect(d.getState().sectionDraft, '箱が消えた').not.toBeNull();
    expect(codeInput(root)!.value, '打った字が消えた').toBe('const a = 2;');
  });

  it('🔴 「書きかけを消して移る」で、書かずに移る', async () => {
    const { root, d, disk } = setup();
    await clickEditCodeBlock(root);
    codeInput(root)!.value = 'const a = 2;';
    selectN2Button(root).click();
    await tick();
    pressRow(root, '書きかけを消して移る');
    await tick();
    expect(d.getState().selectedLid).toBe('n2');
    expect(d.getState().sectionDraft).toBeNull();
    expect(disk.n1, '書かずに移るはずが書いた').toBe(DOC);
  });

  it('🔴 「コードを保存して移る」で、保存してから移る(disk が動き、履歴が 1 件積まれる)', async () => {
    const { root, d, disk, persisted } = setup();
    await clickEditCodeBlock(root);
    codeInput(root)!.value = 'const a = 2;\nconst b = 3;';
    selectN2Button(root).click();
    await tick();
    pressRow(root, 'コードを保存して移る');
    await tick();
    await tick();
    expect(disk.n1).toContain('const b = 3;');
    expect(disk.n1).toContain('内容 A。'); // ほかは無事
    expect(persisted.length, '書込が届いていない').toBe(1);
    expect(persisted[0]!.checkpoint, '履歴に積んでいない').toBe(true);
    expect(d.getState().selectedLid, '保存したのに移っていない').toBe('n2');
    expect(d.getState().sectionDraft).toBeNull();
  });
});

/**
 * 🔴 **frontmatter のあるノートでも ✎ が使える(#1044 段3 2巡目の修理、V1)**。
 *
 * 直す前は `tableLineAt`(frontmatter 込みの行を返す)の結果をそのまま
 * `startCodeEditAt` へ渡していたので、`OPEN_CODE_DRAFT` の reducer が
 * `frontmatterLineCount` を**もう一度**足し、frontmatter を持つノートでは
 * ✎ が必ず「このコードブロックを編集できませんでした」に落ちていた。
 */
describe('frontmatter があるノートでも ✎ が使える(#1044 段3 2巡目の修理、V1)', () => {
  it('🔴 ✎ で開き、打って保存すると、正しい枠(disk)が変わる(frontmatter は無傷)', async () => {
    const { root, d, disk, persisted } = setup({}, DOC_FM);
    await clickEditCodeBlock(root);
    expect(
      d.getState().error,
      '「このコードブロックを編集できませんでした」に落ちた(V1 の再発)',
    ).toBeFalsy();
    expect(
      codeDraft(d)?.original,
      '前提が崩れている(frontmatter の行数ずれで違う枠 / 何も開いていない)',
    ).toBe('const a = 1;');
    const ta = codeInput(root);
    expect(ta, '箱が DOM に出ていない(V1 の再発)').not.toBeNull();
    ta!.value = 'const a = 2;';
    root.querySelector<HTMLElement>('[data-pkc-action="save-code-draft"]')!.click();
    await tick();
    expect(disk.n1, 'frontmatter が消えた / 動いた').toContain('---\ntags: [x]\n---');
    expect(disk.n1, '別の枠(章の内容など)を書き換えた').toContain('## A');
    expect(disk.n1, '打った字が届いていない').toContain('const a = 2;');
    expect(disk.n1, '古い中身が残っている').not.toContain('const a = 1;');
    expect(persisted.length, '書込が届いていない').toBe(1);
    expect(persisted[0]!.checkpoint, '履歴に積んでいない').toBe(true);
  });
});

/**
 * 🔴 **引用(`>`)の中のコード枠でも ✎ が使える(#1044 段3 2巡目の修理、V2)**。
 *
 * 直す前は `code-box.ts` の `blockAtLine` が**本文の器の直下だけ**を見ていたので、
 * 引用の中に地の文が 1 行でもあると枠の div へ当たらず、`OPEN_CODE_DRAFT` の
 * reducer は成功する(`sectionDraft` は在る)のに**箱が DOM に 1 バイトも
 * 出ない** ── 押しても無言、理由も出ないいちばん静かな dead click だった。
 */
describe('引用の中のコード枠でも ✎ が使える(#1044 段3 2巡目の修理、V2)', () => {
  it('🔴 引用の中の枠を開き、打って保存すると、`> ` が付き直り地の文は無傷', async () => {
    const { root, d, disk, persisted } = setup({}, DOC_QUOTE);
    await clickEditCodeBlock(root);
    expect(d.getState().error, '押しても無言のまま理由も出ないバグの再発').toBeFalsy();
    expect(
      codeDraft(d)?.original,
      '引用の前置きを剥がさずに控えた、または何も開いていない',
    ).toBe('const a = 1;');
    const ta = codeInput(root);
    expect(ta, '箱が DOM に出ていない(V2 の再発)').not.toBeNull();
    ta!.value = 'const a = 2;\nconst b = 3;';
    root.querySelector<HTMLElement>('[data-pkc-action="save-code-draft"]')!.click();
    await tick();
    expect(disk.n1, '`> ` が付き直っていない').toContain('> const a = 2;');
    expect(disk.n1, '2 行目に `> ` が付き直っていない').toContain('> const b = 3;');
    expect(disk.n1, '引用の中の地の文が消えた').toContain('> 引用の説明文。');
    expect(persisted.length, '書込が届いていない').toBe(1);
    expect(persisted[0]!.checkpoint, '履歴に積んでいない').toBe(true);
  });

  it('🔴 刻印の外を押しても、無言のままではなく理由が出る', async () => {
    const { root, statuses } = setup({}, DOC_QUOTE);
    await tick();
    // ⚠ わざと `.pkc-md-block` の外(刻印の無い所)に置く ── `tableLineAt` が
    //   `null` を返す形(押した物から「その枠の行」を引けない)。
    const rogue = document.createElement('button');
    rogue.setAttribute('data-pkc-action', 'edit-code-block');
    root.querySelector('[data-pkc-field="detail-body"]')!.append(rogue);
    rogue.click();
    await tick();
    expect(
      statuses.some((s) => s.includes('見つかりません')),
      '行が引けないのに無言のまま(理由が出ていない)',
    ).toBe(true);
  });
});

/**
 * 🔴 **コード枠 A を開いたまま、別のコード枠 B の ✎ を押す**
 * (#1044 段3 2巡目の修理、V4)── `identityBefore` を保存の前に控え、
 * 保存後にその身元で B を探し直す経路(`startCodeEditAt` の「② 別の枠」)。
 */
describe('コード枠 A を開いたまま、別のコード枠 B の ✎ を押すと共有の 3 択を通す(#1044 段3 2巡目の修理、V4)', () => {
  function pressRow(root: HTMLElement, label: string): void {
    const rows = [...root.querySelectorAll<HTMLButtonElement>('[data-pkc-field="pick-section-leave"]')];
    const b = rows.find((r) => r.textContent === label);
    if (b === undefined) throw new Error(`前提が崩れている: 「${label}」が出ていない`);
    b.click();
  }

  it('🔴 変更が無ければ、聞かずに切り替わる(A は無傷、B が開く)', async () => {
    const { root, d, disk } = setup({}, DOC_TWO_FENCES);
    await clickEditCodeBlock(root);
    expect(codeDraft(d)?.original, '前提が崩れている(A が開いていない)').toBe('const a = 1;');
    // ⚠ A の div は箱に差し替わっているので、残る ✎ は B のもの 1 つだけ
    await clickEditCodeBlock(root);
    expect(
      root.querySelectorAll('[data-pkc-field="pick-section-leave"]').length,
      '変更が無いのに聞いている',
    ).toBe(0);
    expect(codeDraft(d)?.original, 'B へ切り替わっていない').toBe('b = 2');
    expect(disk.n1, '変更が無いのに disk が動いた').toBe(DOC_TWO_FENCES);
  });

  it('🔴 変更あり・frontmatter つきでも「コード」の字で 3 択を出し、「コードを保存して移る」で A が保存され B が開く', async () => {
    const { root, d, disk, persisted } = setup({}, DOC_TWO_FENCES_FM);
    await clickEditCodeBlock(root);
    codeInput(root)!.value = 'const a = 999;';
    await clickEditCodeBlock(root);
    await tick();
    expect(
      document.querySelector('[data-pkc-field="dialog-title"]')?.textContent,
      '設問が出ていない、またはコードの字になっていない',
    ).toBe('書きかけのコードがあります');
    pressRow(root, 'コードを保存して移る');
    await tick();
    await tick();
    expect(disk.n1, '打った字が届いていない').toContain('const a = 999;');
    expect(disk.n1, 'frontmatter が動いた').toContain('tags: [x]');
    expect(persisted.length, '書込が届いていない').toBe(1);
    expect(persisted[0]!.checkpoint, '履歴に積んでいない').toBe(true);
    expect(codeDraft(d)?.original, 'B が開いていない').toBe('b = 2');
  });

  /**
   * 🔴 **「同じ枠か」の比べ方の基準**(#1044 段3、着地前レビュー 2 巡目の 🔴)。
   * ⚠ 控えている行(`CodeDraft.line`)は **frontmatter 込み**の行、✎ が運ぶ行は
   *   **剥がした**行 ── そのまま比べると、frontmatter の行数と 2 つの枠の間隔が
   *   **たまたま一致した**ノートでだけ、B を押しても A と取り違えて**何も起きない**。
   * 🔑 だから一致する形をわざと作る(frontmatter 3 行 / A は剥がした 0 行目 /
   *   B は剥がした 3 行目)。上の 2 本は間隔が一致しないので、この取り違えを通らない。
   */
  it('🔴 frontmatter の行数と枠の間隔が一致するノートでも、B の ✎ で B が開く(A と取り違えない)', async () => {
    const DOC_COINCIDE = '---\ntags: [x]\n---\n```js\nconst a = 1;\n```\n```py\nb = 2\n```\n';
    // 前提:frontmatter が 3 行で、B の開きが剥がした本文の 3 行目(= A の生の行)
    expect(frontmatterLineCount(DOC_COINCIDE), '前提が崩れている(frontmatter の行数)').toBe(3);
    const { root, d } = setup({}, DOC_COINCIDE);
    await clickEditCodeBlock(root);
    expect(codeDraft(d)?.original, '前提が崩れている(A が開いていない)').toBe('const a = 1;');
    expect(codeDraft(d)?.line, '前提が崩れている(A の生の行が 3 でない)').toBe(3);
    await clickEditCodeBlock(root);
    expect(codeDraft(d)?.original, 'B を押したのに A のまま(同じ枠と取り違えた)').toBe('b = 2');
  });
});

/**
 * 🔴 **`detail.ts` の「箱が開いている間は本文を描き直さない」門(V3、#1044 段3
 *   2巡目の修理)**。⚠ **`section-box-flow.test.ts` の同名 describe と同じ形**
 *   (2 つ目の書き方を作らない)── 章とコード枠は同じ 1 本の門を共有するので、
 *   両方で通す。
 */
describe('箱が開いている間、別経路の本文更新で打ちかけが消えない(#1044 段3 2巡目の修理、V3)', () => {
  it('🔴 コード枠の欄が開いている間に BODY_LOADED が来ても、打ちかけの字は消えない', async () => {
    const { root, d } = setup();
    await clickEditCodeBlock(root);
    const ta = codeInput(root);
    expect(ta, '前提が崩れている(箱が出ていない)').not.toBeNull();
    ta!.value = 'const a = 打ちかけ;';

    // 🔴 別経路(別タブ等)が同じノートの本文を書き換え、その通知が届く
    d.dispatch({
      type: 'BODY_LOADED',
      lid: 'n1',
      body: DOC.replace('内容 A。', '別窓が書いた。'),
    });
    await tick();

    expect(d.getState().sectionDraft, '別経路の読み直しでコードの欄が消えた').not.toBeNull();
    expect(codeInput(root), '別経路の読み直しで箱が DOM から消えた').not.toBeNull();
    expect(codeInput(root)!.value, '打ちかけの字が消えた').toBe('const a = 打ちかけ;');
  });
});
