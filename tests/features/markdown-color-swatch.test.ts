/** @vitest-environment happy-dom */
/**
 * 🔴 **バッククォートで囲んだ色コードの左に、色の見本を置く**(#1224)。
 *
 * - 出すのは**インラインコードの中身が `#` + 16 進の 3 / 6 / 8 桁ちょうど**のときだけ
 *   (Gemini 裁定 2026-10-01 Q1 = A: 地の文の `#3b82f6` には出さない)。
 * - 既定は**切**(読む面だけが旗を渡す)── 書き出した HTML・Word・印刷に空の要素を出さない。
 * - 見本は**字を持たない**(`textContent` / 選択 / コピーに入らない ── CLAUDE.md §10)。
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '@features/markdown/markdown-render';

const on = (md: string): string => renderMarkdown(md, { colorSwatches: true });

function swatches(html: string): HTMLElement[] {
  const host = document.createElement('div');
  host.innerHTML = html;
  return [...host.querySelectorAll<HTMLElement>('[data-pkc-color-swatch]')];
}

describe('色の見本が出る形(#1224)', () => {
  it.each([
    ['3 桁', '#fff'],
    ['6 桁', '#3b82f6'],
    ['8 桁(透明度つき)', '#3b82f680'],
    ['6 桁・大文字', '#3B82F6'],
  ])('🔴 %s のインラインコードの左に 1 つ出て、色がそのまま渡る', (_n, code) => {
    const html = on(`色は \`${code}\` です\n`);
    const found = swatches(html);
    expect(found, '見本が出ていない').toHaveLength(1);
    expect(found[0]!.getAttribute('style')).toBe(`--pkc-swatch: ${code}`);
    // 左であること(見本の直後がコードの字)
    expect(html).toContain(`</span><code>${code}</code>`);
  });

  it('🔴 同じ段落の複数のコードには、1 つずつ出る', () => {
    const found = swatches(on('`#111111` と `#222222` と `#333333`\n'));
    expect(found.map((e) => e.getAttribute('style'))).toEqual([
      '--pkc-swatch: #111111',
      '--pkc-swatch: #222222',
      '--pkc-swatch: #333333',
    ]);
  });

  it('🔴 表のセル・見出し・リストの中のコードにも出る', () => {
    expect(swatches(on('| 名 | 色 |\n|---|---|\n| 青 | `#3b82f6` |\n'))).toHaveLength(1);
    expect(swatches(on('## 主色 `#3b82f6`\n'))).toHaveLength(1);
    expect(swatches(on('- 青 `#3b82f6`\n- 赤 `#ef4444`\n'))).toHaveLength(2);
  });
});

describe('色の見本が出ない形(#1224)', () => {
  it.each([
    ['地の文の色コード(囲んでいない)', '色は #3b82f6 です'],
    ['タグ行', '#3b82f6 #買い物'],
    ['7 桁', '`#3b82f68`'],
    ['4 桁', '`#fffa`'],
    ['16 進でない字', '`#ggg`'],
    ['# が無い', '`3b82f6`'],
    ['前後に字がある', '`color: #3b82f6`'],
    ['先頭が # でない', '`x#fff`'],
  ])('🔴 %s には出ない', (_n, md) => {
    expect(swatches(on(md + '\n')), md).toHaveLength(0);
  });

  it('🔴 コード囲み(```)の中の色コードには出ない', () => {
    expect(swatches(on('```\n`#3b82f6`\n#3b82f6\n```\n'))).toHaveLength(0);
    expect(swatches(on('```css\ncolor: #3b82f6;\n```\n'))).toHaveLength(0);
  });

  it('🔴 リンクの中のコードには出ない(押すと飛ぶのか色を選ぶのか分からない)', () => {
    expect(swatches(on('[`#3b82f6`](https://example.com)\n'))).toHaveLength(0);
  });

  it('🔴 既定(旗なし)では 1 つも出ず、出力は 1 バイトも変わらない', () => {
    const md = '`#3b82f6` と `#fff`\n';
    expect(swatches(renderMarkdown(md))).toHaveLength(0);
    expect(renderMarkdown(md)).toBe(renderMarkdown(md, { colorSwatches: false }));
    expect(renderMarkdown(md)).not.toContain('pkc-color-swatch');
  });

  it('🔴 色コードが 1 つも無い本文は、旗を立てても 1 バイトも変わらない', () => {
    const md = '# 題\n\n`code` と **太字** と #タグ\n\n- a\n';
    expect(on(md)).toBe(renderMarkdown(md));
  });
});

describe('見本は字を持たない(#1224。CLAUDE.md §10)', () => {
  it('🔴 textContent は見本を足す前と同じ(選択・コピーに入らない)', () => {
    const md = '色は `#3b82f6` と `#fff` です\n';
    const host = document.createElement('div');
    host.innerHTML = on(md);
    const plain = document.createElement('div');
    plain.innerHTML = renderMarkdown(md);
    expect(host.textContent).toBe(plain.textContent);
    for (const s of swatches(on(md))) {
      expect(s.textContent, '見本が字を持っている').toBe('');
      expect(s.children.length, '見本が子を持っている').toBe(0);
    }
  });

  it('🔴 飾りの見本は読み上げの対象にならない(aria-hidden)/ 押せる見本は名前を持つ', () => {
    // 押せない綴り(3 桁・大文字・8 桁)は飾り
    for (const s of swatches(on('`#fff` `#3B82F6` `#3b82f680`\n'))) {
      expect(s.getAttribute('aria-hidden')).toBe('true');
      expect(s.getAttribute('role'), '飾りが button になっている').toBeNull();
    }
    // 押せる見本(6 桁小文字)は button なので aria-hidden にしない(押せるのに読み上げから消える形を作らない)
    for (const s of swatches(on('`#3b82f6`\n'))) {
      expect(s.getAttribute('aria-hidden'), '押せる見本が読み上げから消えている').toBeNull();
      expect(s.getAttribute('role')).toBe('button');
      expect(s.getAttribute('aria-label'), '押せる見本に名前が無い').toBeTruthy();
    }
  });

  /**
   * 🔴 **押せない綴りの見本は、ホバーで理由を言う**(#1254 §1)。押せる見本(6 桁小文字)は
   * 今までの「押して色を選び直す」のまま(対照群)。⚠ 綴りごとに 1 件ずつ見る。
   */
  it.each([
    ['大文字', '#3B82F6'],
    ['3 桁', '#fff'],
    ['8 桁', '#3b82f680'],
  ])('🔴 押せない綴り(%s)の見本にはホバーの理由が付き、飾りのまま(押せる属性は付かない)', (_n, code) => {
    const found = swatches(on(`\`${code}\`\n`));
    expect(found).toHaveLength(1);
    expect(found[0]!.getAttribute('title')).toBe(
      'この書き方(大文字・3 桁・8 桁)は綴りを変えないので、押しても直せません',
    );
    expect(found[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(found[0]!.hasAttribute('data-pkc-action'), '押せない物が押せる形になった').toBe(false);
  });

  it('対照群(#1254 §1): 押せる見本(6 桁小文字)は「押して色を選び直す」のまま / 理由の字は出ない', () => {
    const [s] = swatches(on('`#3b82f6`\n'));
    expect(s!.getAttribute('title')).toBe('押して色を選び直す');
    expect(s!.outerHTML).not.toContain('押しても直せません');
  });

  it('見本の title は字ではない(textContent は変わらない)', () => {
    const md = '`#FFF` `#abc`\n';
    const a = document.createElement('div');
    a.innerHTML = on(md);
    const b = document.createElement('div');
    b.innerHTML = renderMarkdown(md);
    expect(a.textContent).toBe(b.textContent);
  });

  it('🔴 色の字は escape される(コードの中身は 16 進だけだが、属性に書く字は必ず escape)', () => {
    // 判定が通るのは 16 進だけ ── 属性を突き破る字を書いた形は、そもそも見本にならない
    expect(swatches(on('`#fff"><script>`\n'))).toHaveLength(0);
  });
});
