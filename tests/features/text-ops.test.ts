/**
 * P8 段⑥: **書式パネルの規則**。
 *
 * 🔑 pure module なので、罠は全部ここで見られる ── 実ブラウザでしか確かめられない
 * 形にしなかったのはそのため。逆に言えば、**ここで見ていない罠は誰も見ていない**。
 *
 * ⚠ 見るのは「押したら文字列がこうなる」だけでなく、**戻せるか**(トグル)と
 * **隣の書式を壊さないか**(`**太字**` に斜体)まで。前者だけだと、
 * 「付くけど外れない」実装が緑で通る。
 */
import { describe, expect, it } from 'vitest';
import {
  applyFormat,
  autoPairFor,
  appendAt,
  appendBlock,
  FORMAT_OPS,
  TABLE_BLOCK,
  CODE_BLOCK,
  MERMAID_BLOCK,
  type FormatOp,
  type TextSelection,
} from '../../src/features/markdown/text-ops';

/** `|` で選択範囲を書く記法(見て分かる fixture を作る)。 */
function sel(marked: string): TextSelection {
  const start = marked.indexOf('|');
  const end = marked.indexOf('|', start + 1) - 1;
  return { text: marked.replace(/\|/g, ''), start, end };
}
/** 結果を同じ記法へ戻す(選択位置も一緒に見る ── ここを落とすと caret が迷子)。 */
function show(s: TextSelection): string {
  return `${s.text.slice(0, s.start)}|${s.text.slice(s.start, s.end)}|${s.text.slice(s.end)}`;
}

describe('行頭の印', () => {
  it('付けて、押し直すと外れる', () => {
    const once = applyFormat(sel('|やること|'), 'h2');
    expect(once.text).toBe('## やること');
    expect(applyFormat(once, 'h2').text).toBe('やること');
  });

  it('🔴 番号付きは**押し直すと外れる**(付けた印と同じ文字列で判定しない)', () => {
    // かつて `1. ` で判定していた ── 2 行目以降は `2. ` `3. ` になるので
    // **二度と外せなかった**(付くだけのボタン)
    const once = applyFormat(sel('|あ\nい\nう|'), 'ol');
    expect(once.text).toBe('1. あ\n2. い\n3. う');
    expect(applyFormat(once, 'ol').text).toBe('あ\nい\nう');
  });

  it('🔴 チェック行に箇条書きを押しても `[ ] ` が露出しない', () => {
    // `- ` で判定すると `- [ ] やること` が「もう箇条書き」と読まれ、
    // 外して `[ ] やること` になる(印が壊れる向きの誤差)
    const out = applyFormat(sel('|- [ ] やること|'), 'ul');
    expect(out.text).toBe('- やること');
    expect(out.text).not.toContain('[ ]');
  });

  it('種類を変えると置き換わる(重ならない)', () => {
    expect(applyFormat(sel('|# 見出し|'), 'h3').text).toBe('### 見出し');
    expect(applyFormat(sel('|- 項目|'), 'quote').text).toBe('> 項目');
  });

  it('一部だけ付いている状態からは**揃える**(外さない)', () => {
    const out = applyFormat(sel('|- あ\nい|'), 'ul');
    expect(out.text).toBe('- あ\n- い');
  });

  it('選択が行の途中でも行全体に効く', () => {
    expect(applyFormat(sel('見出|し|です'), 'h1').text).toBe('# 見出しです');
  });
});

describe('囲む印', () => {
  it('付けて、押し直すと外れる(選択の内側でも外側でも)', () => {
    const bold = applyFormat(sel('|強調|'), 'bold');
    expect(show(bold)).toBe('**|強調|**');
    // 選択は中身のまま = 押し直しは「外側に印がある」経路
    expect(applyFormat(bold, 'bold').text).toBe('強調');
    // 印ごと選び直した場合も外れる
    expect(applyFormat({ text: '**強調**', start: 0, end: 8 }, 'bold').text).toBe('強調');
  });

  it('🔴 `**太字**` に斜体を掛けても太字が壊れない', () => {
    // 「先頭が印か」で判定していると `*太字*` に化けて**太字が消える**
    const inner = { text: '**太字**', start: 2, end: 4 };
    const italic = applyFormat(inner, 'italic');
    expect(italic.text).toBe('***太字***');
    // そこで斜体を押し直すと**太字に戻る**(全部剥がれない)
    expect(applyFormat(italic, 'italic').text).toBe('**太字**');
  });

  it('選択が無いときは印だけ入れて間にカーソルを置く', () => {
    const out = applyFormat({ text: 'あ', start: 1, end: 1 }, 'code');
    expect(out.text).toBe('あ``');
    expect(out.start).toBe(2);
    expect(out.end).toBe(2);
  });
});

describe('差し込む塊', () => {
  it('🔴 雛形に目印の制御文字が残らない', () => {
    // 目印(`\u0001`)は `template()` が取り除く ── 残ると**本文に混入する**
    for (const b of [TABLE_BLOCK, CODE_BLOCK, MERMAID_BLOCK]) {
      // ⚠ 正規表現に制御文字を書くと lint(`no-control-regex`)が止める ──
      // 符号位置で見る(このほうが「何を弾いたか」も読める)
      const bad = [...b.text].filter((c) => {
        const cp = c.codePointAt(0)!;
        return (cp < 32 && c !== '\n') || cp === 127;
      });
      expect(bad, '雛形に制御文字が残っている').toEqual([]);
    }
  });

  it('表はカーソルが最初のセルに入る', () => {
    const out = applyFormat({ text: '', start: 0, end: 0 }, 'table');
    expect(out.text.split('\n')[0]).toBe('| 項目 | 値 |');
    // ⚠ 位置を数字で pin しない(雛形を直すと嘘になる)── **何の直前か**を見る
    expect(out.text.slice(out.start, out.start + 2)).toBe(' |');
    expect(out.text.slice(0, out.start)).toBe('| 項目 | 値 |\n|---|---|\n| ');
  });

  it('🔴 行の途中に差し込むときは改行してから入れる', () => {
    // 段落の途中に fence が生えると markdown として壊れる
    const out = applyFormat({ text: '文の途中', start: 2, end: 2 }, 'mermaid');
    expect(out.text.startsWith('文の\n```mermaid')).toBe(true);
    expect(out.text.endsWith('```\n\n途中')).toBe(true);
  });

  it('リンクは url が選択される(すぐ貼れる)', () => {
    const out = applyFormat(sel('|ここ|'), 'link');
    expect(show(out)).toBe('[ここ](|url|)');
  });
});

describe('追記', () => {
  it('ログは日時の節を足し、カーソルは末尾', () => {
    const out = appendAt('前の記録', '## 2026-08-03 12:00:00');
    expect(out.text).toBe('前の記録\n\n## 2026-08-03 12:00:00\n\n');
    expect(out.start).toBe(out.text.length);
    expect(out.end).toBe(out.text.length);
  });

  it('ノートは空行だけ空ける(見出しを勝手に足さない)', () => {
    expect(appendAt('本文', null).text).toBe('本文\n\n');
  });

  it('🔴 押すたびに空行が増えない', () => {
    // 末尾を畳まないと、10 回押した本文は空行 20 行を抱えて書き出される
    const once = appendAt('本文', null);
    const twice = appendAt(once.text, null);
    expect(twice.text).toBe('本文\n\n');
    const log1 = appendAt('本文', '## A');
    const log2 = appendAt(log1.text, '## B');
    expect(log2.text).toBe('本文\n\n## A\n\n## B\n\n');
  });

  it('🔴 一塊で追記する(見出し + 中身が 1 回で閉じる)', () => {
    expect(appendBlock('前の記録', '## A', '今日のできごと')).toBe(
      '前の記録\n\n## A\n\n今日のできごと\n',
    );
    expect(appendBlock('本文', null, 'あとがき')).toBe('本文\n\nあとがき\n');
  });

  it('🔴 空の追記は本文を変えない(日時見出しだけの空節を積まない)', () => {
    // ⚠ ここは effect の失敗判定(`newBody === body`)の土台でもある ──
    // 変えてしまうと「空を追記したのに成功した」ことになる
    expect(appendBlock('本文', '## A', '')).toBe('本文');
    expect(appendBlock('本文', '## A', '   \n\t ')).toBe('本文');
  });

  it('空の本文でも先頭に余白を作らない', () => {
    expect(appendAt('', '## A').text).toBe('## A\n\n');
    expect(appendAt('   \n\n', null).text).toBe('');
  });
});

describe('パネルの表', () => {
  it('🔴 表に並んだ操作は**全部効く**(押しても何も起きないボタンを作らない)', () => {
    for (const { op } of FORMAT_OPS) {
      const out = applyFormat({ text: 'あいう', start: 0, end: 3 }, op);
      expect(out.text, `${op} が本文を変えない`).not.toBe('あいう');
    }
  });

  it('未知の op は本文を変えない(型を抜けてきても壊さない)', () => {
    const before = { text: 'あ', start: 0, end: 1 };
    expect(applyFormat(before, 'nope' as FormatOp).text).toBe('あ');
  });
});

/**
 * 🔴 **auto pair**(2026-08-05。ライブエディタ S5c。user 提案 §5.6 ②)。
 *
 * > user 提案「**auto pair は開放終端をそもそも作りにくくする機構であり、入力補助な**」
 *
 * ここで守るのは 3 つ:
 * ① **行内の対**は閉じが入り、caret が中に来る(選択があれば囲む = 文字を消さない)
 * ② 🔴 **行頭のブロック記号**(``` / :::)は閉じが**次の行**に入る
 *    ── 行内の対と同じ扱いにすると `` `````` `` になって狙いと逆に壊れる
 * ③ **補わないときは `null`**(= ブラウザにそのまま打たせる)── ここで
 *    「空文字を挿す」を返すと、`execCommand` 経由になって undo の粒度が変わる
 */
describe('autoPairFor(auto pair の規則)', () => {
  const at = (text: string, start: number, end = start) => ({ text, start, end });

  it('① 行内の対は閉じが入り、caret は中に来る', () => {
    const r = autoPairFor(at('あ', 1), '「');
    expect(r).toEqual({ insert: '「」', start: 2, end: 2 });
  });

  it('① 選択があるときは囲む(選んだ文字が消えない)', () => {
    const r = autoPairFor(at('あここい', 1, 3), '「');
    expect(r).toEqual({ insert: '「ここ」', start: 2, end: 4 });
  });

  it('② 🔴 行頭の 3 つ目のバッククォートで、閉じが**次の行**に入る', () => {
    // 行頭に `` が在る状態で 3 つ目を打つ
    const r = autoPairFor(at('``', 2), '`');
    expect(r).toEqual({ insert: '`\n```', start: 3, end: 3 });
    // caret は開き記号の直後 = 言語を打てる位置
    const after = '``' + r!.insert;
    expect(after).toBe('```\n```');
    expect(after.slice(0, r!.start)).toBe('```');
  });

  it('② 🔴 行頭の 1 つ目・2 つ目は対にしない(``` を組む途中を邪魔しない)', () => {
    expect(autoPairFor(at('', 0), '`')).toBeNull();
    expect(autoPairFor(at('`', 1), '`')).toBeNull();
    // ⚠ 対にしてしまうと `` ` `` × 3 で `` `````` `` になる(狙いと逆)
  });

  it('② `:::` も同じ(閉じが次の行・caret は名前を打つ位置)', () => {
    const r = autoPairFor(at('::', 2), ':');
    expect(r).toEqual({ insert: ':\n:::', start: 3, end: 3 });
    expect('::' + r!.insert).toBe(':::\n:::');
  });

  it('② 4 つ目以降は閉じを足さない(閉じが二重に増えない)', () => {
    expect(autoPairFor(at('```', 3), '`')).toBeNull();
  });

  it('② 行頭でも、後ろに文字が在るならブロックとして扱わない', () => {
    // `` |あ` のような途中 ── ここでブロックの閉じを入れると本文を割る
    const r = autoPairFor(at('``あ', 2), '`');
    expect(r).toEqual({ insert: '``', start: 3, end: 3 });
  });

  it('② 行の途中のバッククォートは行内の対(行頭判定が緩んでいない)', () => {
    const r = autoPairFor(at('あ``', 3), '`');
    expect(r).toEqual({ insert: '``', start: 4, end: 4 });
  });

  it('② 2 行目の行頭でも効く(行の切り出しが先頭固定になっていない)', () => {
    const r = autoPairFor(at('あ\n``', 4), '`');
    expect(r).toEqual({ insert: '`\n```', start: 5, end: 5 });
  });

  it('③ 対でない打鍵は null(ブラウザにそのまま打たせる)', () => {
    expect(autoPairFor(at('あ', 1), 'x')).toBeNull();
    expect(autoPairFor(at('あ', 1), 'Enter')).toBeNull();
  });
});
