/** @vitest-environment node */
/**
 * 🔴 **アプリのタイルの並べ替え**(#857 段①)── 計画を立てる純関数。
 *
 * ⚠ ここが見るのは**何を書くか**だけ。実際に書くのは adapter
 * (`tests/adapter/app-tile-order.test.ts`)、掴めるかは実ブラウザ。
 */
import { describe, expect, it } from 'vitest';
import {
  applyTileWrites,
  isMovableTile,
  planTileMove,
  type TileOrderWrite,
} from '../../src/features/launcher/tile-order';
import { dualTile, withBuiltinTiles, type LauncherTile } from '../../src/features/launcher/tiles';

/** entry 由来のタイル 1 枚。⚠ `order` 未設定は `undefined` を明示して渡す。 */
const t = (lid: string, over: Partial<LauncherTile> = {}): LauncherTile => ({
  lid,
  title: lid,
  group: '',
  kind: 'url',
  url: `https://example.test/${lid}`,
  ...over,
});

/** 並びを読みやすくする(lid だけ)。 */
const lids = (xs: readonly LauncherTile[]): string[] => xs.map((x) => x.lid);

describe('掴んで落とす(同じ群)', () => {
  const abc = [t('a', { order: 0 }), t('b', { order: 1 }), t('c', { order: 2 })];

  it('🔴 いちばん下を先頭へ落とすと、その群に連番が振り直る', () => {
    expect(planTileMove(abc, 'c', { kind: 'edge', group: '', anchor: 'a', edge: 'before' })).toEqual([
      { lid: 'c', order: 0 },
      { lid: 'a', order: 1 },
      { lid: 'b', order: 2 },
    ]);
  });

  it('🔴 末尾へ落とす(いちばん下のタイルの `after`)', () => {
    expect(planTileMove(abc, 'a', { kind: 'edge', group: '', anchor: 'c', edge: 'after' })).toEqual([
      { lid: 'b', order: 0 },
      { lid: 'c', order: 1 },
      { lid: 'a', order: 2 },
    ]);
  });

  /**
   * 🔴 **元の位置へ落とし戻したら 1 件も書かない。**
   * ⚠ ここが空でないと、掴んで戻しただけで**触っていないノートの frontmatter が
   *   増える**(履歴も動く)。
   */
  it('🔴 並びが変わらない回は 1 件も書かない', () => {
    expect(planTileMove(abc, 'b', { kind: 'edge', group: '', anchor: 'c', edge: 'before' })).toEqual([]);
    // ⚠ 自分の手前へ落とす(= 動いていない)も同じ
    expect(planTileMove(abc, 'b', { kind: 'edge', group: '', anchor: 'b', edge: 'before' })).toEqual([]);
    // ⚠ 末尾の物を末尾へ
    expect(planTileMove(abc, 'c', { kind: 'edge', group: '', anchor: 'c', edge: 'after' })).toEqual([]);
    // ⚠ 自分の 1 つ上の「下半分」= いまの位置そのもの
    expect(planTileMove(abc, 'c', { kind: 'edge', group: '', anchor: 'b', edge: 'after' })).toEqual([]);
  });

  /**
   * 🔴 **番号の無い群は、初めての並べ替えで全件に番号が付く**。
   * ⚠ `sortTiles` は `app_order` 未設定を**末尾**に置くので、動かした 1 件にだけ
   *   番号を付けると**付けていない物が全部下へ飛ぶ**(この test が無いと、
   *   その壊れ方が静かに通る)。
   */
  it('🔴 番号を持たない群は、1 回の並べ替えで全件に連番が付く', () => {
    const raw = [t('a'), t('b'), t('c')];
    expect(planTileMove(raw, 'c', { kind: 'edge', group: '', anchor: 'a', edge: 'before' })).toEqual([
      { lid: 'c', order: 0 },
      { lid: 'a', order: 1 },
      { lid: 'b', order: 2 },
    ]);
  });

  /**
   * 🔴 **渡された配列の並びに寄りかからない**(着地前レビュー ⚠8)。
   * ⚠ `planTileMove` は中で `sortTiles` を通しているが、**崩した配列を渡す test が
   *   1 件も無い**と、その 1 行を消しても全部緑になる(何も守っていない)。
   */
  it('🔴 順が崩れた配列を渡しても、`app_order` の順で読む', () => {
    const shuffled = [t('c', { order: 2 }), t('a', { order: 0 }), t('b', { order: 1 })];
    expect(planTileMove(shuffled, 'c', { kind: 'step', by: -1 })).toEqual([
      { lid: 'c', order: 1 },
      { lid: 'b', order: 2 },
    ]);
  });

  it('⚠ 知らない lid の手前へは入れない(末尾へ落とさない)', () => {
    expect(planTileMove(abc, 'a', { kind: 'edge', group: '', anchor: 'zzz', edge: 'before' })).toEqual([]);
  });
});

describe('群をまたいで落とす(user 裁定 2026-09-12「またげる」)', () => {
  const mixed = [
    t('a', { order: 0 }),
    t('b', { order: 1 }),
    t('x', { group: '仕事', order: 0 }),
    t('y', { group: '仕事', order: 1 }),
  ];

  it('🔴 別の群の途中へ落とすと、群も一緒に書き替わる', () => {
    const plan = planTileMove(mixed, 'a', { kind: 'edge', group: '仕事', anchor: 'y', edge: 'before' });
    // ⚠ `x` は既に 0 番なので**書かない**(値が変わる行だけ書く)
    expect(plan).toEqual([
      { lid: 'a', order: 1, group: '仕事' },
      { lid: 'y', order: 2 },
    ]);
    // 🔑 群を書くのは**動かした 1 件だけ** ── 他の行の `app_group` は触らない
    expect(plan.filter((w) => w.group !== undefined).map((w) => w.lid)).toEqual(['a']);
  });

  it('⚠ 元居た群は振り直さない(触っていない物を書かない)', () => {
    const plan = planTileMove(mixed, 'a', { kind: 'edge', group: '仕事', anchor: 'y', edge: 'after' });
    expect(plan.map((w) => w.lid), '元の群の b まで書いている').not.toContain('b');
  });

  /**
   * 🔴 **並びが同じでも、群が変わるなら書く。**
   * ⚠ 「変わらないなら書かない」の門が群まで飲み込むと、**落とせて効かない**
   *   (押せるのに何も起きない)という、この repo がいちばん嫌う形になる。
   */
  it('🔴 落とした先での位置が同じでも、群が変われば書く', () => {
    const one = [t('a', { order: 0 }), t('x', { group: '仕事', order: 0 })];
    expect(planTileMove(one, 'a', { kind: 'edge', group: '仕事', anchor: 'x', edge: 'before' })).toEqual([
      { lid: 'a', order: 0, group: '仕事' },
      { lid: 'x', order: 1 },
    ]);
  });
});

describe('上へ / 下へ(掴めない人の道)', () => {
  const abc = [t('a', { order: 0 }), t('b', { order: 1 }), t('c', { order: 2 })];

  it('🔴 1 つ上へ / 1 つ下へ', () => {
    expect(planTileMove(abc, 'b', { kind: 'step', by: -1 })).toEqual([
      { lid: 'b', order: 0 },
      { lid: 'a', order: 1 },
    ]);
    expect(planTileMove(abc, 'b', { kind: 'step', by: 1 })).toEqual([
      { lid: 'c', order: 1 },
      { lid: 'b', order: 2 },
    ]);
  });

  it('⚠ 端では何もしない(輪にしない ── 一番上で「上へ」を押して末尾へ飛ばない)', () => {
    expect(planTileMove(abc, 'a', { kind: 'step', by: -1 })).toEqual([]);
    expect(planTileMove(abc, 'c', { kind: 'step', by: 1 })).toEqual([]);
  });

  it('⚠ 数えるのは同じ群の中だけ(別の群の物を飛び越えない)', () => {
    const mixed = [t('a', { order: 0 }), t('x', { group: '仕事', order: 0 })];
    // a は既定群の 1 件だけなので、上へも下へも動けない
    expect(planTileMove(mixed, 'a', { kind: 'step', by: 1 })).toEqual([]);
  });
});

describe('組み込みは並べ替えの対象外', () => {
  it('🔴 組み込みタイルを動かそうとしても 1 件も書かない(entry を持たない)', () => {
    const all = withBuiltinTiles([t('a', { order: 0 })], { office: false });
    expect(planTileMove(all, dualTile().lid, { kind: 'step', by: -1 })).toEqual([]);
    expect(
      planTileMove(all, dualTile().lid, { kind: 'edge', group: '', anchor: 'a', edge: 'before' }),
    ).toEqual([]);
  });

  it('🔑 見分ける規則は 1 本(`isMovableTile`)', () => {
    expect(isMovableTile(t('a'))).toBe(true);
    expect(isMovableTile(dualTile())).toBe(false);
  });

  /**
   * ⚠ **組み込みの上へ落としても、組み込みの群へは入らない。**
   * 🔑 群の名前で受けるので、`launcher.ts` が組み込みの升目を落とし先にしなければ
   *   ここへは来ない ── それでも計画側で 1 度止める(門は 2 枚)。
   */
  it('⚠ 組み込みの群を行き先にしても、そこは並べ替えの対象ではない', () => {
    const all = withBuiltinTiles([t('a', { order: 0 })], { office: false });
    const plan = planTileMove(all, 'a', {
      kind: 'edge',
      group: dualTile().group,
      anchor: dualTile().lid,
      edge: 'before',
    });
    // ⚠ 組み込みは `movable` から落ちるので、行き先の目印が見つからず何も書かない
    expect(plan).toEqual([]);
  });
});

describe('画面へ先に当てる(楽観)', () => {
  /**
   * 🔴 **群の名前が「組み込みアプリ」より後ろに並ぶ物を入れる**(着地前レビュー ⚠8)。
   * ⚠ 1 稿目の fixture は `''` と `'仕事'` だけで、**どちらも `組` より前**に並ぶ ──
   *   だから組み込みを `sortTiles` に混ぜる変異を当てても**位置が変わらず**、
   *   この検査は何も守っていなかった。`資料`(資 > 組)なら、混ぜた版では
   *   組み込みが user のタイルの**間**へ割り込む。
   */
  it('🔴 組み込みは末尾のまま動かない(群の名前で混ざらない)', () => {
    const all = withBuiltinTiles(
      [t('a', { order: 0 }), t('b', { order: 1 }), t('z', { group: '資料', order: 0 })],
      { office: false },
    );
    const plan: TileOrderWrite[] = [
      { lid: 'b', order: 0 },
      { lid: 'a', order: 1 },
    ];
    const next = applyTileWrites(all, plan);
    expect(lids(next).slice(0, 2), '並べ替えが画面に出ていない').toEqual(['b', 'a']);
    expect(
      lids(next).slice(2),
      '組み込みの並びが変わった(user のタイルの間へ割り込んだ)',
    ).toEqual(lids(all).slice(2));
  });

  it('🔴 群が変われば、その群へ移って見える', () => {
    const mixed = [t('a', { order: 0 }), t('x', { group: '仕事', order: 0 })];
    const next = applyTileWrites(mixed, [{ lid: 'a', order: 1, group: '仕事' }]);
    expect(next.map((n) => [n.lid, n.group])).toEqual([
      ['x', '仕事'],
      ['a', '仕事'],
    ]);
  });

  it('⚠ 書くものが無ければ 1 つも動かさない', () => {
    const all = withBuiltinTiles([t('a', { order: 0 })], { office: false });
    expect(lids(applyTileWrites(all, []))).toEqual(lids(all));
  });
});
