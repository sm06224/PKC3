/**
 * 🔴 **スマートフォルダの条件**(#421 段①。user 要望 2026-08-26
 * 「iPhoneとかのメモアプリにあるスマートメモのような整理機能が欲しいです」)。
 *
 * 守る主張:
 * 1. **正本は本文の frontmatter** ── 読み書きは原文 splice(説明文を壊さない)
 * 2. 🔴 **条件が空なら「何も集めない」**(「全部集める」ではない)
 * 3. 条件が 2 つ以上なら **AND**(全部付いているものだけ)
 * 4. **自分自身は当てない**(入れ子が 1 段深く見える)
 * 5. **上限で切っても、数は数え続ける**(「これで全部」と嘘をつかない)
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_SMART,
  MAX_SMART_TAGS,
  SMART_LIMIT,
  SMART_TAGS_KEY,
  createSmartScan,
  isSmartEmpty,
  matchesSmartTags,
  SMART_CREATED_KEY,
  SMART_DATED_KEY,
  SMART_FIELDS,
  SMART_KIND_KEY,
  SMART_TEXT_KEY,
  SMART_UPDATED_KEY,
  MAX_SMART_TEXT_CHARS,
  needsRescan,
  smartWriteError,
  readSmartSpec,
  smartCondError,
  smartCutoff,
  smartFieldValue,
  smartQueryOf,
  withSmartField,
  withSmartTag,
  writeSmartSpec,
  type SmartCondResult,
  type SmartSpec,
} from '../../src/features/smart/smart-spec';
import { MAX_TAG_CHARS } from '../../src/features/flavor/tags';

const withTags = (...tags: string[]): string =>
  `---\ntags: [${tags.join(', ')}]\n---\n本文\n`;

describe('条件を読む(#421 段①)', () => {
  it('🔴 配列でもカンマ区切りでも読む(user がどちらで書いても通す)', () => {
    expect(readSmartSpec(`---\n${SMART_TAGS_KEY}: [請求, 未処理]\n---\n`).tags).toEqual([
      '請求',
      '未処理',
    ]);
    expect(readSmartSpec(`---\n${SMART_TAGS_KEY}: 請求, 未処理\n---\n`).tags).toEqual([
      '請求',
      '未処理',
    ]);
  });

  it('条件が書いていなければ空(= 何も集めない)', () => {
    expect(isSmartEmpty(readSmartSpec('ただの本文\n'))).toBe(true);
    expect(isSmartEmpty(readSmartSpec(`---\n${SMART_TAGS_KEY}: \n---\n`))).toBe(true);
  });

  /**
   * ⚠ **空の要素は `null` で来る**(frontmatter の parser がそう返す)── そのまま
   * 文字にすると **`"null"` という名前の条件**が生まれる(`readTags` が同じ罠を
   * 踏んで直してある)。
   */
  it('⚠ 空の要素が「null」という条件にならない', () => {
    expect(readSmartSpec(`---\n${SMART_TAGS_KEY}: [請求, , 未処理]\n---\n`).tags).toEqual([
      '請求',
      '未処理',
    ]);
  });

  it('⚠ 重複は 1 つに畳む(大小は無視)', () => {
    expect(readSmartSpec(`---\n${SMART_TAGS_KEY}: [Bill, bill, 請求]\n---\n`).tags).toEqual([
      'Bill',
      '請求',
    ]);
  });

  it('⚠ 上限を超えたぶんは読まない(条件が読めなくなる)', () => {
    const many = Array.from({ length: MAX_SMART_TAGS + 5 }, (_, i) => `t${String(i)}`);
    expect(readSmartSpec(`---\n${SMART_TAGS_KEY}: [${many.join(', ')}]\n---\n`).tags).toHaveLength(
      MAX_SMART_TAGS,
    );
  });
});

describe('条件を書く(#421 段①)', () => {
  it('🔴 説明文を壊さずに書き足す(原文 splice)', () => {
    const body = `---\ntitle-note: あ\n---\n\n月末にまとめて処理するぶん。\n`;
    const out = writeSmartSpec(body, { ...EMPTY_SMART, tags: ['請求'] });
    expect(out, '説明文が消えた').toContain('月末にまとめて処理するぶん。');
    expect(out, '他の key が消えた').toContain('title-note: あ');
    expect(readSmartSpec(out).tags).toEqual(['請求']);
  });

  /**
   * 🔴 **空になったら key ごと消す** ── `smart-tags: []` を残すと、次に読んだとき
   * 「条件が在るのに当たらない」に見える。
   */
  it('🔴 条件が空になったら key ごと消える', () => {
    const body = writeSmartSpec('本文\n', { ...EMPTY_SMART, tags: ['請求'] });
    expect(body).toContain(SMART_TAGS_KEY);
    const off = writeSmartSpec(body, EMPTY_SMART);
    expect(off, '空の条件が残っている').not.toContain(SMART_TAGS_KEY);
  });

  const okSpec = (r: SmartCondResult): SmartSpec => {
    if (!r.ok) throw new Error(`通るはずが ${r.reason} で断られた`);
    return r.spec;
  };

  it('足す / 外すは、押しても同じなら unchanged(呼び側が「書かない」を選べる)', () => {
    const one = withSmartTag(EMPTY_SMART, '請求', 'add');
    expect(okSpec(one).tags).toEqual(['請求']);
    const again = withSmartTag(okSpec(one), '請求', 'add');
    expect(again, '同じ条件が 2 度並ぶ').toEqual({ ok: false, reason: 'unchanged' });
    expect(withSmartTag(EMPTY_SMART, '請求', 'remove'), '無いものを外せている').toEqual({
      ok: false,
      reason: 'unchanged',
    });
    expect(okSpec(withSmartTag(okSpec(one), '請求', 'remove')).tags).toEqual([]);
  });

  /**
   * 🔴 **断られた理由が読めること**(着地前の変異試験 S14b から)。
   * ⚠ 「変わらなかった」を 1 つに畳むと、呼び側は**黙って捨てるしかない** ──
   *   user は 9 個目を足したつもりで、何も起きない画面を見る。
   */
  it('🔴 上限に当たったら足さず、**理由が出る**(黙って古い方を落とさない)', () => {
    const full = { ...EMPTY_SMART, tags: Array.from({ length: MAX_SMART_TAGS }, (_, i) => `t${String(i)}`) };
    const over = withSmartTag(full, 'new', 'add');
    expect(over, '上限を超えて足している').toEqual({ ok: false, reason: 'limit' });
    expect(smartCondError('limit'), '理由が読めない').toContain(String(MAX_SMART_TAGS));
    // ⚠ 満杯でも**外す**ほうは通る(でないと詰んで動かせない)
    expect(okSpec(withSmartTag(full, 't0', 'remove')).tags).not.toContain('t0');
  });

  it('🔴 タグとして受けられないものは invalid で、理由が出る', () => {
    expect(withSmartTag(EMPTY_SMART, '   ', 'add')).toEqual({ ok: false, reason: 'invalid' });
    expect(withSmartTag(EMPTY_SMART, 'x'.repeat(MAX_TAG_CHARS + 1), 'add')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(smartCondError('invalid')).toContain(String(MAX_TAG_CHARS));
    // 🔑 **黙ってよいのは「押しても同じ」だけ** ── ここを取り違えると無言で捨てる
    expect(smartCondError('unchanged'), '黙るべきものに帯を出している').toBeNull();
  });
});

describe('当てる(#421 段①)', () => {
  it('🔴 条件が空なら、どんなノートにも当たらない(「全部」ではない)', () => {
    expect(matchesSmartTags(EMPTY_SMART, ['請求'])).toBe(false);
    expect(matchesSmartTags(EMPTY_SMART, [])).toBe(false);
  });

  it('🔴 条件が 2 つなら AND(全部付いているものだけ)', () => {
    const spec = { ...EMPTY_SMART, tags: ['請求', '未処理'] };
    expect(matchesSmartTags(spec, ['請求', '未処理', '他'])).toBe(true);
    expect(matchesSmartTags(spec, ['請求']), '片方だけで当たっている').toBe(false);
  });

  it('⚠ 突き合わせは大小を無視する(札の見た目は原文のまま)', () => {
    expect(matchesSmartTags({ ...EMPTY_SMART, tags: ['Bill'] }, ['bill'])).toBe(true);
  });
});

describe('走査(#421 段①)', () => {
  const run = (spec: SmartSpec, rows: { lid: string; head: string }[], self = 'self') => {
    const scan = createSmartScan(spec, self);
    scan.feed(rows);
    return scan.finish();
  };

  it('🔴 条件に当たったものだけ集める', () => {
    const out = run({ ...EMPTY_SMART, tags: ['請求'] }, [
      { lid: 'a', head: withTags('請求') },
      { lid: 'b', head: withTags('家事') },
      { lid: 'c', head: withTags('請求', '未処理') },
    ]);
    expect(out.lids).toEqual(['a', 'c']);
    expect(out.total).toBe(2);
  });

  /**
   * 🔴 **自分自身は当てない** ── 条件タグを書いた本文が自分の中に並ぶと、
   * 開くたびに入れ子が 1 段深く見える。
   */
  it('🔴 自分自身は当たらない', () => {
    const out = run({ ...EMPTY_SMART, tags: ['請求'] }, [
      { lid: 'self', head: withTags('請求') },
      { lid: 'a', head: withTags('請求') },
    ]);
    expect(out.lids, '自分が中に並んでいる').toEqual(['a']);
  });

  it('⚠ 条件が空なら 1 件も集めない(走査ごと素通り)', () => {
    const out = run({ ...EMPTY_SMART, tags: [] }, [{ lid: 'a', head: withTags('請求') }]);
    expect(out.lids).toEqual([]);
    expect(out.total).toBe(0);
  });

  /**
   * 🔴 **上限で切っても数は数え続ける** ── 黙って切ると user は「これで全部」と読む。
   */
  it('🔴 上限を超えても、総数は正しく返る', () => {
    const rows = Array.from({ length: SMART_LIMIT + 25 }, (_, i) => ({
      lid: `n${String(i)}`,
      head: withTags('請求'),
    }));
    const out = run({ ...EMPTY_SMART, tags: ['請求'] }, rows);
    expect(out.lids, '上限を超えて lid を持っている').toHaveLength(SMART_LIMIT);
    expect(out.total, '切ったぶんを数えていない').toBe(SMART_LIMIT + 25);
  });

  it('⚠ 何回に分けて食わせても答えは同じ(worker は 500 件ずつ渡す)', () => {
    const rows = [
      { lid: 'a', head: withTags('請求') },
      { lid: 'b', head: withTags('家事') },
      { lid: 'c', head: withTags('請求') },
    ];
    const scan = createSmartScan({ ...EMPTY_SMART, tags: ['請求'] }, 'self');
    scan.feed(rows.slice(0, 2));
    scan.feed(rows.slice(2));
    expect(scan.finish().lids).toEqual(['a', 'c']);
  });
});

/**
 * 🔴 **列で引く条件**(#421 段②)。
 *
 * ⚠ 起票時の 6 条件のうち **2 つは作れない**(実装を読んで判明):
 *   「チェック項目がある」は `task_total` が**多めに数えた候補数**で、
 *   `task-count.ts` 自身が「表示に使わないこと」と宣言している(一覧に並べると
 *   **項目 0 件のノートが混ざる**)/「未処理がある」は**列が無い**。
 *   🔑 どちらも**列を足す段**が要るので、ここには入れない。
 */
describe('列で引く条件(#421 段②)', () => {
  const read = (yaml: string): SmartSpec => readSmartSpec(`---\n${yaml}\n---\n本文\n`);

  it('🔴 種類・更新・作成・日付を読む', () => {
    const spec = read(
      [
        `${SMART_KIND_KEY}: attachment`,
        `${SMART_UPDATED_KEY}: 30d`,
        `${SMART_CREATED_KEY}: 7`,
        `${SMART_DATED_KEY}: true`,
      ].join('\n'),
    );
    expect(spec.kind).toBe('attachment');
    expect(spec.updatedDays).toBe(30);
    // 🔑 **`30d` でも `7` でも読む**(記法を減らさない ── user がどちらで書いても通す)
    expect(spec.createdDays).toBe(7);
    expect(spec.dated).toBe(true);
  });

  /**
   * 🔴 **知らない綴りは条件にしない** ── 受けると「書いたのに 1 件も集まらない」
   * だけの入れ物ができ、理由が画面のどこにも出ない(silent fail)。
   */
  it('🔴 受けられない値は条件にしない(黙って効かない条件を作らない)', () => {
    expect(read(`${SMART_KIND_KEY}: しらない種類`).kind, '知らない種類を受けた').toBeNull();
    expect(read(`${SMART_UPDATED_KEY}: あした`).updatedDays).toBeNull();
    expect(read(`${SMART_UPDATED_KEY}: 0`).updatedDays, '0 日以内を受けた').toBeNull();
    expect(read(`${SMART_UPDATED_KEY}: 99999`).updatedDays, '上限を超えて受けた').toBeNull();
    expect(read(`${SMART_DATED_KEY}: たぶん`).dated).toBeNull();
    // ⚠ **対照群** ── 受けられる綴りはちゃんと通る(空振り防止)
    expect(read(`${SMART_DATED_KEY}: no`).dated).toBe(false);
  });

  it('🔴 条件が 1 つも無い、の判定に列の条件も入る', () => {
    expect(isSmartEmpty(EMPTY_SMART)).toBe(true);
    expect(isSmartEmpty({ ...EMPTY_SMART, kind: 'text' }), 'タグが無いだけで空と読んだ').toBe(
      false,
    );
    expect(isSmartEmpty({ ...EMPTY_SMART, dated: false })).toBe(false);
  });

  /**
   * 🔴 **その場で落とせるのは、タグだけの入れ物に限る**。
   * ⚠ 列の条件は**本文を書いた瞬間に変わる**(`updated_at` は保存のたびに動く)ので、
   *   手で継ぎ足すと嘘になる ── 呼び側はこれで見分ける。
   */
  it('🔴 列の条件を持っているかが分かる', () => {
    expect(needsRescan({ ...EMPTY_SMART, tags: ['請求'] }), 'タグを列と読んだ').toBe(false);
    expect(needsRescan({ ...EMPTY_SMART, kind: 'text' })).toBe(true);
    expect(needsRescan({ ...EMPTY_SMART, updatedDays: 7 })).toBe(true);
    expect(needsRescan({ ...EMPTY_SMART, createdDays: 7 })).toBe(true);
    expect(needsRescan({ ...EMPTY_SMART, dated: true })).toBe(true);
  });

  it('🔴 決める / 外すが本文へ往復する(説明文は無傷)', () => {
    const start = '---\ntitle: 名前\n---\n説明の文\n';
    const r = withSmartField(readSmartSpec(start), 'updated', '30d');
    expect(r.ok).toBe(true);
    const body = writeSmartSpec(start, r.ok ? r.spec : EMPTY_SMART);
    expect(readSmartSpec(body).updatedDays).toBe(30);
    expect(body, '説明文が壊れた').toContain('説明の文');
    expect(body, '他の key が消えた').toContain('title: 名前');
    // 外すと key ごと消える(「条件が在るのに当たらない」に見せない)
    const off = withSmartField(readSmartSpec(body), 'updated', '');
    const body2 = writeSmartSpec(body, off.ok ? off.spec : EMPTY_SMART);
    expect(body2).not.toContain(SMART_UPDATED_KEY);
    expect(body2, '説明文が壊れた').toContain('説明の文');
  });

  it('⚠ 押しても同じなら unchanged / 受けられない値は invalid', () => {
    const spec = { ...EMPTY_SMART, kind: 'text' };
    expect(withSmartField(spec, 'kind', 'text')).toEqual({ ok: false, reason: 'unchanged' });
    expect(withSmartField(spec, 'kind', 'しらない')).toEqual({ ok: false, reason: 'invalid' });
    // 🔑 **空文字は「指定しない」**(外す)── invalid にしない
    expect(withSmartField(spec, 'kind', '')).toEqual({ ok: true, spec: EMPTY_SMART });
  });

  it('🔑 画面へ戻す値が、読める綴りと同じ', () => {
    const spec = { ...EMPTY_SMART, kind: 'folder', updatedDays: 30, dated: false };
    for (const f of SMART_FIELDS) {
      const v = smartFieldValue(spec, f);
      if (v === '') continue;
      // ⚠ **往復する** ── 画面の値をそのまま渡し直したら「変わらない」になるはず
      expect(withSmartField(spec, f, v), `${f} が往復していない`).toEqual({
        ok: false,
        reason: 'unchanged',
      });
    }
  });

  /**
   * 🔴 **境目の時刻はここで作る**(worker に時計を持ち込まない)。
   * ⚠ worker が `Date.now()` を読むと、走らせるたびに答えが変わって test が書けない。
   */
  it('🔴 「N 日以内」が境目の時刻になる', () => {
    const now = Date.parse('2026-08-26T00:00:00.000Z');
    expect(smartCutoff(7, now)).toBe('2026-08-19T00:00:00.000Z');
    expect(smartCutoff(null, now), '指定していないのに境目を作った').toBeNull();
    const q = smartQueryOf({ ...EMPTY_SMART, updatedDays: 7, kind: 'text' }, now);
    expect(q.updatedFrom).toBe('2026-08-19T00:00:00.000Z');
    expect(q.createdFrom, '指定していないほうにも境目が付いた').toBeNull();
    expect(q.kind).toBe('text');
  });
});

/**
 * 🔴 **語で絞る**(#421 段③)。
 *
 * 守る主張:
 * 1. 本文の `smart-text:` が条件として読め、画面へ往復する
 * 2. **当てるのはここではない** ── worker の SQL 1 か所である(§7)。
 *    だから `needsRescan` が true を返し、reducer はその場で当て直さない
 * 3. 読めない語は**条件にしない**(黙って切り詰めない)
 */
describe('語で絞る(#421 段③)', () => {
  const withText = (v: string): string => `---\n${SMART_TEXT_KEY}: ${v}\n---\n説明\n`;

  it('🔴 本文に書いた語が、条件として読める', () => {
    expect(readSmartSpec(withText('請求書')).text).toBe('請求書');
  });

  /**
   * ⚠ **1 行に潰す** ── 索引は行を跨がないので、改行を含む語は探しようがない。
   * 🔑 潰すのは**読む側**である(書く側も同じ関数を通る ── `withSmartField`)。
   */
  it('🔴 前後の空白と連続する空白は 1 つに潰れる', () => {
    expect(readSmartSpec(withText('"  請求  書  "')).text).toBe('請求 書');
  });

  it('🔴 空の語は条件にしない(「全部集まる」にしない)', () => {
    expect(readSmartSpec(withText('"   "')).text).toBeNull();
    expect(readSmartSpec('本文だけ\n').text, '書いていないのに条件が付いた').toBeNull();
  });

  /**
   * 🔴 **長すぎる語は黙って切り詰めない。** 切り詰めると
   * 「書いた語と集まる語が違う」という、画面に理由の出ない形になる。
   */
  it('🔴 上限を超える語は条件にならない', () => {
    const ok = 'あ'.repeat(MAX_SMART_TEXT_CHARS);
    const over = 'あ'.repeat(MAX_SMART_TEXT_CHARS + 1);
    expect(readSmartSpec(withText(ok)).text, '上限ちょうどが落ちた').toBe(ok);
    expect(readSmartSpec(withText(over)), '上限超えを受けた').toEqual(
      expect.objectContaining({ text: null }),
    );
    expect(withSmartField(EMPTY_SMART, 'text', over)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('🔴 画面から打った語が、本文へ書かれて往復する', () => {
    const out = withSmartField(EMPTY_SMART, 'text', ' 請求  書 ');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.spec.text).toBe('請求 書');
    const body = writeSmartSpec('説明\n', out.spec);
    expect(readSmartSpec(body).text, '書いたものが読めない').toBe('請求 書');
    expect(smartFieldValue(out.spec, 'text'), '画面へ戻らない').toBe('請求 書');
    // ⚠ 外したら key ごと消える(`smart-text: ""` を残すと「条件が在るのに当たらない」)
    const off = withSmartField(out.spec, 'text', '');
    expect(off.ok).toBe(true);
    if (off.ok) expect(writeSmartSpec(body, off.spec)).not.toContain(SMART_TEXT_KEY);
  });

  it('🔴 語も worker へ渡る', () => {
    const q = smartQueryOf({ ...EMPTY_SMART, text: '請求書' }, Date.parse('2026-08-26T00:00:00Z'));
    expect(q.text).toBe('請求書');
  });

  it('🔴 語だけでも「条件が在る」と数える(空は空、のまま)', () => {
    expect(isSmartEmpty({ ...EMPTY_SMART, text: '請求書' }), '語を条件と数えていない').toBe(false);
    expect(isSmartEmpty(EMPTY_SMART)).toBe(true);
  });

  /**
   * 🔴 **その場で当て直させない**(§7)── 当てるのは FTS5 / LIKE = SQL 1 か所である。
   * ⚠ ここが false を返すと、reducer が `body.includes(語)` 相当の**2 つ目の規則**を
   *   持つことになり、帯の並びと探す欄の結果が静かに食い違う。
   */
  it('🔴 語の条件を持つ入れ物は、集め直しが要る', () => {
    expect(needsRescan({ ...EMPTY_SMART, text: '請求書' }), '語をその場で当てにいく').toBe(true);
    // 対照群 ── タグだけならその場で当て直せる
    expect(needsRescan({ ...EMPTY_SMART, tags: ['請求'] })).toBe(false);
  });
});

/**
 * 🔴 **落として入れられるか / ここから外せるか**(#421 段②の穴)。
 *
 * ⚠ 直す前は「条件が 1 つも無い」ときしか断っておらず、**タグを 1 つも持たない
 *   入れ物**へ落とすと**無言で何も起きなかった**(2026-08-26 に対照群つきで実測)。
 */
describe('書けない条件しか無いなら、理由を出す(#421 段②の穴)', () => {
  it('🔴 タグ以外の条件だけの入れ物は、落とすのを断る', () => {
    for (const spec of [
      { ...EMPTY_SMART, updatedDays: 30 },
      { ...EMPTY_SMART, kind: 'text' },
      { ...EMPTY_SMART, createdDays: 7 },
      { ...EMPTY_SMART, dated: true },
      { ...EMPTY_SMART, text: '請求書' },
    ]) {
      const msg = smartWriteError(spec, 'add');
      expect(msg, `${JSON.stringify(spec)} を無言で通した`).not.toBeNull();
      // ⚠ **次にすることまで書く** ── 「できません」だけでは user は止まる
      expect(msg, '直し方が書いていない').toContain('タグ');
    }
  });

  /**
   * ⚠ **押した動作の言葉で書く** ── 「落とした」と「外した」では次にすることが違う。
   */
  it('🔴 落とすときと外すときで、断り文が違う', () => {
    const spec = { ...EMPTY_SMART, updatedDays: 30 };
    const add = smartWriteError(spec, 'add');
    const remove = smartWriteError(spec, 'remove');
    expect(add).not.toBe(remove);
    expect(add, '落とした話になっていない').toContain('入れる');
    expect(remove, '外した話になっていない').toContain('外す');
  });

  it('🔴 条件が 1 つも無いときは、そう書く(別の理由)', () => {
    expect(smartWriteError(EMPTY_SMART, 'add'), '条件が空の断りが出ない').toContain('条件がありません');
  });

  /**
   * 🔑 **対照群** ── タグの条件が 1 つでもあれば通す。
   * ⚠ 置かないと「常に断る」実装でもこの describe は全部緑になる。
   */
  it('🔴 タグの条件があれば通す', () => {
    expect(smartWriteError({ ...EMPTY_SMART, tags: ['請求'] }, 'add')).toBeNull();
    expect(smartWriteError({ ...EMPTY_SMART, tags: ['請求'], updatedDays: 30 }, 'remove')).toBeNull();
  });
});
