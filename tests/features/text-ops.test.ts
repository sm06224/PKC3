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
  DIAGRAM_CHOICES,
  DIAGRAM_TEMPLATES,
  BAR_FORMAT_OPS,
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

/**
 * 🔴 **#950**: 選んで「コードブロック」を押すと、選んだ字が消えていた
 * (`insertBlock` が `slice(start, end)` を 1 度も使っていなかった)。
 * 4 つとも「選んだものを囲む」にする ── ここは `applyFormat` を通して
 * end-to-end で見る(帯のボタンと同じ経路)。繋がり(押した所から欄まで)は
 * `tests/adapter/format-append.test.ts` / `tests/adapter/palette.test.ts`。
 */
describe('🔴 選んだものを囲む(#950)', () => {
  /** 3 つとも同じ形(囲む/外す)を持つので、まとめて回す。 */
  const FENCES: readonly { op: 'codeblock' | 'math' | 'mermaid'; open: string; close: string }[] = [
    { op: 'codeblock', open: '```', close: '```' },
    { op: 'math', open: '$$', close: '$$' },
    { op: 'mermaid', open: '```mermaid', close: '```' },
  ];

  for (const { op, open, close } of FENCES) {
    describe(op, () => {
      it('🔴 選んだ字は消えない(囲まれる)', () => {
        const out = applyFormat({ text: 'あいうえお', start: 1, end: 4 }, op);
        // ⚠ 消えていない ── 「選んだ字が本文のどこかに丸ごと残っている」を見る
        expect(out.text, '選んだ字が消えた').toContain('いうえ');
        expect(out.text).toContain(open);
        expect(out.text).toContain(close);
        // ⚠ 前後の字も 1 バイトも失っていない
        expect(out.text.startsWith('あ')).toBe(true);
        expect(out.text.endsWith('お')).toBe(true);
      });

      /**
       * ⚠ **base は「選択が行の境界ちょうど」の文**にする(`start === 0` かつ
       *   `end === text.length`)── 行の途中で囲むと、囲むこと自体が
       *   `あ`/`お` を別の行へ追い出す(「行として立つ」ため必ず改行が要る)ので、
       *   外したときに**その改行まで元へ戻せる保証は無い**(fence が要求した
       *   構造であって、外す操作が持っている情報だけでは判別できない)。
       *   ここで見たいのは「外れるか」であって「行の構造まで完全に戻るか」
       *   ではないので、**その混同が起きない fixture**を選ぶ。
       */
      it('もう一度押すと外れる(fence ごと選び直した場合)', () => {
        const once = applyFormat({ text: 'いうえ', start: 0, end: 3 }, op);
        // ⚠ fence ごと選ぶ(先頭〜末尾を丸ごと)
        const twice = applyFormat({ text: once.text, start: 0, end: once.text.length }, op);
        expect(twice.text, '外れていない(押し直しても増えるだけ)').toBe('いうえ');
      });

      it('もう一度押すと外れる(中身だけ選び直した場合)', () => {
        const innerStart = open.length + 1;
        const innerEnd = innerStart + 3; // 'いうえ'.length
        const once = applyFormat({ text: 'いうえ', start: 0, end: 3 }, op);
        const twice = applyFormat({ text: once.text, start: innerStart, end: innerEnd }, op);
        expect(twice.text, '外れていない').toBe('いうえ');
        // ⚠ 選択も元の位置に戻る(打ち直さずに続けられる)
        expect(twice.start).toBe(0);
        expect(twice.end).toBe(3);
      });

      it('行の途中で選んでも、fence は行として立つ(前後に改行)', () => {
        const out = applyFormat({ text: '文の途中です', start: 2, end: 4 }, op);
        const lines = out.text.split('\n');
        expect(lines, `fence が行として立っていない: ${out.text}`).toContain(open);
        expect(lines).toContain(close);
      });

      it('末尾の改行を含めて選んでも、内側に空行が増えない', () => {
        // 「いうえ\n」まで選ぶ(改行込み)
        const out = applyFormat({ text: 'あいうえ\nお', start: 1, end: 5 }, op);
        // open の直後の行が空でない(空行が挟まっていない)ことを見る
        const lines = out.text.split('\n');
        const openAt = lines.indexOf(open);
        expect(openAt, 'open が見つからない').toBeGreaterThanOrEqual(0);
        expect(lines[openAt + 1], '内側に空行が増えた').not.toBe('');
        // 🔴 上の 2 つは「空行が無いか」の緩い網 ── `midBreak` を常に `\n` に
        //   する変異(選んだ字が既に改行で終わっていても、もう 1 本足す)は
        //   「open の直後」だけを見ていると通り抜ける(足された空行は
        //   close の直前に出るため)。ここは**全体を** byte 単位で見る。
        expect(out.text, 'close の直前に余分な空行が増えた').toBe(`あ\n${open}\nいうえ\n${close}\nお`);
      });

      /**
       * 🔴 **`lineBreaksAround` の判定を弱める変異への網**。
       *
       * ⚠ 上の test 群は「前後に改行が要るか」の**存在**は見ているが、
       *   「**要らないのに足していないか**」までは見ていない ──
       *   `atLineStart` / `tailNeedsBreak` の判定を弱める(`\n` の直後かの
       *   確認を落とす)変異は、選択の前後に**既に行の境界が在る**場面でしか
       *   見えない(その場合だけ「余分な改行」が実際に増える)。
       */
      it('🔴 選択の直前が既に行頭なら(先頭でなくても)、余分な改行を足さない', () => {
        const before = 'まえ\nあと';
        const out = applyFormat({ text: before, start: 3, end: 5 }, op); // 'あと' を選ぶ
        expect(out.text, '要らない改行が増えた').toBe(`まえ\n${open}\nあと\n${close}`);
      });

      it('🔴 選択の直後が既に改行なら(文書末尾でなくても)、余分な改行を足さない', () => {
        const before = 'まえ\nあと';
        const out = applyFormat({ text: before, start: 0, end: 2 }, op); // 'まえ' を選ぶ
        expect(out.text, '要らない改行が増えた').toBe(`${open}\nまえ\n${close}\nあと`);
      });

      it('文書の先頭・末尾ちょうどを選んでも壊れない', () => {
        const out = applyFormat({ text: 'まるごと', start: 0, end: 4 }, op);
        expect(out.text).toContain('まるごと');
        expect(out.text.startsWith(open)).toBe(true);
      });

      it('選択が改行 1 文字だけでも、その改行を失わない', () => {
        // 'あ' '\n' 'い' の、真ん中の改行だけを選ぶ
        const out = applyFormat({ text: 'あ\nい', start: 1, end: 2 }, op);
        // ⚠ 前後の文字が両方残っている(=改行を含む選択でも捨てられていない)
        expect(out.text).toContain('あ');
        expect(out.text).toContain('い');
        expect(out.text).toContain(open);
        expect(out.text).toContain(close);
      });

      /**
       * 🔴 **`open === close` の 2 つ(codeblock / math)だけに在る罠**。
       *
       * ⚠ `tryUnwrapBlock` の①(fence ごと)は「1 行目が open・最終行が close」
       *   を見るが、**選択が 1 行だけ**で、その 1 行がちょうど fence の綴り
       *   (` ``` ` / `$$`)そのものだと、**1 行が「1 行目」にも「最終行」にも
       *   同時に当たる**。⚠ `lines.length >= 2` の下限が無いと、これを
       *   「もう囲まれている」と誤読して**その 1 行を空文字に消す**
       *   (`lines.slice(1, -1)` が 1 要素の配列に対して空配列を返すため)。
       *   ⚠ mermaid は `open('```mermaid') !== close('```')` なので、この形は
       *   そもそも起こらない(対象外)。
       */
      if (open === close) {
        it('🔴 fence そのものと同じ 1 行を選んでも、消えない(下限 lines.length >= 2)', () => {
          const out = applyFormat({ text: `まえ\n${open}\nあと`, start: 3, end: 3 + open.length }, op);
          expect(out.text, `${open} という行そのものが消えた`).toContain(open);
          expect(out.text).toContain('まえ');
          expect(out.text).toContain('あと');
        });
      }
    });
  }

  it('🔴 codeblock は囲んだ直後、caret が open の直後(言語を打てる位置)へ来る', () => {
    const out = applyFormat({ text: 'あいうえお', start: 1, end: 4 }, 'codeblock');
    expect(out.start).toBe(out.end); // 選択ではなく caret(打てる状態)
    expect(out.text.slice(0, out.start).endsWith('```')).toBe(true);
    expect(out.text[out.start]).toBe('\n');
  });

  it('🔴 codeblock は言語を打ってから選び直しても外れる(startsWith 判定)', () => {
    const wrapped = applyFormat({ text: 'いうえ', start: 0, end: 3 }, 'codeblock');
    // 言語を打つ(caret の位置に "ts" を挿す、と同じ効果を手で作る)
    const withLang = wrapped.text.slice(0, wrapped.start) + 'ts' + wrapped.text.slice(wrapped.start);
    expect(withLang, '前提が崩れている(caret の位置が言語を打てる所ではない)').toBe(
      '```ts\nいうえ\n```',
    );
    // fence ごと選び直して押す
    const unwrapped = applyFormat({ text: withLang, start: 0, end: withLang.length }, 'codeblock');
    expect(unwrapped.text, '言語付きの fence を外せない').toBe('いうえ');
  });

  it('⚠ 選んだ範囲の中に既に ``` があっても、選んだ字は失われない(壊れ方は既存の markdown の制約と同じ)', () => {
    // ⚠ 決めたこと: 長さを自動で伸ばす仕組みは入れない(過剰実装を避ける)。
    //   ここで確かめるのは「壊れないこと」ではなく「**消えない**こと」。
    const before = 'まえ\n```\nなか\n```\nあと';
    const out = applyFormat({ text: before, start: 0, end: before.length }, 'codeblock');
    for (const piece of ['まえ', 'なか', 'あと']) {
      expect(out.text, `${piece} が消えた`).toContain(piece);
    }
  });

  it('🔴 選んでいないときは、これまでどおり空の雛形を入れる(壊さない)', () => {
    // ⚠ 既存の空選択の経路(insertBlock)は 1 バイトも変えていないことの対照群
    for (const op of ['codeblock', 'math', 'mermaid'] as const) {
      const out = applyFormat({ text: '', start: 0, end: 0 }, op);
      expect(out.text.length, `${op} の空選択が挙動を変えた`).toBeGreaterThan(0);
    }
  });

  /**
   * 🔴 **着地前レビュー ①(最優先。データが消える)の再現**。
   *
   * `open === close`(codeblock / math)は 1 行だけを見て開き/閉じを区別できない。
   * 選択の直前・直後の行だけを見る局所判定は、**選択と無関係などこかに在る
   * 別の囲みの閉じ行**と**その次の囲みの開き行**が選択に隣接しているとき、
   * それを「選択を囲む対」と誤読して外し、**独立した 2 つの囲みを融合させ、
   * 境界の fence 行を消す**(レビューの再現そのもの)。
   *
   * ⚠ この test は**直す前は落ちる**(`/tmp/claude-0/scratch-950/text-ops.ts.bak`
   * = 旧 `tryUnwrapBlock` を一時的に差し戻して確認済み)。
   */
  describe('🔴 無関係な既存の囲みを、選択の検出が壊さない(着地前レビュー ①)', () => {
    for (const { op, open } of FENCES.filter((f) => f.open === f.close)) {
      it(`${op}: 2 つの無関係な囲みの間にある選択を囲んでも、両方を融合させない`, () => {
        // レビューの再現例そのもの(codeblock はレビューの文字列、math は同型)
        const before = `${open}\nold code\n${open}\n今日は晴れです\n${open}\nnotes\n${open}`;
        const idx = before.indexOf('今日は晴れです');
        const out = applyFormat({ text: before, start: idx, end: idx + '今日は晴れです'.length }, op);

        // ⚠ 壊れた形そのもの(境界の fence が消えて 1 つの塊に融合する)が
        //   出ていないことを、まず直接見る
        expect(out.text, '2 つの囲みが融合した(境界の fence が消えた)').not.toContain(
          `old code\n今日は晴れです\nnotes`,
        );
        // ⚠ 元の 3 つの内容は 1 バイトも失われていない
        expect(out.text).toContain('old code');
        expect(out.text).toContain('notes');
        expect(out.text).toContain('今日は晴れです');
        // ⚠ fence 行(そのものと一致する行)の本数は減っていない(4 → 6 に増える:
        //   選んだ行を新しく囲んだ分だけ増える。融合すると 4 → 2 に減る)
        const fenceLineCount = before.split('\n').filter((l) => l === open).length;
        const afterCount = out.text.split('\n').filter((l) => l === open).length;
        expect(afterCount, 'fence 行が減った(境界が消えた=融合した)').toBeGreaterThan(fenceLineCount);
      });
    }

    for (const { op, open, close } of FENCES) {
      it(`${op}: 選択が既存の 2 つの完結した囲みをまたいで丸ごと選ばれても、内側の fence が孤立しない`, () => {
        // 隙間なく並んだ 2 つの完結した囲み。全体を選んで押す
        // (open が「1 行目」・close が「最終行」に一致するので、旧実装は
        //  「もう囲まれている」と誤読して外し、境界の fence だけを剥いで
        //  内側の fence(2 つ目の開き・1 つ目の閉じ)を孤立させる)
        const before = `${open}\nblock A\n${close}\n${open}\nblock B\n${close}`;
        const out = applyFormat({ text: before, start: 0, end: before.length }, op);

        // ⚠ 壊れた形そのもの: 外側の fence が剥がれて、本文の先頭が裸の中身から
        //   始まる(旧実装は「先頭行が open・最終行が close」を丸ごと囲みと
        //   誤読して両方剥がすので、選択の先頭がそのまま文書の先頭になる選択
        //   ではここが必ず裸になる)
        expect(out.text.startsWith('block A'), '外側の fence が剥がれて中身が裸になった').toBe(false);
        // ⚠ 2 つの囲みは、それぞれ依然として fence の中に居る(内容も fence も
        //   1 バイトも失っていない)
        expect(out.text).toContain(`${open}\nblock A\n${close}`);
        expect(out.text).toContain(`${open}\nblock B\n${close}`);
      });
    }

    /**
     * 🔴 **総当たりの残り(コーディネーターの指定)**: 門を置かなかった形を
     * 個別に潰す ── 囲みが選択の**前だけ** / **後だけ**にある形。
     * ⚠ 「両方」(上のループ)だけでは、`isAdjacentPair` の**片側だけが
     * 存在しない**分岐(`roleAt` が `-1` を返す側)を 1 度も通らない。
     */
    for (const { op, open } of FENCES.filter((f) => f.open === f.close)) {
      it(`${op}: 囲みが選択の前だけに在っても、その囲みを巻き込まない`, () => {
        const before = `${open}\nold\n${open}\n今日は晴れです`;
        const idx = before.indexOf('今日は晴れです');
        const out = applyFormat({ text: before, start: idx, end: idx + '今日は晴れです'.length }, op);
        expect(out.text).toContain('old');
        expect(out.text).toContain('今日は晴れです');
        expect(out.text, '前の囲みが消えた').not.toBe(`${open}\nold\n今日は晴れです`);
        const fenceLineCount = before.split('\n').filter((l) => l === open).length;
        const afterCount = out.text.split('\n').filter((l) => l === open).length;
        expect(afterCount, 'fence 行が減った').toBeGreaterThan(fenceLineCount);
      });

      it(`${op}: 囲みが選択の後だけに在っても、その囲みを巻き込まない`, () => {
        const before = `今日は晴れです\n${open}\nold\n${open}`;
        const out = applyFormat({ text: before, start: 0, end: '今日は晴れです'.length }, op);
        expect(out.text).toContain('old');
        expect(out.text).toContain('今日は晴れです');
        expect(out.text, '後の囲みが消えた').not.toBe(`今日は晴れです\n${open}\nold`);
        const fenceLineCount = before.split('\n').filter((l) => l === open).length;
        const afterCount = out.text.split('\n').filter((l) => l === open).length;
        expect(afterCount, 'fence 行が減った').toBeGreaterThan(fenceLineCount);
      });
    }

    it('🔴 空行だけの選択を囲んでも、前後の中身は失われない', () => {
      const before = 'まえ\n\n\nあと';
      const start = before.indexOf('\n\n\n') + 1; // 2 本の空行の間
      const out = applyFormat({ text: before, start, end: start + 1 }, 'codeblock');
      expect(out.text).toContain('まえ');
      expect(out.text).toContain('あと');
      expect(out.text).toContain('```');
    });

    it('🔴 全角の字を選んで囲んでも、1 文字も変わらない', () => {
      const before = 'まえ３＋４＝きろく';
      const idx = before.indexOf('３＋４＝');
      const out = applyFormat({ text: before, start: idx, end: idx + '３＋４＝'.length }, 'codeblock');
      expect(out.text).toContain('３＋４＝');
      expect(out.text).toContain('まえ');
      expect(out.text).toContain('きろく');
    });
  });

  describe('表(選んだ行を素直に表にする)', () => {
    it('🔴 選んだ字は消えない(CSV 風の複数行が升に入る)', () => {
      const csv = '見出A,見出B\n1,2\n3,4';
      const out = applyFormat({ text: csv, start: 0, end: csv.length }, 'table');
      expect(out.text).toContain('見出A');
      expect(out.text).toContain('見出B');
      expect(out.text).toContain('| 1 | 2 |');
      expect(out.text).toContain('| 3 | 4 |');
      // ⚠ markdown の表として読める形(区切り行を持つ)
      expect(out.text).toMatch(/\|\s*---\s*\|\s*---\s*\|/);
      /**
       * 🔴 **1 行目が見出しになっていること**(`toContain` だけでは見えない)。
       * ⚠ 見出しの判定を取り違えても(例: 2 行目を見出しにしても)、
       *   `gfmTable` は空の見出しを補って**升の中身自体は残す**ので、上の
       *   `toContain` は**全部通ってしまう**(変異試験 M8 が SURVIVED で教えた)。
       * 🔑 だから**表の並び順そのもの**(1 行目 → 区切り → データ)を見る。
       */
      const lines = out.text.split('\n').filter((l) => l.startsWith('|'));
      expect(lines[0], '1 行目が見出しになっていない').toBe('| 見出A | 見出B |');
      expect(lines[1]).toMatch(/^\|\s*---\s*\|\s*---\s*\|$/);
      expect(lines[2]).toBe('| 1 | 2 |');
      expect(lines[3]).toBe('| 3 | 4 |');
    });

    it('区切りの無い 1 行は 1 升の見出しだけの表になる(文字が消えない)', () => {
      const out = applyFormat({ text: 'ただの文', start: 0, end: 4 }, 'table');
      expect(out.text).toContain('ただの文');
      expect(out.text).toContain('|');
    });

    /**
     * 🔴 **着地前レビュー ⑥の再現**: 既に表に見える選択にもう一度「表」を
     * 押すと、`|` がセルの値として読まれ `gfmCellText` が `\|` へ逃がすので
     * `| \| a \| b \| |` のような壊れた升になっていた。
     *
     * 🔑 **決めたこと(user 裁定が要る所は変えない)**: 完全なトグル(表 →
     * 元の CSV/TSV)は作らない ── ここで見るのは「壊さない(そのまま返す)」
     * ことだけ。⚠ この test は**直す前は落ちる**
     * (`looksLikeTable` を差し戻して確認済み)。
     */
    it('🔴 既に表に見える選択は、壊さずそのまま返す(二重変換しない)', () => {
      const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';
      const out = applyFormat({ text: table, start: 0, end: table.length }, 'table');
      expect(out.text, '既に表なのに変換して壊れた').toBe(table);
      // ⚠ 壊れた形そのもの(`|` がセルの値として逃がされる)が出ていない
      expect(out.text).not.toContain('\\|');
    });

    /**
     * 🔴 **`looksLikeTable` の判定を片方だけにする変異への網**
     * (`startsWith('|')` だけ・`endsWith('|')` だけでは、**半分だけ `|` の
     * 形をした素の文章**を「もう表」と誤読して、変換せず素通りさせてしまう)。
     */
    it('🔴 行の先頭に `|` が無ければ、表に見えないので変換する', () => {
      // 全行が `|` で終わるが、始まってはいない ── 表には見えない
      const before = 'a, b|\nc, d|';
      const out = applyFormat({ text: before, start: 0, end: before.length }, 'table');
      expect(out.text, '表に見えると誤読して変換しなかった').not.toBe(before);
      expect(out.text).toContain('| a');
    });

    it('🔴 行の末尾に `|` が無ければ、表に見えないので変換する', () => {
      // 全行が `|` で始まるが、終わってはいない ── 表には見えない
      const before = '|a, b\n|c, d';
      const out = applyFormat({ text: before, start: 0, end: before.length }, 'table');
      expect(out.text, '表に見えると誤読して変換しなかった').not.toBe(before);
    });

    it('🔴 全角の字が升に入っていても、tab で正しく割る', () => {
      const before = '品目\t数量\nりんご\t３個';
      const out = applyFormat({ text: before, start: 0, end: before.length }, 'table');
      expect(out.text).toContain('| 品目 | 数量 |');
      expect(out.text).toContain('| りんご | ３個 |');
    });

    it('🔴 tab 区切り(表計算からの貼り付け)は tab のほうを使う', () => {
      const out = applyFormat({ text: 'A\tB\n1\t2', start: 0, end: 7 }, 'table');
      // ⚠ comma で割っていたら 1 升(タブごと 1 文字列)になり、A/B が別升に来ない
      expect(out.text).toContain('| A | B |');
      expect(out.text).toContain('| 1 | 2 |');
    });

    /**
     * 🔴 **着地前レビュー ②の再現**: 日本語の桁区切りカンマは comma を
     * 「多く数える」ので、生の文字数(tab=1・comma=2)で選ぶと tab で
     * 割るべき 2 列の貼り付けが comma で割られ、升がバラバラになる。
     *
     * ⚠ この test は**直す前(生の文字数で数える版)は落ちる**
     * (`/tmp/claude-0/scratch-950/text-ops.ts.bak` の `pickCsvDelimiter` で
     * 確認済み ── tabs=1, commas=2 なので `tabs > commas` が false になり
     * comma が選ばれ、`| 備考\t合計は1 | 200 | 000円です |` に壊れていた)。
     */
    it('🔴 日本語の桁区切りカンマがあっても、tab のほうを使う(生の文字数で数えない)', () => {
      const before = '備考\t合計は1,200,000円です';
      const out = applyFormat({ text: before, start: 0, end: before.length }, 'table');
      expect(out.text).toContain('| 備考 | 合計は1,200,000円です |');
      // ⚠ 壊れた形(comma で割ってしまい、数字が升にバラバラに散る)が出ていない
      expect(out.text).not.toContain('| 200 |');
      expect(out.text).not.toContain('| 000円です |');
    });

    /**
     * 🔴 **`isSelfConsistent` の `width > 1` を落とす変異への網**。
     *
     * ⚠ tab が 1 個も無い文書は、tab で割ると**全行が幅 1 に「一致」する**
     *   (何も割れていないだけなのに、揃って見えてしまう)。`width > 1` を
     *   落とすと、tab が無いのに `tabOk` が真になりうる ── ここでは
     *   「comma のほうが真に自己無矛盾(幅 3/2 の不一致は無い前提)」を
     *   崩す形にはせず、**comma が不一致で tab が『無いのに真』になる**
     *   場面をそのまま作る(comma は行ごとに列数が違うので、この文書は
     *   本来どちらの区切り字でも綺麗には割れない ── 実装は comma へ倒す
     *   ── のが正しい)。
     */
    it('🔴 tab が 1 つも無いのに「揃って見える」だけで tab を選ばない', () => {
      const before = '田中さん,鈴木さん,佐藤さんへ\n会議は10時,場所はA会議室です';
      const out = applyFormat({ text: before, start: 0, end: before.length }, 'table');
      // ⚠ 壊れた形(tab が 1 個も無いのに tab を選び、各行が 1 升に潰れる)
      expect(out.text, 'tab が無いのに tab を選んだ(行が 1 升に潰れた)').not.toContain(
        '| 田中さん,鈴木さん,佐藤さんへ |',
      );
      expect(out.text).toContain('| 田中さん | 鈴木さん | 佐藤さんへ |');
    });

    /**
     * 🔴 **`tabOk !== commaOk` の判定を弱める変異への網**
     * (`if (tabOk)` だけにすると、comma が真に自己無矛盾なのに、迷い込んだ
     * 生の tab 1 個(区切りとしては機能していない)に負けて tab を選ぶ)。
     */
    it('🔴 comma が自己無矛盾なら、迷い込んだ生の tab 1 個に負けない', () => {
      const before = '見出A,見出B\n1,2\tstray\n3,4';
      const out = applyFormat({ text: before, start: 0, end: before.length }, 'table');
      expect(out.text, 'comma で割るべきなのに tab を選んだ').toContain('| 見出A | 見出B |');
    });

    it('選んでいないときは、これまでどおり空の 2 列の雛形(壊さない)', () => {
      const out = applyFormat({ text: '', start: 0, end: 0 }, 'table');
      expect(out.text.split('\n')[0]).toBe('| 項目 | 値 |');
    });

    it('空白だけの選択は、空の雛形へ逃がす(何も囲む中身が無いので)', () => {
      const out = applyFormat({ text: 'あ   お', start: 1, end: 4 }, 'table');
      expect(out.text).toContain('あ');
      expect(out.text).toContain('お');
      expect(out.text).toContain('| 項目 | 値 |');
    });

    it('行の途中で選んでも、表は行として立つ(前後に改行)', () => {
      const out = applyFormat({ text: '文の途中です', start: 2, end: 4 }, 'table');
      const lines = out.text.split('\n');
      expect(lines.some((l) => l.startsWith('|'))).toBe(true);
      expect(out.text).toContain('文の');
      expect(out.text).toContain('です');
    });
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
/**
 * 🔴 **「図」を押したときに選べる表**(#528 案 B。user 裁定 2026-09-04)。
 * ⚠ 繋がり(押す → 開く → 入る)は `tests/adapter/format-append.test.ts`。
 *   ここは**表そのもの**の約束 ── 先頭がこれまでの「図」であること / 5 種 / 重複なし。
 */
describe('図の一覧の表(#528 案 B)', () => {
  it('🔴 先頭はこれまでの「図」そのもの(MERMAID_BLOCK と同一の実体)', () => {
    // ⚠ `toEqual` ではなく同一性 ── 写しを置くと、片方を直した日に食い違う
    expect(DIAGRAM_CHOICES[0]!.block).toBe(MERMAID_BLOCK);
    expect(DIAGRAM_CHOICES[0]!.label).toBe('フローチャート');
    // 対照群 ── 中身は今までの「図」と 1 バイト違わない
    expect(applyFormat({ text: '', start: 0, end: 0 }, 'mermaid').text).toBe(
      DIAGRAM_CHOICES[0]!.block.text,
    );
  });

  it('🔴 5 種 = フローチャート + UML の 4 種(表から引いていて、数も名指しで pin)', () => {
    expect(DIAGRAM_CHOICES).toHaveLength(5);
    expect(DIAGRAM_CHOICES.slice(1)).toEqual(DIAGRAM_TEMPLATES);
    expect(new Set(DIAGRAM_CHOICES.map((d) => d.id)).size, 'id が重複').toBe(5);
    expect(new Set(DIAGRAM_CHOICES.map((d) => d.label)).size, '字が重複').toBe(5);
    // ⚠ 5 つとも mermaid の囲みで始まり、2 行目が種類の名前(空の枠を入れない)
    for (const d of DIAGRAM_CHOICES) {
      const lines = d.block.text.split('\n');
      expect(lines[0], `${d.label} が mermaid の囲みで始まっていない`).toBe('```mermaid');
      expect(lines[1]!.trim().length, `${d.label} の 1 行目(種類)が空`).toBeGreaterThan(0);
    }
  });

  it('🔴 「図」は書式の帯の表からは外れている(押すと先に聞くため)', () => {
    expect(BAR_FORMAT_OPS.map((o) => o.op)).not.toContain('mermaid');
    // ⚠ op そのものは残っている(雛形の一覧と表の先頭が挿す口)
    expect(FORMAT_OPS.map((o) => o.op)).toContain('mermaid');
  });
});

describe('autoPairFor(auto pair の規則)', () => {
  const at = (text: string, start: number, end = start) => ({ text, start, end });

  it('① 行内の対は閉じが入り、caret は中に来る', () => {
    const r = autoPairFor(at('あ', 1), '「');
    expect(r).toEqual({ kind: 'insert', insert: '「」', start: 2, end: 2 });
  });

  it('① 選択があるときは囲む(選んだ文字が消えない)', () => {
    const r = autoPairFor(at('あここい', 1, 3), '「');
    expect(r).toEqual({ kind: 'insert', insert: '「ここ」', start: 2, end: 4 });
  });

  it('② 🔴 行頭の 3 つ目のバッククォートで、閉じが**次の行**に入る', () => {
    // 行頭に `` が在る状態で 3 つ目を打つ
    const r = autoPairFor(at('``', 2), '`');
    expect(r).toEqual({ kind: 'insert', insert: '`\n```', start: 3, end: 3 });
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
    expect(r).toEqual({ kind: 'insert', insert: ':\n:::', start: 3, end: 3 });
    expect('::' + r!.insert).toBe(':::\n:::');
  });

  it('② 4 つ目以降は閉じを足さない(閉じが二重に増えない)', () => {
    expect(autoPairFor(at('```', 3), '`')).toBeNull();
  });

  it('② 行頭でも、後ろに文字が在るならブロックとして扱わない', () => {
    // `` |あ` のような途中 ── ここでブロックの閉じを入れると本文を割る
    const r = autoPairFor(at('``あ', 2), '`');
    expect(r).toEqual({ kind: 'insert', insert: '``', start: 3, end: 3 });
  });

  it('② 行の途中のバッククォートは行内の対(行頭判定が緩んでいない)', () => {
    const r = autoPairFor(at('あ``', 3), '`');
    expect(r).toEqual({ kind: 'insert', insert: '``', start: 4, end: 4 });
  });

  it('② 2 行目の行頭でも効く(行の切り出しが先頭固定になっていない)', () => {
    const r = autoPairFor(at('あ\n``', 4), '`');
    expect(r).toEqual({ kind: 'insert', insert: '`\n```', start: 5, end: 5 });
  });

  it('③ 対でない打鍵は null(ブラウザにそのまま打たせる)', () => {
    expect(autoPairFor(at('あ', 1), 'x')).toBeNull();
    expect(autoPairFor(at('あ', 1), 'Enter')).toBeNull();
  });
});

/**
 * 🔴 **閉じ記号の通り抜け**(2026-08-21、cowork 実機レポート #15)。
 *
 * 報告:「`tags: [あ, い]` と打つと `tags: [あ, い]]` になる」。⚠ **Q3 と Q5 の
 * 両方で踏んでいた** ── つまり user も同じ所で必ず引っかかる。
 *
 * 🔴 **被害は「余分な 1 文字」では済まない。** `frontmatter.ts` は
 * `tags: [あ, い]]` を `startsWith('[') && endsWith(']')` で受理するので、
 * **警告 0 件で `{tags:["あ","い]"]}` と読む** ── タグが**無言で別物になる**。
 *
 * ⚠ **開き側しか当てていなかった。** 対は 9 組と**有限**なのに、既存の test は
 * 開き記号(`「` / `` ` `` / `:`)しか打っておらず、閉じを打つ test は
 * リポジトリ全体で **0 件**だった(CLAUDE.md §2「表に載っている件数は
 * 誰かが数えた分でしかない ── 組み合わせが有限なら全部当てる」)。
 * 🔑 だからここは **9 対 × 3 状況の全数表**にする。
 */
describe('🔴 閉じ記号の通り抜け(9 対の全数)', () => {
  const at = (text: string, start: number, end = start) => ({ text, start, end });

  /** 開き → 閉じ。⚠ **実装の表を写さない**(写すと本物が変わってもここは古いまま)。 */
  const PAIRS: ReadonlyArray<readonly [string, string]> = [
    ['`', '`'],
    ['[', ']'],
    ['(', ')'],
    ['{', '}'],
    ['「', '」'],
    ['『', '』'],
    ['（', '）'],
    ['【', '】'],
    ['"', '"'],
  ];

  /** 打鍵を 1 文字ずつ流して、出来上がる本文と caret を返す(`row-swap` の意味論)。 */
  const typeAll = (keys: readonly string[]): { text: string; caret: number } => {
    let text = '';
    let caret = 0;
    for (const key of keys) {
      const r = autoPairFor({ text, start: caret, end: caret }, key);
      if (r === null) {
        text = text.slice(0, caret) + key + text.slice(caret);
        caret += key.length;
        continue;
      }
      if (r.kind === 'insert') text = text.slice(0, caret) + r.insert + text.slice(caret);
      caret = r.start;
    }
    return { text, caret };
  };

  it('🔴 9 対とも、開いて中を打って閉じると「対が 1 組」になる', () => {
    const broken: string[] = [];
    for (const [open, close] of PAIRS) {
      // ⚠ 行頭を避ける(行頭は ``` / ::: のブロック枝が先に効く ── 別の主張)
      const { text } = typeAll(['x', open, 'あ', close]);
      if (text !== `x${open}あ${close}`) broken.push(`${open}${close}: ${text}`);
    }
    expect(broken, `閉じが二重になった対: ${broken.join(' / ')}`).toEqual([]);
  });

  it('🔴 報告そのもの ── tags: [あ, い] がそのまま残る', () => {
    const { text } = typeAll([...'tags: [あ, い]']);
    expect(text, 'frontmatter のタグが無言で別物になる形').toBe('tags: [あ, い]');
  });

  it('🔴 報告そのもの ── - [ ] やること がそのまま残る', () => {
    const { text } = typeAll([...'- [ ] やること']);
    expect(text).toBe('- [ ] やること');
  });

  it('入れ子でも通り抜ける ── [題](url) がそのまま残る', () => {
    const { text } = typeAll([...'[題](url)']);
    expect(text).toBe('[題](url)');
  });

  it('通り抜けたら caret は閉じの右へ進む(挿さずに跨ぐ)', () => {
    const r = autoPairFor(at('[]', 1), ']');
    expect(r).toEqual({ kind: 'skip', insert: '', start: 2, end: 2 });
  });

  /**
   * ⚠ **通り抜けてよいのは「すぐ右がその閉じ」のときだけ。**
   *   そうでないなら普通に 1 文字打つ(= `null`)── ここを緩めると
   *   「閉じを打ったのに入らない」という**逆の壊れ方**になる。
   */
  it('すぐ右が別の字なら通り抜けない(そのまま打たせる)', () => {
    expect(autoPairFor(at('[あ', 1), ']')).toBeNull();
    expect(autoPairFor(at('[', 1), ']')).toBeNull();
    expect(autoPairFor(at('', 0), ']')).toBeNull();
  });

  /** ⚠ 選択があるときは通り抜けない ── 選んだ文字を閉じで囲むほうが自然。 */
  it('選択があるときは通り抜けず、囲む(同字対)', () => {
    const r = autoPairFor(at('"ここ"', 1, 3), '"');
    expect(r).toEqual({ kind: 'insert', insert: '"ここ"', start: 2, end: 4 });
  });

  /**
   * 🔴 **同字対は通り抜けを先に判定する。** 後回しにすると「開き」と読んで
   *   新しい対を開くので、被害が 1 文字増える(直す前は `"あ"` が `"あ"""`)。
   */
  it('🔴 同字対(バッククォート / 二重引用符)も通り抜ける', () => {
    expect(autoPairFor(at('x``', 2), '`')).toEqual({
      kind: 'skip',
      insert: '',
      start: 3,
      end: 3,
    });
    expect(autoPairFor(at('x""', 2), '"')).toEqual({
      kind: 'skip',
      insert: '',
      start: 3,
      end: 3,
    });
  });

  /** ⚠ ブロック(``` / :::)の組み立ては、通り抜けに食われていない。 */
  it('行頭のブロック組み立ては変わらない(通り抜けが先に効いていない)', () => {
    expect(autoPairFor(at('``', 2), '`')).toEqual({
      kind: 'insert',
      insert: '`\n```',
      start: 3,
      end: 3,
    });
    expect(autoPairFor(at('```', 3), '`')).toBeNull();
  });
});
