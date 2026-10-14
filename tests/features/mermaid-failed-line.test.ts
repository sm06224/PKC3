/**
 * 図(mermaid)が描けないとき、原文の上に 1 行出す(#1163 依頼 72-1)。
 *
 * 守る主張:
 * 1. 🔴 `failed` の器に「図を描けません(書き方を確かめてください)」が出る(グラフと同じ置き方)
 * 2. 英語の理由(`data-pkc-mermaid-error`)は画面の字に入れない
 * 3. 🔴 端末の都合(画像にできない等)は「この端末では図を描けませんでした」(書き方を疑わせない)
 * 4. マニュアルが同じ字を書いている(画面と食い違わない)
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** 選択子リストを割って丸ごと一致で引く。⚠ 注釈を落としてから(注釈に満たされない)。 */
function ruleBody(css: string, selector: string): string | null {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const top = code.split('@media')[0]!;
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(top); m !== null; m = re.exec(top)) {
    const sels = m[1]!.split(',').map((x) => x.trim());
    if (sels.includes(selector)) return m[2]!;
  }
  return null;
}

const LINE = '図を描けません(書き方を確かめてください)';

describe('図が描けないときの 1 行', () => {
  const css = readFileSync('src/styles/app.css', 'utf-8');

  it('🔴 failed の器の前に字が出る(グラフと同じ形)', () => {
    const body = ruleBody(css, ".pkc-md-rendered [data-pkc-mermaid-state='failed']::before");
    expect(body, '規則が無い').not.toBeNull();
    expect(body!).toContain(`content: '${LINE}'`);
    expect(body!).toContain('display: block');
    expect(body!, '英語の理由は出さない').not.toContain('attr(');
    // 対照群: グラフの規則は今もある(同じ読み方で引けている)
    expect(ruleBody(css, ".pkc-md-rendered [data-pkc-chart-state='failed']::before")).not.toBeNull();
  });

  it('🔴 端末の都合で描けなかったときは別の字(書き方のせいにしない)', () => {
    const body = ruleBody(
      css,
      ".pkc-md-rendered [data-pkc-mermaid-state='failed'][data-pkc-mermaid-device]::before",
    );
    expect(body, '端末の都合の規則が無い').not.toBeNull();
    expect(body!).toContain("content: 'この端末では図を描けませんでした'");
    expect(body!, '書き方の字が混ざっている').not.toContain('書き方');
  });

  it('🔴 グラフ: 理由は属性の字そのまま(前置きは adapter が付ける)/ 取りこぼしの 1 行は ready のときだけ', () => {
    const failed = ruleBody(css, ".pkc-md-rendered [data-pkc-chart-state='failed']::before");
    expect(failed).not.toBeNull();
    expect(failed!).toContain('content: attr(data-pkc-chart-error)');
    expect(failed!, '前置きが CSS に残っている(端末の都合の理由にも付いてしまう)').not.toContain("'グラフを描けません");
    const note = ruleBody(
      css,
      ".pkc-md-rendered [data-pkc-chart-state='ready'][data-pkc-chart-note]::before",
    );
    expect(note, '取りこぼしの 1 行の規則が無い').not.toBeNull();
    expect(note!).toContain('attr(data-pkc-chart-note)');
    expect(note!).toContain('display: block');
  });

  it('マニュアルが同じ字を書いている', () => {
    expect(readFileSync('docs/manual.md', 'utf-8')).toContain(`**「${LINE}」**`);
  });
});
