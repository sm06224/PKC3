/**
 * メッセージ型(設計 doc ui-total-design-2026-09.md §7、段②a)。
 *
 * ⚠ 守っているのは「形」「中身を漏らさない」「未読の数え方」の 3 つ。
 * ⚠ 守っていないもの:worker 側の同時書込耐性(1 tx で守る ── storage-worker.test.ts)、
 *   adapter 側の控え(message-post.test.ts)。
 */
import { describe, expect, it } from 'vitest';
import {
  MESSAGE_CAP_DEFAULT,
  MESSAGE_CAP_OPTIONS,
  JOB_CAP,
  MESSAGE_KIND_LABEL,
  SYSTEM_JOB_LID,
  SYSTEM_MESSAGE_LID,
  capForMessageLid,
  countUnread,
  formatMessageSection,
  isSystemMessageLid,
  lidForMessageKind,
  sanitizeMessageText,
  titleForMessageLid,
  trimToCap,
  type MessageKind,
} from '../../src/features/message/message-log';

describe('lid / 題名 / 上限(段②a)', () => {
  it('種類ごとに正しい lid へ振り分ける', () => {
    for (const k of ['result', 'caution', 'problem', 'delivery'] as MessageKind[]) {
      expect(lidForMessageKind(k)).toBe(SYSTEM_MESSAGE_LID);
    }
    expect(lidForMessageKind('job')).toBe(SYSTEM_JOB_LID);
  });

  it('🔴 isSystemMessageLid は 2 lid だけ true(判定は 1 か所)', () => {
    expect(isSystemMessageLid(SYSTEM_MESSAGE_LID)).toBe(true);
    expect(isSystemMessageLid(SYSTEM_JOB_LID)).toBe(true);
    expect(isSystemMessageLid('普通のノート')).toBe(false);
    expect(isSystemMessageLid('')).toBe(false);
  });

  it('題名は lid で決まる', () => {
    expect(titleForMessageLid(SYSTEM_MESSAGE_LID)).toBe('メッセージ');
    expect(titleForMessageLid(SYSTEM_JOB_LID)).toBe('処理の記録');
  });

  it('job は configuredCap を無視して 5,000 で固定', () => {
    expect(capForMessageLid(SYSTEM_JOB_LID, 100)).toBe(JOB_CAP);
    expect(capForMessageLid(SYSTEM_MESSAGE_LID, 100)).toBe(100);
    expect(MESSAGE_CAP_OPTIONS).toContain(MESSAGE_CAP_DEFAULT);
  });

  it('5 種類の画面の字が全部揃っている', () => {
    expect(MESSAGE_KIND_LABEL).toEqual({
      result: '結果',
      caution: '注意',
      problem: '問題',
      delivery: '配信',
      job: '処理',
    });
  });
});

describe('formatMessageSection(段②a)', () => {
  it('見出し + 太字の種類 + 出所 + 文、の形で組む', () => {
    const s = formatMessageSection({
      at: '2026-09-21T05:11:22.000Z',
      kind: 'problem',
      source: 'app',
      text: '保存できませんでした',
    });
    expect(s).toMatch(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n/);
    // 🔴 `app` は出所として言う意味が無いので書かない(英語の内部名を画面に出さない。#1087)
    expect(s).toContain('**問題** 保存できませんでした');
    expect(s).not.toContain('app:');
    expect(s.endsWith('\n\n')).toBe(true);
  });

  it('🔴 出所は日本語で書く(内部の英語名を出さない)/ 表に無い名前はそのまま', () => {
    const at = '2026-09-21T05:11:22.000Z';
    const line = (source: string): string =>
      formatMessageSection({ at, kind: 'caution', source, text: 'x' }).split('\n')[1] ?? '';
    expect(line('quota')).toBe('**注意** 保存領域の空き: x');
    expect(line('storage')).toBe('**注意** 保存先: x');
    expect(line('notice')).toBe('**注意** お知らせ: x');
    expect(line('schedule')).toBe('**注意** 予定: x');
    expect(line('portable-boot')).toBe('**注意** PKC3 入り HTML の起動: x');
    expect(line('office-profile')).toBe('**注意** Office: x');
    expect(line('db-rescue-rebuild')).toBe('**注意** ノートの保存データの作り直し: x');
    expect(line('db-rescue-reset')).toBe('**注意** ノートの保存データの初期化: x');
    expect(line('storage-vacuum')).toBe('**注意** 保存領域を縮める: x');
    expect(line('force-release')).toBe('**注意** 書き込みの強制終了: x');
    expect(line('status')).toBe('**注意** x');
    // 処理の記録の lane 名・既に日本語の出所は触らない
    expect(line('markdown-render')).toBe('**注意** markdown-render: x');
    expect(line('貼り付け')).toBe('**注意** 貼り付け: x');
    // 日本語にしても未読の数え方は変わらない(種類の太字を読むだけ)
    const body = formatMessageSection({ at, kind: 'caution', source: 'quota', text: 'x' });
    expect(countUnread(body, null)).toBe(1);
  });

  it('🔴 種類が変わると、字も変わる(貼り替えではないことを見る)', () => {
    const base = { at: '2026-09-21T00:00:00.000Z', source: 'app', text: 'x' };
    const result = formatMessageSection({ ...base, kind: 'result' });
    const caution = formatMessageSection({ ...base, kind: 'caution' });
    expect(result).toContain('**結果**');
    expect(caution).toContain('**注意**');
    expect(result).not.toContain('**注意**');
  });
});

describe('sanitizeMessageText(中身を漏らさない。#7)', () => {
  // ⚠ 「押した場所」の実装ノートが列挙する 13 か所の形は、全部 「…」/『…』 のどちらか
  it('「…」の中身を潰す(題名・見出し)', () => {
    expect(sanitizeMessageText('「私の秘密の日記」を開けませんでした')).toBe(
      '「…」を開けませんでした',
    );
  });

  it('『…』の中身を潰す(別の括弧の形)', () => {
    expect(sanitizeMessageText('添付『領収書2026.pdf』が見つかりません')).toBe(
      '添付『…』が見つかりません',
    );
  });

  it('🔴 括弧が複数あれば、全部潰す(1 つ目だけで止めない)', () => {
    expect(sanitizeMessageText('「A」から「B」へ移動しました')).toBe('「…」から「…」へ移動しました');
  });

  it('改行を空白へ変える', () => {
    expect(sanitizeMessageText('1 行目\n2 行目')).toBe('1 行目 2 行目');
  });

  it('80 字を超えたら切って「…」を付ける', () => {
    const long = 'あ'.repeat(90);
    const out = sanitizeMessageText(long);
    expect(out.length).toBe(81); // 80 字 + 省略記号
    expect(out.endsWith('…')).toBe(true);
  });

  it('80 字ちょうどなら切らない', () => {
    const exact = 'あ'.repeat(80);
    expect(sanitizeMessageText(exact)).toBe(exact);
  });

  it('括弧も改行も無い普通の文はそのまま', () => {
    expect(sanitizeMessageText('起動しました')).toBe('起動しました');
  });

  /**
   * 🔴 **アプリが書いた固定の文は、頭が一致するあいだ潰さず切らない**(#1087)。
   * ⚠ 潰すと案内のボタン名(「容量の内訳」)が「…」になり、80 字で切ると「次にすること」が落ちる。
   */
  it('🔴 固定の頭(fixedHead)は括弧も 80 字も通し、続きの生の字だけ潰して切る', () => {
    const head = 'あ'.repeat(100) + 'システムの「容量の内訳」を開いてください。';
    expect(sanitizeMessageText(head, head)).toBe(head);
    // 続きは今までどおり
    const withRaw = sanitizeMessageText(`${head}(検出: 「秘密.pdf」)`, head);
    expect(withRaw.startsWith(head)).toBe(true);
    expect(withRaw).toContain('「…」');
    expect(withRaw).not.toContain('秘密');
    // 頭が一致しない文には効かない(対照群 ── 固定の印を付ければ何でも通る穴にしない)
    const other = sanitizeMessageText(`「秘密」${'い'.repeat(100)}`, head);
    expect(other).not.toContain('秘密');
    expect(other.endsWith('…')).toBe(true);
  });
});

describe('改行の類は節を割らない(#1087)', () => {
  /** 🔴 `\r` / U+2028 / U+2029 は、`## ` の前なら節の切れ目になる(`splitSections` の `^` が当たる)。 */
  const breaks: ReadonlyArray<[string, string]> = [
    ['CR', '\r'],
    ['CRLF', '\r\n'],
    ['LF', '\n'],
    ['U+2028', '\u2028'],
    ['U+2029', '\u2029'],
  ];
  for (const [name, br] of breaks) {
    it(`${name} の後ろに ## を置いた字でも、節は 1 件のまま`, () => {
      const text = sanitizeMessageText(`1 行目${br}## 偽の節${br}**問題** 偽`);
      expect(text).not.toMatch(/[\r\n\u2028\u2029]/);
      const section = formatMessageSection({ at: '2026-10-01T00:00:00Z', kind: 'problem', source: 'app', text });
      // 対照:節を 2 つ並べて、数えるのは 2 件(割れていないから 2 件で止まる)
      expect(countUnread(section + section, null)).toBe(2);
      expect(trimToCap(section + section, 1)).toBe(section);
    });
    it(`${name} は固定の頭(fixedHead)の中でも空白になる`, () => {
      const head = `頭${br}## 偽`;
      expect(sanitizeMessageText(head, head)).toBe('頭 ## 偽');
    });
  }
});

describe('trimToCap(古い節から落とす)', () => {
  const sectionAt = (n: number): string =>
    formatMessageSection({
      at: `2026-09-${String(10 + n).padStart(2, '0')}T00:00:00.000Z`,
      kind: 'result',
      source: 'app',
      text: `件 ${n}`,
    });

  it('上限以下なら 1 バイトも変えない', () => {
    const body = [sectionAt(1), sectionAt(2)].join('');
    expect(trimToCap(body, 5)).toBe(body);
  });

  it('🔴 上限を超えたら、古い節から落とす(新しい節を残す)', () => {
    const body = [sectionAt(1), sectionAt(2), sectionAt(3)].join('');
    const trimmed = trimToCap(body, 2);
    expect(trimmed).not.toContain('件 1');
    expect(trimmed).toContain('件 2');
    expect(trimmed).toContain('件 3');
  });

  it('空の本文はそのまま(0 件)', () => {
    expect(trimToCap('', 5)).toBe('');
  });

  it('ちょうど上限なら 1 バイトも変えない', () => {
    const body = [sectionAt(1), sectionAt(2)].join('');
    expect(trimToCap(body, 2)).toBe(body);
  });
});

describe('countUnread(注意 / 問題だけ数える)', () => {
  const at = (h: number): string => `2026-09-21T0${h}:00:00.000Z`;

  it('結果・配信・処理は未読に数えない', () => {
    const body = [
      formatMessageSection({ at: at(1), kind: 'result', source: 'a', text: 'x' }),
      formatMessageSection({ at: at(2), kind: 'delivery', source: 'a', text: 'x' }),
      formatMessageSection({ at: at(3), kind: 'job', source: 'a', text: 'x' }),
    ].join('');
    expect(countUnread(body, null)).toBe(0);
  });

  it('🔴 注意・問題は数える', () => {
    const body = [
      formatMessageSection({ at: at(1), kind: 'caution', source: 'a', text: 'x' }),
      formatMessageSection({ at: at(2), kind: 'problem', source: 'a', text: 'x' }),
      formatMessageSection({ at: at(3), kind: 'result', source: 'a', text: 'x' }),
    ].join('');
    expect(countUnread(body, null)).toBe(2);
  });

  it('読んだ時刻より前の節は数えない', () => {
    const body = [
      formatMessageSection({ at: at(1), kind: 'problem', source: 'a', text: 'x' }),
      formatMessageSection({ at: at(5), kind: 'problem', source: 'a', text: 'y' }),
    ].join('');
    expect(countUnread(body, at(3))).toBe(1);
  });

  it('読んだ直後(読んだ時刻ちょうど)は未読に数えない', () => {
    const body = formatMessageSection({ at: at(3), kind: 'problem', source: 'a', text: 'x' });
    expect(countUnread(body, at(3))).toBe(0);
  });
});
