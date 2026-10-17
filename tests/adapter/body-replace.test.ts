/** @vitest-environment happy-dom */
/**
 * 本文の置換(#191 / 台帳 #180 の B-3)。
 *
 * 🔴 守る主張:
 * 1. 素の文字列で当てる(正規表現にしない ── `.` を打った瞬間に全部に当たらない)
 * 2. 置換語が検索語を含んでいても暴走しない
 * 3. 大小を無視して当てても、**原文の他の部分は 1 文字も変わらない**
 * 4. 空の検索語では**何もしない**(本文が置換語で埋まる事故を先に止める)
 * 5. **編集中だけ**効く / **0 件でも黙らない**(dead click を作らない)
 * 6. 帯は打鍵で消えない場所に在る(検索語が描き直しで消えない)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countMatches, replaceAll } from '../../src/features/markdown/body-replace';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { CenterRouter } from '../../src/adapter/ui/render/center';
import { attachmentBody } from '../../src/features/flavor/attachment-flavor';
import { foldAttachmentHead } from '../../src/features/flavor/attachment-edit-fold';

describe('置換の規則(純関数)', () => {
  it('🔴 正規表現ではなく素の文字列で当てる', () => {
    expect(countMatches('a.b axb', '.')).toBe(1);
    expect(replaceAll('a.b axb', '.', '-').body).toBe('a-b axb');
  });

  it('🔴 置換語が検索語を含んでも暴走しない', () => {
    expect(replaceAll('aaa', 'a', 'aa')).toEqual({ body: 'aaaaaa', count: 3 });
  });

  it('🔴 大小無視でも原文の他の部分は変わらない', () => {
    const r = replaceAll('Log log LOG のログ', 'log', '記録');
    expect(r.count).toBe(3);
    expect(r.body, '当たっていない所まで書き換わった').toBe('記録 記録 記録 のログ');
  });

  it('🔴 当たっていない所の大小が保たれる(写しから切り出さない)', () => {
    // ⚠ 変異試験 M4 が生き延びて判明 ── 比較用の小文字化した写しから切り出しても、
    //    **周りが小文字ばかりの本文では違いが出ない**。大文字を周囲に置いて初めて鳴る
    expect(replaceAll('ABC log XYZ', 'log', '記録').body).toBe('ABC 記録 XYZ');
  });

  it('大小を区別する指定も効く', () => {
    expect(replaceAll('Log log', 'log', 'x', { caseSensitive: true })).toEqual({
      body: 'Log x',
      count: 1,
    });
  });

  it('🔴 空の検索語では何もしない(本文が埋まらない)', () => {
    expect(countMatches('abc', '')).toBe(0);
    expect(replaceAll('abc', '', 'X')).toEqual({ body: 'abc', count: 0 });
  });

  it('日本語も数えられる', () => {
    expect(countMatches('ログとろぐとログ', 'ログ')).toBe(2);
  });

  it('見つからなければ本文を返す(同じ文字列)', () => {
    const body = '## 2026-08-15 10:00:00\n\n作業した\n';
    expect(replaceAll(body, '存在しない', 'x')).toEqual({ body, count: 0 });
  });
});

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'textlog',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

describe('置換の配線', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  /**
   * ⚠ **本文の面まで描く**(2026-08-15)── 置換の切替は**編集の帯**へ移したので、
   * 器を組んだだけでは画面に出ない。`CenterRouter` を繋いで**実際に編集へ入る**。
   * 🔑 これは規律どおりでもある: 押す物が在る状態で押す(dispatch で近道しない)。
   */
  function editing(body: string) {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const center = new CenterRouter(regions.detail);
    d.onState((st) => center.render(st));
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1')], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
    return { root, d };
  }

  const fill = (root: HTMLElement, find: string, replace: string) => {
    root.querySelector<HTMLInputElement>('[data-pkc-field="replace-find"]')!.value = find;
    root.querySelector<HTMLInputElement>('[data-pkc-field="replace-with"]')!.value = replace;
  };
  const press = (root: HTMLElement, action: string) =>
    root.querySelector<HTMLButtonElement>(`[data-pkc-action="${action}"]`)!.click();

  it('🔴 編集中に押すと本文が実際に変わる', () => {
    const { root, d } = editing('## 2026-08-15 10:00:00\n\nログを書いた\n');
    d.dispatch({ type: 'START_EDIT' });
    fill(root, 'ログ', '記録');
    press(root, 'replace-all');
    expect(d.getState().openBody?.body, '押しても本文が変わらない').toContain('記録を書いた');
  });

  it('🔴 編集していないときは本文を書き換えない', () => {
    const { root, d } = editing('ログ\n');
    fill(root, 'ログ', '記録');
    press(root, 'replace-all');
    expect(d.getState().openBody?.body, '読んでいるだけなのに書き換わった').toBe('ログ\n');
  });

  it('🔴 0 件でも黙らない(押して無反応にしない)', () => {
    const { root, d } = editing('ログ\n');
    d.dispatch({ type: 'START_EDIT' });
    fill(root, '存在しない語', 'x');
    press(root, 'replace-all');
    expect(d.getState().notice, '見つからなかったことを言っていない').toContain('見つかりません');
  });

  it('置き換えたら件数を言う', () => {
    const { root, d } = editing('ログ ログ\n');
    d.dispatch({ type: 'START_EDIT' });
    fill(root, 'ログ', '記録');
    press(root, 'replace-all');
    expect(d.getState().notice).toContain('2 件');
  });

  it('🔴 置き換えた知らせはエラーの行に入れない(「エラー: 2 件を置き換えました」にしない)', () => {
    const { root, d } = editing('ログ ログ\n');
    d.dispatch({ type: 'START_EDIT' });
    expect(d.getState().error, '前提:始める前にエラーは出ていない').toBeNull();
    fill(root, 'ログ', '記録');
    press(root, 'replace-all');
    expect(d.getState().error, '成功したのにエラーの行に入った').toBeNull();
    fill(root, '存在しない語', 'x');
    press(root, 'replace-all');
    expect(d.getState().error, '見つからなかっただけでエラーの行に入った').toBeNull();
  });

  it('🔴 編集中でないときに「すべて置換」を押しても黙らない(本文は変えない)', () => {
    const { root, d } = editing('ログ\n');
    expect(d.getState().phase, '前提: 編集中になっている').toBe('ready');
    fill(root, 'ログ', 'x');
    press(root, 'replace-all');
    expect(d.getState().openBody?.body, '編集中でないのに本文を変えた').toBe('ログ\n');
    expect(d.getState().error).toBe('「すべて置換」は編集中のノートでだけ使えます(「ノートを編集する」を押してから)');
  });

  it('🔴 探す語が空なら、空の鉤括弧ではなく何を入れるかを言う', () => {
    const { root, d } = editing('ログ\n');
    d.dispatch({ type: 'START_EDIT' });
    fill(root, '', 'x');
    press(root, 'replace-all');
    expect(d.getState().notice).toBe('探す語を入れてください');
    expect(d.getState().openBody?.body, '空の語で本文が変わった').toBe('ログ\n');
  });

  it('🔴 帯は既定で畳まれ、押すと開いて探す欄に焦点が来る', () => {
    const { root, d } = editing('ログ\n');
    const bar = root.querySelector<HTMLElement>('[data-pkc-region="replace-bar"]')!;
    expect(bar.hidden, '常に居座っている').toBe(true);
    // ⚠ 切替は**編集の帯**に在る(閲覧中は押せない導線を置かない)
    expect(
      root.querySelector('[data-pkc-action="toggle-replace"]'),
      '閲覧中なのに置換の切替が出ている',
    ).toBeNull();
    d.dispatch({ type: 'START_EDIT' });
    press(root, 'toggle-replace');
    expect(bar.hidden).toBe(false);
    expect(
      document.activeElement?.getAttribute('data-pkc-field'),
      '開いたのに打てない(焦点が来ていない)',
    ).toBe('replace-find');
    press(root, 'toggle-replace');
    expect(bar.hidden, 'もう一度押しても閉じない').toBe(true);
  });

  it('🔴 Ctrl+H が同じボタンを押す(編集中)', () => {
    const { root, d } = editing('ログ\n');
    d.dispatch({ type: 'START_EDIT' });
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(
      root.querySelector<HTMLElement>('[data-pkc-region="replace-bar"]')!.hidden,
      'Ctrl+H で開かない',
    ).toBe(false);
  });

  it('🔴 帯は本文の面の外に在る(打鍵の描き直しで検索語が消えない)', () => {
    const { root } = editing('ログ\n');
    const bar = root.querySelector<HTMLElement>('[data-pkc-region="replace-bar"]')!;
    expect(
      bar.closest('[data-pkc-region="detail"]'),
      '本文の面の中に在る(描き直しで打ちかけが消える置き方)',
    ).toBeNull();
    expect(bar.closest('[data-pkc-region="center"]')).not.toBeNull();
  });
});

/**
 * 🔴 **「すべて置換」の結果が、編集欄に映る**(#1579)。
 *
 * 症状:置換すると state の本文だけが変わり、編集欄(textarea / 1 面の行の元)は古い字のまま。
 * そのまま 1 字打つと古い全文が state へ戻り、**置換が黙って消えた**。
 * 🔑 見るのは「欄の値」と「置換の後に打った結果」── state だけ見ると、直す前も緑になる。
 */
describe('🔴 置換の結果が編集欄へ映る(#1579)', () => {
  const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
  const ATT = attachmentBody({ name: 'a.pdf', mime: 'application/pdf', size: 1, assetKey: 'ast-1' });

  function editingWith(body: string, archetype: EntryMeta['archetype'] = 'textlog') {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const center = new CenterRouter(regions.detail, undefined, null, undefined, (b) =>
      d.dispatch({ type: 'UPDATE_OPEN_BODY', body: b }),
    );
    d.onState((st) => center.render(st));
    bindActions(root, d);
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [{ ...meta('n1'), archetype }], relations: [] });
    d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
    d.dispatch({ type: 'BODY_LOADED', lid: 'n1', body });
    d.dispatch({ type: 'START_EDIT' });
    return { root, d };
  }
  const replaceAllIn = (root: HTMLElement, find: string, to: string) => {
    root.querySelector<HTMLInputElement>('[data-pkc-field="replace-find"]')!.value = find;
    root.querySelector<HTMLInputElement>('[data-pkc-field="replace-with"]')!.value = to;
    root.querySelector<HTMLButtonElement>('[data-pkc-action="replace-all"]')!.click();
  };

  afterEach(() => localStorage.removeItem('pkc3.editor-mode'));

  describe('2 列(設定 split)', () => {
    beforeEach(() => localStorage.setItem('pkc3.editor-mode', 'split'));

    it('🔴 欄の値が置換後になり、続けて打っても置換が残る', () => {
      const { root, d } = editingWith('ログを書いた。ログ。\n');
      replaceAllIn(root, 'ログ', '記録');
      const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
      expect(ta.value, '欄が古い字のまま').toBe('記録を書いた。記録。\n');
      ta.value += 'X';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      expect(d.getState().openBody?.body, '打ったら置換が消えた').toBe('記録を書いた。記録。\nX');
    });

    it('🔴 打鍵の echo では欄へ書き戻さない(value の代入 0 回・カーソルも動かない)', () => {
      const { root, d } = editingWith('abc\n');
      const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
      const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
      let writes = 0;
      Object.defineProperty(ta, 'value', {
        configurable: true,
        get: () => desc.get!.call(ta) as string,
        set: (v: string) => {
          writes += 1;
          desc.set!.call(ta, v);
        },
      });
      for (const c of 'あいうえお') {
        // テスト自身の代入は数えない(本物の setter を直に呼ぶ)
        desc.set!.call(ta, desc.get!.call(ta) + c);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      expect(writes, '打鍵のたびに欄へ書き戻している(カーソルが飛ぶ)').toBe(0);
      expect(d.getState().openBody?.body).toBe('abc\nあいうえお');
      ta.setSelectionRange(2, 2);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      expect(ta.selectionStart).toBe(2);
    });

    it('🔴 続けて 2 回置換しても、2 回目の結果が欄に出る(元へ戻す置換でも)', () => {
      const { root } = editingWith('ログ\n');
      replaceAllIn(root, 'ログ', '記録');
      const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
      expect(ta.value).toBe('記録\n');
      // ⚠ 元の本文へ戻す置換 ── 「前に見た本文」の控えが古いままだと、同じ字に見えて欄が動かない
      replaceAllIn(root, '記録', 'ログ');
      expect(ta.value, '2 回目の置換が欄に出ない').toBe('ログ\n');
    });

    it('🔴 探す語が畳んだ設定の行にだけ当たるときは、何も置換されず設定の行も動かない(#1579 Q1 = A)', () => {
      const { root, d } = editingWith(ATT + '\n説明\n', 'attachment');
      replaceAllIn(root, 'ast-1', 'ast-2');
      expect(d.getState().openBody!.body, '見えない設定の行が書き換わった').toBe(ATT + '\n説明\n');
      expect(d.getState().notice ?? '', '0 件のはずが置換された顔').toContain('見つかりませんでした');
    });

    it('🔴 設定の行と説明の両方に探す語が在っても、説明だけが置換され、件数も説明の分だけ(#1579 Q1 = A)', () => {
      const body = attachmentBody({ name: 'pdf-report.pdf', mime: 'application/pdf', size: 1, assetKey: 'ast-1' }) + '\npdf の説明 pdf\n';
      const { root, d } = editingWith(body, 'attachment');
      expect(body.toLowerCase().split('pdf').length - 1, '前提:設定の行にも当たる語').toBeGreaterThan(2);
      replaceAllIn(root, 'pdf', 'PDF');
      const after = d.getState().openBody!.body;
      const head = foldAttachmentHead(body)!.head;
      expect(after.startsWith(head), '設定の行が 1 byte でも動いた').toBe(true);
      expect(after.slice(head.length)).toBe('PDF の説明 PDF\n');
      expect(d.getState().notice).toBe('2 件を置き換えました');
    });

    it('対照群:添付でない通常のノートは、先頭の情報の塊にも当たる(従来どおり)', () => {
      const body = '---\ntags: pdf\n---\npdf 本文\n';
      const { root, d } = editingWith(body, 'text');
      replaceAllIn(root, 'pdf', 'PDF');
      expect(d.getState().openBody!.body).toBe('---\ntags: PDF\n---\nPDF 本文\n');
      expect(d.getState().notice).toBe('2 件を置き換えました');
    });

    it('🔴 プレビューも置換後になる', async () => {
      const { root } = editingWith('ログ\n');
      replaceAllIn(root, 'ログ', '記録');
      await tick(60);
      const pv = root.querySelector('[data-pkc-region="editor-preview"]')!;
      expect(pv.textContent).toContain('記録');
      expect(pv.textContent ?? '', 'プレビューが古い').not.toContain('ログ');
    });

    it('🔴 添付ノート:畳んだ設定の行は変わらず、説明だけが置換される', () => {
      const { root, d } = editingWith(ATT + '\nログの説明\n', 'attachment');
      replaceAllIn(root, 'ログ', '記録');
      const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]')!;
      expect(ta.value).toBe('記録の説明\n');
      ta.value += 'X';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const body = d.getState().openBody!.body;
      expect(body.startsWith(ATT + '\n'), '設定の行が変わった').toBe(true);
      expect(body.endsWith('記録の説明\nX')).toBe(true);
      expect(foldAttachmentHead(body)).not.toBeNull();
    });
  });

  describe('1 画面(既定のライブ編集)', () => {
    beforeEach(() => localStorage.setItem('pkc3.editor-mode', 'live'));

    it('🔴 置換の後に全文を開くと置換後の字で、打つと置換が残る', async () => {
      const { root, d } = editingWith('ログを書いた\n');
      await tick();
      replaceAllIn(root, 'ログ', '記録');
      await tick(60);
      const live = root.querySelector('[data-pkc-region="editor-live"]')!;
      expect(live.textContent, '見えている文書が古い').toContain('記録を書いた');
      root.querySelector<HTMLButtonElement>('[data-pkc-field="edit-all"]')!.click();
      const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
      expect(ta.value, '行の元が古い字のまま').toBe('記録を書いた');
      ta.value += 'X';
      ta.blur();
      await tick();
      expect(d.getState().openBody?.body, '打ったら置換が消えた').toContain('記録を書いた');
      expect(d.getState().openBody?.body).toContain('X');
    });

    it('🔴 行を開いたまま置換しても、その行の確定が置換を消さない', async () => {
      const { root, d } = editingWith('ログ一行目\n\nログ二行目\n');
      await tick();
      root.querySelector<HTMLButtonElement>('[data-pkc-field="edit-all"]')!.click();
      expect(root.querySelector('[data-pkc-field="row-source"]')).not.toBeNull();
      replaceAllIn(root, 'ログ', '記録');
      await tick(60);
      // 置換で本文が差し替わると、開いていた行は閉じる(古い行番号へ継ぎ足さないため)
      expect(
        root.querySelector('[data-pkc-field="row-source"]'),
        '置換のあとも古い行の欄が開いたまま',
      ).toBeNull();
      expect(root.querySelector('[data-pkc-region="editor-live"]')!.textContent).toContain('記録一行目');
      // 開き直して打つと、置換の上に積まれる
      root.querySelector<HTMLButtonElement>('[data-pkc-field="edit-all"]')!.click();
      const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
      expect(ta.value).toContain('記録一行目');
      ta.value += 'X';
      ta.blur();
      await tick();
      const body = d.getState().openBody?.body ?? '';
      expect(body, '置換が消えた').toContain('記録一行目');
      expect(body).toContain('記録二行目');
      expect(body).toContain('X');
    });

    it('🔴 行に分けられず原文編集へ退避した欄にも映り、打っても置換が残る', async () => {
      // 行ごとの分割が組めない本文(attachment-edit-fold.test.ts の退避と同じ形)
      const src = [':::figure{id="あ い"}', '', 'ログ本文', '', ':::', '', 'あと', ''].join('\n');
      const { root, d } = editingWith(src);
      await tick(40);
      const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="editor-body"]');
      expect(ta, '退避の欄が出ていない(前提が崩れている)').not.toBeNull();
      replaceAllIn(root, 'ログ', '記録');
      expect(ta!.value, '退避の欄が古い字のまま').toContain('記録本文');
      ta!.value += 'X';
      ta!.dispatchEvent(new Event('input', { bubbles: true }));
      expect(d.getState().openBody?.body, '打ったら置換が消えた').toContain('記録本文');
    });

    it('🔴 置換を押した直後の Ctrl+Z(焦点は「すべて置換」ボタン)で置換の前へ戻れる', async () => {
      const { root, d } = editingWith('ログ\n');
      await tick();
      replaceAllIn(root, 'ログ', '記録');
      await tick(60);
      // ⚠ 撃つ先は document.body ではなく、実際に焦点の在るボタン(実ブラウザで届かなかった)
      const btn = root.querySelector<HTMLElement>('[data-pkc-action="replace-all"]')!;
      btn.focus();
      const ev = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
      btn.dispatchEvent(ev);
      expect(d.getState().openBody?.body, '置換を取り消せない').toBe('ログ\n');
      expect(ev.defaultPrevented).toBe(true);
    });

    it('🔴 探す語の欄の Ctrl+Z は奪わない(欄の取り消しはブラウザ自前)', async () => {
      const { root, d } = editingWith('ログ\n');
      await tick();
      replaceAllIn(root, 'ログ', '記録');
      await tick(60);
      const find = root.querySelector<HTMLInputElement>('[data-pkc-field="replace-find"]')!;
      const ev = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
      find.dispatchEvent(ev);
      expect(d.getState().openBody?.body).toBe('記録\n');
      expect(ev.defaultPrevented).toBe(false);
    });

    it('🔴 置換の帯のボタンで Ctrl+A を押しても「全文を編集」は奪わない', async () => {
      const { root } = editingWith('ログ\n');
      await tick();
      replaceAllIn(root, 'ログ', '記録');
      await tick(60);
      const btn = root.querySelector<HTMLElement>('[data-pkc-action="replace-all"]')!;
      btn.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }),
      );
      expect(root.querySelector('[data-pkc-field="row-source"]'), '帯から全文編集が開いた').toBeNull();
    });

    it('🔴 行の確定は取り消しの履歴に 1 件だけ(置換の echo で空の 1 手が積まれない)', async () => {
      const { root, d } = editingWith('ログ\n');
      await tick();
      root.querySelector<HTMLButtonElement>('[data-pkc-field="edit-all"]')!.click();
      const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]')!;
      ta.value += 'Y';
      ta.blur();
      await tick();
      expect(d.getState().openBody?.body).toBe('ログY\n');
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }),
      );
      expect(d.getState().openBody?.body, '1 回の Ctrl+Z で戻らない(空の履歴が積まれた)').toBe('ログ\n');
    });
  });
});

/**
 * 🔴 **小文字にすると長さが変わる字の後ろでも、正しい箇所を置き換える**(#1087、本文の書換の見直し)。
 * 直す前は写しの添字で原文を切っていたので、`İ`(U+0130。小文字にすると 2 字)の後ろの置換が全部ずれた。
 */
describe('大小無視の置換と、長さが変わる字', () => {
  it('🔴 `İ` の後ろの語を、ずれずに置き換える', () => {
    expect(replaceAll('İstanbul ve Ankara', 'ankara', 'X')).toEqual({ body: 'İstanbul ve X', count: 1 });
  });

  it('🔴 `İ` が何個あっても、ずれが積み重ならない', () => {
    const r = replaceAll('İİİ abc İ ABC', 'abc', 'x');
    expect(r).toEqual({ body: 'İİİ x İ x', count: 2 });
    expect(countMatches('İİİ abc İ ABC', 'abc'), '件数と置換が食い違う').toBe(2);
  });

  it('対照群: 長さが変わらない本文は今までどおり', () => {
    expect(replaceAll('Ankara ankara', 'ANKARA', 'X')).toEqual({ body: 'X X', count: 2 });
  });
});

/**
 * 🔴 **見えていない所は置換の外**(#1087 A2)。直す前は本文の生の文字列全体に当てていたので、
 * `docs` → `manual` でリンクの URL・`entry:` の lid・`asset:` の鍵・前書きの項目名まで書き換わり、リンクや画像が切れた。
 */
describe('置換の外に置く範囲(リンクの宛先 / 参照の語 / 前書きの項目名)', () => {
  it('🔴 URL・ノートの参照・添付の鍵を変えず、見える字だけ変わる', () => {
    const body = [
      '[docs](https://example.com/docs/api)',
      '[n](entry:n1docs-abc)',
      '![i](asset:ab12docs34)',
      'docs の説明',
    ].join('\n');
    const r = replaceAll(body, 'docs', 'manual');
    expect(r.body).toBe(
      [
        '[manual](https://example.com/docs/api)',
        '[n](entry:n1docs-abc)',
        '![i](asset:ab12docs34)',
        'manual の説明',
      ].join('\n'),
    );
    expect(r.count, '画面の「N 件」と実際の置換数がずれた').toBe(2);
    expect(countMatches(body, 'docs')).toBe(2);
  });

  it('🔴 前書きの項目名は変えず、値は置換する(`date` → `day` で日付が外れない)', () => {
    const body = '---\ndate: date 2026\ntags: [a]\n---\n本文 date\n';
    const r = replaceAll(body, 'date', 'day');
    expect(r.body).toBe('---\ndate: day 2026\ntags: [a]\n---\n本文 day\n');
    expect(r.count).toBe(2);
    // 囲みの行そのものも対象外
    expect(replaceAll(body, '---', '+++')).toEqual({ body, count: 0 });
  });

  it('🔴 長さが変わる字(`İ`)を含む本文でも、範囲の外に置く(原文の位置で比べる経路)', () => {
    const body = 'İ [docs](https://x.example/docs) docs';
    const r = replaceAll(body, 'docs', 'manual');
    expect(r).toEqual({ body: 'İ [manual](https://x.example/docs) manual', count: 2 });
    expect(countMatches(body, 'docs')).toBe(2);
  });

  it('コードの中は今どおり置換する(見え方の判断になるので変えない)', () => {
    const body = '`[a](https://docs.example/x)` と\n```\n[b](entry:docs1)\n```\n';
    const r = replaceAll(body, 'docs', 'manual');
    expect(r.body).toBe('`[a](https://manual.example/x)` と\n```\n[b](entry:manual1)\n```\n');
    expect(r.count).toBe(2);
  });

  it('検索語が保護の範囲にかかる当たりは、半端に書き換えない(対照群: 範囲の外は置換する)', () => {
    const body = '[x](entry:abc) と entry: の語';
    // 「y:ab」は参照の語の途中にかかる
    expect(replaceAll(body, 'y:ab', 'Z')).toEqual({ body, count: 0 });
    // 「(entry」は範囲の外で始まり、中で終わる ── 当たりの長さ全体で見る
    expect(replaceAll(body, '(entry', 'Z')).toEqual({ body, count: 0 });
    // 「entry: 」(後ろに何も続かない)は参照ではないので置換する
    expect(replaceAll(body, 'entry: ', 'E ').body).toBe('[x](entry:abc) と E の語');
  });

  /**
   * 大量の組み合わせ(検索語 × 本文の部品 × 大小)── 期待値は実装を参照しない:
   * 守る部分を目印の字へ置き換えた本文で、検索語の出現を数える(数えるのは見える字だけ)。
   */
  const PARTS: Array<{ text: string; guard: string[] }> = [
    { text: '[docs](https://example.com/docs/api)', guard: ['https://example.com/docs/api'] },
    { text: '[n](entry:n1docs-abc)', guard: ['entry:n1docs-abc'] },
    { text: '![i](asset:ab12docs34)', guard: ['asset:ab12docs34'] },
    { text: '<https://example.com/docs>', guard: ['<https://example.com/docs>'] },
    { text: '[ref]: https://x.example/docs/z', guard: ['https://x.example/docs/z'] },
    { text: '<img src="a/docs.png" alt="docs">', guard: ['a/docs.png'] },
    { text: 'see entry:docs1 and pkc://docs/x', guard: ['entry:docs1', 'pkc://docs/x'] },
    { text: '見える docs と DOCS', guard: [] },
  ];
  const TERMS = ['docs', 'DOCS', 'a', 'e', 'https', 'entry', 'asset', 'x', 'api'];

  it('🔴 検索語 × 部品 × 大小: 守る部分は置換前と同じ・件数は見える字だけ', () => {
    let checked = 0;
    let guarded = 0;
    for (const part of PARTS) {
      for (const term of TERMS) {
        for (const cs of [false, true]) {
          const body = `前\n${part.text}\n\n後ろ\n${part.text}\n末`;
          const r = replaceAll(body, term, '@@', { caseSensitive: cs });
          for (const g of part.guard) {
            guarded += 1;
            expect(r.body.split(g).length - 1, `${term}/${cs}: 守る部分 ${g} が変わった`).toBe(2);
          }
          // 期待値は別の観測から:守る部分を目印に替えた本文での出現数
          let masked = body;
          for (const g of part.guard) masked = masked.split(g).join('¶');
          const hay = cs ? masked : masked.toLowerCase();
          const needle = cs ? term : term.toLowerCase();
          const want = hay.split(needle).length - 1;
          expect(r.count, `${part.text} × ${term} × cs=${cs}`).toBe(want);
          expect(countMatches(body, term, { caseSensitive: cs }), '件数と置換が食い違う').toBe(r.count);
          checked += 1;
        }
      }
    }
    // 空振り防止: 部品 × 語 × 大小を全部回し、守る部分を実際に検めた回数が非ゼロ
    expect(checked).toBe(PARTS.length * TERMS.length * 2);
    expect(guarded).toBeGreaterThan(100);
  });
});
