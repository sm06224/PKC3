/** @vitest-environment happy-dom */
/**
 * 🔴 **右揃えの列(`---:`)の見出しは、✎ の空きを字の左へ回す**(#1264 欠陥 6)。
 *
 * > 画面で起きていたこと: 編集できる見出しは右に `--s3 + 24px`(いちばん右は `+ 48px`)の空きを持つ。
 * > 右揃えの列では見出しの字だけが左へずれ、**真下の数字と右端が合わなかった**。
 *
 * ⚠ 実ブラウザで組んだ位置は見ない(happy-dom は描画しない)── ここは「規則が在って、当たる先が合っていて、
 *   重みが同じ既存規則に**順番で勝っている**」を**構文で**見る(`tests/helpers/css-blocks.ts`)。
 * 🔑 当たる属性は**本物の描画**から読む(`style="text-align:right"` ── 手で綴りを書かない)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';

const css = (): string => withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));

const RIGHT_TH = ".pkc-md-rendered .pkc-md-block th[style*='text-align:right']:has(> .pkc-cell-edit-btn)";
const RIGHT_BTN = ".pkc-md-rendered .pkc-md-block th[style*='text-align:right'] > .pkc-cell-edit-btn";
const LAST_TH = '.pkc-md-rendered .pkc-md-block th:last-child:has(> .pkc-cell-edit-btn)';
const LAST_BTN = '.pkc-md-rendered .pkc-md-block th:last-child > .pkc-cell-edit-btn';

/** 規則の**出てくる順**(選択子リストの丸ごと一致)。同じ重みの規則は後ろが勝つので順番が主張になる。 */
function positionsOf(text: string, sel: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1]!.split(',').map((x) => x.trim().replace(/\s+/g, ' '));
    if (sels.includes(sel)) out.push(m.index);
  }
  return out;
}

describe('右揃えの見出しの ✎ は字の左(#1264 欠陥 6)', () => {
  it('🔴 右揃えの見出しは、空きを左へ置き(start = s3 + 24px / end = s3)、✎ を左に出す', () => {
    const text = css();
    const th = blocksFor(text, RIGHT_TH).join('\n');
    expect(th.length, '右揃えの見出しの規則が無い(空振り)').toBeGreaterThan(0);
    expect(th, '空きを字の左へ置いていない').toMatch(
      decl('padding-inline-start', 'calc\\(var\\(--s3\\) \\+ 24px\\)'),
    );
    expect(th, '右の空きが残っている(字が真下の数字と合わない)').toMatch(
      decl('padding-inline-end', 'var\\(--s3\\)'),
    );
    const btn = blocksFor(text, RIGHT_BTN).join('\n');
    expect(btn.length, '右揃えの ✎ の規則が無い(空振り)').toBeGreaterThan(0);
    expect(btn, '✎ を左へ出していない').toMatch(decl('left', 'var\\(--s2\\)'));
    expect(btn, '✎ の右の指定が残っている(左右の両方に張り付く)').toMatch(decl('right', 'auto'));
  });

  it('🔴 同じ重みの「いちばん右の列」の規則より、後ろに在る(右揃えの最後の列も左へ回る)', () => {
    const text = css();
    for (const [mine, last] of [
      [RIGHT_TH, LAST_TH],
      [RIGHT_BTN, LAST_BTN],
    ] as const) {
      const a = positionsOf(text, mine);
      const b = positionsOf(text, last);
      expect(a.length, `${mine} が無い`).toBe(1);
      expect(b.length, `対照群: ${last} が消えた(前提が変わった)`).toBe(1);
      expect(a[0]!, '右揃えの規則が最後の列の規則より前に在る ── 重みが同じなので負ける').toBeGreaterThan(b[0]!);
    }
  });

  it('⚠ 対照群: 他の列は今のまま(右へ空け、いちばん右はさらに +48px、✎ は右)', () => {
    const text = css();
    const base = blocksFor(text, '.pkc-md-rendered th:has(> .pkc-cell-edit-btn)').join('\n');
    expect(base, '基底の右の空きが変わった').toMatch(
      decl('padding-inline-end', 'calc\\(var\\(--s3\\) \\+ 24px\\)'),
    );
    expect(blocksFor(text, LAST_TH).join('\n'), '最後の列の空きが変わった').toMatch(
      decl('padding-inline-end', 'calc\\(var\\(--s3\\) \\+ 24px \\+ 48px\\)'),
    );
    expect(blocksFor(text, '.pkc-md-rendered .pkc-cell-edit-btn').join('\n'), '✎ の基底が右でなくなった').toMatch(
      decl('right', 'var\\(--s2\\)'),
    );
    // 右揃えの規則が、寄せの無い・左・中央の見出しに当たる綴りになっていない
    for (const sel of [RIGHT_TH, RIGHT_BTN]) {
      expect(sel, '当たる先が「右揃え」だけでない').toContain("[style*='text-align:right']");
    }
  });

  it('🔴 当たる属性は、本物の描画が右揃えの見出しにだけ焼く(`---:` だけ。左・中央・寄せ無しは焼かない)', () => {
    const html = renderMarkdown('| 左 | 右 | 中 | 無 |\n|:---|---:|:---:|---|\n| a | 1 | b | c |\n', {
      sourceLineAnchors: true,
      interactiveCells: true,
    } as never);
    const host = document.createElement('div');
    host.innerHTML = html;
    const heads = [...host.querySelectorAll<HTMLElement>('th')];
    expect(heads.length, '前提: 見出しが 4 つ描かれていない').toBe(4);
    const hits = heads.map((th) => th.matches("[style*='text-align:right']"));
    expect(hits, '右揃えの見出しだけが当たる').toEqual([false, true, false, false]);
    for (const th of heads) {
      expect(th.querySelector('.pkc-cell-edit-btn'), '前提: ✎ が焼かれていない').not.toBeNull();
    }
  });
});
