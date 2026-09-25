/** @vitest-environment happy-dom */
/**
 * 🔴 **押せないときの断り文は、画面に在るボタンの字で出口を言う**(C11 / #1045)。
 *
 * 直す前は「いま押せない理由」の字が **4 通り**に割れていた:
 *
 * | どこ | 出口の言い方 |
 * |---|---|
 * | 右の列の上の 1 行(`EDITING_NOTE`) | 保存するか、**キャンセル**すると |
 * | 右の列のボタンに乗せたときの字(`phaseDisabledNote`) | **確定**するか**取り消して** |
 * | 集計を開けないとき / スマホの戻る / 印刷 / 外からの書込 | 保存するか**取り消して** / **確定**するか**取り消して** |
 * | 保存に失敗して止まったとき | 保存をやり直すか**取り消して** |
 *
 * ⚠ 「確定」「取り消し」は**画面のどのボタンの字でもない**。しかも保存に失敗して
 *   止まったときは、取り消し(`CANCEL_EDIT`)は断られる ── **押せない出口を案内していた**。
 *
 * 🔑 だから期待値を**手で書かない**。描いた画面からボタンの字を引き、断り文が
 *   それを含むことを見る(ボタンの名前を変えた日に、断り文を置き去りにしたら落ちる)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import {
  blockedActionNote,
  EDITING_NOTE,
  phaseBlockReason,
} from '../../src/adapter/state/app-state';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { DetailRenderer } from '../../src/adapter/ui/render/detail';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { codeOnly } from '../helpers/code-only';

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 'あ',
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

beforeEach(() => {
  document.body.textContent = '';
});

function mounted() {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const d = new Dispatcher();
  const regions = buildShell(root);
  const detail = new DetailRenderer(regions.detail);
  const inspector = new InspectorRenderer(regions.inspector);
  d.onState((s) => {
    detail.render(s);
    inspector.render(s);
  });
  bindActions(root, d);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
  d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body: '本文\n' });
  return { root, d };
}

/** ボタンの字(図案の器を除いた、読める字)。 */
function labelOf(root: HTMLElement, action: string): string {
  const b = root.querySelector<HTMLElement>(`[data-pkc-region="detail"] [data-pkc-action="${action}"]`);
  expect(b, `本文の面に ${action} のボタンが無い(前提が崩れた)`).not.toBeNull();
  const label = b!.querySelector('[data-pkc-field="label"]')?.textContent ?? b!.textContent ?? '';
  expect(label.trim(), `${action} のボタンに字が無い`).not.toBe('');
  return label.trim();
}

/** 保存に失敗して止まった状態(守るべき未達 commit が在るときだけ立つ ── その順で作る)。 */
function toSaveFailed(d: Dispatcher): void {
  d.dispatch({ type: 'START_EDIT' });
  d.dispatch({ type: 'UPDATE_OPEN_BODY', body: '本文 2\n' });
  d.dispatch({ type: 'COMMIT_EDIT' });
  d.dispatch({ type: 'SYS_ERROR', error: 'disk' });
  expect(d.getState().phase, '前提が崩れている(error phase になっていない)').toBe('error');
}

describe('🔴 断り文の出口は、描いた画面のボタンの字で言う(C11)', () => {
  it('編集中 ── 「保存」「キャンセル」の字を含む', () => {
    const { root, d } = mounted();
    d.dispatch({ type: 'START_EDIT' });
    const save = labelOf(root, 'commit-edit');
    const cancel = labelOf(root, 'cancel-edit');
    for (const text of [EDITING_NOTE, blockedActionNote('editing')!]) {
      expect(text, '出口が画面のボタンの字と違う').toContain(save);
      expect(text, '出口が画面のボタンの字と違う').toContain(cancel);
    }
  });

  it('保存に失敗して止まったとき ── 画面に在る唯一の出口「再保存」の字を含み、「取り消し」を言わない', () => {
    const { root, d } = mounted();
    toSaveFailed(d);
    const retry = labelOf(root, 'retry-persist');
    // ⚠ 対照群 ── この phase では取り消しが本当に効かない(だから案内してはいけない)
    expect(root.querySelector('[data-pkc-action="cancel-edit"]'), '取り消しのボタンが出ている').toBeNull();
    d.dispatch({ type: 'CANCEL_EDIT' });
    expect(d.getState().phase, '取り消しが効いた(前提が崩れた)').toBe('error');
    for (const text of [blockedActionNote('error')!, phaseBlockReason('error')!]) {
      expect(text, '押せる出口を言っていない').toContain(retry);
      expect(text, '押せない出口を案内している').not.toContain('取り消');
    }
  });

  it('🔴 右の列 ── 乗せたときの字は、列の上の 1 行と同じ字で理由を言う', () => {
    const { root, d } = mounted();
    d.dispatch({ type: 'START_EDIT' });
    const line = root.querySelector<HTMLElement>('[data-pkc-field="inspector-editing-note"]');
    expect(line?.hidden, '列の上の 1 行が出ていない(前提が崩れた)').toBe(false);
    const said = line!.textContent ?? '';
    const locked = [
      ...root.querySelectorAll<HTMLButtonElement>('[data-pkc-region="inspector"] button:disabled'),
    ].filter((b) => b.title !== '');
    // ⚠ 空振り防止 ── 押せないボタンが 1 つも無ければ、下の loop は何も見ていない
    expect(locked.length, '押せないボタンが見つからない(前提が崩れた)').toBeGreaterThanOrEqual(5);
    for (const b of locked) {
      const reason = b.title.split('\n').at(-1);
      expect(reason, `${b.getAttribute('data-pkc-action')} の乗せたときの字が列の上の 1 行と違う`).toBe(
        said,
      );
      expect(b.title, '理由を括弧で二重に包んでいる').not.toMatch(/\([^)]*\(/);
    }
  });

  it('保存に失敗して止まったときも、右の列の 2 つの字は揃う', () => {
    const { root, d } = mounted();
    toSaveFailed(d);
    const said =
      root.querySelector<HTMLElement>('[data-pkc-field="inspector-editing-note"]')?.textContent ?? '';
    expect(said, '列の上の 1 行が phase の字を言っていない').toBe(blockedActionNote('error'));
    const locked = [
      ...root.querySelectorAll<HTMLButtonElement>('[data-pkc-region="inspector"] button:disabled'),
    ].filter((b) => b.title !== '');
    expect(locked.length).toBeGreaterThanOrEqual(5);
    for (const b of locked) expect(b.title.split('\n').at(-1)).toBe(said);
  });
});

/**
 * 🔴 **画面のどのボタンの字でもない出口を、コードに戻さない**。
 * ⚠ 見るのは**コードだけ**(`codeOnly`)── 直した経緯を書いた注釈に満たされないように。
 */
describe('🔴 「確定」「取り消し」で出口を言う断り文が src に戻っていない(C11)', () => {
  const FORBIDDEN = [
    '確定するか取り消して',
    '保存するか取り消して',
    '保存するか、取り消して',
    'やり直すか取り消して',
    '編集を取り消して',
  ];
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
  }
  const files = walk(join(__dirname, '../../src'));

  it('空振り防止 ── src の .ts を読めている', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('0 件', () => {
    const hits: string[] = [];
    for (const f of files) {
      const code = codeOnly(readFileSync(f, 'utf8'));
      for (const w of FORBIDDEN) if (code.includes(w)) hits.push(`${f}: ${w}`);
    }
    expect(hits).toEqual([]);
  });
});

/**
 * 🔴 **C11b(#1045)── 手書きの「編集を終了してから」/「編集を終えてから」を
 *   `phaseBlockReason` へ寄せた**。
 *
 * 直す前は src の**約 62 か所**が前置きを手で書いており、その多くは
 * `phase !== 'ready'` で断っていた ── だから**保存に失敗して止まっているとき
 * (編集していない)にも「編集を終了してから」と言っていた**(#516 と同じ
 * 「存在しない編集を探させる」誤り)。
 *
 * 🔑 寄せなかったのは 2 か所だけ ── **等値で pin する**(直したら消さないと
 * 落ちる形)。理由はそれぞれの file に書いてある:
 * - `capture.ts` ── 「編集中は取り込めません。」という**別の一文**が先に在り、
 *   前置きだけ差し替えても文全体の一致は保てない(状態を 2 重に語る文)
 * - `view-window.ts` ── ここには `phase` が届いていない(`landed: boolean`
 *   しか無く、`SET_VIEW_MODE` の条件を辿ってようやく `'editing'` だと分かる)
 */
describe('🔴 手書きの前置きは phaseBlockReason へ寄せてある(C11b / #1045)', () => {
  const PHRASES = ['編集を終了してから', '編集を終えてから'] as const;
  /** `phaseBlockReason` 自身の定義(ここが「1 か所」の本体。除外してよい)。 */
  const DEFINITION_FILE = 'src/adapter/state/app-state.ts';
  /** 寄せなかった 2 か所(理由は上のコメント)。ここだけ手書きの前置きが残ってよい。 */
  const KNOWN_KEPT: Record<string, string> = {
    'src/adapter/ui/actions/capture.ts': '編集を終えてから',
    'src/adapter/platform/view-window.ts': '編集を終えてから',
  };

  function walkTs(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walkTs(p, out);
      else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
  }
  const srcRoot = join(__dirname, '../../src');
  const files = walkTs(srcRoot);
  const relOf = (f: string): string => `src${f.slice(srcRoot.length)}`.replace(/\\/g, '/');

  it('空振り防止 ── src の .ts を読めている', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('この 1 か所(定義)と既知の 2 か所を除いて、src のコードに残っていない', () => {
    const hits: string[] = [];
    for (const f of files) {
      const rel = relOf(f);
      const code = codeOnly(readFileSync(f, 'utf8'));
      for (const phrase of PHRASES) {
        if (!code.includes(phrase)) continue;
        if (rel === DEFINITION_FILE && phrase === '編集を終了してから') continue;
        if (KNOWN_KEPT[rel] === phrase) continue;
        hits.push(`${rel}: ${phrase}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('既知リストの 2 か所は、いまも実在する(消えたら KNOWN_KEPT を更新する合図)', () => {
    for (const [rel, phrase] of Object.entries(KNOWN_KEPT)) {
      const code = codeOnly(readFileSync(join(__dirname, '../..', rel), 'utf8'));
      expect(code.includes(phrase), `${rel} に「${phrase}」が見つからない`).toBe(true);
    }
  });
});

/**
 * 🔴 **error の相でも、代表 3 か所が「編集を終了」を言わない(C11b)**。
 *
 * ⚠ 上の門は**字が残っていないこと**しか見ない ── `phaseBlockReason` に
 *   差し替えたつもりで引数を取り違えていても(例: `state.phase` の代わりに
 *   固定の `'editing'` を渡す)、字面の検査は気づけない。ここは**実際に
 *   error 相を作って撃ち**、出てくる字を見る。
 * 🔑 直す前(d0cfaaf)に戻すと、この 3 件は「再保存」を含まず「編集を終了」を
 *   含む形で落ちることを 1 度確かめてある(手順は C11b の実装コメントに記録)。
 */
describe('🔴 保存に失敗して止まったとき ── 代表 3 か所は「再保存」を言い、「編集を終了」を言わない(C11b)', () => {
  /** 押した所を模す ── `data-pkc-action` だけ持つ素のボタン(event delegation で受かる)。 */
  function press(root: HTMLElement, action: string, attrs: Record<string, string> = {}): void {
    const btn = root.ownerDocument.createElement('button');
    btn.setAttribute('data-pkc-action', action);
    for (const [k, v] of Object.entries(attrs)) btn.setAttribute(k, v);
    root.append(btn);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    btn.remove();
  }

  const SITES: ReadonlyArray<{ action: string; attrs?: Record<string, string> }> = [
    { action: 'delete-entry' },
    { action: 'rename-entry-begin' },
    { action: 'restore-revision', attrs: { 'data-pkc-rev-id': 'r1' } },
  ];

  for (const { action, attrs } of SITES) {
    it(`${action}`, () => {
      const { root, d } = mounted();
      toSaveFailed(d);
      press(root, action, attrs);
      const err = d.getState().error;
      const retry = labelOf(root, 'retry-persist');
      expect(err, `${action} が押せない理由を出していない(前提が崩れた)`).not.toBe('');
      expect(err, '押せる出口(再保存)を言っていない').toContain(retry);
      expect(err, '存在しない編集を案内している').not.toContain('編集を終了');
      expect(err, '存在しない編集を案内している').not.toContain('編集を終えて');
    });
  }
});
