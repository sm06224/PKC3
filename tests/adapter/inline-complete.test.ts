/** @vitest-environment happy-dom */
/**
 * 🔴 打ちながら出る補完の小窓(#1449 `/` / #1450 `@`)── binder の配線ごと、本物の欄に打って確かめる。
 */
import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { initialState } from '../../src/adapter/state/app-state';
import { buildFormatBar } from '../../src/adapter/ui/render/format-bar';
import { SLASH_TOOLS } from '../../src/features/markdown/inline-complete';

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

describe('/ から先に聞く挿入の道具を呼ぶ(#1982 段 3)', () => {
  it('字は帯のボタンの字と同じ(帯を描いて読む ── 書き写した字と食い違わない)', () => {
    const bar = buildFormatBar();
    for (const t of SLASH_TOOLS) {
      const btn = bar.querySelector(`[data-pkc-action="${t.action}"]`);
      expect(btn, `${t.action} が帯に無い`).not.toBeNull();
      expect(btn!.querySelector('[data-pkc-field="label"]')?.textContent, t.action).toBe(t.label);
    }
  });

  it('/日付 → 「日付を挿入」が出て、Tab で `/日付` が消え、帯と同じ受け手(日付の選び)が開く', () => {
    const { type, key, menu, rows, ta } = setup();
    type('前の行\n/日付');
    expect(menu(), '小窓が出ない').not.toBeNull();
    expect(rows()).toContain('日付を挿入');
    key('Tab');
    expect(ta.value, '/日付 が残っている').toBe('前の行\n');
    expect(document.querySelector('dialog'), '日付の選びが開かない(受け手が呼ばれていない)').not.toBeNull();
  });

  it('文中の /日付 では出ない(行頭だけ)', () => {
    const { type, menu } = setup();
    type('今日は /日付');
    expect(menu()).toBeNull();
  });
});

describe('(asset: の補完(#2001 段 4)── 4 つの欄すべて', () => {
  const BODIES: Record<string, string> = {
    a1: '---\nattachment.name: 請求書.pdf\nattachment.mime: application/pdf\nattachment.size: 2048\nattachment.asset_key: k-pdf\n---\n',
    a2: '---\nattachment.name: 写真.png\nattachment.mime: image/png\nattachment.size: 100\nattachment.asset_key: k-png\n---\n',
  };
  let reads = 0;
  function setupAsset(field: string, readOverride?: (lids: readonly string[]) => Promise<ReadonlyMap<string, string>>) {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    root.innerHTML = `<div data-pkc-region="detail"><textarea data-pkc-field="${field}"></textarea></div>`;
    document.body.append(root);
    const ta = root.querySelector<HTMLTextAreaElement>('textarea')!;
    const metas = new Map<string, never>();
    for (const [i, [lid, title, arche]] of [['a1', '請求書.pdf', 'attachment'], ['a2', '写真.png', 'attachment'], ['t1', 'ただのノート', 'text']].entries()) {
      metas.set(lid!, { lid, title, archetype: arche, createdAt: null, updatedAt: 'u1', entryOrder: i, status: null, date: null, archived: false } as never);
    }
    const d = new Dispatcher({ ...initialState, cid: 'c1', phase: 'editing', selectedLid: 't1', entryMetas: metas as never, order: ['a1', 'a2', 't1'] });
    reads = 0;
    const dispatchSpy = vi.spyOn(d, 'dispatch');
    bindActions(root, d, {
      readBodies:
        readOverride ??
        ((lids: readonly string[]) => {
          reads += 1;
          return Promise.resolve(new Map(lids.map((l) => [l, BODIES[l] ?? ''] as const)));
        }),
    });
    const type = async (value: string): Promise<void> => {
      ta.focus();
      ta.value = value;
      ta.setSelectionRange(value.length, value.length);
      ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    };
    const rows = (): string[] =>
      [...root.querySelectorAll(`${REGION} [data-pkc-field="inline-complete-item"]`)].map((r) => r.textContent ?? '');
    return { root, ta, type, rows, menu: () => root.querySelector(REGION), d, dispatchSpy };
  }

  for (const field of ['editor-body', 'row-source', 'section-draft-input', 'append-input']) {
    it(`${field}: (asset: で添付の一覧(名前・種類・大きさ)→ 語で絞る → Tab で画像は ![名前](asset:key)`, async () => {
      const s = setupAsset(field);
      await s.type('前 ![](asset:');
      expect(s.rows(), '一覧が出ない').toEqual(['請求書.pdfPDF · 2.0 KB', '写真.pngPNG · 100 B']);
      await s.type('前 ![](asset:写');
      expect(s.rows()).toEqual(['写真.pngPNG · 100 B']);
      const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      s.ta.dispatchEvent(ev);
      expect(s.ta.value).toBe('前 ![写真.png](asset:k-png)');
      expect(s.menu()).toBeNull();
    });
  }

  it('Enter でも入る(`/` と同じ)/ 画像でない添付はリンク / 自動の ) は二重にならない', async () => {
    const s = setupAsset('editor-body');
    await s.type('(asset:請求');
    s.ta.value = '(asset:請求)';
    s.ta.setSelectionRange(9, 9);
    s.ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    s.ta.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(s.ta.value).toBe('[請求書.pdf](asset:k-pdf)');
  });

  it('一致が無ければ出ない / 読んだ添付は覚える(2 回目は読み直さない)/ 設定で切れる', async () => {
    const s = setupAsset('editor-body');
    await s.type('(asset:zzz');
    expect(s.menu()).toBeNull();
    expect(reads).toBe(1);
    await s.type('(asset:');
    expect(s.menu()).not.toBeNull();
    expect(reads, '覚えていない').toBe(1);
    localStorage.setItem('pkc3.inline-complete', '0');
    try {
      await s.type('(asset:請');
      expect(s.menu()).toBeNull();
    } finally {
      localStorage.removeItem('pkc3.inline-complete');
    }
  });

  it('🔴 添付の一覧を読めなかったら、黙らず理由を出す(続けて打っても 1 度だけ)/ 直ったら出る', async () => {
    let fail = true;
    const s = setupAsset('editor-body', (lids) =>
      fail ? Promise.reject(new Error('boom')) : Promise.resolve(new Map(lids.map((l) => [l, BODIES[l] ?? ''] as const))),
    );
    const failures = (): unknown[] =>
      s.dispatchSpy.mock.calls.filter((c) => (c[0] as { type: string }).type === 'OP_FAILED').map((c) => c[0]);
    await s.type('(asset:');
    await s.type('(asset:請');
    expect(s.menu()).toBeNull();
    expect(failures().length, '読めないのに何も言わない / 毎打鍵で言う').toBe(1);
    expect(JSON.stringify(failures()[0])).toContain('添付の一覧を読めませんでした');
    fail = false;
    await s.type('(asset:請求');
    expect(s.rows()).toEqual(['請求書.pdfPDF · 2.0 KB']);
  });

  it('古い応答は捨てる: 待つ間に引き金を消したら小窓は出ない', async () => {
    const s = setupAsset('editor-body');
    s.ta.focus();
    s.ta.value = '(asset:';
    s.ta.setSelectionRange(7, 7);
    s.ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
    s.ta.value = 'あ';
    s.ta.setSelectionRange(1, 1);
    s.ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    expect(s.menu()).toBeNull();
  });
});
