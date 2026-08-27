/**
 * #395 段①: **追記の入り先を選べる**。
 *
 * > user の物語: 長い議事録の「決定事項」の節に 1 行だけ足したい。
 *
 * 見るのは 4 点:
 * ① 見出しが並ぶか(fence・frontmatter に騙されないか)
 * ② 🔴 **選んだ節の末尾に入るか**(次の節へこぼれない)
 * ③ 🔴 **印が解けなければ足さないか**(黙って末尾へ落とさない)
 * ④ 同じ字の見出しが 2 つあっても取り違えないか
 */
import { describe, expect, it } from 'vitest';
import {
  appendIntoSection,
  insertedLines,
  listAppendTargets,
  removeInsertedLines,
  resolveAppendAt,
  sectionAt,
} from '../../src/features/markdown/append-target';

const DOC = [
  '# 議事録',
  '',
  '出席者は 3 名。',
  '',
  '## 決定事項',
  '',
  '- A を採用する',
  '',
  '## 次回',
  '',
  '来週。',
  '',
].join('\n');

describe('入り先の一覧', () => {
  it('見出しが深さつきで並ぶ', () => {
    expect(listAppendTargets(DOC).map((t) => [t.level, t.text])).toEqual([
      [1, '議事録'],
      [2, '決定事項'],
      [2, '次回'],
    ]);
  });

  it('🔴 fence の中の # は見出しではない(コードはコードである)', () => {
    const body = ['# 本物', '', '```sh', '# これはコメント', '```', ''].join('\n');
    expect(listAppendTargets(body).map((t) => t.text)).toEqual(['本物']);
  });

  it('🔴 frontmatter の中は見ない(設定の行を節にしない)', () => {
    const body = ['---', 'title: # にせ', 'tags: [x]', '---', '', '# 本物', ''].join('\n');
    expect(listAppendTargets(body).map((t) => t.text)).toEqual(['本物']);
  });

  it('⚠ 同じ字の見出しは別の印になる(取り違えたら別の節へ入る)', () => {
    const body = ['## 補足', '', 'a', '', '## 補足', '', 'b', ''].join('\n');
    const slugs = listAppendTargets(body).map((t) => t.slug);
    expect(new Set(slugs).size, '2 つの節が同じ印になっている').toBe(2);
  });

  it('見出しが 1 つも無ければ空(末尾しか選べない)', () => {
    expect(listAppendTargets('ただの本文\n')).toEqual([]);
  });
});

describe('入る位置', () => {
  const slugOf = (text: string): string =>
    listAppendTargets(DOC).find((t) => t.text === text)!.slug;

  it('🔴 節の実のある最後の行の次(空行の下に置かない)', () => {
    // '- A を採用する' は 6 行目(0 起点)── その次
    expect(resolveAppendAt(DOC, slugOf('決定事項'))).toBe(7);
  });

  it('⚠ 深い見出しは自分の節の中身(跨ぐ)', () => {
    const body = ['# 章', '', 'a', '', '## 節', '', 'b', '', '# 次の章', ''].join('\n');
    const chapter = listAppendTargets(body).find((t) => t.text === '章')!.slug;
    // '# 次の章' は 8 行目 → その手前の実のある行 'b'(6 行目)の次
    expect(resolveAppendAt(body, chapter)).toBe(7);
  });

  it('最後の節は本文の終わりまで', () => {
    expect(resolveAppendAt(DOC, slugOf('次回'))).toBe(11);
  });

  it('🔴 印が解けなければ null(在ることにしない)', () => {
    expect(resolveAppendAt(DOC, 'no-such-section')).toBeNull();
  });
});

describe('差し挟む', () => {
  const slugOf = (text: string): string =>
    listAppendTargets(DOC).find((t) => t.text === text)!.slug;

  it('🔴 選んだ節の中に入り、次の節へこぼれない', () => {
    const out = appendIntoSection(DOC, slugOf('決定事項'), null, 'B も採用する')!;
    const lines = out.split('\n');
    const at = lines.indexOf('B も採用する');
    expect(at, '入っていない').toBeGreaterThan(lines.indexOf('- A を採用する'));
    expect(at, '次の節へこぼれた').toBeLessThan(lines.indexOf('## 次回'));
  });

  it('⚠ 直前の段落とくっつかない(1 行空ける)', () => {
    const out = appendIntoSection(DOC, slugOf('決定事項'), null, 'B')!;
    const lines = out.split('\n');
    expect(lines[lines.indexOf('B') - 1], '直前と地続きになっている').toBe('');
  });

  it('⚠ 次の見出しともくっつかない', () => {
    const out = appendIntoSection(DOC, slugOf('決定事項'), null, 'B')!;
    const lines = out.split('\n');
    expect(lines[lines.indexOf('## 次回') - 1]).toBe('');
  });

  it('🔴 印が解けなければ null ── 黙って末尾へ落とさない', () => {
    expect(appendIntoSection(DOC, 'gone', null, 'B')).toBeNull();
  });

  it('🔴 中身が空なら null(空の節を積まない)', () => {
    expect(appendIntoSection(DOC, slugOf('決定事項'), null, '   \n  ')).toBeNull();
  });

  it('ログの日時見出しも一緒に入る', () => {
    const out = appendIntoSection(DOC, slugOf('決定事項'), '### 12:00', 'メモ')!;
    const lines = out.split('\n');
    expect(lines[lines.indexOf('メモ') - 2]).toBe('### 12:00');
    expect(lines.indexOf('メモ'), '次の節へこぼれた').toBeLessThan(lines.indexOf('## 次回'));
  });

  it('🔑 他の行は 1 バイトも変わらない(挿すだけ)', () => {
    const out = appendIntoSection(DOC, slugOf('決定事項'), null, 'B')!;
    const removed = out
      .split('\n')
      .filter((l) => l !== 'B')
      .join('\n');
    // ⚠ 空けた 1 行ぶんだけ増えている ── それ以外は原文と同じ並び
    expect(removed.replace(/\n\n+/g, '\n\n')).toBe(DOC.replace(/\n\n+/g, '\n\n'));
  });
});

/**
 * 🔴 **足したものを外せる**(#395 段①。user 指示 2026-08-23
 * 「**片道の操作を作らない**」)。
 *
 * ⚠ 見るのは「戻せるか」だけではない ── **戻せないときに戻したふりをしないか**が
 * 本題である(別の行が消えるのが、この機構でいちばん悪い負け方)。
 */
describe('取り消しの材料', () => {
  /**
   * ⚠ **run の分かれ方は pin しない**(1 稿目はした ── 落ちて分かった)。
   * 空行を run の**前**に入れるか**後ろ**に入れるかは、同じ本文を作る 2 通りの
   * 書き方であって、どちらでも正しい。字面を pin すると
   * **実装の綴りを test 側に書き写す**ことになり、同じ盲点を共有する
   * (CLAUDE.md §1「期待値は別の観測から作る」)。
   * 🔑 だから見るのは**性質**:取り出した run を消すと元へ戻る。
   */
  it('挿し込んだ行を取り出すと、それを消して元へ戻る', () => {
    const slug = listAppendTargets(DOC).find((t) => t.text === '決定事項')!.slug;
    const next = appendIntoSection(DOC, slug, null, 'B')!;
    const run = insertedLines(DOC, next)!;
    expect(run.join('\n'), '足した字が run に入っていない').toContain('B');
    expect(removeInsertedLines(next, run)).toBe(DOC);
  });

  it('末尾追記でも取り出せる(入り先を選ばない道も戻せる)', () => {
    const run = insertedLines('a\n', 'a\n\nB\n')!;
    expect(removeInsertedLines('a\n\nB\n', run)).toBe('a\n');
  });

  it('🔴 純粋な挿入でなければ null(置換を取り消しの材料にしない)', () => {
    expect(insertedLines('a\nb\n', 'a\nX\nb\nc\n')).toBeNull();
  });

  it('🔴 短くなっていれば null', () => {
    expect(insertedLines('a\nb\n', 'a\n')).toBeNull();
  });

  it('⚠ 同じ行が既に在っても、増えた分だけを取る', () => {
    // 'B' が元から在る本文へ、もう 1 つ 'B' を足した形
    expect(insertedLines('B\n', 'B\nB\n')).toEqual(['B']);
  });
});

describe('取り消し', () => {
  it('足した行が消え、他は 1 バイトも変わらない', () => {
    const slug = listAppendTargets(DOC).find((t) => t.text === '決定事項')!.slug;
    const next = appendIntoSection(DOC, slug, null, 'B')!;
    const run = insertedLines(DOC, next)!;
    expect(removeInsertedLines(next, run)).toBe(DOC);
  });

  it('🔴 その並びが無ければ null ── 黙って別の所を消さない', () => {
    expect(removeInsertedLines(DOC, ['', '在りません'])).toBeNull();
  });

  it('🔴 同じ字が 2 か所にあれば、**後ろのほう**が消える(直前の 1 手)', () => {
    const body = ['x', 'B', 'y', 'B', 'z'].join('\n');
    expect(removeInsertedLines(body, ['B'])).toBe(['x', 'B', 'y', 'z'].join('\n'));
  });

  it('⚠ 上に行が足されていても消せる(行番号を握っていない)', () => {
    const slug = listAppendTargets(DOC).find((t) => t.text === '決定事項')!.slug;
    const next = appendIntoSection(DOC, slug, null, 'B')!;
    const run = insertedLines(DOC, next)!;
    // 別の窓が先頭に 2 行足した後で取り消す
    const shifted = `別の窓の行\nもう 1 行\n${next}`;
    expect(removeInsertedLines(shifted, run)).toBe(`別の窓の行\nもう 1 行\n${DOC}`);
  });

  it('空の並びは null(何も指していない材料で消さない)', () => {
    expect(removeInsertedLines(DOC, [])).toBeNull();
  });
});

/**
 * 🔴 **押した行が居る節**(#495。Alt+クリックで入り先を指す)。
 *
 * > user 裁定 2026-08-27「センターペインの**追記位置指定は Alt+クリック**にしましょう」
 *
 * 見るのは 3 点:
 * ① いちばん近い**上の**見出しが返るか(深い節の中で親を返さない)
 * ② 🔴 **上に見出しが無ければ `null`**(「末尾」へ落とさない ── 押した所と
 *    関係ない場所へ入るのが、この機構でいちばん静かな負け方である)
 * ③ 印が `listAppendTargets` と**同じ綴り**か(食い違うと `<select>` に無い印を選ぶ)
 */
describe('押した行の節を引く(sectionAt)', () => {
  it('その行を含む節が返る', () => {
    expect(sectionAt(DOC, 7)?.text, '「- A を採用する」の行').toBe('決定事項');
    expect(sectionAt(DOC, 11)?.text, '「来週。」の行').toBe('次回');
  });

  it('🔑 見出しそのものの行も、その節に数える', () => {
    expect(sectionAt(DOC, 4)?.text).toBe('決定事項');
  });

  it('🔴 いちばん近い上の見出しを返す(親へ繰り上げない)', () => {
    const body = ['# 親', '', '## 子', '', 'ここ', ''].join('\n');
    expect(sectionAt(body, 4)?.text).toBe('子');
    // 対照群 ── 子より上なら親が返る
    expect(sectionAt(body, 1)?.text).toBe('親');
  });

  it('🔴 上に見出しが無ければ null(末尾へ落とさない)', () => {
    const body = ['まえがき', '', '# 本題', '', 'a', ''].join('\n');
    expect(sectionAt(body, 0), 'まえがきの行で節を返した').toBeNull();
    // 対照群 ── 見出しの下なら返る
    expect(sectionAt(body, 4)?.text).toBe('本題');
  });

  it('見出しが 1 つも無い本文では、どこを押しても null', () => {
    expect(sectionAt('ただの本文。\n\nもう 1 行。', 2)).toBeNull();
  });

  /**
   * 🔴 **`<select>` に並ぶ印と同じ綴りであること** ── 食い違うと、押しても
   *   「一覧に無い」で断られる(実装が別の綴りを作っていても、片方の test だけ
   *   見ていたら分からない。CLAUDE.md §7)。
   */
  it('🔴 印は listAppendTargets と同じ綴り(2 つ目の命名規則を作らない)', () => {
    const body = ['# 決定事項', '', 'a', '', '# 決定事項', '', 'b', ''].join('\n');
    const slugs = listAppendTargets(body).map((t) => t.slug);
    expect(slugs).toHaveLength(2);
    expect(slugs[0]).not.toBe(slugs[1]); // 同じ字でも別の印(取り違えない)
    expect(sectionAt(body, 2)?.slug).toBe(slugs[0]);
    expect(sectionAt(body, 6)?.slug).toBe(slugs[1]);
  });

  /**
   * ⚠ **frontmatter を跨いでも数え方が変わらない** ── 呼び側は原文の行を渡す
   *   契約なので、ここが剥がした側で数えていると**節が 1 つ上へずれる**。
   */
  it('🔴 frontmatter が在っても、原文の行番号で引ける', () => {
    const body = ['---', 'title: x', '---', '# 本題', '', 'ここ', ''].join('\n');
    expect(sectionAt(body, 5)?.text).toBe('本題');
    // 対照群 ── frontmatter の中の行は、まだどの節にも入らない
    expect(sectionAt(body, 1)).toBeNull();
  });
});
