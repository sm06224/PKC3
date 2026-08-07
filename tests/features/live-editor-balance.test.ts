/** @vitest-environment happy-dom */
/**
 * ライブエディタの**釣り合い**(2026-08-07)。
 *
 * 原文の囲いの走査(`scanContainers`)と、描画の最上位の塊(`splitTopLevelBlocks`)の
 * 数が合わないと `buildBlockPartition` が `ok: false` を返し、行ごとの編集が
 * **全文の入力欄へ落ちる**。
 *
 * 🔴 **これは fallback なので、壊れても test は落ちない。**
 * だから今日の真理値を**表として固定する**ことにした ── 治ったものが赤に戻るのも、
 * まだ治っていないものが黙って増えるのも、両方この 1 本で見える。
 *
 * ⚠ **除外リストにしない**。「差があったら skip」と書いた瞬間、この検査は no-op に
 *   なる(CLAUDE.md「ガードは代替物で満たせない条件にする」)。代わりに:
 *   ① `ok` の値を**全件**書き出して突合する
 *   ② `ok: false` の項目には **理由を必須**にする(書けない食い違いを増やせない)
 *   ③ **`true` の件数に下限**を置く(全部 false にして表を書き換える逃げ道を塞ぐ)
 */
import { describe, expect, it } from 'vitest';
import { scanContainers } from '../../src/features/markdown/source-blocks';
import { splitTopLevelBlocks } from '../../src/features/markdown/html-blocks';
import {
  renderMarkdownWithRanges,
  buildBlockPartition,
} from '../../src/features/markdown/source-ranges';

function balance(body: string): { spans: number; blocks: number; ok: boolean } {
  const { html, ranges } = renderMarkdownWithRanges(body, { sourceLineAnchors: false });
  const blocks = splitTopLevelBlocks(html);
  const containers = scanContainers(body);
  const part = buildBlockPartition(blocks, ranges, body.split('\n').length, containers);
  return { spans: containers.length, blocks: blocks.length, ok: part.ok };
}

interface Case {
  readonly name: string;
  readonly body: string;
  /** 行ごとの編集が開くか。 */
  readonly ok: boolean;
  /**
   * ⚠ `ok: false` のときは**必須**。なぜ今日まだ釣り合っていないかを書く
   * (書けない食い違いを黙って表に足せないようにする)。
   */
  readonly whyNotOk?: string;
}

const CASES: readonly Case[] = [
  // ── 名前つきの囲い(renderer も走査器も 1 塊)──────────────
  { name: ':::note', body: ':::note\n中身\n:::\n', ok: true },
  { name: ':::section', body: ':::section{role=body}\n中身\n:::\n', ok: true },
  { name: ':::callout', body: ':::callout{type=tip}\n中身\n:::\n', ok: true },
  {
    name: ':::admonition',
    body: ':::admonition{type=warning title=題}\n中身\n:::\n',
    ok: true,
  },
  { name: ':::if', body: ':::if{format=html}\n中身\n:::\n', ok: true },
  { name: ':::details', body: ':::details{summary=x}\n中身\n:::\n', ok: true },
  { name: ':::frontmatter', body: ':::frontmatter\n中身\n:::\n', ok: true },
  { name: ':::body', body: ':::body\n中身\n:::\n', ok: true },
  { name: ':::quote', body: ':::quote{author=x}\n中身\n:::\n', ok: true },
  { name: ':::figure', body: ':::figure{#f1}\n中身\n^^^ 題\n:::\n', ok: true },
  { name: ':::paragraph', body: ':::paragraph{align=center}\n中身\n:::\n', ok: true },
  { name: ':::note の入れ子', body: ':::note\n:::note\n中身\n:::\n:::\n', ok: true },
  { name: ':::toc(中を飲まない)', body: ':::toc\n\n# 見出し\n', ok: true },

  // ── Tier 0(語彙)── `:::` の直後が英字なので走査器も見えている ────
  { name: ':::code (Tier 0)', body: ':::code\n中身\n:::\n', ok: true },
  { name: ':::red,bg-yellow (Tier 0)', body: ':::red,bg-yellow\n中身\n:::\n', ok: true },
  { name: ':::red 1.2em (Tier 0)', body: ':::red 1.2em\n中身\n:::\n', ok: true },

  // ── Tier 1(名前を持たない開き)── 2026-08-07 に直した ────────
  //    ⚠ 直す前は走査器が見落として(spans=0)全文の入力欄へ落ちていた
  { name: ':::.hl (Tier 1)', body: ':::.hl\n中身\n:::\n', ok: true },
  { name: ':::.a.b (Tier 1)', body: ':::.a.b\n中身\n:::\n', ok: true },
  { name: ':::.a#id (Tier 1)', body: ':::.a#id\n中身\n:::\n', ok: true },
  { name: ':::{.hl} (Tier 1)', body: ':::{.hl}\n中身\n:::\n', ok: true },
  { name: '::: {.hl} (Tier 1 pandoc)', body: '::: {.hl}\n中身\n:::\n', ok: true },
  { name: ':::{#id .a} (Tier 1)', body: ':::{#id .a}\n中身\n:::\n', ok: true },
  { name: '::: bareCls (Tier 1 pandoc)', body: '::: bareCls\n中身\n:::\n', ok: true },
  { name: ':::.hl + 末尾空白', body: ':::.hl   \n中身\n:::\n', ok: true },
  /**
   * 🔴 **末尾に余りが付いた Tier 1 は「開き」ではない**(2026-08-07 実測)。
   * renderer は畳まず 2 塊の literal にする ── 走査器も見てはいけない。
   * ⚠ ここが無いと、開きの正規表現から `$` の錨を外す変異が**生き延びる**
   *   (実際に生き延びた)。錨を外すと走査器だけが 1 囲いと見て**退行**する。
   */
  { name: '::: bareCls + 余り(畳まない)', body: '::: bareCls あまり\n中身\n:::\n', ok: true },
  { name: ':::.hl + 余り(畳まない)', body: ':::.hl あまり\n中身\n:::\n', ok: true },
  { name: ':::{.hl} + 余り(畳まない)', body: ':::{.hl} あまり\n中身\n:::\n', ok: true },

  // ── 走査器が見ない形(renderer も畳まない = 揃っている)────────
  {
    name: ':::_private(走査器も renderer も畳まない)',
    body: ':::_private\n中身\n:::\n',
    ok: true,
  },

  // ── 入れ子(2026-08-07 に直した)────────────────────────────
  //    ⚠ 直す前はここに並ぶ 4 件が全部 `ok: false` だった。原因は**走査器ではなく
  //      renderer** で、`quote` / `format` / `details` / `figure` / region の走査が
  //      「開いたら**最初に出会った `:::`**まで」の平坦な形のままだったこと ──
  //      内側の閉じを自分の閉じとして食い、HTML が交差していた
  //      (`</blockquote>` が `</section>` より先に出る)。
  //    🔑 実測すると壊れていたのは表の 4 件ではなく **外×内 112 通りのうち 48 通り**
  //      だった。全数は `tests/features/markdown-nesting.test.ts` が持つ ──
  //      **ここは「ライブエディタが開くか」だけを見る**。
  { name: ':::quote > :::section', body: ':::quote{author=x}\n:::section{role=body}\n中身\n:::\n:::\n', ok: true },
  { name: ':::format > :::details', body: ':::format{.a}\n:::details{summary=x}\n中身\n:::\n:::\n', ok: true },
  { name: 'Tier 1 の入れ子(:::.outer > :::.inner)', body: ':::.outer\n:::.inner\n中身\n:::\n:::\n', ok: true },
  { name: ':::quote > :::note', body: ':::quote{author=x}\n:::note\n中身\n:::\n:::\n', ok: true },

  // ── 畳まれない名前(2026-08-07 に直した)────────────────────
  //    ⚠ 直す前は走査器が `:::name` を**一律に**囲いと見ていたので、renderer が
  //      畳まない名前では塊の数が合わず**全文の入力欄へ落ちて**いた。
  //    🔑 走査器と renderer が `directive-open.ts` の**同じ判定**を引くようにして直した。
  //      当時のヘッダが書いていた「表を持ち込むな(判定が 2 か所になる)」という懸念は
  //      正しかったので、**表ではなく判定そのものを共有**している。
  { name: ':::foo(畳まれない名前)', body: ':::foo\n中身\n:::\n', ok: true },
  { name: ':::unknown-thing', body: ':::unknown-thing\n中身\n:::\n', ok: true },

  // ── まだ釣り合っていない形(理由つきで記録する)──────────────
  {
    name: ':::figure に使えない id',
    body: ':::figure{id="あ い"}\n中身\n:::\n',
    ok: false,
    whyNotOk:
      'renderer は id が不正な figure を畳まず 3 塊の literal にする(打ち間違いの合図なので黙って通さない)。' +
      '走査器は**形**だけを見るので囲いと読む ── 属性の妥当性まで共有するには、' +
      'figure / table / equation の id 検証を directive-open.ts へ降ろす必要がある。' +
      '⚠ 開かない側に倒れるので害は「今日の編集画面へ退避する」だけで、壊れた分割の上で編集させるより安全である。',
  },
];

describe('ライブエディタの釣り合い(行ごとの編集が開くか)', () => {
  for (const c of CASES) {
    it(`${c.ok ? '開く' : '開かない'}: ${c.name}`, () => {
      const r = balance(c.body);
      expect(r.ok, `${c.name}: spans=${r.spans} blocks=${r.blocks}`).toBe(c.ok);
      // ⚠ **空振り防止**: 塊が 1 個も無い(= 何も描いていない)本文で通さない
      expect(r.blocks, `${c.name}: 塊が 0 個(何も検めていない)`).toBeGreaterThan(0);
    });
  }

  /**
   * 🔴 **表そのものを守る**。件数と理由の 2 つ。
   * ⚠ これが無いと「釣り合わなくなったら表の `ok` を false に書き換える」で
   *   いくらでも緑にできる ── 表は安全網ではなく**申告**になる。
   */
  it('🔴 釣り合っていない形には理由が要る / 開く形の件数に下限がある', () => {
    for (const c of CASES) {
      if (c.ok) continue;
      expect(c.whyNotOk, `${c.name}: 釣り合わない理由が書かれていない`).toBeTruthy();
      expect((c.whyNotOk ?? '').length, `${c.name}: 理由が短すぎる`).toBeGreaterThan(40);
    }
    const open = CASES.filter((c) => c.ok).length;
    // ⚠ 2026-08-07: 入れ子で 28 → 32、畳まれない名前で 32 → 34。
    //    減ったら**退行**である(増えるのは歓迎)
    expect(open, '行ごとの編集が開く形が減っている(退行)').toBeGreaterThanOrEqual(34);
    // ⚠ 残るのは「名前は知っているが属性が不正」な 1 件だけ。増やすには理由が要る
    expect(CASES.filter((c) => !c.ok).length, '釣り合わない形が増えている').toBeLessThanOrEqual(1);
  });

  /**
   * 🔴 **Tier 1 は「走査器が見ている」ことを直接見る**(2026-08-07)。
   *
   * 上の表は `ok` という**下流の結果**を見ている ── 別の理由で ok になっても通る。
   * 壊れる当の振る舞い(走査器が Tier 1 の開きを囲いと見なすか)を直接 pin する。
   */
  it('🔴 走査器は Tier 1 の開きを囲いと見なす(閉じの行は見なさない)', () => {
    const opens = [
      ':::.hl',
      ':::.a.b#id',
      ':::{.hl}',
      '::: {.hl}',
      '::: bareCls',
      ':::{#id .a}',
    ];
    for (const o of opens) {
      const spans = scanContainers(`${o}\n中身\n:::\n`);
      expect(spans.length, `${o} を囲いと見ていない`).toBe(1);
      expect(spans[0]!.start, `${o} の開始行が違う`).toBe(0);
      expect(spans[0]!.end, `${o} が閉じまで飲んでいない`).toBe(2);
      expect(spans[0]!.open, `${o} を「閉じていない」と誤判定している`).toBe(false);
    }
    // ⚠ 閉じの行そのものを開きと読まない(読むと 1 文書が延々と囲いになる)
    expect(scanContainers(':::\n本文\n').length, '閉じの行を開きと読んでいる').toBe(0);
    expect(scanContainers('::: \n本文\n').length, '空白だけの閉じを開きと読んでいる').toBe(0);
    // ⚠ 末尾に余りが付いた形は renderer が畳まない ── 走査器も見てはいけない
    for (const j of ['::: bareCls あまり', ':::.hl あまり', ':::{.hl} あまり']) {
      expect(scanContainers(`${j}\n中身\n:::\n`).length, `${j} を囲いと読んでいる`).toBe(0);
    }
  });
});
