/** @vitest-environment happy-dom */
/**
 * 🔴 **章だけの下書き ── 押してから disk まで(#1044 段2)**。
 *
 * 純粋な reducer は `tests/adapter/section-draft.test.ts` が見る。ここは
 * **画面から届くか**(右クリック → 「この章を編集する」→ 箱が出る → 打つ →
 * 「章を保存する」→ disk へ着く / 履歴が動く)と、**移るときに聞く**(#1044 設計
 * doc §3、裁定 Q2 = A)の 2 つを、実物の `DetailRenderer` + `bindActions` +
 * `connectStoreEffects` を繋いで見る。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert, EntryStamps } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { bindActions, type BinderServices } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';
import { MarkdownClient } from '../../src/adapter/platform/render/markdown-client';
import type { RenderMarkdownOptions } from '../../src/features/markdown/markdown-render';
import { bindEditLockRelease } from '../../src/adapter/state/edit-lock-release';
import { answerDialog, dialogMessage } from './dialog-helper';

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

const DOC = ['# 議事録', '', '前置き。', '', '## 決定事項', '', '- 牛乳を買う', '', '## 次回', '', '来週。', ''].join(
  '\n',
);

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

function setup(overrides: Partial<BinderServices> = {}) {
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
  /**
   * 🔴 **実配線と同じく、状態駆動の解放も繋ぐ**(#1044 段2、F-B)。
   * ⚠ `main.ts` は `services.releaseEditLock`(binder の即時呼び出し)と
   *   `bindEditLockRelease`(state 駆動 ── 章の欄が system command で閉じた
   *   ときもここが返す)を**両方**繋いでいる。この fixture が片方だけしか
   *   繋いでいなかったので、章の欄の「二重解放をここで外す」(F-B)を反映した
   *   直後に `releases` が空になった(実配線を半分しか再現していなかった、
   *   という fixture 側の欠けが露見した ── CLAUDE.md §2)。
   */
  bindEditLockRelease(d, () => ({ releaseEdit: (_cid, lid) => releases.push(lid) }), 'c1');
  const disk: Record<string, string> = { n1: DOC, n2: 'べつのノート\n' };
  const persisted: { entry: EntryUpsert; checkpoint?: boolean }[] = [];
  /**
   * 🔴 **`getBody` を手で握れるようにする**(#1044 段2 4巡目の修理、T1)。
   * ⚠ `REQUEST_SECTION_SAVE` は disk から読み直すところ(`store.getBody`)が
   *   最初の await ── ここを止めれば「保存を撃ち ack を返さない」窓を再現できる
   *   (`append-box.test.ts` の `hold()` と同じ作法)。
   */
  let gate: { release: () => void } | null = null;
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid: string) => {
      if (gate) {
        const held = gate;
        await new Promise<void>((res) => {
          held.release = res;
        });
      }
      return disk[lid] ?? null;
    },
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
    setLockAnswer: (a: 'granted' | 'denied' | 'unreachable') => {
      lockAnswer = a;
    },
    /** 保存の disk 読み直しを止めて窓を開ける。返り値を呼ぶと通す。 */
    holdSave(): { pass(): void } {
      gate = { release: () => undefined };
      const held = gate;
      return {
        pass: () => {
          gate = null;
          held.release();
        },
      };
    },
  };
}

/** 見出し「決定事項」の `<h2>` を右クリックし、「この章を編集する」を押す。 */
async function openDraftOnHead2(root: HTMLElement, d: Dispatcher): Promise<void> {
  await tick();
  const heads = [...root.querySelectorAll<HTMLElement>('[data-pkc-field="detail-body"] h2')];
  const head = heads.find((h) => h.textContent === '決定事項');
  if (head === undefined) throw new Error('前提が崩れている: 見出しが描けていない');
  rightClick(head);
  const btn = root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="edit-section"]`);
  if (btn === null) throw new Error('前提が崩れている: 「この章を編集する」が出ていない');
  btn.click();
  await tick();
  void d;
}

function sectionInput(root: HTMLElement): HTMLTextAreaElement | null {
  return root.querySelector<HTMLTextAreaElement>('[data-pkc-field="section-draft-input"]');
}

describe('章を右クリックから開き、打って保存する(#1044 段2)', () => {
  it('🔴 「この章を編集する」で、章だけが入力欄になる(打ちかけの原文が入る)', async () => {
    const { root, d } = setup();
    await openDraftOnHead2(root, d);
    expect(d.getState().sectionDraft?.heading).toBe('決定事項');
    const ta = sectionInput(root);
    expect(ta, '箱が出ていない').not.toBeNull();
    expect(ta!.value).toContain('## 決定事項');
    expect(ta!.value).toContain('牛乳を買う');
    // 🔴 アプリ全体は編集中にならない ── 一覧・他の面はそのまま
    expect(d.getState().phase).toBe('ready');
    // ⚠ ほかの章は読む面のまま(箱に取り込まれていない)
    expect(root.querySelector('[data-pkc-field="detail-body"]')?.textContent).toContain('前置き。');
    expect(root.querySelector('[data-pkc-field="detail-body"]')?.textContent).toContain('来週。');
  });

  it('🔴 「章を保存する」で、disk へ届き履歴に 1 版積まれる', async () => {
    const { root, d, persisted, disk } = setup();
    await openDraftOnHead2(root, d);
    const ta = sectionInput(root)!;
    ta.value = '## 決定事項\n\n- 牛乳を買う\n- パンを買う';
    root.querySelector<HTMLElement>('[data-pkc-action="save-section-draft"]')!.click();
    await tick();
    expect(d.getState().sectionDraft, '保存後も箱が残っている').toBeNull();
    expect(disk.n1).toContain('パンを買う');
    expect(disk.n1).toContain('前置き。'); // ほかの章は無事
    expect(persisted.length, '書込が届いていない').toBe(1);
    expect(persisted[0]!.checkpoint, '履歴に積んでいない').toBe(true);
    // 🔑 読む面が最新の字を出す(箱が外れ、新しい本文で描き直った)
    await tick();
    expect(root.querySelector('[data-pkc-field="detail-body"]')?.textContent).toContain('パンを買う');
    expect(sectionInput(root), '保存後も箱が残っている(DOM)').toBeNull();
  });

  it('🔴 「章の編集をやめる」で、聞かずに閉じる(disk は無傷)', async () => {
    const { root, d, disk } = setup();
    await openDraftOnHead2(root, d);
    const ta = sectionInput(root)!;
    ta.value = '## 決定事項\n\n打ちかけ';
    root.querySelector<HTMLElement>('[data-pkc-action="cancel-section-draft"]')!.click();
    await tick();
    expect(d.getState().sectionDraft).toBeNull();
    expect(disk.n1).toBe(DOC);
    expect(sectionInput(root)).toBeNull();
  });

  /**
   * 🔴 **返ってこない保存の最後の出口**(#1044 段2 4巡目の修理、T1)。
   *
   * ⚠ 直す前は `saving: true` のまま詰まると逃げ道が 1 つも無かった ──
   *   2 つのボタンは押せず(`syncSectionBoxSaving`)、離れる操作は外側の門
   *   (`guardSectionDraftTransition`)が断り続け、`F5` 以外に出口が無かった。
   * 🔑 **追記の `writeLock` と同じ「打ち切る」ボタン**(`force-release`)を移す。
   */
  it('🔴 保存を撃って ack が返らない間だけ「打ち切る」が出て、押すと saving が解け箱と書きかけは残る', async () => {
    const { root, d, holdSave, disk, statuses } = setup();
    await openDraftOnHead2(root, d);
    const ta = sectionInput(root)!;
    ta.value = '## 決定事項\n\n打ちかけ';
    const release = () =>
      root.querySelector<HTMLButtonElement>(
        '[data-pkc-region="section-draft-buttons"] [data-pkc-action="force-release"]',
      )!;
    // 前提:まだ保存していない間は「打ち切る」は隠れている
    expect(release().hidden, '前提が崩れている(保存していないのに出ている)').toBe(true);

    const gate = holdSave();
    root.querySelector<HTMLElement>('[data-pkc-action="save-section-draft"]')!.click();
    await tick();
    expect(d.getState().sectionDraft?.saving, '前提が崩れている(保存中になっていない)').toBe(true);

    // ① 条件が立つ ── 保存 / やめるは押せない、「打ち切る」は出ている
    expect(
      root.querySelector<HTMLButtonElement>('[data-pkc-action="save-section-draft"]')!.disabled,
    ).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>('[data-pkc-action="cancel-section-draft"]')!.disabled,
    ).toBe(true);
    expect(release().hidden, '保存中なのに「打ち切る」が出ていない').toBe(false);

    // ② 押す → 確認(章の書き込みだと分かる字)→ 同じ action(FORCE_RELEASE_LOCK)で解ける
    release().click();
    expect(dialogMessage()).toContain('章の書き込みを強制的に打ち切ります');
    await answerDialog('ok');
    await tick();

    // ③ saving が解け、箱と書きかけは残る(user がコピーできる)
    expect(d.getState().sectionDraft, '打ち切ったのに箱が消えた').not.toBeNull();
    expect(d.getState().sectionDraft!.saving, '打ち切ったのに保存中の印が残っている').toBe(false);
    expect(sectionInput(root), '打ち切ったのに箱が DOM から消えた').not.toBeNull();
    expect(sectionInput(root)!.value, '打ち切ったのに書きかけが消えた').toBe(
      '## 決定事項\n\n打ちかけ',
    );
    expect(
      statuses.some((s) => s.includes('章の書き込みを打ち切りました')),
      '画面に痕跡が残っていない',
    ).toBe(true);

    // ④ 対照群 ── 打ち切った後は「打ち切る」がまた隠れる(常に出す形になっていない)
    expect(release().hidden, '打ち切った後も出ている').toBe(true);

    // ⑤ 遅れて ack(SECTION_SAVED)が届いても、世代が変わっているので無視される
    //    ── 書き込みは実際に disk へ進む(表示が古くなるだけ)が、画面(箱・書きかけ)は
    //    それで巻き戻ったり消えたりしない
    gate.pass();
    await tick();
    await tick();
    expect(d.getState().sectionDraft, '遅れた ack で箱が消えた').not.toBeNull();
    expect(sectionInput(root)!.value, '遅れた ack で書きかけが上書きされた').toBe(
      '## 決定事項\n\n打ちかけ',
    );
    expect(disk.n1, '打ち切った後も disk への書込は進んでいるはず').toContain('打ちかけ');
  });

  it('🔴 別のタブが編集中なら、ロックが取れず理由が出る(箱は開かない)', async () => {
    const { root, d, setLockAnswer, locks } = setup();
    setLockAnswer('denied');
    await tick();
    const heads = [...root.querySelectorAll<HTMLElement>('[data-pkc-field="detail-body"] h2')];
    const head = heads.find((h) => h.textContent === '決定事項')!;
    rightClick(head);
    root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="edit-section"]`)!.click();
    await tick();
    expect(d.getState().sectionDraft, 'ロックが取れていないのに開いた').toBeNull();
    expect(d.getState().error ?? '').toContain('別のタブ');
    expect(sectionInput(root)).toBeNull();
    expect(locks, 'ロックを試みていない').toContain('n1');
  });

  it('🔴 同じノートを選んでも(移っていない)、聞かない・箱は消えない', async () => {
    const { root, d } = setup();
    await openDraftOnHead2(root, d);
    sectionInput(root)!.value = '## 決定事項\n\n打ちかけ';
    // ⚠ n1(いま開いているノート)自身の行を押す
    root.querySelector<HTMLElement>('[data-pkc-action="select-entry"]')?.remove();
    const self = document.createElement('button');
    self.setAttribute('data-pkc-action', 'select-entry');
    self.setAttribute('data-pkc-entry', 'n1');
    root.append(self);
    self.click();
    await tick();
    expect(
      root.querySelectorAll('[data-pkc-field="pick-section-leave"]').length,
      '同じノートを選んだのに聞いた',
    ).toBe(0);
    expect(d.getState().sectionDraft, '同じノートを選んだだけで箱が消えた').not.toBeNull();
    expect(sectionInput(root)!.value, '打った字が消えた').toBe('## 決定事項\n\n打ちかけ');
  });
});

/**
 * 🔴 **`force-release` は「押した箱」で対象を決める ── 固定の優先順位ではない**
 *   (#1044 段2 5巡目の修理、U2)。
 *
 * ⚠ 直す前は `bodyLockOf(state)?.holder === 'section'`(writeLock → tileWrite →
 *   editing → sectionDraft の固定順)で名乗る対象を決めていた ── 別のノートの
 *   追記が `writeLock` を握っていると、**章の箱**の「打ち切る」を押しても
 *   確認文・console・画面の 1 行・メッセージが**追記と別のノートの題名**を名乗る。
 * 🔑 ここは「n1 の章が保存中(saving)」と「n2 の追記が writeLock を握っている」を
 *   **同時に**作り、①章の箱を押す → 章・n1 を名乗る ②追記の箱(相当)を押す →
 *   追記・n2 を名乗る、の両方を見る。
 */
describe('force-release は「押した箱」で対象を決める(#1044 段2 5巡目の修理、U2)', () => {
  /** n1 の章を保存中(saving)のまま止め、n2 の追記で writeLock も同時に立てる。 */
  async function bothStuck(): Promise<ReturnType<typeof setup> & { gate: { pass(): void } }> {
    const s = setup();
    await openDraftOnHead2(s.root, s.d);
    sectionInput(s.root)!.value = '## 決定事項\n\n打ちかけ';
    const gate = s.holdSave(); // ⚠ getBody を止める(REQUEST_SECTION_SAVE / REQUEST_APPEND 共通)
    s.root.querySelector<HTMLElement>('[data-pkc-action="save-section-draft"]')!.click();
    await tick();
    expect(s.d.getState().sectionDraft?.saving, '前提が崩れている(章が保存中でない)').toBe(true);
    s.d.dispatch({ type: 'APPEND_TO_ENTRY', lid: 'n2', text: '追記', heading: null, target: null });
    expect(s.d.getState().writeLock?.lid, '前提が崩れている(n2 の writeLock が立っていない)').toBe(
      'n2',
    );
    return { ...s, gate };
  }

  it('🔴 章の箱を押すと、別のノートの writeLock があっても「章」と n1 の題名を名乗る', async () => {
    const s = await bothStuck();
    const releaseInSection = s.root.querySelector<HTMLButtonElement>(
      '[data-pkc-region="section-draft-buttons"] [data-pkc-action="force-release"]',
    )!;
    releaseInSection.click();
    expect(
      dialogMessage(),
      '章の箱を押したのに、追記だと名乗った(bodyLockOf の固定順に戻っている)',
    ).toContain('章の書き込みを強制的に打ち切ります');
    await answerDialog('ok');
    await tick();
    expect(s.statuses.at(-1), '画面の 1 行が章の対象(n1)を名乗っていない').toContain('t-n1');
    expect(s.statuses.at(-1), '画面の 1 行が「章」と言っていない').toContain('章の書き込み');
    s.gate.pass();
  });

  it('🔴 追記の箱を押すと、n1 の章が保存中でも「追記」と n2 の題名を名乗る', async () => {
    const s = await bothStuck();
    // ⚠ 実物の AppendBoxRenderer はこの fixture に繋いでいない(detail のみ購読) ──
    //   「章の箱の外」を再現するには十分なので、素の `force-release` ボタンを
    //   section-draft の外へ置く(`append-box.test.ts` の「待っている書き込みが
    //   無いとき」と同じ作法)。
    const releaseOutsideSection = document.createElement('button');
    releaseOutsideSection.setAttribute('data-pkc-action', 'force-release');
    s.root.append(releaseOutsideSection);
    releaseOutsideSection.click();
    expect(
      dialogMessage(),
      '章の箱の外を押したのに、章だと名乗った',
    ).toContain('追記の書き込みを強制的に打ち切ります');
    await answerDialog('ok');
    await tick();
    expect(s.statuses.at(-1), '画面の 1 行が追記の対象(n2)を名乗っていない').toContain('t-n2');
    expect(s.statuses.at(-1), '画面の 1 行が「追記」と言っていない').toContain('追記の書き込み');
    s.gate.pass();
  });
});

describe('書きかけのまま別のノートを選ぶと、先に聞く(#1044 段2、裁定 Q2 = A)', () => {
  function rows(root: HTMLElement): HTMLButtonElement[] {
    return [...root.querySelectorAll<HTMLButtonElement>('[data-pkc-field="pick-section-leave"]')];
  }
  function pressRow(root: HTMLElement, label: string): void {
    const b = rows(root).find((r) => r.textContent === label);
    if (b === undefined) throw new Error(`前提が崩れている: 「${label}」が出ていない`);
    b.click();
  }

  it('🔴 変更が無ければ、聞かずに移る(箱を閉じるだけ)', async () => {
    const { root, d, releases } = setup();
    await openDraftOnHead2(root, d);
    // ⚠ 何も打たずに一覧のもう 1 件を選ぶ(select-entry。行は無くても action で撃てる)
    const target = document.createElement('button');
    target.setAttribute('data-pkc-action', 'select-entry');
    target.setAttribute('data-pkc-entry', 'n2');
    root.append(target);
    target.click();
    await tick();
    expect(rows(root).length, '聞かずに移るはずが、聞いている').toBe(0);
    expect(d.getState().sectionDraft).toBeNull();
    expect(d.getState().selectedLid).toBe('n2');
    expect(releases).toContain('n1');
  });

  it('🔴 変更があれば聞く ──「移らない」を押すと、選択も箱も打った字もそのまま', async () => {
    const { root, d } = setup();
    await openDraftOnHead2(root, d);
    sectionInput(root)!.value = '## 決定事項\n\n打ちかけ';
    const target = document.createElement('button');
    target.setAttribute('data-pkc-action', 'select-entry');
    target.setAttribute('data-pkc-entry', 'n2');
    root.append(target);
    target.click();
    await tick();
    expect(
      document.querySelector('[data-pkc-field="dialog-title"]')?.textContent,
      '設問の題名が出ていない',
    ).toBe('書きかけの章があります');
    expect(rows(root).map((r) => r.textContent)).toEqual([
      '章を保存して移る',
      '書きかけを消して移る',
      '移らない',
    ]);
    pressRow(root, '移らない');
    await tick();
    expect(d.getState().selectedLid, '移ってしまった').toBe('n1');
    expect(d.getState().sectionDraft, '箱が消えた').not.toBeNull();
    expect(sectionInput(root)!.value, '打った字が消えた').toBe('## 決定事項\n\n打ちかけ');
  });

  it('🔴 「書きかけを消して移る」で、書かずに移る', async () => {
    const { root, d, disk } = setup();
    await openDraftOnHead2(root, d);
    sectionInput(root)!.value = '## 決定事項\n\n打ちかけ';
    const target = document.createElement('button');
    target.setAttribute('data-pkc-action', 'select-entry');
    target.setAttribute('data-pkc-entry', 'n2');
    root.append(target);
    target.click();
    await tick();
    pressRow(root, '書きかけを消して移る');
    await tick();
    expect(d.getState().selectedLid).toBe('n2');
    expect(d.getState().sectionDraft).toBeNull();
    expect(disk.n1, '書かずに移るはずが書いた').toBe(DOC);
  });

  it('🔴 「章を保存して移る」で、保存してから移る(保存が成功したときだけ)', async () => {
    const { root, d, disk, persisted } = setup();
    await openDraftOnHead2(root, d);
    sectionInput(root)!.value = '## 決定事項\n\n- 牛乳を買う\n- パンを買う';
    const target = document.createElement('button');
    target.setAttribute('data-pkc-action', 'select-entry');
    target.setAttribute('data-pkc-entry', 'n2');
    root.append(target);
    target.click();
    await tick();
    pressRow(root, '章を保存して移る');
    await tick();
    await tick();
    expect(disk.n1).toContain('パンを買う');
    expect(persisted.length).toBe(1);
    expect(d.getState().selectedLid, '保存したのに移っていない').toBe('n2');
    expect(d.getState().sectionDraft).toBeNull();
  });

  it('🔴 保存が断られたら(別窓で書き換え)、移らない', async () => {
    const { root, d, disk } = setup();
    await openDraftOnHead2(root, d);
    /**
     * 🔴 **別窓が書いた体は、`disk`(store の写し)を直に変える**
     *   (#1044 段2 3巡目の修理、S1)。⚠ 直す前(2巡目)は `BODY_LOADED` を
     *   dispatch していたが、保存は effect 化されて **disk から読み直す**
     *   ので、`openBody`(画面側)を動かしても保存の一致判定には効かない ──
     *   本物の別窓の書込は disk 自身が動く。
     */
    disk.n1 = DOC.replace('牛乳を買う', '牛乳と卵を買う');
    sectionInput(root)!.value = '## 決定事項\n\n打ちかけ';
    const target = document.createElement('button');
    target.setAttribute('data-pkc-action', 'select-entry');
    target.setAttribute('data-pkc-entry', 'n2');
    root.append(target);
    target.click();
    await tick();
    pressRow(root, '章を保存して移る');
    await tick();
    await tick();
    expect(d.getState().selectedLid, '断られたのに移った').toBe('n1');
    expect(d.getState().sectionDraft, '断られたのに箱が消えた').not.toBeNull();
    expect(d.getState().error ?? '').toContain('別の場所で書き換えられました');
    expect(disk.n1, '断ったのに disk が書き換わった').toBe(
      DOC.replace('牛乳を買う', '牛乳と卵を買う'),
    );
  });

  /**
   * 🔴 **T7:待つ間に system 側で章の欄が閉じていたら、保存したと数えない**
   *   (#1044 段2 4巡目の修理)。
   *
   * ⚠ 「章を保存して移る」を選ぶまでの間(ダイアログの答えを待っている間)に、
   *   別タブが `n1` を消した体(system の `SYS_BOOTED`)で章の欄が閉じる。
   *   直す前は `sectionBoxText` がダイアログを開く**前**に掴んだ古い
   *   `host`(骨組みが作り直されて外れた node。子は残っている)から
   *   打ちかけの字を拾ってしまい、`SAVE_SECTION_DRAFT` を無言の no-op で
   *   撃ち、`waitSectionSaveSettled` は `sectionDraft === null` を見て
   *   即 `'saved'` を返していた ── 何も書いていないのに保存できた扱いで
   *   移る(偽の成功)。
   * 🔑 見るのは**`SAVE_SECTION_DRAFT` を撃たないこと**(dispatch を監視)。
   *   移ること自体は構わない(system が既に閉じた結果を受け入れる)。
   */
  it('🔴 T7:章を保存して移るを選んだ間に、章の欄が system 側で閉じていたら、保存を試みずに移る', async () => {
    const { root, d } = setup();
    await openDraftOnHead2(root, d);
    sectionInput(root)!.value = '## 決定事項\n\n打ちかけ';
    const target = document.createElement('button');
    target.setAttribute('data-pkc-action', 'select-entry');
    target.setAttribute('data-pkc-entry', 'n2');
    root.append(target);
    target.click();
    await tick();
    expect(
      document.querySelector('[data-pkc-field="dialog-title"]')?.textContent,
      '前提が崩れている(聞いていない)',
    ).toBe('書きかけの章があります');

    // ⚠ ダイアログの答えを待つ間に、別タブが n1 を消した体で下書きが system 側で閉じる
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n2')], relations: [] });
    expect(d.getState().sectionDraft, '前提が崩れている(まだ閉じていない)').toBeNull();

    const dispatched: string[] = [];
    const origDispatch = d.dispatch.bind(d);
    vi.spyOn(d, 'dispatch').mockImplementation((a) => {
      dispatched.push(a.type);
      origDispatch(a);
    });
    try {
      pressRow(root, '章を保存して移る');
      await tick();
      await tick();

      expect(
        dispatched,
        '既に閉じているのに SAVE_SECTION_DRAFT を撃った(偽の成功へ向かう経路)',
      ).not.toContain('SAVE_SECTION_DRAFT');
      // 🔑 移るのは構わない(system が既に閉じた結果を受け入れる)
      expect(d.getState().selectedLid, '移るのは構わないのに移っていない').toBe('n2');
    } finally {
      vi.restoreAllMocks();
    }
  });
});

/**
 * 🔴 **同じノートの別の見出しへ切り替えても、編集ロックが本当に外れない**
 * (#1044 段2 2巡目の修理、R1)。
 *
 * ⚠ 直す前は「閉じてから開く」の間に `bindEditLockRelease` がロックを本当に
 *   手放し、取り直さずに次の見出しを開いていた ── 別タブが同じノートを同時に
 *   編集できる(#177 と同じ事故)。ここでは `setup()` の `locks` / `releases`
 *   台帳(fake の acquire/release 記録)で、**取り直しが本当に起きているか**を
 *   数で見る ── 変異(聞かずに開く / 行のずらしを外す)も同じ道中で殺す。
 */
describe('章の欄:同じノートの別の見出しへ切り替えると、ロックを取り直す(#1044 段2 2巡目の修理、R1)', () => {
  const DOC3 = ['## A', '', 'a 段落。', '', '## B', '', 'b 段落。', '', '## C', '', 'c 段落。', ''].join('\n');

  /** `DOC3` を n1 の本文にしてから B を開く。 */
  async function openDraftOnB(root: HTMLElement, d: Dispatcher, disk: Record<string, string>) {
    disk.n1 = DOC3;
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: DOC3 });
    await tick();
    const heads = [...root.querySelectorAll<HTMLElement>('[data-pkc-field="detail-body"] h2')];
    const head = heads.find((h) => h.textContent === 'B');
    if (head === undefined) throw new Error('前提が崩れている: DOC3 の見出し B が描けていない');
    rightClick(head);
    root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="edit-section"]`)!.click();
    await tick();
  }

  /** 見出し C を右クリックして「この章を編集する」を押す(B の下書きが開いている状態から)。 */
  function clickEditSectionOnC(root: HTMLElement): void {
    const heads = [...root.querySelectorAll<HTMLElement>('[data-pkc-field="detail-body"] h2')];
    const head = heads.find((h) => h.textContent === 'C');
    if (head === undefined) throw new Error('前提が崩れている: 見出し C が描けていない');
    rightClick(head);
    root.querySelector<HTMLElement>(`${MENU} [data-pkc-action="edit-section"]`)!.click();
  }

  /** 台帳上、いま 'n1' のロックを何回分「握ったまま」か(acquire 数 − release 数)。 */
  function held(log: { locks: string[]; releases: string[] }): number {
    return (
      log.locks.filter((l) => l === 'n1').length - log.releases.filter((l) => l === 'n1').length
    );
  }

  /** 3 択の設問(`pick-section-leave`)から、字が一致するボタンを押す。 */
  function pressRow(root: HTMLElement, label: string): void {
    const rows = [...root.querySelectorAll<HTMLButtonElement>('[data-pkc-field="pick-section-leave"]')];
    const b = rows.find((r) => r.textContent === label);
    if (b === undefined) throw new Error(`前提が崩れている: 「${label}」が出ていない`);
    b.click();
  }

  it('(i) 変更なし → 見出し C が開き、ロックは台帳上このタブが握ったまま', async () => {
    const { root, d, disk, locks, releases } = setup();
    await openDraftOnB(root, d, disk);
    expect(d.getState().sectionDraft?.heading, '前提が崩れている(B が開けていない)').toBe('B');
    expect(held({ locks, releases }), '前提が崩れている(開いた時点で握れていない)').toBe(1);

    clickEditSectionOnC(root);
    await tick();

    expect(d.getState().sectionDraft?.heading, 'C が開いていない(無言で捨てた?)').toBe('C');
    // 🔑 本命:閉じてから開く間にロックを手放したきりではなく、取り直している
    expect(locks.filter((l) => l === 'n1').length, 'ロックを取り直していない').toBe(2);
    expect(releases.filter((l) => l === 'n1').length, '閉じたときに返していない').toBe(1);
    expect(held({ locks, releases }), 'このタブが握ったままになっていない').toBe(1);
  });

  it('(ii) 変更あり →「書きかけを消して移る」→ C が開き、同じくロックを取り直す', async () => {
    const { root, d, disk, locks, releases } = setup();
    await openDraftOnB(root, d, disk);
    sectionInput(root)!.value = '## B\n\n打ちかけ';

    clickEditSectionOnC(root);
    await tick();
    expect(
      document.querySelector('[data-pkc-field="dialog-title"]')?.textContent,
      '設問が出ていない(変更ありなのに聞いていない)',
    ).toBe('書きかけの章があります');
    pressRow(root, '書きかけを消して移る');
    await tick();

    expect(d.getState().sectionDraft?.heading, 'C が開いていない').toBe('C');
    expect(disk.n1, '書かずに移るはずが書いた').toBe(DOC3);
    expect(locks.filter((l) => l === 'n1').length, 'ロックを取り直していない').toBe(2);
    expect(releases.filter((l) => l === 'n1').length).toBe(1);
    expect(held({ locks, releases }), 'このタブが握ったままになっていない').toBe(1);
  });

  it('(iii) 変更あり →「章を保存して移る」、B に 2 行足して保存 → 開いた箱の先頭が「## C」(行のずれが効いている)', async () => {
    const { root, d, disk, persisted, locks, releases } = setup();
    await openDraftOnB(root, d, disk);
    // B に 2 行足す(見出し行を含めて 3 行 → 5 行。C の行番号は +2 ずれる)
    sectionInput(root)!.value = '## B\n\nb 段落。\n足した 1 行目\n足した 2 行目';

    clickEditSectionOnC(root);
    await tick();
    expect(
      document.querySelector('[data-pkc-field="dialog-title"]')?.textContent,
      '設問が出ていない',
    ).toBe('書きかけの章があります');
    pressRow(root, '章を保存して移る');
    await tick();
    await tick();

    expect(persisted.length, '保存が届いていない').toBe(1);
    expect(disk.n1, '保存した字が disk に無い').toContain('足した 2 行目');
    // 🔑 本命(F-E / R1b):行のずれを計算して開くので、C の中身がそのまま開ける
    //   ── 変異(行のずらしを外す)を当てると、B の増えた 2 行の途中や、
    //   ずれた行(C ではない箇所)を C の見出しとして開いてしまう。
    expect(d.getState().sectionDraft?.heading, '開いた章が C ではない(行のずれが効いていない)').toBe(
      'C',
    );
    const ta = sectionInput(root)!;
    expect(ta.value.startsWith('## C'), '箱の先頭が見出し C ではない').toBe(true);
    // 🔑 本命(R1):保存(閉じる)→ 開く、の間でロックを取り直している
    expect(locks.filter((l) => l === 'n1').length, 'ロックを取り直していない').toBe(2);
    expect(releases.filter((l) => l === 'n1').length).toBe(1);
    expect(held({ locks, releases }), 'このタブが握ったままになっていない').toBe(1);
  });

  /**
   * 🔴 **(iv) 切替の 2 回目の acquire が denied になる回**(#1044 段2 3巡目の修理、S5)。
   *
   * ⚠ 「閉じてから開く」の間に**別タブが横取りした**体 ── B を閉じたあとの
   *   取り直しが `denied` で返る。⚠ ここで無言に捨てると(押しても何も起きない)、
   *   user は「押し間違えたのか、B の書きかけが消えたのか」が分からなくなる。
   * 🔑 見るのは 2 点:①**理由が出る**(`OP_FAILED`、無言にならない)
   *   ②**箱の状態**(B は既に `CANCEL_SECTION_DRAFT` で閉じているので、denied の
   *   結果は「B へ戻らず、章の欄は閉じたまま」── `!dirty` の作法(「先に閉じてから
   *   取り直す」)が、取り直しに失敗した回にそのまま現れる)。
   * ⚠ **`held()` は使わない** ── あの式は「acquire は必ず release と対になる」を
   *   前提にしているが、`denied` は**そもそも握っていない**(この fake の
   *   `locks.push` は「試みた」を記録するだけで「握れた」ではない)。生の件数を見る。
   */
  it('(iv) 変更なし → 2 回目の acquire が denied → 理由が出て、章の欄は閉じたまま(無言にならない)', async () => {
    const { root, d, disk, locks, releases, setLockAnswer } = setup();
    await openDraftOnB(root, d, disk);
    expect(d.getState().sectionDraft?.heading, '前提が崩れている(B が開けていない)').toBe('B');

    // 🔴 B を閉じたあと、C への取り直しだけ denied にする(別タブが横取りした体)
    setLockAnswer('denied');
    clickEditSectionOnC(root);
    await tick();

    // ① 理由が出る(無言にならない)
    expect(d.getState().error ?? '', '理由が出ていない(押しても何も起きないように見える)').toContain(
      '別のタブかウィンドウで編集中です',
    );
    // ② 箱の状態:B は `!dirty` の作法で先に閉じられ、取り直しに失敗したので
    //   章の欄は閉じたまま(B へは戻らない ── 「閉じずに差し替える」専用の経路は無い)
    expect(d.getState().sectionDraft, 'denied なのに何かが開いている').toBeNull();
    expect(sectionInput(root), '箱が DOM に残っている(閉じたはずなのに)').toBeNull();
    // 🔑 台帳:B の open(1)+ C への取り直し(1)= 2 回試み、release は B を閉じた 1 回だけ
    //   (denied の回は握れていないので release も無い)
    expect(locks.filter((l) => l === 'n1').length, '取り直しを試みていない').toBe(2);
    expect(releases.filter((l) => l === 'n1').length, 'B を閉じたときに返していない').toBe(1);
  });

  /**
   * 🔴 **(v) T7 の対 ── 待つ間に system 側で下書きのノート自体が消えていたら、
   *   保存を試みずに、無言にならない**(#1044 段2 5巡目の修理、U1)。
   *
   * ⚠ `leaveSectionDraftOrAsk` の T7(4巡目)は「別のノートへ移る」だけを見ていた
   *   ── `startSectionEditAt`(同じノートの別の見出しを開く)の `choice === 'save'`
   *   には同じ門が無かった(段2、U1 の本題)。ここは `withSectionDraftLeave` へ
   *   寄せたことで、この呼び手でも T7 が効くことを見る。
   * ⚠ ここ(同じノートに留まる側)で system が下書きを閉じるのは、
   *   `guardSectionDraftTransition` の `entryGone`(そのノート自体が消えた)だけ
   *   ── `movedAway` は `selectedLid` が動かないので起きない。だから
   *   `SYS_BOOTED` で n1 を丸ごと落とす体を使う。
   */
  it('(v) T7の対:待つ間に system 側で n1 ごと消えていたら、保存を試みず、無言にならない', async () => {
    const { root, d, disk } = setup();
    await openDraftOnB(root, d, disk);
    sectionInput(root)!.value = '## B\n\n打ちかけ';

    clickEditSectionOnC(root);
    await tick();
    expect(
      document.querySelector('[data-pkc-field="dialog-title"]')?.textContent,
      '前提が崩れている(聞いていない)',
    ).toBe('書きかけの章があります');

    // ⚠ ダイアログの答えを待つ間に、別タブが n1 を丸ごと消した体(entryGone)
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n2')], relations: [] });
    expect(d.getState().sectionDraft, '前提が崩れている(まだ閉じていない)').toBeNull();
    // 🔑 「無言にならない」は既に system 側が置いている(guardSectionDraftTransition)
    expect(
      d.getState().notice,
      '前提が崩れている(system が知らせずに閉じた)',
    ).toContain('章の編集を終えました');

    const dispatched: string[] = [];
    const origDispatch = d.dispatch.bind(d);
    vi.spyOn(d, 'dispatch').mockImplementation((a) => {
      dispatched.push(a.type);
      origDispatch(a);
    });
    try {
      const rows = [
        ...root.querySelectorAll<HTMLButtonElement>('[data-pkc-field="pick-section-leave"]'),
      ];
      const saveRow = rows.find((r) => r.textContent === '章を保存して移る');
      if (saveRow === undefined) throw new Error('前提が崩れている: 「章を保存して移る」が出ていない');
      saveRow.click();
      await tick();
      await tick();

      expect(
        dispatched,
        '既に閉じているのに SAVE_SECTION_DRAFT を撃った(偽の成功へ向かう経路)',
      ).not.toContain('SAVE_SECTION_DRAFT');
      // 🔑 偽の成功で「開いた」ことにしない(C が開いていない)/ 無言にもならない
      //   (system が置いた知らせがそのまま残る)
      expect(d.getState().sectionDraft, '偽の成功で何か開いた').toBeNull();
      expect(sectionInput(root), '偽の成功で箱が DOM に出た').toBeNull();
      expect(d.getState().notice, '知らせが消えた(無言になった)').toContain('章の編集を終えました');
    } finally {
      vi.restoreAllMocks();
    }
  });
});

/**
 * 🔴 **箱が開いている間、無関係な state 変化で本文を描き直さない**(#1044 段2、F-G)。
 *
 * ⚠ `detail.ts` の `render()` にある
 * `if (boxKey !== this.sectionBoxFor) { … } if (boxKey !== null) return;`
 * を丸ごと `if (true) { … }` にしても(= 常に描き直す形にしても)、
 * 既存の 10 test は**全部緑のまま**だった(着地前レビューで確認 ── 打ちかけの字は
 * `installSectionBox` の冪等性(既に箱が在れば差し替えない)が別の理由で守っていたため)。
 * 🔑 この test は**その門そのもの**を見る ── markdown の描画(`MarkdownClient.render`)
 * の呼び出し回数を数え、箱を開いた後の無関係な state 変化で**増えない**ことを確かめる。
 */
class CountingMarkdownClient extends MarkdownClient {
  calls = 0;
  override render(text: string, opts: RenderMarkdownOptions = {}): Promise<string> {
    this.calls++;
    return super.render(text, opts);
  }
}

describe('render() の指紋(#1044 段2、F-G)', () => {
  it('🔴 箱を開いた後、無関係な state 変化を何度起こしても、markdown の描画は増えない', async () => {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const shell = buildShell(root);
    const d = new Dispatcher();
    const md = new CountingMarkdownClient();
    const detail = new DetailRenderer(shell.detail, null, md);
    d.onState((s) => detail.render(s));
    const services: BinderServices = {
      acquireEditLock: async () => 'granted',
      releaseEditLock: () => {},
    };
    bindActions(root, d, services);
    const disk: Record<string, string> = { n1: DOC, n2: 'べつのノート\n' };
    connectStoreEffects(d, {
      ...stubRevisionOps(),
      getBody: async (lid: string) => disk[lid] ?? null,
      deleteEntry: async () => {},
      setEntryParent: async () => {},
      renameEntry: async (): Promise<EntryStamps> => stubStamps(),
      replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
      reorderEntry: async (): Promise<EntryStamps> => stubStamps(),
      persistEntry: async (): Promise<EntryStamps> => stubStamps(),
    });
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1'), meta('n2')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    await openDraftOnHead2(root, d);
    expect(d.getState().sectionDraft, '章の箱が開いていない(前提が崩れている)').not.toBeNull();

    const afterOpen = md.calls;
    expect(afterOpen, '章の箱を開いた回さえ描いていない(前提が崩れている)').toBeGreaterThan(0);

    // ⚠ 章の下書き・selectedLid・本文のどれとも無関係な state 変化を複数回起こす
    d.dispatch({ type: 'MESSAGES_UNREAD_SET', count: 3 });
    d.dispatch({ type: 'OP_FAILED', error: 'なにかの通知' });
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'x' });
    await tick();

    expect(
      md.calls,
      '箱が開いている間、無関係な state 変化で markdown を描き直した(門が効いていない)',
    ).toBe(afterOpen);
  });
});
