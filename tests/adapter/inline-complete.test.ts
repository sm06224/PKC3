/** @vitest-environment happy-dom */
/**
 * 🔴 打ちながら出る補完の小窓(#1449 `/` / #1450 `@`)── binder の配線ごと、本物の欄に打って確かめる。
 */
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { initialState } from '../../src/adapter/state/app-state';

const REGION = '[data-pkc-region="inline-complete"]';

function setup(field = 'editor-body', phase: 'editing' | 'ready' = 'editing') {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  root.innerHTML = `<div data-pkc-region="detail"><textarea data-pkc-field="${field}"></textarea></div>`;
  document.body.append(root);
  const ta = root.querySelector<HTMLTextAreaElement>('textarea')!;
  const metas = new Map<string, never>();
  for (const [i, [lid, title]] of [['n1', '先週の議事録'], ['n2', '買い物メモ'], ['self', '今のノート']].entries()) {
    metas.set(lid!, {
      lid, title, archetype: 'text', createdAt: null, updatedAt: null, entryOrder: i, status: null, date: null, archived: false,
    } as never);
  }
  const d = new Dispatcher({
    ...initialState,
    cid: 'c1',
    phase,
    selectedLid: 'self',
    entryMetas: metas as never,
    order: ['n1', 'n2', 'self'],
  });
  bindActions(root, d, {});
  const type = (value: string): void => {
    ta.focus();
    ta.value = value;
    ta.setSelectionRange(value.length, value.length);
    ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
  };
  const key = (k: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    ta.dispatchEvent(ev);
    return ev;
  };
  const menu = (): HTMLElement | null => root.querySelector(REGION);
  const rows = (): string[] =>
    [...root.querySelectorAll(`${REGION} [data-pkc-field="inline-complete-item"]`)].map((r) => r.firstElementChild?.textContent ?? '');
  return { root, ta, type, key, menu, rows, d };
}

describe('/ の記法パレット(#1449)', () => {
  it('行頭の / で一覧が出て、絞り込み → Tab で入る(/ ごと置き換わる)', () => {
    const s = setup();
    s.type('/');
    expect(s.menu()).not.toBeNull();
    expect(s.rows().length).toBeGreaterThan(3);
    s.type('/h2');
    expect(s.rows()[0]).toBe('見出し2');
    const ev = s.key('Tab');
    expect(ev.defaultPrevented).toBe(true);
    expect(s.menu()).toBeNull();
    expect(s.ta.value).toBe('## ');
    // 続きをそのまま打てる(行ごと選んだ形で残ると、次の 1 字で印が消える)
    expect([s.ta.selectionStart, s.ta.selectionEnd]).toEqual([3, 3]);
  });
  it('Enter でも入る。↑↓ で別の行を選べる', () => {
    const s = setup();
    s.type('/見出し');
    expect(s.rows()).toEqual(['見出し1', '見出し2', '見出し3']);
    s.key('ArrowDown');
    s.key('Enter');
    expect(s.ta.value).toBe('## ');
  });
  it('途中の / や 0 件のときは出ない / Esc で閉じて、同じ引き金では出し直さない', () => {
    const s = setup();
    s.type('A/B');
    expect(s.menu()).toBeNull();
    s.type('/usr/bin');
    expect(s.menu()).toBeNull();
    s.type('/表');
    expect(s.menu()).not.toBeNull();
    const ev = s.key('Escape');
    expect(ev.defaultPrevented).toBe(true);
    expect(s.menu()).toBeNull();
    s.type('/表の');
    expect(s.menu()).toBeNull();
  });
  it('小窓が無いときの Tab / Enter / Esc は奪わない', () => {
    const s = setup();
    s.type('ふつうの文');
    expect(s.key('Enter').defaultPrevented).toBe(false);
    expect(s.key('Tab').defaultPrevented).toBe(false);
  });
  it('小窓が開いている間の Esc は、編集を終わらせる側へ届かない(閉じるだけ)', () => {
    const s = setup();
    let reached = 0;
    document.addEventListener('keydown', () => void (reached += 1));
    s.type('/表');
    s.key('Escape');
    expect(reached).toBe(0);
    s.key('Escape');
    expect(reached).toBe(1);
  });
  it('日本語入力の変換中は何もしない', () => {
    const s = setup();
    s.ta.value = '/';
    s.ta.setSelectionRange(1, 1);
    s.ta.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    expect(s.menu()).toBeNull();
  });
  it('追記欄と 1 面の行(row-source)でも出る', () => {
    for (const f of ['append-input', 'row-source']) {
      const s = setup(f);
      s.type('/表');
      expect(s.menu(), f).not.toBeNull();
    }
  });
});

describe('@ のノートと日付(#1450)', () => {
  it('@ + 題名の一部 → Tab で [題名](entry:lid) に置き換わる。自分自身は出ない', () => {
    const s = setup();
    s.type('参照: @議事');
    expect(s.rows()).toEqual(['先週の議事録']);
    s.key('Tab');
    expect(s.ta.value).toBe('参照: [先週の議事録](entry:n1)');
    s.type('@今の');
    expect(s.menu()).toBeNull();
  });
  it('@today → 日付(予定の書き方)に置き換わる', () => {
    const s = setup();
    s.type('- [ ] 提出 @today');
    expect(s.rows()[0]).toBe('今日');
    s.key('Tab');
    expect(s.ta.value).toMatch(/^- \[ \] 提出 @\d{4}-\d{2}-\d{2}\s*$/u);
    expect(s.ta.value).not.toContain('@today');
  });
  it('文の途中の @ のあとの Enter は、選ぶまでふつうの改行(小窓だけ閉じる)', () => {
    const s = setup();
    s.type('連絡 @');
    expect(s.menu()).not.toBeNull();
    const ev = s.key('Enter');
    expect(ev.defaultPrevented).toBe(false);
    expect(s.menu()).toBeNull();
  });
  it('予定記法 @2026-… とメールアドレスでは出ない', () => {
    const s = setup();
    s.type('@2026-10');
    expect(s.menu()).toBeNull();
    s.type('foo@bar');
    expect(s.menu()).toBeNull();
  });
  it('小窓の行を押すと入り、欄の焦点は奪わない', () => {
    const s = setup();
    s.type('@買い物');
    const row = s.root.querySelector<HTMLElement>(`${REGION} [data-pkc-field="inline-complete-item"]`)!;
    const ev = new Event('pointerdown', { bubbles: true, cancelable: true });
    row.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(s.ta.value).toBe('[買い物メモ](entry:n2)');
  });
});

describe('設定で切れる(#1449 / #1450)', () => {
  it('「入力中に補完の候補を出す」を切ると / も @ も出ない。入れ直すと出る', () => {
    const s = setup();
    try {
      localStorage.setItem('pkc3.inline-complete', '0');
      s.type('/表');
      expect(s.menu(), '切ったのに / の候補が出た').toBeNull();
      s.type('@今日');
      expect(s.menu(), '切ったのに @ の候補が出た').toBeNull();
      localStorage.setItem('pkc3.inline-complete', '1');
      s.type('/表');
      expect(s.menu(), '入れ直しても出ない(対照群)').not.toBeNull();
    } finally {
      localStorage.removeItem('pkc3.inline-complete');
    }
  });
  it('保存が無い端末の既定は入', () => {
    localStorage.removeItem('pkc3.inline-complete');
    const s = setup();
    s.type('/表');
    expect(s.menu()).not.toBeNull();
  });
});

describe('書式バーの「この行を計算する」(#766 D-3)', () => {
  it('押すと、カーソルの行の式の答えが行の終わりに入る / 式でない行では理由を言う', async () => {
    const { buildFormatBar } = await import('../../src/adapter/ui/render/format-bar');
    const s = setup();
    const bar = buildFormatBar();
    s.root.append(bar);
    const btn = bar.querySelector<HTMLElement>('[data-pkc-action="calc-line"]')!;
    expect(btn.textContent).toBe('この行を計算する');
    s.ta.value = '2+3=';
    s.ta.setSelectionRange(4, 4);
    btn.click();
    expect(s.ta.value).toBe('2+3=5');
    // 式でない行 ── 黙らず、本文は変わらない
    s.ta.value = 'ふつうの文';
    s.ta.setSelectionRange(5, 5);
    btn.click();
    expect(s.ta.value).toBe('ふつうの文');
  });
});

describe('着地前レビューの指摘', () => {
  it('🔴 / の挿入は、引き金を消す入力と入れる入力に割れず、input が 1 回(Ctrl+Z 1 手の前提)', () => {
    const s = setup();
    s.type('/見出し2');
    let inputs = 0;
    s.ta.addEventListener('input', () => void (inputs += 1));
    s.key('Tab');
    expect(s.ta.value).toBe('## ');
    expect(inputs, '消す入力と入れる入力が別々に走った(Ctrl+Z が 2 手になる)').toBe(1);
  });

  it('🔴 / の挿入が、行の途中を壊さない(引き金より前・caret より後ろの字は残る)', () => {
    const s = setup();
    s.ta.value = '前の行\n/表\n次の行';
    s.ta.focus();
    s.ta.setSelectionRange(6, 6);
    s.ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(s.menu()).not.toBeNull();
    s.key('Tab');
    expect(s.ta.value.startsWith('前の行\n')).toBe(true);
    expect(s.ta.value.endsWith('\n次の行')).toBe(true);
    expect(s.ta.value).not.toContain('/表');
  });

  it('⚠ 変換中の Enter / Tab は候補を確定しない(isComposing / keyCode 229)', () => {
    const s = setup();
    s.type('/見出し');
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      for (const k of ['Enter', 'Tab']) {
        const ev = s.key(k, init);
        expect(ev.defaultPrevented, `${JSON.stringify(init)} の ${k} を奪った`).toBe(false);
        expect(s.ta.value, `${JSON.stringify(init)} の ${k} で候補が入った`).toBe('/見出し');
      }
    }
    expect(s.menu(), '変換中の keydown で小窓が閉じた').not.toBeNull();
    // 対照群:変換中でなければ入る
    s.key('Enter');
    expect(s.ta.value).toBe('# ');
  });

  it('⚠ 変換を始めたら小窓を閉じる(compositionstart)', () => {
    const s = setup();
    s.type('/表');
    expect(s.menu()).not.toBeNull();
    s.ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(s.menu()).toBeNull();
  });

  it.each(['editor-body', 'row-source', 'append-input'])(
    '⚠ %s: ノートを切り替えたら小窓は残らない(対照群:同じ本文の打鍵では閉じない)',
    (field) => {
      const s = setup(field, 'ready');
      s.type('/表');
      expect(s.menu()).not.toBeNull();
      // 対照群:本文が変わるだけの状態変化(UPDATE_OPEN_BODY の類)では閉じない
      s.d.dispatch({ type: 'UPDATE_OPEN_BODY', lid: 'self', body: 'x' } as never);
      expect(s.menu(), '打鍵の状態変化で閉じた').not.toBeNull();
      s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
      expect(s.d.getState().selectedLid, '前提:ノートが切り替わっていない').toBe('n1');
      expect(s.menu(), 'ノートを切り替えたのに小窓が残った').toBeNull();
    },
  );

  it('⚠ 欄が画面から消えたら、キー・クリック・サイズ変更で小窓を片付ける', () => {
    for (const how of ['resize', 'click', 'key'] as const) {
      const s = setup();
      s.type('/表');
      expect(s.menu()).not.toBeNull();
      const ta = s.ta;
      ta.remove();
      if (how === 'resize') window.dispatchEvent(new Event('resize'));
      else if (how === 'click') s.root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      else s.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      expect(s.menu(), `${how}: 孤児の小窓が残った`).toBeNull();
    }
  });
});
