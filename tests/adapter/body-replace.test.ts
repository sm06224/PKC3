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
    expect(d.getState().error, '見つからなかったことを言っていない').toContain('見つかりません');
  });

  it('置き換えたら件数を言う', () => {
    const { root, d } = editing('ログ ログ\n');
    d.dispatch({ type: 'START_EDIT' });
    fill(root, 'ログ', '記録');
    press(root, 'replace-all');
    expect(d.getState().error).toContain('2 件');
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
      const ta = root.querySelector<HTMLTextAreaElement>('[data-pkc-field="row-source"]');
      if (ta !== null) {
        ta.value += 'X';
        ta.blur();
        await tick();
      }
      const body = d.getState().openBody?.body ?? '';
      expect(body, '置換が消えた').toContain('記録一行目');
      expect(body).toContain('記録二行目');
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

    it('🔴 取り消し(Ctrl+Z)で置換の前へ戻れる', async () => {
      const { root, d } = editingWith('ログ\n');
      await tick();
      replaceAllIn(root, 'ログ', '記録');
      await tick(60);
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }),
      );
      expect(d.getState().openBody?.body).toBe('ログ\n');
    });
  });
});
