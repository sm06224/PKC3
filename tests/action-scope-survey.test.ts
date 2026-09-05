/**
 * 🔴 **「指さないと始められない操作」の全数仕分けを腐らせない**(#582 R1)。
 *
 * ## なぜ test が要るか
 *
 * `docs/development/operation-model-2026-08.md` §4 の推薦は §7 条件① に懸かっている ──
 * **点引数が過半なら床はパレットではなく右クリックへ倒す**。実測は **40 / 183 = 22%** で
 * 過半ではないので推薦は立つが、⚠ **受け手は増える**(同じ日に 181 → 183 へ動いた)。
 *
 * 🔑 だから見張るのは 2 つ:
 *   ① **割り当て漏れが出たら落ちる**(新しい受け手を足した人に仕分けさせる)
 *   ② 🔴 **doc の数と食い違ったら落ちる** ── この doc は**同じ日に 181 が 2 か所で嘘に
 *      なった**。数を doc に書く以上、**doc を読んで突き合わせる**しかない
 *
 * ⚠ **件数だけを pin しても足りない**(§1 空振り)── 2 件を種別ごと入れ替えても
 *   件数は動かない。だから**名指しの錨**を別に置く。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error -- CI script は素の .mjs(ビルド対象外)
import { receivers as receiversRaw } from '../scripts/action-outlets.mjs';
// @ts-expect-error -- CI script は素の .mjs(ビルド対象外)
import { assign as assignRaw, classify as classifyRaw, counts as countsRaw } from '../scripts/action-scope-survey.mjs';

type Cls = 'P1' | 'P2' | 'E' | 'V' | 'N';
const receivers = receiversRaw as () => string[];
const classify = classifyRaw as () => Map<string, Cls>;
const counts = countsRaw as () => Record<Cls, number>;
const assign = assignRaw as (
  all: readonly string[],
  groups: readonly (readonly [string, readonly string[]])[],
) => Map<string, string>;

const DOC = 'docs/development/operation-model-2026-08.md';

/**
 * doc §7.1 の表から 5 つの数を読む。
 *
 * ⚠ **見つからなければ投げる** ── 「0 件だから一致」を作らない(§1)。
 * ⚠ 行の頭を種別の名前で留める(散文の中の数字に満たされないため)。
 */
function docCounts(): Record<Cls, number> {
  const text = readFileSync(DOC, 'utf-8');
  const at = text.indexOf('### 7.1');
  if (at < 0) throw new Error(`${DOC} に §7.1 が無い(doc の形が変わった)`);
  const seg = text.slice(at, text.indexOf('\n## ', at) < 0 ? text.length : text.indexOf('\n## ', at));
  const out = {} as Record<Cls, number>;
  for (const [key, label] of [
    ['P1', 'P1 真の点'],
    ['P2', 'P2 現在地で代替'],
    ['E', 'E 列挙'],
    ['V', 'V 値'],
    ['N', 'N 名詞'],
  ] as const) {
    const m = new RegExp(`^\\| \\*\\*${label}\\*\\* \\| \\*{0,2}(\\d+)`, 'm').exec(seg);
    if (m === null || m[1] === undefined) throw new Error(`§7.1 の表に「${label}」の行が無い`);
    out[key] = Number(m[1]);
  }
  return out;
}

describe('#582 R1 ── 受け手の引数の仕分け', () => {
  it('🔴 受け手を 1 つ残らず仕分けている(足したら落ちる)', () => {
    const map = classify();
    expect(map.size, '仕分けが受け手と揃っていない').toBe(receivers().length);
  });

  it('🔴 件数を等値で pin する(推薦の根拠そのもの)', () => {
    // ⚠ 2026-08-31: `open-manual-window`(#645)で N が 1 増えた
    // ⚠ 2026-09-02: スマホ用画面の `phone-page` / `phone-menu`(#632 段①)で N が 2 増えた
    //   ── どちらも押した所から何も要らない(行き先はボタンの属性 / 対象は選択中のノート)
    // ⚠ 2026-09-04: 付箋の `open-note-window`(#685 段②)で N が 1 増えた
    //   ── 対象は押した行(無ければ選択中)で、押した所から引数は要らない
    // ⚠ 2026-09-04: `insert-diagram` / `copy-chapter-md` / `copy-block-md` / `set-too-narrow-enabled` 等で N が 92 → 96、#676 の板の 3 受け手で 99、合流後の実測で 100(2026-09-05、#724 ③ ── 内訳の 1 件は数え直していない)
    // ⚠ 2026-09-05: 塊の移動の「元に戻す」`undo-move`(#684 段①)で N が 1 増えた
    //   ── 材料は state の `lastMove`、押した所から何も要らない(`undo-append` と同じ)
    // ⚠ 2026-09-05(#215): 行の右クリックからの整理 3 つ(`rename-entry-begin` / `move-to-folder` /
    //   `create-in-folder`)で P2 が 29 → 32 ── 押した行が無ければ `selectedLid` に効く
    // ⚠ 2026-09-05(#579): `copy-section-ref` で N が 101 → 102(`copy-chapter-md` と同じ仕分け ──
    //   行番号はメニューが運ぶので、押した所からは何も要らない)
    expect(counts()).toEqual({ P1: 40, P2: 32, E: 19, V: 8, N: 102 });
  });

  it('🔴 名指しの錨 ── 件数が同じまま入れ替わっても落ちる', () => {
    const m = classify();
    // ⚠ 5 種それぞれの**代表**。どれも「なぜその種別か」が実装から読める物を選ぶ
    expect(m.get('edit-cell'), '表のセルは、どのセルを押したかが要る').toBe('P1');
    expect(m.get('select-entry'), '行の選択は selectedLid で代替できる').toBe('P2');
    expect(m.get('set-view'), '面の切替は閉じた選択肢').toBe('E');
    expect(m.get('set-app-icon'), 'アイコンは欄の値(対象は selectedLid)').toBe('V');
    expect(m.get('open-palette'), 'パレットを開くのに引数は要らない').toBe('N');
  });

  it('🔴 doc §7.1 の数と一致する(doc だけが古くなるのを止める)', () => {
    expect(docCounts()).toEqual(counts());
  });

  it('🔴 点引数は過半ではない(= 推薦「パレットが床」が立つ条件)', () => {
    const c = counts();
    const total = (Object.values(c) as number[]).reduce((a, b) => a + b, 0);
    expect(c.P1 * 2, `点引数が過半になった(${c.P1}/${total})── doc §7 条件①により推薦を見直す`)
      .toBeLessThan(total);
  });
});

/**
 * 🔴 **門そのものを叩く**(§2 未実行の経路)。
 *
 * ⚠ `classify()` は**正しい表**しか渡さないので、この 2 つの門は
 *   上の 5 件からは**一度も通らない** ── 消しても緑のままになる。
 */
describe('#582 R1 ── 仕分けの門', () => {
  it('🔴 実在しない受け手を割り当てたら投げる(綴り違いが静かに N へ落ちない)', () => {
    expect(() => assign(['a', 'b'], [['P1', ['a', 'typo-b']]])).toThrow(/実在しない受け手/);
  });

  it('🔴 同じ受け手を 2 度割り当てたら投げる', () => {
    expect(() => assign(['a'], [['P1', ['a']], ['E', ['a']]])).toThrow(/二重に割り当てた/);
  });

  it('⚠ 割り当てなかったものは N になる(対照群 ── 門が何でも投げるのではない)', () => {
    expect(assign(['a', 'b'], [['P1', ['a']]])).toEqual(new Map([['a', 'P1'], ['b', 'N']]));
  });
});
