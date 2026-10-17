/** @vitest-environment node */
/**
 * #1163 束 H1(右のペイン)の純関数:書記素の字数 / ファイルの種類の短い名前 / 日付と時刻 /
 * 画面に描かれるチェック欄の数 / タグの読み違え / 括弧なしの URL の置換除外。
 */
import { describe, expect, it } from 'vitest';
import { cheapGraphemeCount, countGraphemes } from '../../src/features/stats/body-stats';
import { mimeLabel } from '../../src/features/asset/mime-label';
import { formatStoredMinute } from '../../src/features/datetime/stored-date';
import { countDrawnTasks } from '../../src/features/markdown/task-drawn';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import { hasMisreadableTagShape } from '../../src/features/flavor/tag-words';
import { frontmatterProblem } from '../../src/features/markdown/frontmatter';
import { applyTagsToBody } from '../../src/features/markdown/body-rewrite';
import { countMatches, replaceAll } from '../../src/features/markdown/body-replace';

describe('依頼 165 / 315:字数は見た目の字数(書記素)で数える', () => {
  it('🔴 絵文字・合字・改行・結合文字を 1 字と数える(UTF-16 の長さとは別の数)', () => {
    const cases: Array<[string, string, number]> = [
      ['絵文字', '😀', 1],
      ['𠮷(サロゲート対の漢字)', '𠮷', 1],
      ['合字の絵文字(家族)', '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}', 1],
      ['Windows の改行', 'a\r\nb', 3],
      ['濁点を別の字で持つ「が」', 'が', 1],
      ['異体字セレクタ付きの漢字', '葛︀', 1],
      ['混ぜた文', 'ab😀あ', 4],
    ];
    for (const [name, text, want] of cases) {
      expect(countGraphemes(text), name).toBe(want);
      // 前提:UTF-16 の長さとは違う数になる形だけを並べている(同じなら、この表は何も言っていない)
      if (name !== '混ぜた文') expect(text.length, `${name}: 前提が崩れている`).toBeGreaterThan(want);
    }
  });

  it('対照群: 分割を要さない本文は length のまま(日本語・ASCII・全角)', () => {
    expect(countGraphemes('あいう abc ＡＢＣ')).toBe('あいう abc ＡＢＣ'.length);
    expect(cheapGraphemeCount('あいう')).toBe(3);
    // 要する本文は「安く数えられない」と言う(呼び手が前回の数を持ち越す)
    expect(cheapGraphemeCount('😀')).toBeNull();
    expect(cheapGraphemeCount('a\r\nb')).toBeNull();
  });
});

describe('依頼 164:ファイルの種類の短い名前', () => {
  it('🔴 PDF などは短い名前、知らない種類は正式な名前のまま、空は「ファイル」', () => {
    expect(mimeLabel('application/pdf')).toBe('PDF');
    expect(mimeLabel('image/png')).toBe('PNG');
    expect(mimeLabel('image/x-unknown')).toBe('画像');
    expect(mimeLabel('application/x-something')).toBe('application/x-something');
    expect(mimeLabel('')).toBe('ファイル');
    expect(mimeLabel('application/pdf; charset=binary')).toBe('PDF');
  });
});

describe('依頼 166:作成・更新に時刻を添える', () => {
  function withTZ<T>(tz: string, fn: () => T): T {
    const before = process.env.TZ;
    process.env.TZ = tz;
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  }
  it('🔴 端末の日付と時刻を分まで(UTC の保存値を端末の時刻へ)。日付だけの値は日付のまま', () => {
    expect(withTZ('Asia/Tokyo', () => formatStoredMinute('2026-08-04 23:30:45'))).toBe('2026-08-05 08:30');
    expect(withTZ('UTC', () => formatStoredMinute('2026-08-04 23:30:45'))).toBe('2026-08-04 23:30');
    expect(formatStoredMinute('2026-08-04')).toBe('2026/08/04');
    expect(formatStoredMinute(null)).toBe('—');
    expect(formatStoredMinute('なにか')).toBe('なにか');
  });
});

describe('依頼 316:右のペインのチェック項目は、画面に描かれる数', () => {
  const drawn = (body: string): { total: number; done: number } => {
    const html = renderMarkdown(body, { interactiveTasks: true });
    const boxes = [...html.matchAll(/<input type="checkbox" class="pkc-task-checkbox"[^>]*>/g)];
    return { total: boxes.length, done: boxes.filter((m) => m[0].endsWith(' checked>')).length };
  };
  const CORPUS: ReadonlyArray<readonly [string, string]> = [
    ['入れ子の箇条書き(画面には出るのに行の走査が数えない)', '- - [ ] a\n- - [x] b\n'],
    ['段落のすぐ後ろの字下げ(画面には出ないのに行の走査が数える)', '段落\n    - [ ] x\n'],
    ['素直な一覧', '- [ ] a\n- [x] b\n- [ ] c\n'],
    ['コードの中', '```\n- [ ] にせ\n```\n- [x] ほん\n'],
    ['前書きの後', '---\ntags: [x]\n---\n- [ ] a\n'],
  ];
  it.each(CORPUS)('🔴 %s: 描く側の数と一致する', (_n, body) => {
    expect(countDrawnTasks(body)).toEqual(drawn(body));
  });
  it('🔑 前提:この corpus には、かんばんの多めの数え方と描く側が割れる形が入っている(入っていなければ、一致は何も言っていない)', async () => {
    const { listTaskItems } = await import('../../src/features/markdown/task-count');
    const diverging = CORPUS.filter(([, b]) => listTaskItems(b).length !== drawn(b).total);
    expect(diverging.length, '割れる形が 1 つも無い').toBeGreaterThanOrEqual(2);
  });
  it('チェックの印が無い本文は描かずに 0 件', () => {
    expect(countDrawnTasks('ふつうの本文\n- 箇条書き\n')).toEqual({ total: 0, done: 0 });
  });
});

describe('依頼 318:タグの書き方を読み違える形は、知らせてタグの足し引きを止める', () => {
  const MISREAD: ReadonlyArray<readonly [string, string]> = [
    ['複数行の [ ]', '---\ntags: [a,\n  b]\n---\n本文\n'],
    ['長い文の書き方 >-', '---\ntags: >-\n  a b\n---\n本文\n'],
    ['空行をはさんだ - a', '---\ntags:\n  - a\n\n  - b\n---\n本文\n'],
    ['行末のメモ', '---\ntags:\n  - a # メモ\n---\n本文\n'],
  ];
  const FINE: ReadonlyArray<readonly [string, string]> = [
    ['1 行の [ ]', '---\ntags: [a, b]\n---\n本文\n'],
    ['普通の - a の並び', '---\ntags:\n  - a\n  - b\n---\n本文\n'],
    ['引用符の中の #', '---\ntags:\n  - "a # b"\n---\n本文\n'],
    ['別の鍵の複数行', '---\ntitle: >-\n  長い\n  題\ntags: [a]\n---\n本文\n'],
  ];
  const frontLines = (b: string): string[] => b.split('\n').slice(1, b.split('\n').indexOf('---', 1));

  it.each(MISREAD)('🔴 %s は読み違える形と言い、右のペインの判定(frontmatterProblem)も言う', (_n, body) => {
    expect(hasMisreadableTagShape(frontLines(body))).toBe(true);
    expect(frontmatterProblem(body)?.kind).toBe('tags');
  });
  it.each(FINE)('対照群: %s は言わない', (_n, body) => {
    expect(hasMisreadableTagShape(frontLines(body))).toBe(false);
    expect(frontmatterProblem(body)?.kind ?? null).not.toBe('tags');
  });
  it('🔴 その本文にはタグを足さない・外さない(書き直すと残りの行が取り残される)', () => {
    for (const [n, body] of MISREAD) {
      const add = applyTagsToBody(body, ['z'], 'add');
      expect(add.body, `${n}: 足してしまった`).toBeNull();
      expect(add.refused, `${n}: 断りの理由が無い`).toBe('unreadable');
      expect(applyTagsToBody(body, ['a'], 'remove').body, `${n}: 外してしまった`).toBeNull();
    }
    // 対照群:読める書き方には今までどおり足せる
    expect(applyTagsToBody(FINE[0]![1], ['z'], 'add').body).not.toBeNull();
  });
});

describe('依頼 320:括弧なしでそのまま書いた URL も、すべて置換で書き換えない', () => {
  it('🔴 URL の中の語は置換の外 / 文の中の同じ語は置換する(対照群)', () => {
    const body = 'docs を見る https://example.com/docs/api と docs を直す\n[説明](https://example.com/docs/api)';
    expect(countMatches(body, 'docs')).toBe(2);
    const r = replaceAll(body, 'docs', 'DOC');
    expect(r.count).toBe(2);
    expect(r.body).toBe('DOC を見る https://example.com/docs/api と DOC を直す\n[説明](https://example.com/docs/api)');
  });
  it('末尾の括弧は URL に含めない(括弧の外の語は置換する)', () => {
    expect(replaceAll('(https://a.example/x)docs', 'docs', 'D').body).toBe('(https://a.example/x)D');
  });
});
