/** @vitest-environment happy-dom */
/**
 * 🔴 **ステータスバーの先頭に「いま何をしているか」の 1 語**(C4 / #1038 台帳③ 段 D。
 * 設計 `docs/development/touch-and-unity-design-2026-09.md` §1 P3 / §11 Q2 裁定 A)。
 *
 * `main.ts` は**どの test からも実行されない**(CLAUDE.md §2)ので、判断を
 * `status-line.ts` へ取り出して、ここで直接見る。
 */
import { describe, expect, it } from 'vitest';
import { blockedActionNote } from '../../src/adapter/state/app-state';
import {
  composeStatusLine,
  editingStateWord,
  EDITING_STATE_WORD,
  paintStatusText,
  type StatusLineParts,
} from '../../src/adapter/ui/render/status-line';

/** 空の入力(状態語以外は何も出ていない状態)。テストごとに phase だけ差し替える。 */
function partsFor(phase: StatusLineParts['phase'], extra: Partial<StatusLineParts> = {}): StatusLineParts {
  return {
    phase,
    statusBase: '',
    sync: '',
    portableAssetNote: '',
    persistState: '',
    savingLine: '',
    noticeLine: '',
    errorLine: '',
    ...extra,
  };
}

describe('editingStateWord(phase) ── 状態語そのもの', () => {
  it('🔴 editing は「編集中」', () => {
    expect(editingStateWord('editing')).toBe('編集中');
  });
  it('🔴 ready は空(読んでいるだけのときは何も言わない)', () => {
    expect(editingStateWord('ready')).toBe('');
  });
  it('🔴 error は新しい語を作らず、C11 で 1 本化した断り文をそのまま使う', () => {
    expect(editingStateWord('error')).toBe(blockedActionNote('error'));
    // 空振り防止 ── blockedActionNote が null を返すと上の等値は '' === '' で
    // 常に真になる。C11 が生きていることを確かめる。
    expect(blockedActionNote('error')).not.toBeNull();
  });
  it('initializing は空(起動直後の一瞬に、押せない理由の長文を出さない)', () => {
    expect(editingStateWord('initializing')).toBe('');
  });
});

describe('composeStatusLine ── main.ts の paint() から取り出した組み立て', () => {
  it('🔴 editing: 先頭が「編集中」で始まる(他の知らせが同時に在っても)', () => {
    const text = composeStatusLine(partsFor('editing', { statusBase: '保存先の注意' }));
    expect(text.startsWith(EDITING_STATE_WORD)).toBe(true);
    // 並びの確認(見本 3):状態語 → 他の知らせ の順で ' — ' で繋がる
    expect(text).toBe(`編集中 — 保存先の注意`);
  });

  it('🔴 ready: 「編集中」を 1 文字も含まない(読んでいるだけのときは今までどおり)', () => {
    const text = composeStatusLine(partsFor('ready', { statusBase: '保存先の注意' }));
    expect(text).not.toContain(EDITING_STATE_WORD);
    expect(text).toBe('保存先の注意');
  });

  it('🔴 error: 他の知らせが無ければ、blockedActionNote(\'error\') とちょうど等しい', () => {
    const text = composeStatusLine(partsFor('error'));
    expect(text).toBe(blockedActionNote('error'));
  });

  it('全部空なら空文字(器を畳む判定はここではなく main.ts が持つ)', () => {
    expect(composeStatusLine(partsFor('ready'))).toBe('');
  });
});

/**
 * 🔴 **状態の 1 語だけを別の器に入れる**(#1038 台帳③ C4 の着地前レビュー)。
 * ⚠ 1 稿目は行全体を 1 つの字で出していたので、「編集中」を控えめな知らせと
 *   違う濃さにできなかった。🔑 見るのは 3 つ ── ①状態語が器に入る ②行の字は
 *   `composeStatusLine` と 1 字も違わない(字を読む受け手が壊れない)③状態語が
 *   無いときは器を作らない(前の描画の器が残らない)。
 */
describe('paintStatusText ── 状態の 1 語を別の器に入れる', () => {
  it('🔴 editing: 先頭の器に「編集中」、行の字は composeStatusLine と同じ', () => {
    const el = document.createElement('span');
    const parts = partsFor('editing', { sync: '複数タブ: このタブの保存は本体タブ経由です' });
    const text = paintStatusText(el, parts);
    const state = el.querySelector('[data-pkc-field="status-state"]');
    expect(state?.textContent, '状態語が器に入っていない').toBe(EDITING_STATE_WORD);
    expect(state?.getAttribute('data-pkc-phase')).toBe('editing');
    expect(el.firstChild, '状態語が先頭に無い').toBe(state);
    expect(el.textContent, '行の字が変わった(字を読む受け手が壊れる)').toBe(composeStatusLine(parts));
    expect(text).toBe(composeStatusLine(parts));
  });

  it('🔴 error: 器の phase が error(赤くする印)', () => {
    const el = document.createElement('span');
    paintStatusText(el, partsFor('error'));
    expect(el.querySelector('[data-pkc-field="status-state"]')?.getAttribute('data-pkc-phase')).toBe(
      'error',
    );
  });

  it('⚠ ready に戻ったら器は残らない(前の描画の「編集中」を消す)', () => {
    const el = document.createElement('span');
    paintStatusText(el, partsFor('editing'));
    expect(el.querySelector('[data-pkc-field="status-state"]'), '前提: editing で器が出ていない').not.toBeNull();
    paintStatusText(el, partsFor('ready', { noticeLine: 'コピーしました' }));
    expect(el.querySelector('[data-pkc-field="status-state"]'), '読んでいるのに状態語の器が残った').toBeNull();
    expect(el.textContent).toBe('コピーしました');
  });
});
