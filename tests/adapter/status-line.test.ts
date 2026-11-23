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
import { CORRUPT_REFUSAL } from '../../src/features/storage/db-corruption';
import { blockedActionNote } from '../../src/adapter/state/app-state';
import {
  composeStatusModel,
  isToastDismissible,
  isToastHeld,
  ToastDismissal,
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

describe('severeToastLine ── 実害のある保存先の警告は専用の行(他の知らせの字と混ぜない)', () => {
  it('🔴 model.severe に入り、toast には混ざらない(混ざると新しい知らせが 2 行で切れて読めない)。状態の欄にも残る', () => {
    const m = composeStatusModel(partsFor('ready', { statusBase: '⚠ 閉じると消えます', statusBaseSevere: true, severeToastLine: '⚠ 閉じると消えます', noticeLine: 'コピーしました' }));
    expect(m.severe).toBe('⚠ 閉じると消えます');
    expect(m.toast).toBe('コピーしました');
    expect(m.state[0]?.severe).toBe(true);
    expect(m.live, '読み上げは知らせだけ(常設の警告で毎回読まない)').toBe('コピーしました');
  });
  it('🔴 警告だけでも浮き札は出る(字の欄が空でも畳まない)', () => {
    expect(shouldShowToast({ toast: '', severe: '⚠ x', hasTooNarrow: false })).toBe(true);
    expect(shouldShowToast({ toast: '', severe: '', hasTooNarrow: false })).toBe(false);
  });
});

describe('ToastDismissal ── × の記憶(main.ts の paint が使う本物の判断)', () => {
  const base = (over: Partial<StatusLineParts> = {}): StatusLineParts => partsFor('ready', over);

  it('🔴 × で閉じたエラーは隠れ、別の字のエラーは出て、同じエラーも一度消えてからはまた出る', () => {
    const d = new ToastDismissal();
    expect(d.apply(base({ errorLine: 'エラー: A' })).errorLine).toBe('エラー: A');
    expect(d.dismiss({ errorLine: 'エラー: A', progressLine: '' }, 'エラー: A')).toBe(true);
    expect(d.apply(base({ errorLine: 'エラー: A' })).errorLine, '閉じたのに出ている').toBe('');
    expect(d.apply(base({ errorLine: 'エラー: B' })).errorLine, '別のエラーが出ない').toBe('エラー: B');
    d.dismiss({ errorLine: 'エラー: B', progressLine: '' }, 'エラー: B');
    d.apply(base({ errorLine: '' }));
    expect(d.apply(base({ errorLine: 'エラー: B' })).errorLine, '消えた後の同じエラーが出ない').toBe('エラー: B');
  });

  it('🔴 進行中も同じ(字が変わる / 消えると解く)', () => {
    const d = new ToastDismissal();
    d.dismiss({ errorLine: '', progressLine: '書き出しています…' }, '書き出しています…');
    expect(d.apply(base({ progressLine: '書き出しています…' })).progressLine).toBe('');
    expect(d.apply(base({ progressLine: '取り込んでいます…' })).progressLine).toBe('取り込んでいます…');
  });

  it('🔴 保存先の警告は、閉じるとそのセッションの間は出ない(新しい記憶 = 次の起動では出る)', () => {
    const d = new ToastDismissal();
    expect(d.apply(base({ severeToastLine: '⚠ x' })).severeToastLine).toBe('⚠ x');
    d.dismissSevere();
    expect(d.apply(base({ severeToastLine: '⚠ x' })).severeToastLine).toBe('');
    expect(new ToastDismissal().apply(base({ severeToastLine: '⚠ x' })).severeToastLine, '次の起動で出ない').toBe('⚠ x');
  });

  it('🔴 ふつうの知らせの × は、保存先の警告を隠さない(専用の × だけが隠す)', () => {
    const d = new ToastDismissal();
    expect(d.dismiss({ errorLine: '', progressLine: '' }, 'コピーしました')).toBe(true);
    expect(d.apply(base({ severeToastLine: '⚠ x' })).severeToastLine, '「コピーしました」の × で実害の警告が消えた').toBe('⚠ x');
  });

  it('🔴 保存データの確認へ送る断り書きは × で消えない(押す口ごと無くなるため)/ 対照: ふつうの知らせは消せる', () => {
    const line = CORRUPT_REFUSAL;
    expect(isToastDismissible(line)).toBe(false);
    expect(isToastDismissible('コピーしました')).toBe(true);
    const d = new ToastDismissal();
    expect(d.dismiss({ errorLine: `エラー: ${line}`, progressLine: '' }, `エラー: ${line}`)).toBe(false);
    expect(d.apply(base({ errorLine: `エラー: ${line}` })).errorLine, '消せないはずの断り書きが消えた').toContain(line);
  });
});

describe('isToastHeld ── 読んでいる間か(引く側。押す側の記憶が固まらない)', () => {
  const el = (over: { hidden?: boolean; hover?: boolean; inside?: boolean } = {}) => {
    const focusTarget = document.createElement('button');
    return {
      focusTarget,
      toast: {
        hidden: over.hidden ?? false,
        matches: (sel: string) => sel === ':hover' && over.hover === true,
        contains: (n: Node | null) => over.inside === true && n === focusTarget,
      },
    };
  };
  it('🔴 マウスが載っている / 焦点が中 → 真。どちらでもなければ偽', () => {
    const a = el({ hover: true });
    expect(isToastHeld(a.toast, null)).toBe(true);
    const b = el({ inside: true });
    expect(isToastHeld(b.toast, b.focusTarget)).toBe(true);
    const c = el();
    expect(isToastHeld(c.toast, c.focusTarget)).toBe(false);
  });
  it('🔴 畳まれた札は、焦点が中に在っても・マウスが載っていても読まれていない(焦点を持ったまま畳まれても固まらない)', () => {
    const a = el({ hidden: true, inside: true });
    expect(isToastHeld(a.toast, a.focusTarget)).toBe(false);
    expect(isToastHeld(el({ hidden: true, hover: true }).toast, null)).toBe(false);
  });
  it('🔴 本物の浮き札(shell)でも ── 焦点がボタンに在る間は真、畳むと偽', async () => {
    const { buildShell } = await import('../../src/adapter/ui/render/shell');
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    regions.status.hidden = false;
    regions.statusClose.focus();
    expect(isToastHeld(regions.status, document.activeElement)).toBe(true);
    regions.status.hidden = true;
    expect(isToastHeld(regions.status, document.activeElement), '畳まれたのに真のまま').toBe(false);
  });
});

describe('保存データの確認の押し口 ⇔ × を出さない ⇔ isToastDismissible(parity)', () => {
  it('🔴 断り書きのとき: 押し口が出る ⇔ 消せない。ふつうの知らせでは押し口が出ず、消せる', async () => {
    const { paintStatusRescue } = await import('../../src/adapter/ui/render/status-open');
    const btn = document.createElement('button');
    for (const [text, dismissible] of [[`エラー: ${CORRUPT_REFUSAL}`, false], ['コピーしました', true], [`${CORRUPT_REFUSAL}(open で検出: x)`, false]] as const) {
      paintStatusRescue(btn, text);
      expect(btn.hidden, text).toBe(dismissible);
      expect(isToastDismissible(text), text).toBe(dismissible);
    }
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/styles/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css, '押し口が出ている間に × を隠す CSS が無い').toMatch(/status-rescue'\]:not\(\[hidden\]\)\) > \[data-pkc-field='status-close'\]\s*\{\s*display: none;/);
  });
});
