/**
 * 🔴 **本文の「→「名前」」を押せる字にする規則**(#779 段⑧、user 裁定 2026-09-08)。
 *
 * ⚠ **自前の小さな原稿で見る** ── 実物のマニュアルに当てるだけでは、
 *   「解決しない形」が本文に在るかどうかに検査が左右される
 *   (CLAUDE.md §2「fixture のゼロ件の次元は測っていない次元」)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { findManualRefs, refKey, resolveManualRef } from '../../src/features/help/manual-refs';

describe('本文の参照を拾う(findManualRefs)', () => {
  it('🔴 `→「名前」` の名前だけを、位置つきで拾う', () => {
    const t = 'あれこれ(→「設定」)を見てください。';
    const hits = findManualRefs(t);
    expect(hits.map((h) => h.name)).toEqual(['設定']);
    // ⚠ 位置は**名前だけ**(鉤括弧を含まない)── 含むと差し替えで括弧が消える
    expect(t.slice(hits[0]!.start, hits[0]!.end)).toBe('設定');
  });

  it('🔴 1 本の行に 2 つ在っても、両方 別々に拾う', () => {
    const hits = findManualRefs('(→「設定」)と(→「ヘルプ」)');
    expect(hits.map((h) => h.name)).toEqual(['設定', 'ヘルプ']);
    // ⚠ 後ろのほうが後ろに在る(位置が単調 ── 差し替えはこの順で当てる)
    expect(hits[0]!.end).toBeLessThan(hits[1]!.start);
  });

  it('⚠ `→` と `「` の間の空白は許す(全角も)', () => {
    expect(findManualRefs('→ 「設定」').map((h) => h.name)).toEqual(['設定']);
    expect(findManualRefs('→　「設定」').map((h) => h.name)).toEqual(['設定']);
  });

  it('🔴 名前の中の鉤括弧を 1 段だけ許す(見出しの字と揃える)', () => {
    // ⚠ 実物に在る形 ── 見出しは `付箋を自由に置ける「板」`
    expect(findManualRefs('(→「付箋を自由に置ける「板」」)').map((h) => h.name)).toEqual([
      '付箋を自由に置ける「板」',
    ]);
    // 対照群 ── 入れ子でない参照は今までどおり
    expect(findManualRefs('(→「設定」)').map((h) => h.name)).toEqual(['設定']);
    // ⚠ 2 つ並んでも食い合わない
    expect(findManualRefs('(→「あ「い」」)と(→「う」)').map((h) => h.name)).toEqual([
      'あ「い」',
      'う',
    ]);
  });

  it('⚠ `→` の無い鉤括弧は拾わない(ただの引用)', () => {
    expect(findManualRefs('「設定」を開きます')).toEqual([]);
  });
});

describe('参照の行き先を決める(resolveManualRef)', () => {
  const heads = [
    '設定',
    '🔴 組み込みアプリは**別のウィンドウ**で開きます',
    '予定を扱う',
    '予定(左の列のタブ)',
  ];

  it('🔴 字がそのまま同じ見出しが 1 つ在れば、それ', () => {
    expect(resolveManualRef('設定', heads)).toBe('設定');
  });

  it('🔴 短く書いた参照は、含む見出しが 1 つのときだけ決まる', () => {
    expect(resolveManualRef('組み込みアプリ', heads)).toBe(
      '🔴 組み込みアプリは**別のウィンドウ**で開きます',
    );
  });

  it('🔴 含む先が 2 つ以上なら決めない(勝手にどちらかへ送らない)', () => {
    expect(resolveManualRef('予定', heads)).toBeNull();
  });

  it('🔴 どこにも無ければ決めない(押しても何も起きない字を作らない)', () => {
    expect(resolveManualRef('前へ出す', heads)).toBeNull();
    expect(resolveManualRef('', heads)).toBeNull();
  });

  it('⚠ 記法の印は落として比べる(原文と描いた字のどちらでも当たる)', () => {
    expect(refKey('**タグを、その場で打つ**')).toBe('タグを、その場で打つ');
    // 原文の見出し(印つき)に、描いた字(印なし)の参照が当たる
    expect(resolveManualRef('別のウィンドウ', ['**別のウィンドウ**で開く'])).toBe(
      '**別のウィンドウ**で開く',
    );
  });

  it('🔴 完全一致が 2 つ在るときも決めない(同名の見出しが戻ってきた場合)', () => {
    expect(resolveManualRef('お知らせ', ['お知らせ', 'お知らせ'])).toBeNull();
  });
});

describe('実物のマニュアルに当てる', () => {
  const { text, heads } = ((): { text: string; heads: string[] } => {
    const lines = readFileSync('docs/manual.md', 'utf-8').split('\n');
    let fence = false;
    const body: string[] = [];
    const hs: string[] = [];
    for (const l of lines) {
      if (/^\s*(```|~~~)/.test(l)) {
        fence = !fence;
        continue;
      }
      if (fence) continue;
      body.push(l);
      const m = /^#{1,6} (.*)$/.exec(l);
      if (m) hs.push(m[1]!);
    }
    return { text: body.join('\n'), heads: hs };
  })();

  const hits = findManualRefs(text);

  it('空振り防止 ── 実物から参照を拾えている', () => {
    expect(hits.length, '実物のマニュアルから参照を 1 つも拾えていない').toBeGreaterThan(100);
  });

  it('🔴 大半は行き先が決まる(決まらない分は素の字のまま)', () => {
    const ok = hits.filter((h) => resolveManualRef(h.name, heads) !== null);
    // ⚠ **両側**を見る ── 「全部決まる」でも「1 つも決まらない」でも、規則が壊れている
    expect(ok.length, '押せる字になる参照が少なすぎる').toBeGreaterThan(80);
    expect(ok.length, '全部決まってしまう ── 曖昧を弾く規則が効いていない').toBeLessThan(
      hits.length,
    );
  });

  /**
   * 🔴 **決まらない参照を、身元の等値 pin で留める**(2026-09-08)。
   *
   * ⚠ **実際に壊れていた** ── 今日 5 件の参照が行き先を失っていた:
   *   ①〜③ `付箋を自由に置ける『板』` / `…板`(見出しは `付箋を自由に置ける「板」` ──
   *   括弧の種類が違う)④ `章へのリンク`(#779 段④ の割り直しで**私が壊した**)
   *   ⑤ `使っている量` / `文書の先頭に設定を書く`(節の名前が変わっていた)。
   * 🔴 **どれも無言で出る** ── 読み手は「押せない字」としか分からず、
   *   壊れているのか元からそういう字なのかを**確かめる術がない**。
   *
   * 🔑 だから**上限ではなく身元**で留める(`KNOWN_DEAD` と同じ作法)──
   *   ⚠ 新しく決まらない参照を書いたら**必ず落ちる**ので、書いた人は
   *   「その名前の節は在るか」を 1 度必ず問うことになる。
   *   ⚠ 直したら表からも消さないと落ちるので、burn-down が忘れられない。
   */
  it('🔴 決まらない参照は、既知の 15 件だけ(新しく壊れたら落ちる)', () => {
    const KNOWN_UNRESOLVED: readonly string[] = [
      // ── 操作の道順(節ではない。押す物の名前)
      '本文を CSV の表に書き換える',
      '操作を探す',
      '貼り付けたとき、何が届いてどれを使ったかを画面に出す',
      'ここに板を置く',
      'この板を消す',
      '前へ出す',
      '**このノートをスタックに載せる**',
      '本文を押したときに何が起きるか',
      // ── マニュアルの外(doc を指している)
      '移行ガイド',
      // ── 短すぎて行き先が 2 つ以上ある(どちらへ送るか決められない)
      'スマートフォルダ',
      '予定',
      '連絡先',
      '表',
      '目次',
      'アプリ',
    ];
    const bad = [
      ...new Set(
        hits.filter((h) => resolveManualRef(h.name, heads) === null).map((h) => h.name),
      ),
    ];
    expect(
      bad.sort(),
      '決まらない参照が増減した ── 増えたなら節の名前で書き直す。減らしたなら表からも消す',
    ).toEqual([...KNOWN_UNRESOLVED].sort());
  });

  it('🔴 操作の道順は、押せる字にしない(見出しではないので決まらない)', () => {
    /*
     * ⚠ `→「…」` は 2 つの意味で使われている ── 「その節を見よ」と
     *   「これを押して、次にこれ」。⚠ 器(丸括弧)では分けられないので、
     *   **行き先で分ける**。下の 3 つは実物に在る**操作の道順**で、
     *   どれも見出しではないから決まらない ── それを固定する。
     */
    for (const path of [
      '本文を CSV の表に書き換える',
      '操作を探す',
      '貼り付けたとき、何が届いてどれを使ったかを画面に出す',
    ]) {
      expect(text, `前提が崩れている:「${path}」が本文に無い`).toContain(`→「${path}」`);
      expect(resolveManualRef(path, heads), `操作の道順「${path}」が押せる字になっている`).toBeNull();
    }
  });
});
