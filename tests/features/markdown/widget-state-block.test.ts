/**
 * ウィジェットの状態ブロック(` ```json widget-state="…" `)の読み書き(v4.0 Phase 2 / PR-08)。
 *
 * 守る主張:
 * 1. read / upsert(新規の挿入・既存の差し替え)/ remove が往復する
 * 2. 壊れた JSON・文字列以外の値は丸ごと無視(`null`)
 * 3. 64 KB を超える状態は断り、本文を 1 バイトも変えない
 * 4. 対象のブロック以外の原文は 1 バイトも変えない(別の id・コードブロック・前書き)
 */
import { describe, expect, it } from 'vitest';
import {
  allWidgetStateBlocks,
  hasWidgetStateBlock,
  readWidgetStateBlock,
  removeWidgetStateBlock,
  upsertWidgetStateBlock,
  WIDGET_STATE_BLOCK_LIMIT,
  widgetFenceId,
  widgetStateBlockId,
} from '../../../src/features/markdown/widget-state-block';

const TOOL = '```html id="tracker"\n<p>x</p>\n```';
const ok = (r: ReturnType<typeof upsertWidgetStateBlock>): string => {
  if (!r.ok) throw new Error(r.reason);
  return r.body;
};

describe('見出しの読み方', () => {
  it('状態ブロックの id(引用符の有無を問わない・読めない id は null)', () => {
    expect(widgetStateBlockId('json widget-state="a"')).toBe('a');
    expect(widgetStateBlockId("json widget-state='b-2'")).toBe('b-2');
    expect(widgetStateBlockId('json widget-state=c_3')).toBe('c_3');
    expect(widgetStateBlockId('JSON widget-state="d"')).toBe('d');
    expect(widgetStateBlockId('json widget-state="../x"')).toBeNull();
    expect(widgetStateBlockId('json')).toBeNull();
    expect(widgetStateBlockId('js widget-state="a"')).toBeNull();
  });
  it('本体の id(html / html-render / react / jsx だけ。状態ブロックは本体ではない)', () => {
    expect(widgetFenceId('html id="a"')).toBe('a');
    expect(widgetFenceId('html-render id="a"')).toBe('a');
    expect(widgetFenceId('react id="r"')).toBe('r');
    expect(widgetFenceId('jsx id="j"')).toBe('j');
    expect(widgetFenceId('html')).toBeNull();
    expect(widgetFenceId('js id="a"')).toBeNull();
    expect(widgetFenceId('json widget-state="a"')).toBeNull();
  });
});

describe('read / upsert / remove の往復', () => {
  it('🔴 無ければ本体の囲みの直後へ入れ、読み戻せ、消すと元の本文に戻る', () => {
    const body = `# 題\n\n${TOOL}\n\n後ろの段落\n`;
    const saved = ok(upsertWidgetStateBlock(body, 'tracker', { value: '3', goal: '10' }));
    expect(saved).toBe(
      `# 題\n\n${TOOL}\n\n\`\`\`json widget-state="tracker"\n{\n  "goal": "10",\n  "value": "3"\n}\n\`\`\`\n\n後ろの段落\n`,
    );
    expect(readWidgetStateBlock(saved, 'tracker')).toEqual({ value: '3', goal: '10' });
    expect(hasWidgetStateBlock(saved, 'tracker')).toBe(true);
    expect(removeWidgetStateBlock(saved, 'tracker')).toBe(body);
  });

  it('🔴 在れば中身だけ差し替える(位置も前後も動かさない)', () => {
    const body = `${TOOL}\n\n中\n\n\`\`\`json widget-state="tracker"\n{"value":"1"}\n\`\`\`\n\n末尾\n`;
    const next = ok(upsertWidgetStateBlock(body, 'tracker', { value: '2' }));
    expect(next).toBe(`${TOOL}\n\n中\n\n\`\`\`json widget-state="tracker"\n{\n  "value": "2"\n}\n\`\`\`\n\n末尾\n`);
    expect(readWidgetStateBlock(next, 'tracker')).toEqual({ value: '2' });
  });

  it('本体が見つからなければ末尾へ(末尾の空行を整える)', () => {
    const next = ok(upsertWidgetStateBlock('本文だけ\n\n\n', 'x', { a: 'b' }));
    expect(next).toBe('本文だけ\n\n```json widget-state="x"\n{\n  "a": "b"\n}\n```\n');
    expect(ok(upsertWidgetStateBlock('', 'x', {}))).toBe('```json widget-state="x"\n{}\n```\n');
  });

  it('🔴 他のブロックの原文は 1 バイトも変えない(別の id・前書き・CRLF)', () => {
    const other = '```json widget-state="other"\n{"k":"v"}\n```';
    const body = `---\ntitle: t\n---\r\n${TOOL}\r\n\r\n${other}\r\n`.replace(/\n/g, '\r\n').replace(/\r\r/g, '\r');
    const next = ok(upsertWidgetStateBlock(body, 'tracker', { n: '1' }));
    expect(next.startsWith(`---\r\ntitle: t\r\n---\r\n`)).toBe(true);
    expect(next).toContain(other.replace(/\n/g, '\r\n'));
    expect(next.includes('\n') && !/[^\r]\n/.test(next), 'LF が混ざった').toBe(true);
    expect(readWidgetStateBlock(next, 'other')).toEqual({ k: 'v' });
    const back = removeWidgetStateBlock(next, 'tracker');
    expect(back).toBe(body);
  });

  it('🔴 改行が混ざった本文で、他の行の改行コードを変えない(レビュー指摘)', () => {
    // 大半が LF、1 行だけ CRLF
    const body = `前の段落\r\nもう 1 行\n\n${TOOL}\n\n後ろ\n`;
    const saved = ok(upsertWidgetStateBlock(body, 'tracker', { v: '1' }));
    expect(saved.startsWith('前の段落\r\nもう 1 行\n\n'), '前の行の改行が変わった').toBe(true);
    expect(saved.endsWith('\n\n後ろ\n')).toBe(true);
    expect((saved.match(/\r\n/g) ?? []).length, 'CRLF の数が増えた').toBe(1);
    expect(removeWidgetStateBlock(saved, 'tracker')).toBe(body);
    // 差し替えでも同じ
    const again = ok(upsertWidgetStateBlock(saved, 'tracker', { v: '2' }));
    expect((again.match(/\r\n/g) ?? []).length).toBe(1);
  });

  it('本体が最後の行(改行なし)でも壊さず、消すと元に戻る', () => {
    const body = TOOL;
    const saved = ok(upsertWidgetStateBlock(body, 'tracker', { v: '1' }));
    expect(saved).toBe(`${TOOL}\n\n\`\`\`json widget-state="tracker"\n{\n  "v": "1"\n}\n\`\`\``);
    expect(readWidgetStateBlock(saved, 'tracker')).toEqual({ v: '1' });
    expect(removeWidgetStateBlock(saved, 'tracker')).toBe(body);
  });

  it('鍵が __proto__ でも黙って落とさない', () => {
    const saved = ok(upsertWidgetStateBlock('', 'a', JSON.parse('{"__proto__":"x","b":"y"}') as Record<string, string>));
    expect(saved).toContain('"__proto__": "x"');
    expect(Object.keys(readWidgetStateBlock(saved, 'a')!).sort()).toEqual(['__proto__', 'b']);
  });

  it('同じ id が 2 つあれば read は最初の 1 つ、remove は全部', () => {
    const b = '```json widget-state="a"\n{"v":"1"}\n```\n\nx\n\n```json widget-state="a"\n{"v":"2"}\n```\n';
    expect(readWidgetStateBlock(b, 'a')).toEqual({ v: '1' });
    expect(hasWidgetStateBlock(removeWidgetStateBlock(b, 'a'), 'a')).toBe(false);
    expect(removeWidgetStateBlock(b, 'a')).toBe('x\n');
  });

  it('無い id の remove は本文をそのまま返す', () => {
    const b = `${TOOL}\n`;
    expect(removeWidgetStateBlock(b, 'zz')).toBe(b);
  });

  it('allWidgetStateBlocks は id → 状態(壊れた物は入れない)', () => {
    const b = '```json widget-state="a"\n{"v":"1"}\n```\n\n```json widget-state="b"\n{oops\n```\n';
    const m = allWidgetStateBlocks(b);
    expect([...m.keys()]).toEqual(['a']);
    expect(allWidgetStateBlocks('状態ブロックなし').size).toBe(0);
  });
});

describe('安全に無視・断る', () => {
  it('🔴 壊れた JSON・配列・文字列以外の値は null', () => {
    const blk = (j: string): string => `\`\`\`json widget-state="a"\n${j}\n\`\`\`\n`;
    expect(readWidgetStateBlock(blk('{oops'), 'a')).toBeNull();
    expect(readWidgetStateBlock(blk('[1,2]'), 'a')).toBeNull();
    expect(readWidgetStateBlock(blk('{"a":1}'), 'a')).toBeNull();
    expect(readWidgetStateBlock(blk('{"a":"1","b":null}'), 'a')).toBeNull();
    expect(readWidgetStateBlock(blk('"str"'), 'a')).toBeNull();
    expect(readWidgetStateBlock(blk('{"a":"1"}'), 'a')).toEqual({ a: '1' });
  });

  it('🔴 コードブロックの中・引用の中・前書きの中の偽物は読まない', () => {
    const inCode = '````md\n```json widget-state="a"\n{"v":"x"}\n```\n````\n';
    expect(readWidgetStateBlock(inCode, 'a')).toBeNull();
    const inQuote = '> ```json widget-state="a"\n> {"v":"x"}\n> ```\n';
    expect(readWidgetStateBlock(inQuote, 'a')).toBeNull();
    const inFm = '---\nx: |\n  ```json widget-state="a"\n---\n本文\n';
    expect(readWidgetStateBlock(inFm, 'a')).toBeNull();
  });

  it('🔴 64 KB を超える状態は断り、理由を返す(本文は返さない)', () => {
    const big = { v: 'x'.repeat(WIDGET_STATE_BLOCK_LIMIT) };
    const r = upsertWidgetStateBlock(`${TOOL}\n`, 'tracker', big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('64.0 KB');
    // 境界のすぐ内側は通る
    const near = { v: 'x'.repeat(WIDGET_STATE_BLOCK_LIMIT - 20) };
    expect(upsertWidgetStateBlock(`${TOOL}\n`, 'tracker', near).ok).toBe(true);
  });

  it('値に ``` を含んでも囲みが途中で閉じない', () => {
    const b = ok(upsertWidgetStateBlock('', 'a', { code: '```\nx' }));
    expect(readWidgetStateBlock(b, 'a')).toEqual({ code: '```\nx' });
  });

  it('読めない id では書かない', () => {
    expect(upsertWidgetStateBlock('', '../x', {}).ok).toBe(false);
  });
});
