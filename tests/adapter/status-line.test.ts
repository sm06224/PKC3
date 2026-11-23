/** @vitest-environment happy-dom */
/**
 * 🔴 **「いまの状態」と「一時の知らせ」の組み立て**(旧: ステータスバーの 1 行。2026-11-23 に常設の帯を廃止した)。
 * 元は C4 / #1038 台帳③ 段 D の「いま何をしているか」の 1 語。設計 `docs/development/touch-and-unity-design-2026-09.md`。
 *
 * `main.ts` は**どの test からも実行されない**(CLAUDE.md §2)ので、判断を `status-line.ts` へ取り出して、ここで直接見る。
 * 旧い検査との対応: `composeStatusLine`(1 行の並び)→ `composeStatusModel` の `state` の並び / `toast` の並び、
 * `paintStatusText`(状態語を別の器へ)→ 簡易履歴の「いまの状態」(`message-popover.test.ts`)、
 * `shouldHideStatusBar` → `shouldShowToast`。
 */
import { describe, expect, it } from 'vitest';
import { blockedActionNote } from '../../src/adapter/state/app-state';
import {
  composeStatusModel,
  editingStateWord,
  EDITING_STATE_WORD,
  paintStatusLive,
  paintToastText,
  shouldShowToast,
  stateSummary,
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
    progressLine: '',
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
    // 空振り防止 ── blockedActionNote が null を返すと上の等値は '' === '' で常に真になる
    expect(blockedActionNote('error')).not.toBeNull();
  });
  it('initializing は空(起動直後の一瞬に、押せない理由の長文を出さない)', () => {
    expect(editingStateWord('initializing')).toBe('');
  });
});

describe('composeStatusModel().state ── いまの状態(入口の説明・簡易履歴の「いまの状態」)', () => {
  it('🔴 editing: 先頭が「編集中」(他の状態が同時に在っても)。並びは 状態語 → 保存先 → 複数タブ → … → 保存中', () => {
    const m = composeStatusModel(
      partsFor('editing', {
        statusBase: '保存先の注意',
        sync: '複数タブ: x',
        folderSyncLine: '同期しています…',
        portableAssetNote: '添付の注意',
        persistState: '保存の状態',
        savingLine: '⏳ 保存中…',
      }),
    );
    expect(m.state.map((i) => i.kind)).toEqual(['editing', 'storage', 'sync', 'folder-sync', 'portable', 'persist', 'saving']);
    expect(m.state[0]?.text).toBe(EDITING_STATE_WORD);
    expect(stateSummary(m.state)).toBe('編集中 / 保存先の注意 / 複数タブ: x / 同期しています… / 添付の注意 / 保存の状態 / ⏳ 保存中…');
  });

  it('🔴 ready: 「編集中」を 1 文字も含まない', () => {
    const m = composeStatusModel(partsFor('ready', { statusBase: '保存先の注意' }));
    expect(stateSummary(m.state)).not.toContain(EDITING_STATE_WORD);
    expect(stateSummary(m.state)).toBe('保存先の注意');
  });

  it('🔴 error: 状態の先頭は blockedActionNote(\'error\') とちょうど等しく、その phase を運ぶ(危険色に使う)', () => {
    const m = composeStatusModel(partsFor('error'));
    expect(m.state).toHaveLength(1);
    expect(m.state[0]?.text).toBe(blockedActionNote('error'));
    expect(m.state[0]?.phase).toBe('error');
  });

  it('🔴 保存領域が使えない警告(statusBaseSevere)だけが severe', () => {
    const WARN = '⚠ 保存領域が使えません。このタブで書いたものは、閉じると消えます';
    expect(composeStatusModel(partsFor('ready', { statusBase: WARN, statusBaseSevere: true })).state[0]?.severe).toBe(true);
    // 対照群 ── severe でなければ同じ字でも重大にならない
    expect(composeStatusModel(partsFor('ready', { statusBase: WARN })).state[0]?.severe).toBe(false);
    // 空なら出ない
    expect(composeStatusModel(partsFor('ready', { statusBaseSevere: true })).state).toEqual([]);
  });

  it('全部空なら空', () => {
    const m = composeStatusModel(partsFor('ready'));
    expect(m.state).toEqual([]);
    expect(m.toast).toBe('');
    expect(m.live).toBe('');
  });
});

describe('composeStatusModel().toast / live ── 一時の知らせ', () => {
  it('🔴 状態(編集中・保存先・保存中)は浮き札に出ない ── 常設の帯が無い代わりに入口へ移った', () => {
    const m = composeStatusModel(
      partsFor('editing', { statusBase: '保存先の注意', sync: '複数タブ: x', savingLine: '⏳ 保存中…', persistState: 'p' }),
    );
    expect(m.toast).toBe('');
  });

  it('🔴 進行中 → 知らせ → エラーの順で連なる(旧い行の並びのまま)', () => {
    const m = composeStatusModel(partsFor('ready', { progressLine: '書き出しています…', noticeLine: 'コピーしました', errorLine: 'エラー: x' }));
    expect(m.toast).toBe('書き出しています… — コピーしました — エラー: x');
  });

  it('🔴 読み上げは知らせとエラーだけ(進行中・状態語・保存中の出入りでは読み上げない)', () => {
    const m = composeStatusModel(
      partsFor('editing', { savingLine: '⏳ 保存中…', progressLine: '書き出しています…', noticeLine: 'コピーしました', errorLine: '⚠ エラー: 失敗' }),
    );
    expect(m.live).toBe('コピーしました — ⚠ エラー: 失敗');
  });

  it('ファイルを掴んでいる間の 1 行は fileDrag に分かれる(浮き札には出ない)', () => {
    const m = composeStatusModel(partsFor('ready', { fileDragLine: 'ここへ落とすと取り込みます' }));
    expect(m.fileDrag).toBe('ここへ落とすと取り込みます');
    expect(m.toast).toBe('');
  });
});

describe('shouldShowToast ── 浮き札を出すか(#671 の OK は畳まない)', () => {
  it('字があれば出す', () => {
    expect(shouldShowToast({ toast: '保存しました', hasTooNarrow: false })).toBe(true);
  });
  it('字が空で断り書きも無ければ畳む', () => {
    expect(shouldShowToast({ toast: '', hasTooNarrow: false })).toBe(false);
  });
  it('🔴 #671: 字が空でも、幅不足の断り書き(OK を押す口)がある間は畳まない', () => {
    expect(shouldShowToast({ toast: '', hasTooNarrow: true })).toBe(true);
  });
});

describe('paintToastText / paintStatusLive ── 同じ字なら DOM を触らない', () => {
  it('字が変わったときだけ書く(子ノードの全置換を避ける)', () => {
    const el = document.createElement('span');
    paintToastText(el, 'a');
    const node = el.firstChild;
    paintToastText(el, 'a');
    expect(el.firstChild, '同じ字で子ノードが作り直された').toBe(node);
    paintToastText(el, 'b');
    expect(el.textContent).toBe('b');
  });
  it('読み上げの領域は作り直さず、字だけ書く', () => {
    const live = document.createElement('div');
    live.setAttribute('aria-live', 'polite');
    paintStatusLive(live, 'x');
    expect(live.textContent).toBe('x');
    paintStatusLive(live, '');
    expect(live.textContent).toBe('');
    expect(live.getAttribute('aria-live')).toBe('polite');
  });
});
