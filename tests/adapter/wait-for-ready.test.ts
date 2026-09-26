/** @vitest-environment happy-dom */
/**
 * 🔴 **「先送りの判定」と「断れない取込が待つ判定」は別物である**(#1044 段2
 *   4巡目の修理、T3)。
 *
 * ⚠ `isFullyReady` / `whenPhaseReady`(`phase` だけ)は `reloadSnapshot` の
 *   先送り判定と共有しているので、章の欄(`sectionDraft`)が開いている間も
 *   `true` を返す(3巡目の修理・S1 で意図的にそうした)。
 * 🔑 ここは**その裏側**を見る ── `canAcceptUnrefusedImport` /
 *   `whenAcceptingUnrefusedImport` は章の欄が開いている間 `false` /
 *   待ち続けることを、`isFullyReady` との**差**として pin する。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import {
  canAcceptUnrefusedImport,
  isFullyReady,
  whenAcceptingUnrefusedImport,
} from '../../src/adapter/state/wait-for-ready';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: `t-${lid}`,
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

/** SYS_BOOTED → SELECT_ENTRY → BODY_LOADED まで進めた dispatcher(n1 を開いている)。 */
function booted(): Dispatcher {
  const d = new Dispatcher();
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '## 見出し\n\n中身\n' });
  return d;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('canAcceptUnrefusedImport(#1044 段2 4巡目の修理、T3)', () => {
  it('🔴 phase が ready で章の欄も開いていなければ true', () => {
    const d = booted();
    expect(canAcceptUnrefusedImport(d.getState())).toBe(true);
  });

  it('🔴 全文編集中は false(isFullyReady とここは一致する)', () => {
    const d = booted();
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().phase, '前提が崩れている(編集に入れていない)').toBe('editing');
    expect(isFullyReady(d.getState())).toBe(false);
    expect(canAcceptUnrefusedImport(d.getState())).toBe(false);
  });

  /**
   * 🔴 **本命 ── 章の欄が開いている間、`isFullyReady` と食い違う**。
   * ⚠ ここが一致していたら(= 直す前の形に戻っていたら)、章の欄が開いている間も
   *   断れない取込が即座に進んでしまう(T3 の実害そのもの)。
   */
  it('🔴 章の欄が開いていれば false(phase は ready のまま ── isFullyReady とは食い違う)', () => {
    const d = booted();
    d.dispatch({ type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 0 });
    expect(d.getState().phase, '前提が崩れている(phase が ready でない)').toBe('ready');
    expect(d.getState().sectionDraft, '前提が崩れている(開けていない)').not.toBeNull();
    // 🔑 isFullyReady は true のまま(reload の先送り判定は変えない)
    expect(isFullyReady(d.getState()), 'isFullyReady まで変えてしまった').toBe(true);
    // 🔴 canAcceptUnrefusedImport はここで初めて false になる
    expect(canAcceptUnrefusedImport(d.getState())).toBe(false);
  });

  it('対照群: 章の欄を閉じれば true に戻る', () => {
    const d = booted();
    d.dispatch({ type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 0 });
    d.dispatch({ type: 'CANCEL_SECTION_DRAFT' });
    expect(d.getState().sectionDraft).toBeNull();
    expect(canAcceptUnrefusedImport(d.getState())).toBe(true);
  });
});

describe('whenAcceptingUnrefusedImport(#1044 段2 4巡目の修理、T3)', () => {
  it('🔴 すでに受け入れられる状態なら即座に解決し、onWait は呼ばない', async () => {
    const d = booted();
    let waited = false;
    await whenAcceptingUnrefusedImport(d, () => {
      waited = true;
    });
    expect(waited, '待っていないのに onWait を呼んだ').toBe(false);
  });

  it('🔴 章の欄が開いている間は待ち、CANCEL_SECTION_DRAFT で解ける(onWait も 1 度呼ぶ)', async () => {
    const d = booted();
    d.dispatch({ type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 0 });
    let waitedCount = 0;
    let resolved = false;
    void whenAcceptingUnrefusedImport(d, () => {
      waitedCount += 1;
    }).then(() => {
      resolved = true;
    });
    await tick();
    expect(waitedCount, 'onWait が呼ばれていない').toBe(1);
    expect(resolved, '章の欄が開いている間に解決してしまった').toBe(false);

    // ⚠ 無関係な dispatch では解けない(章の欄はまだ開いている)
    d.dispatch({ type: 'MESSAGES_UNREAD_SET', count: 1 });
    await tick();
    expect(resolved, '無関係な state 変化で解決してしまった').toBe(false);

    d.dispatch({ type: 'CANCEL_SECTION_DRAFT' });
    await tick();
    expect(resolved, '章の欄を閉じたのに解決していない').toBe(true);
    expect(waitedCount, 'onWait が複数回呼ばれた').toBe(1);
  });

  it('🔴 章の欄を「章を保存する」で閉じても解ける(保存の ack まで待つ)', async () => {
    const d = booted();
    d.dispatch({ type: 'OPEN_SECTION_DRAFT', lid: 'n1', line: 0 });
    let resolved = false;
    void whenAcceptingUnrefusedImport(d, () => {}).then(() => {
      resolved = true;
    });
    await tick();
    expect(resolved).toBe(false);
    d.dispatch({
      type: 'SECTION_SAVED',
      lid: 'n1',
      gen: d.getState().lockGen,
      heading: '見出し',
      body: '## 見出し\n\n中身\n',
      status: null,
      date: null,
      archived: false,
    });
    await tick();
    expect(resolved, '保存(SECTION_SAVED)で下書きが閉じても解決していない').toBe(true);
  });
});
