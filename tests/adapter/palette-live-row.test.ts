/** @vitest-environment happy-dom */
/**
 * 🔴 **左の探す欄の `>` から「打っている場所に入れる」操作を呼ぶ**(#582 段③ 第 3 群の残り)。
 *
 * ## 何が起きていたか
 * 1 面のライブ編集で探す欄を押すと、焦点が外れて行が確定し `row-source` が DOM から消える。そのまま「日付を入れる」などを選んでも
 * 書き込む欄が無く、何も起きなかった(2 列の編集は欄が残るので動く)。
 *
 * ## 守るもの
 *  ① 行が探す欄へ焦点を渡す瞬間に控えた行(行番号・原文・caret)で、**行を開き直してから**命令を実行する(開き直す前に押さない)。
 *  ② 開き直せなかった(控えと違う行・別のノート・面が無い)ときは**押さずに**「書き込む欄が変わった」で断る。
 *  ③ 控えは探す欄へ移ったときだけ(他へ移った blur では捨てる)・1 回使ったら捨てる・欄が既に在る(2 列)なら開き直さない。
 *  ④ 「打っている場所に入れる」でない命令(`CARET_INSERT_TOOLS` の外)は、控えがあっても開き直さない。
 * ⚠ 行そのものの開き直し(caret の復元・原文の突き合わせ・予約)は `row-swap.test.ts` が持つ。ここは binder の配線。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { Dispatchable } from '../../src/adapter/state/app-state';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { ROW_REOPEN_EVENT, RowSwap, type RowReopenDetail } from '../../src/adapter/ui/render/row-swap';
import { renderMarkdownWithRanges } from '../../src/features/markdown/source-ranges';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { resetAppDialogForTest } from '../../src/adapter/ui/render/app-dialog';

function meta(lid: string, title: string): EntryMeta {
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
    bodyChars: 0,
  };
}

const FIELD_CHANGED = '書き込む欄が変わったので入れませんでした(もう一度選んでから実行してください)';

/** 1 面のライブ編集を模す:`editor-live` の面 + 開いている行 + 探す欄 + 書式の帯のボタン(押された順を記録する)。 */
function setup() {
  document.body.innerHTML = '';
  resetAppDialogForTest();
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const d = new Dispatcher();
  const sent: Dispatchable[] = [];
  const raw = d.dispatch.bind(d);
  d.dispatch = ((a: Dispatchable) => {
    sent.push(a);
    return raw(a);
  }) as typeof d.dispatch;
  bindActions(root, d, {}, new KeymapStore());
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 'めも'), meta('n2', '議事録')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: 'hello world' });
  // 左の探す欄が `>` の一覧を出している状態(実行時に確かめる)。⚠ 描き直しで焦点が動くので、面を組む前に済ませる
  d.dispatch({ type: 'SET_ENTRY_FILTER', query: '>日付' });

  const detail = document.createElement('div');
  detail.setAttribute('data-pkc-region', 'detail');
  const pane = document.createElement('div');
  pane.setAttribute('data-pkc-region', 'editor-live');
  detail.append(pane);
  const log: string[] = [];
  const mkButton = (id: string): void => {
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', id);
    b.addEventListener('click', () => {
      log.push(`${id}:${detail.querySelector('[data-pkc-field="row-source"]') === null ? 'no-row' : 'row'}`);
    });
    detail.append(b);
  };
  for (const id of ['insert-date', 'renumber-lists']) mkButton(id);
  root.append(detail);

  const filter = root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]');
  if (filter === null) throw new Error('前提: 左の探す欄が無い');

  const row = document.createElement('textarea');
  row.setAttribute('data-pkc-field', 'row-source');
  row.setAttribute('data-pkc-row-line', '0');
  row.value = 'hello world';
  pane.append(row);
  row.focus();
  row.setSelectionRange(5, 5);

  /** 面の側(`RowSwap` の代わり):依頼を記録し、`outcome` に従って行を開き直す。 */
  const asked: RowReopenDetail[] = [];
  let outcome: 'ok' | 'stale' | 'ignore' = 'ok';
  pane.addEventListener(ROW_REOPEN_EVENT, (ev) => {
    const dt = (ev as CustomEvent<RowReopenDetail>).detail;
    asked.push(dt);
    if (outcome === 'ignore') return;
    if (outcome === 'stale') {
      dt.done(false);
      return;
    }
    const r = document.createElement('textarea');
    r.setAttribute('data-pkc-field', 'row-source');
    r.value = dt.source;
    pane.append(r);
    dt.done(true);
  });

  /** 行から焦点が探す欄へ移る(実ブラウザでは blur が確定して行が DOM から消える)。 */
  const leaveRowTo = (to: HTMLElement | null): void => {
    row.dispatchEvent(new FocusEvent('blur', { bubbles: false, relatedTarget: to }));
    row.remove();
  };
  const runRow = (id: string): void => {
    const b = document.createElement('button');
    b.setAttribute('data-pkc-action', 'run-command-row');
    b.setAttribute('data-pkc-command', id);
    root.append(b);
    b.click();
    b.remove();
  };
  return {
    root,
    d,
    sent,
    detail,
    pane,
    row,
    filter,
    log,
    asked,
    leaveRowTo,
    runRow,
    setOutcome: (o: typeof outcome) => (outcome = o),
  };
}

const failed = (sent: Dispatchable[]): string[] =>
  sent.filter((a) => a.type === 'OP_FAILED').map((a) => (a as { error: string }).error);

beforeEach(() => {
  document.body.innerHTML = '';
  resetAppDialogForTest();
});

describe('左の `>` から、1 面の行へ入れる操作を呼ぶ(#582)', () => {
  it('🔴 行を開き直し、caret を戻す依頼を出してから命令を押す(開き直す前に押さない)', () => {
    const a = setup();
    a.leaveRowTo(a.filter);
    a.runRow('insert-date');
    expect(a.asked).toHaveLength(1);
    expect(a.asked[0]).toMatchObject({ line: 0, source: 'hello world', start: 5, end: 5 });
    // 押した時点で行が在る(= 開き直した後に押している)。順番が逆だと 'no-row' になる
    expect(a.log).toEqual(['insert-date:row']);
    expect(failed(a.sent)).toEqual([]);
  });

  it('🔴 範囲を選んでいたら、その範囲ごと控える', () => {
    const a = setup();
    a.row.setSelectionRange(2, 7);
    a.leaveRowTo(a.filter);
    a.runRow('insert-date');
    expect(a.asked[0]).toMatchObject({ start: 2, end: 7 });
  });

  it('🔴 開き直せなかった(控えと違う行など)ときは、押さずに「欄が変わった」で断る', () => {
    const a = setup();
    a.setOutcome('stale');
    a.leaveRowTo(a.filter);
    a.runRow('insert-date');
    expect(a.asked).toHaveLength(1);
    expect(a.log, '開き直せなかったのに押した(別の欄の先頭へ入る)').toEqual([]);
    expect(failed(a.sent)).toEqual([FIELD_CHANGED]);
  });

  it('🔴 別のノートを開いていたら、依頼を出さずに断る(古い行を別のノートへ開かない)', () => {
    const a = setup();
    a.leaveRowTo(a.filter);
    a.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n2' });
    a.d.dispatch({ type: 'BODY_LOADED', lid: 'n2', body: '別のノート' });
    a.runRow('insert-date');
    expect(a.asked).toEqual([]);
    expect(a.log).toEqual([]);
    expect(failed(a.sent)).toEqual([FIELD_CHANGED]);
  });

  it('控えは探す欄へ移ったときだけ。他へ移る blur では捨てる(古い控えで別の場所へ入れない)', () => {
    const a = setup();
    a.leaveRowTo(null); // 本文の外をクリックした
    a.runRow('insert-date');
    expect(a.asked, '探す欄へ移っていないのに開き直した').toEqual([]);
    // 焦点が別の欄(題名など)へ移ったときも控えない(探す欄だけが対象)
    const t = setup();
    const title = document.createElement('input');
    title.setAttribute('data-pkc-field', 'editor-title');
    t.root.append(title);
    t.leaveRowTo(title);
    t.runRow('insert-date');
    expect(t.asked, '探す欄以外へ移ったのに控えた').toEqual([]);
    // 探す欄へ移った後、別の場所の blur が来たら捨てる(対照群: 探す欄自身の blur は捨てない)
    const b = setup();
    b.leaveRowTo(b.filter);
    b.filter.dispatchEvent(new FocusEvent('blur', { relatedTarget: null }));
    b.runRow('insert-date');
    expect(b.asked, '探す欄自身の blur(一覧の行を押す途中)で控えが消えた').toHaveLength(1);
    const c = setup();
    c.leaveRowTo(c.filter);
    const other = document.createElement('input');
    c.root.append(other);
    other.dispatchEvent(new FocusEvent('blur', { bubbles: false, relatedTarget: null }));
    c.runRow('insert-date');
    expect(c.asked, '別の欄の blur を挟んだのに古い控えで開き直した').toEqual([]);
  });

  it('控えは 1 回使ったら捨てる', () => {
    const a = setup();
    a.leaveRowTo(a.filter);
    a.runRow('insert-date');
    expect(a.asked).toHaveLength(1);
    // 開き直した行を閉じて(再び欄が無い)もう一度呼んでも、古い控えでは開き直さない
    a.detail.querySelector('[data-pkc-field="row-source"]')!.remove();
    // ⚠ 命令が走ると左の列が描き直されて、この台の面が外れることがある ── 戻さないと「面が無い」で断られて空振りになる
    if (!a.detail.isConnected) a.root.append(a.detail);
    a.runRow('insert-date');
    expect(a.asked, '使った控えが残っていた').toHaveLength(1);
    expect(a.log, '2 回目は控え無しでそのまま押される').toEqual(['insert-date:row', 'insert-date:no-row']);
    expect(failed(a.sent), '2 回目が欄が変わったと断られた(空振りの顔)').toEqual([]);
  });

  it('欄が既に在る(2 列の編集など)なら開き直さない', () => {
    const a = setup();
    a.leaveRowTo(a.filter);
    const field = document.createElement('textarea');
    field.setAttribute('data-pkc-field', 'editor-body');
    a.detail.append(field);
    a.runRow('insert-date');
    expect(a.asked).toEqual([]);
    expect(a.log).toEqual(['insert-date:no-row']);
  });

  it('「打っている場所に入れる」でない命令(全文の道具)は、控えがあっても開き直さない', () => {
    const a = setup();
    a.leaveRowTo(a.filter);
    a.runRow('renumber-lists');
    expect(a.asked).toEqual([]);
  });

  it('行が開いていた印(data-pkc-row-line)が無い欄は控えない', () => {
    const a = setup();
    a.row.removeAttribute('data-pkc-row-line');
    a.leaveRowTo(a.filter);
    a.runRow('insert-date');
    expect(a.asked).toEqual([]);
  });

  it('面が応えなかったとき(予約中)は、命令を先に押さない', () => {
    const a = setup();
    a.setOutcome('ignore');
    const spy = vi.fn();
    a.detail.querySelector('[data-pkc-action="insert-date"]')!.addEventListener('click', spy);
    a.leaveRowTo(a.filter);
    a.runRow('insert-date');
    expect(a.asked).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('控えの捨て方(#582 着地前レビュー F2)', () => {
  const reattach = (a: ReturnType<typeof setup>): void => {
    if (!a.detail.isConnected) a.root.append(a.detail);
  };

  it('🔴 本文の余白のような焦点を持てない所を押したら、控えを捨てる(後の `>` が古い行を開かない)', () => {
    const a = setup();
    a.leaveRowTo(a.filter);
    // 余白を押す: mousedown は飛ぶが、焦点を持つ要素が無いので blur は飛ばない
    a.detail.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    a.runRow('insert-date');
    expect(a.asked, '余白を押した後の `>` が古い行を開いた').toEqual([]);
  });

  it('対照群: 探す欄・その一覧の行を押す mousedown では控えを捨てない', () => {
    const a = setup();
    a.leaveRowTo(a.filter);
    a.filter.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'run-command-row');
    a.root.append(btn);
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    a.runRow('insert-date');
    expect(a.asked).toHaveLength(1);
  });

  it('🔴 探す欄が、一覧の外の物へ焦点を渡したら捨てる。一覧の行へ渡すなら残す', () => {
    const a = setup();
    a.leaveRowTo(a.filter);
    const other = document.createElement('button');
    a.root.append(other);
    a.filter.dispatchEvent(new FocusEvent('blur', { bubbles: false, relatedTarget: other }));
    a.runRow('insert-date');
    expect(a.asked, '探す欄から別の所へ移ったのに控えが残った').toEqual([]);

    const b = setup();
    b.leaveRowTo(b.filter);
    const listBtn = document.createElement('button');
    listBtn.setAttribute('data-pkc-action', 'run-command-row');
    b.root.append(listBtn);
    b.filter.dispatchEvent(new FocusEvent('blur', { bubbles: false, relatedTarget: listBtn }));
    b.runRow('insert-date');
    expect(b.asked, '一覧の行へ移っただけで控えが消えた').toHaveLength(1);
  });

  it('🔴 `>` の一覧の行を押したら、どの命令でも控えを使い切る(次の別の操作が古い控えを拾わない)', () => {
    const a = setup();
    a.leaveRowTo(a.filter);
    a.runRow('renumber-lists'); // 控えを使わない命令
    expect(a.asked, '全文の道具で行を開き直した').toEqual([]);
    reattach(a);
    a.d.dispatch({ type: 'SET_ENTRY_FILTER', query: '>日付' });
    reattach(a);
    a.runRow('insert-date');
    expect(a.asked, '前の操作を素通りした控えで、後の操作が行を開き直した').toEqual([]);
  });

  it('🔴 探す欄が `>` の一覧を出していないなら、控えがあっても開き直さない', () => {
    const a = setup();
    a.d.dispatch({ type: 'SET_ENTRY_FILTER', query: 'ふつうの語' });
    reattach(a);
    a.row.focus();
    a.leaveRowTo(a.filter);
    a.runRow('insert-date');
    expect(a.asked).toEqual([]);
  });
});

/**
 * 🔴 **本物の `RowSwap` と `bindActions` を繋ぐ**(#582 着地前レビュー F6)。
 * ⚠ 上の台は面の側を模している ── 控えた行番号・原文・caret が本物の行の開き直しと噛み合うか(段落 / 箇条書きの項目 /
 *   行数が変わる確定の直後)は、ここでしか見えない。見るのは**入れた字が狙った行の狙った位置に着くこと**。
 */
describe('本物の RowSwap と繋ぐ(#582)', () => {
  function live(body: string, defer = false) {
    document.body.innerHTML = '';
    resetAppDialogForTest();
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    const d = new Dispatcher();
    const refusals: string[] = [];
    const rawDispatch = d.dispatch.bind(d);
    d.dispatch = ((a: Dispatchable) => {
      if (a.type === 'OP_FAILED') refusals.push((a as { error: string }).error);
      return rawDispatch(a);
    }) as typeof d.dispatch;
    bindActions(root, d, {}, new KeymapStore());
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1', 'めも')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
    d.dispatch({ type: 'SET_ENTRY_FILTER', query: '>日付' });
    const detail = document.createElement('div');
    detail.setAttribute('data-pkc-region', 'detail');
    const pane = document.createElement('div');
    pane.setAttribute('data-pkc-region', 'editor-live');
    detail.append(pane);
    // 「日付を入れる」の受け手の代わり: 押した瞬間の caret に字を挿す(本物のボタンと同じく caret を読む)
    const inserted: string[] = [];
    const btn = document.createElement('button');
    btn.setAttribute('data-pkc-action', 'insert-date');
    btn.addEventListener('click', () => {
      const ta = pane.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]');
      if (ta === null) {
        inserted.push('(欄なし)');
        return;
      }
      ta.setRangeText('★', ta.selectionStart, ta.selectionEnd, 'end');
      inserted.push(ta.value);
    });
    detail.append(btn);
    root.append(detail);
    let text = body;
    let queued: string | null = null;
    const render = (t: string): void => {
      const { html, ranges } = renderMarkdownWithRanges(t);
      swap.update(t, html, ranges);
    };
    const swap = new RowSwap(pane, {
      commit: (s, e, t) => {
        const lines = text.split('\n');
        text = [...lines.slice(0, s), ...t.split('\n'), ...lines.slice(e + 1)].join('\n');
        if (defer) queued = text;
        else render(text);
      },
      onInserted: () => {},
    });
    render(text);
    const filter = root.querySelector<HTMLInputElement>('[data-pkc-field="entry-filter"]')!;
    const rowTa = (): HTMLTextAreaElement | null => pane.querySelector('[data-pkc-field="row-source"]');
    /** 行を開いて caret を置き、探す欄へ移り、一覧の「日付を入れる」を押す。 */
    const openThenCallFromLeft = (target: Element, at: number): void => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }));
      const ta = rowTa()!;
      expect(ta, '前提: 行が開かない').not.toBeNull();
      ta.setSelectionRange(at, at);
      return void ta;
    };
    const leaveToFilterAndRun = (): void => {
      const ta = rowTa()!;
      ta.dispatchEvent(new FocusEvent('blur', { bubbles: false, relatedTarget: filter })); // capture が控え、行自身の blur が確定
      const b = document.createElement('button');
      b.setAttribute('data-pkc-action', 'run-command-row');
      b.setAttribute('data-pkc-command', 'insert-date');
      root.append(b);
      b.click();
      b.remove();
    };
    return {
      pane,
      refusals,
      inserted,
      rowTa,
      openThenCallFromLeft,
      leaveToFilterAndRun,
      body: () => text,
      flush: () => {
        if (queued !== null) {
          const t = queued;
          queued = null;
          render(t);
        }
      },
    };
  }
  const pOf = (pane: HTMLElement, t: string): Element =>
    [...pane.querySelectorAll('p')].find((e) => e.textContent?.includes(t))!;
  const liOf = (pane: HTMLElement, t: string): Element =>
    [...pane.querySelectorAll('li')].find((e) => e.textContent?.includes(t))!;

  it('段落の行: 途中の caret の位置に入る', () => {
    const l = live('# 題\n\nhello world\n\n最後');
    l.openThenCallFromLeft(pOf(l.pane, 'hello'), 5);
    l.leaveToFilterAndRun();
    expect(l.inserted).toEqual(['hello★ world']);
    expect(l.rowTa()!.value).toBe('hello★ world');
  });

  it('箇条書きの 2 つ目の項目: その項目の caret の位置に入る(他の項目は動かない)', () => {
    const l = live('- [ ] 一つめ\n- [ ] 二つめ\n- [ ] 三つめ');
    l.openThenCallFromLeft(liOf(l.pane, '二つめ'), 8);
    expect(l.rowTa()!.value, '前提: 項目だけが開いていない').toBe('- [ ] 二つめ');
    l.leaveToFilterAndRun();
    expect(l.inserted).toEqual(['- [ ] 二つ★め']);
    expect(l.body()).toBe('- [ ] 一つめ\n- [ ] 二つめ\n- [ ] 三つめ');
  });

  it('🔴 予約中に別の行が開かれて予約が捨てられたら、黙らず「欄が変わった」で断る(押したのに無反応にしない)', () => {
    const l = live('# 題\n\nhello\n\n最後', true);
    l.openThenCallFromLeft(pOf(l.pane, 'hello'), 5);
    const ta = l.rowTa()!;
    ta.value = 'hello\nworld';
    l.leaveToFilterAndRun(); // 行数が変わる確定 → 予約
    expect(l.refusals, '予約に回っていない(前提)').toEqual([]);
    // 着弾前に別の塊を開く(予約は用済みとして捨てられる)
    pOf(l.pane, '最後').dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }));
    expect(l.refusals).toEqual([FIELD_CHANGED]);
    expect(l.inserted, '断ったのに入れた').toEqual([]);
  });

  it('🔴 行数が変わる確定の直後(描き直しが着弾する前)でも、着弾後に狙った行の caret に入る', () => {
    const l = live('# 題\n\nhello\n\n最後', true);
    l.openThenCallFromLeft(pOf(l.pane, 'hello'), 5);
    const ta = l.rowTa()!;
    ta.value = 'hello\nworld'; // 打って行数が増えた
    ta.setSelectionRange(11, 11);
    l.leaveToFilterAndRun();
    expect(l.inserted, '着弾前に押した(古い座標の行へ入る)').toEqual([]);
    l.flush();
    expect(l.inserted, '着弾後に入っていない').toEqual(['hello\nworld★']);
    expect(l.body()).toBe('# 題\n\nhello\nworld\n\n最後');
  });
});
