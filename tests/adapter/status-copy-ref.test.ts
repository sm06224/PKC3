/** @vitest-environment happy-dom */
/**
 * PDF を新しい添付にした知らせの隣に「参照をコピー」を出す(#1626 の 4。Gemini 裁定 = #1163 の依頼 34 の Q4)。
 *
 * 守るのは:
 * ① 器が押し口を持ち、受け手 `copy-entry-ref`(右の列・右クリックの「参照をコピー」と同じ 1 本)へ繋がっている
 * ② 🔴 実際に出る保存の知らせ(`save-edited.ts` が組む字)の間だけ出る ── 別の知らせが上書きしたら畳む(対照群つき)
 * ③ 🔴 押すと、その添付の参照(`[題名](entry:…)`)がコピーされる
 * ④ main.ts が、押し口の出し入れを「開く」と同じ口で配線している(原文 pin。「開く」と同じ条件で自動消去を止める)
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { paintStatusCopyRef } from '../../src/adapter/ui/render/status-open';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { PDF_SAVED_NOTICE_TAIL } from '../../src/features/pdf/pdf-attachments';

afterEach(() => {
  document.body.textContent = '';
});

const SAVED = '「報告書 (抜き出し).pdf」を元の PDF と同じフォルダの添付に加えました';

describe('PDF の保存の知らせの隣の「参照をコピー」(#1626)', () => {
  it('① 器が押し口を持ち、受け手へ繋がっている(最初は畳んである)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const regions = buildShell(root);
    const b = regions.statusCopyRef;
    expect(b.getAttribute('data-pkc-action'), '受け手の無い口').toBe('copy-entry-ref');
    expect(b.textContent).toBe('参照をコピー');
    expect(b.hidden, '知らせが無いのに出ている').toBe(true);
    expect(regions.status.contains(b), '状態の行の外に居る').toBe(true);
  });

  it('🔴 ② 実際に出る保存の知らせの間だけ出る / 別の知らせが上書きしたら畳む', () => {
    // 前提: 知らせの字は、保存の経路が組む字の終わり(定数)で終わる ── tests/adapter/pdf-save-edited.test.ts が実際の字を pin している
    expect(SAVED.endsWith(PDF_SAVED_NOTICE_TAIL)).toBe(true);

    const b = document.createElement('button');
    b.hidden = true;
    const state = { noticeOpen: 'NEW1', selectedLid: 'ORIG', notice: SAVED };
    expect(paintStatusCopyRef(b, state, SAVED), '保存の知らせの隣に出ていない').toBe(true);
    expect(b.hidden).toBe(false);
    expect(b.getAttribute('data-pkc-entry'), '押し先の添付を運んでいない').toBe('NEW1');
    // 貼る先は別のノートなので、その添付を開いていても出す(「開く」は畳む)
    expect(paintStatusCopyRef(b, { ...state, selectedLid: 'NEW1' }, SAVED)).toBe(true);
    // 対照群 ── 別の知らせ(開く身元は残っている)・身元が無い・字が上書きされた
    expect(paintStatusCopyRef(b, { ...state, notice: '「x.pdf」を添付にしました' }, '「x.pdf」を添付にしました')).toBe(false);
    expect(b.hidden, '別の知らせの隣に残っている').toBe(true);
    expect(b.hasAttribute('data-pkc-entry'), '古い押し先が残っている').toBe(false);
    expect(paintStatusCopyRef(b, { ...state, noticeOpen: null }, SAVED)).toBe(false);
    expect(paintStatusCopyRef(b, state, 'コピーしました')).toBe(false);
  });

  it('🔴 ③ 押すと、その添付の参照がコピーされる(開いているノートではなく、知らせの添付)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const d = new Dispatcher();
    const regions = buildShell(root);
    const copied: string[] = [];
    bindActions(root, d, { copyText: (t: string) => void copied.push(t) });
    d.dispatch({
      type: 'SYS_BOOTED',
      cid: 'c1',
      metas: [
        {
          lid: 'NEW1',
          title: '報告書 (抜き出し).pdf',
          archetype: 'attachment',
          createdAt: null,
          updatedAt: null,
          entryOrder: 1,
          status: null,
          date: null,
          archived: false,
          bodyChars: null,
        },
      ],
      relations: [],
    });
    d.dispatch({ type: 'OP_NOTICE', message: SAVED, open: 'NEW1' });
    const b = regions.statusCopyRef;
    paintStatusCopyRef(b, d.getState(), SAVED);
    expect(b.hidden, '前提: 出ていない').toBe(false);
    b.click();
    expect(copied.length, '押してもコピーされない').toBe(1);
    expect(copied[0]).toContain('entry:NEW1');
  });

  it('⚠ ④ main.ts が「開く」と同じ口で出し入れしている(原文 pin)', () => {
    const code = readFileSync('src/main.ts', 'utf-8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).toContain('paintStatusCopyRef(regions.statusCopyRef, dispatcher.getState(), shown)');
    // 出ている間は自動で消さない(消すと、押す前に機会が無くなる)
    expect(code).toContain('return open || undo || create || copyRef;');
  });
});
