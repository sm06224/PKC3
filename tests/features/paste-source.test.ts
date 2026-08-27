/**
 * 🔴 **貼付でどの形を読むか**(user 指示 2026-08-25、3 通目)。
 *
 * > 「**無言でHTMLペーストを取得する以外のスイッチ経路を用意するなど、
 * > 実用とデバッグを兼用する工夫をしなさい / そのために設定やフラグはあるんだから!**」
 *
 * ⚠ ここが守るのは 3 つ:
 * ① **設定どおりの順で読む**(自動が当たらない回に、user が自分で直せる)
 * ② **要らない形は解析しない**(押した瞬間に止まらない)
 * ③ 🔴 **診断に中身を出さない**(貼ったものは私物で、画面の文字は履歴に残る)
 */
import { describe, expect, it } from 'vitest';
import {
  choosePaste,
  describePaste,
  DEFAULT_PASTE_SOURCE,
  isPasteSource,
  PASTE_SOURCES,
  type PasteSource,
} from '../../src/features/markdown/paste-source';

/** 呼ばれた口を数える(⚠ **遅延**であることの観測点)。 */
function run(
  source: PasteSource,
  have: {
    html?: string | null;
    htmlFence?: string | null;
    rtf?: string | null;
    permalink?: string | null;
  },
  sizes = { html: 100, rtf: 200, plain: 50 },
) {
  const called: string[] = [];
  const out = choosePaste({
    source,
    sizes,
    convert: {
      permalink: () => {
        called.push('permalink');
        return have.permalink ?? null;
      },
      html: () => {
        called.push('html');
        return have.html ?? null;
      },
      htmlFence: () => {
        called.push('htmlFence');
        return have.htmlFence ?? null;
      },
      rtf: () => {
        called.push('rtf');
        return have.rtf ?? null;
      },
    },
  });
  return { ...out, called };
}

describe('設定の語彙', () => {
  it('既定は `auto`(設定を知らない人がいままでどおり)', () => {
    expect(DEFAULT_PASTE_SOURCE).toBe('auto');
    expect(PASTE_SOURCES[0]!.id).toBe('auto');
  });

  it('知らない値は受けない', () => {
    for (const s of PASTE_SOURCES) expect(isPasteSource(s.id)).toBe(true);
    expect(isPasteSource('rich')).toBe(false);
    expect(isPasteSource('')).toBe(false);
  });

  it('⚠ どの選択肢にも「なぜ選ぶか」が書いてある(名前だけでは選べない)', () => {
    for (const s of PASTE_SOURCES) expect(s.hint.length).toBeGreaterThan(8);
  });
});

describe('自動(既定)', () => {
  it('ウェブページの形が先、リッチテキストは控え', () => {
    const r = run('auto', { html: 'H', rtf: 'R' });
    expect(r.text).toBe('H');
    expect(r.attempt.used).toBe('html');
    // 🔑 **RTF は解析していない**(要らない形に時間を使わない)
    expect(r.called).not.toContain('rtf');
  });

  it('ウェブページの形が空振りしたらリッチテキストへ回る', () => {
    const r = run('auto', { html: null, rtf: 'R' });
    expect(r.text).toBe('R');
    expect(r.attempt.used).toBe('rtf');
    expect(r.attempt.skipped).toContainEqual({
      kind: 'html',
      why: '変換しても得るものがありませんでした',
    });
  });

  it('どちらも駄目なら介入しない(既定の貼付に委ねる)', () => {
    const r = run('auto', { html: null, rtf: null });
    expect(r.text).toBeNull();
    expect(r.attempt.used).toBe('plain');
  });

  it('ノートへのリンクはいちばん先(外部リンクの形にしない)', () => {
    const r = run('auto', { permalink: 'P', html: 'H' });
    expect(r.text).toBe('P');
    expect(r.called).not.toContain('html');
  });

  it('届いていない形は「届いていません」と記録する', () => {
    const r = run('auto', { html: null }, { html: 0, rtf: 0, plain: 10 });
    expect(r.attempt.skipped).toEqual([
      { kind: 'html', why: '届いていません' },
      { kind: 'rtf', why: '届いていません' },
    ]);
    expect(r.called).toEqual(['permalink']); // 🔑 1 つも解析していない
  });
});

describe('ウェブページの形だけ', () => {
  it('🔴 リッチテキストを読まない(届いていても)', () => {
    const r = run('html', { html: null, rtf: 'R' });
    expect(r.text, 'リッチテキストを読んでいる').toBeNull();
    expect(r.called, 'リッチテキストを解析している').not.toContain('rtf');
  });

  it('⚠ 読まなかった理由を残す(黙って落とさない)', () => {
    const r = run('html', { html: 'H', rtf: 'R' });
    expect(r.attempt.skipped).toContainEqual({ kind: 'rtf', why: '設定で読まない形です' });
  });
});

describe('リッチテキストを優先', () => {
  it('🔴 ウェブページの形より先に読む', () => {
    const r = run('rtf', { html: 'H', rtf: 'R' });
    expect(r.text).toBe('R');
    expect(r.attempt.used).toBe('rtf');
    expect(r.called, 'ウェブページの形を解析している').not.toContain('html');
  });

  it('リッチテキストが空振りしたらウェブページの形へ回る(切り捨てない)', () => {
    const r = run('rtf', { html: 'H', rtf: null });
    expect(r.text).toBe('H');
    expect(r.attempt.used).toBe('html');
  });
});

describe('変換しない', () => {
  it('🔴 何も解析しない', () => {
    const r = run('plain', { html: 'H', rtf: 'R', permalink: 'P' });
    expect(r.text).toBeNull();
    expect(r.called, '「変換しない」なのに解析している').toEqual([]);
  });

  it('🔴 ノートへのリンクも書き換えない(設定の字が嘘にならない)', () => {
    const r = run('plain', { permalink: 'P' });
    expect(r.text).toBeNull();
    expect(r.attempt.used).toBe('plain');
  });
});

describe('診断の 1 行', () => {
  const attempt = (over: Partial<Parameters<typeof describePaste>[0]> = {}) =>
    describePaste({
      source: 'auto',
      sizes: { html: 1234, rtf: 5678, plain: 90 },
      used: 'html',
      skipped: [],
      ...over,
    });

  it('何が届いて、どれを使ったかが分かる', () => {
    const s = attempt();
    expect(s).toContain('1,234');
    expect(s).toContain('5,678');
    expect(s).toContain('ウェブページの形を使いました');
  });

  it('🔴 中身を 1 文字も出さない(貼ったものは私物で、画面の文字は履歴に残る)', () => {
    const s = describePaste({
      source: 'auto',
      sizes: { html: 3, rtf: 0, plain: 3 },
      used: 'html',
      skipped: [],
    });
    // 🔑 出るのは**大きさと判断**だけ ── 数字と決まった語しか出ない
    expect(s).not.toMatch(/[<>{}\\]/);
  });

  it('見送った理由が付く(なぜ使われなかったかが分かる)', () => {
    const s = attempt({ used: 'rtf', skipped: [{ kind: 'html', why: '設定で読まない形です' }] });
    expect(s).toContain('ウェブページの形は設定で読まない形です');
  });

  it('⚠ 既定でないときは設定の名前を出す(何が効いているか分かる)', () => {
    expect(attempt({ source: 'rtf' })).toContain('リッチテキストを優先');
    expect(attempt({ source: 'auto' }), '既定まで書くと毎回うるさい').not.toContain('設定:');
  });

  it('何も届いていない回も、そう言う', () => {
    expect(attempt({ sizes: { html: 0, rtf: 0, plain: 0 }, used: 'plain' })).toContain(
      '何も届いていません',
    );
  });
});

/**
 * 🔴 **「大きすぎて読まなかった」を、そう書く**(#487)。
 *
 * ⚠ 直す前は上限超過も「変換しても得るものがありませんでした」と出ていた ──
 *   **理由が嘘**である(中身は 1 バイトも読んでいない)。
 * ⚠ しかも**長い生成 AI の返答こそ**この設定が相手にするものなので、
 *   いちばん当たりやすい所で嘘をついていた。
 *
 * 🔑 ここが守るのは 2 つ:
 * ① **理由が実態と合っている**(読まなかったのか、読んで空だったのか)
 * ② 🔴 **上限を超えたら変換器を呼ばない**(呼んでいたら「読んでいない」が嘘になる)
 */
describe('🔴 大きすぎて読まなかった、と書く (#487)', () => {
  const HTML_CAP = 1024 * 1024;
  const RTF_CAP = 4 * 1024 * 1024;

  /** その形の見送りの理由。 */
  const why = (out: ReturnType<typeof run>, kind: string): string | undefined =>
    out.attempt.skipped.find((s) => s.kind === kind)?.why;

  it('🔴 上限を 1 バイト超えた HTML は「大きすぎて」と書き、変換器を呼ばない', () => {
    const out = run('auto', { html: '# 変換できた' }, { html: HTML_CAP + 1, rtf: 0, plain: 5 });
    expect(why(out, 'html'), '理由が「大きすぎて」になっていない').toContain('大きすぎて');
    // 🔴 **空振り防止 + 主張の本体** ── 呼んでいたら「読んでいない」が嘘になる
    expect(out.called, '上限を超えたのに変換器を呼んでいる').not.toContain('html');
    expect(out.attempt.used).toBe('plain');
  });

  /**
   * 🔴 **境界の突合**(CLAUDE.md §7「規則を 1 つに寄せ、parity test を置く」)。
   * ⚠ 上限の比較は**変換器の中**と `choosePaste` の 2 か所にある ── 値は import で
   *   1 つに寄せたが、**不等号の向きがずれたら理由が 1 バイト分だけ嘘になる**。
   * 🔑 だから `= 上限`(読む)と `上限 + 1`(読まない)の**両側**を留める。
   */
  it('🔴 ちょうど上限なら読む ── 境界が変換器と揃っている', () => {
    const out = run('auto', { html: '# 変換できた' }, { html: HTML_CAP, rtf: 0, plain: 5 });
    expect(out.called, 'ちょうど上限なのに変換器を呼んでいない').toContain('html');
    expect(out.attempt.used).toBe('html');
  });

  it('⚠ 上限の内側で変換できなかったときは、これまでどおり「得るものが…」', () => {
    const out = run('auto', { html: null }, { html: 100, rtf: 0, plain: 5 });
    expect(why(out, 'html')).toContain('得るもの');
    expect(why(out, 'html'), '読んでいないと誤解させる字が混ざっている').not.toContain('大きすぎ');
    expect(out.called, '変換を試していない(前提が崩れた)').toContain('html');
  });

  it('🔴 リッチテキストも同じ ── 上限を超えたら呼ばない', () => {
    const out = run('rtf', { rtf: '# 変換できた' }, { html: 0, rtf: RTF_CAP + 1, plain: 5 });
    expect(why(out, 'rtf')).toContain('大きすぎて');
    expect(out.called, '上限を超えたのに変換器を呼んでいる').not.toContain('rtf');
  });

  /**
   * 🔴 **2 つの上限が別物であることを、ここだけが確かめる**(変異試験 N4 が教えた)。
   *
   * ⚠ 1 稿目は RTF の試験を `RTF_CAP + 1`(= 4MB 超)で書いていたが、それは
   *   **HTML の上限(1MB)も超えている** ── だから `rtf` の上限に `html` の上限を
   *   当てる変異が**生き延びた**(どちらの値でも「大きすぎ」になる)。
   * 🔑 効くのは**2 つの上限の間**だけである:1MB を超え、4MB の内側。
   */
  it('🔴 リッチテキストの上限は HTML より大きい ── 2MB は読む', () => {
    const out = run('rtf', { rtf: '# 変換できた' }, { html: 0, rtf: 2 * 1024 * 1024, plain: 5 });
    expect(out.called, 'RTF の上限に HTML の上限を当てている').toContain('rtf');
    expect(out.attempt.used).toBe('rtf');
  });

  it('🔴 囲みも、上限と「中身が空」を混ぜない', () => {
    const big = run('html-fence', { htmlFence: '```html\nx\n```' }, {
      html: HTML_CAP + 1,
      rtf: 0,
      plain: 5,
    });
    expect(why(big, 'html')).toContain('大きすぎて');
    expect(big.called, '上限を超えたのに囲みを組もうとしている').not.toContain('htmlFence');

    // ⚠ 上限の内側で `null` = 「`<meta charset>` を外したら空だった」だけ
    const empty = run('html-fence', { htmlFence: null }, { html: 100, rtf: 0, plain: 5 });
    expect(why(empty, 'html')).toContain('空');
    expect(why(empty, 'html'), '読んでいないと誤解させる字が混ざっている').not.toContain('大きすぎ');
    expect(empty.called).toContain('htmlFence');
  });
});
