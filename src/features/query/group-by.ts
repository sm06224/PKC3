/**
 * **frontmatter で束ねて表にする**(#184 / 台帳 #180 の A-4)。
 *
 * 🔴 **ここは純関数**(features 層)。DB も DOM も知らない ── 受け取るのは
 * 「lid と**本文の先頭**」の列だけ。呼ぶのは storage worker である。
 *
 * ## なぜ worker で束ねるのか(性能の分かれ目)
 *
 * ⚠ 一覧を描くとき、主スレッドに**本文は 1 バイトも常駐していない**
 * (`core/model/entry-meta.ts` が「body の不在は意図的」と宣言している)。
 * だから束ねるには本文が要る ── しかし **`getBodies` で全件を主スレッドへ運ぶのは
 * 禁じ手**である:
 *
 * - 不可侵指示(2026-07-27)「ゼロコピー、生成とライフサイクル後の速やかな破棄」に正面から当たる
 * - ランチャーが「添付だけ」に絞った理由(`store-effects.ts`「全 entry の body を
 *   読むと開くたびに全文を舐める」)と同じ穴
 *
 * 🔑 だから **全文検索と同じ型**に乗せる ── 重い舐めは worker、主スレッドへ返すのは
 * **束ねた結果(値と lid)だけ**。題名は主スレッドの `entryMetas` に既に在るので、
 * 表を描くのに本文は要らない。
 *
 * 🔑 さらに worker が読むのは **本文の先頭だけ**(`substr`)。frontmatter は
 * 定義上「本文の先頭の `---` 囲み」で、上限も 16KB(`resolveCap('frontmatter','bytes')`)
 * なので、**先頭を切って渡せば全文を読む必要が無い**。
 */

import { parseFrontmatter, type FrontmatterValue } from '../markdown/frontmatter';
import { resolveCap } from '../notation/caps';

/**
 * 🔴 **worker が読む本文の先頭の字数**(#184。レビュー A-2 で直した)。
 *
 * ⚠ 1 稿目は `16 * 1024` を直書きし、コメントに「字数はバイト数以下なので、
 * 上限内の frontmatter は必ず入る」と書いていた ── **その因果が間違っていた**。
 * 上限(16KB)が掛かるのは**囲みの中身**であって、窓は**囲みごと**切るので、
 * ASCII の frontmatter がちょうど上限まで書かれていると**閉じの `---` が窓の外**へ出る
 * (実測: 中身 16,384 バイト → 本文 16,397 字。窓 16,384 字では閉じ fence が落ちる)。
 * そのノートは `found:false` になり、**黙って「未設定」の組へ落ちる**。
 *
 * 🔑 だから **cap から導く**(直書きしない)── cap を将来 32KB へ上げても追従する。
 * 余白は囲み 2 行と改行のぶん(実際に要るのは 8 字ほど。64 は安全側)。
 */
export const FRONTMATTER_SCAN_CHARS = resolveCap('frontmatter', 'bytes') + 64;

/** 1 件ぶんの材料。`head` は**本文の先頭**(全文でも動くが、渡す側が切る)。 */
export interface QueryRow {
  lid: string;
  head: string;
}

/** 束ねた 1 組。 */
export interface QueryGroup {
  /** 束ねた値。空文字は「この key を持っていない」= 未設定。 */
  value: string;
  /** その組に属する件数(**上限で切る前**の数)。 */
  total: number;
  /** その組の lid(`total` より少ないことがある ── 切ったぶん)。 */
  lids: readonly string[];
}

/** key の目録(user に「何で束ねられるか」を出すため)。 */
export interface QueryKeyStat {
  key: string;
  /** その key を持っている件数。 */
  count: number;
}

export interface GroupResult {
  groups: readonly QueryGroup[];
  /** 上限で**捨てた組**の数。⚠ 0 でないなら画面に出す(黙って切らない)。 */
  omittedGroups: number;
  /** 実際に見た件数(空振り検出に使う ── 0 なら「束ねた」は何も言っていない)。 */
  scanned: number;
}

export interface KeyResult {
  keys: readonly QueryKeyStat[];
  omittedKeys: number;
  scanned: number;
}

/**
 * 上限。⚠ どれも「画面に出して意味がある量」で決めてある ──
 * 大きくすると表が読めなくなり、小さくすると user のデータが黙って消える。
 */
export const QUERY_LIMITS = {
  /** 目録に出す key の数。 */
  keys: 50,
  /** 1 回の表に出す組の数。 */
  groups: 200,
  /** 1 組が抱える lid の数。 */
  lidsPerGroup: 500,
  /** 組の名前の長さ(字)。⚠ 長い値は**丸める**が、丸めたことが判る形にする。 */
  valueChars: 80,
} as const;

/** 未設定の組の値(空文字)。表示名は adapter 側が決める(features は字を持たない)。 */
export const UNSET = '';

/**
 * frontmatter の値を「組の名前」へ落とす。
 *
 * ⚠ **配列は 1 件が複数の組に属する**(`tags: [a, b]` は a にも b にも入る)──
 * これが無いとタグで束ねられない。
 * ⚠ `null` は「書いてあるが空」なので**未設定と同じ扱い**にする(user から見て
 * `key:` とだけ書いた行と、書いていない行を別の組にしても意味が無い)。
 */
function valuesOf(v: FrontmatterValue | undefined): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) {
      if (item === null) continue;
      const s = String(item).trim();
      if (s !== '') out.push(clip(s));
    }
    return out;
  }
  const s = String(v).trim();
  return s === '' ? [] : [clip(s)];
}

function clip(s: string): string {
  return s.length <= QUERY_LIMITS.valueChars ? s : `${s.slice(0, QUERY_LIMITS.valueChars)}…`;
}

/**
 * 🔴 **1 回の走査で、目録と表を同時に作る**(レビュー B-3 で直した)。
 *
 * ⚠ 1 稿目は目録と表が**それぞれ独立に全件を舐めて**いたので、面を開くたびに
 * **DB の全件走査が 2 回**走っていた(op の回数は 2 でも、走査は 2 回である)。
 * ⚠ さらに worker が**全行を一度に materialize** していたため、本文の長い container で
 * 一時ピークが跳ねた ── `storage-worker.ts` 冒頭のメモリ 2 原則(**大きな値は
 * 保持しない**)と、2026-07-27 の不可侵指示(ゼロコピー / 即破棄)から外れていた。
 *
 * 🔑 だから **少しずつ食わせる形**にする。呼び側(worker)は数百件ずつ読んで `feed` し、
 * 最後に `finish()` する ── どの瞬間も手元に在るのは 1 まとまりだけである。
 */
export interface QueryScan {
  feed(rows: readonly QueryRow[]): void;
  /** ⚠ `groups` は key を選んでいないとき `null`(0 組ではない)。 */
  finish(): { keys: KeyResult; groups: GroupResult | null };
}

export function createQueryScan(key: string | null): QueryScan {
  const count = new Map<string, number>();
  const buckets = new Map<string, { total: number; lids: string[] }>();
  let scanned = 0;

  const take = (value: string, lid: string): void => {
    let b = buckets.get(value);
    if (b === undefined) {
      b = { total: 0, lids: [] };
      buckets.set(value, b);
    }
    b.total += 1;
    // ⚠ 上限を超えたぶんは lid を持たないが、**数は数え続ける**
    // (「N 件中 M 件を出しています」と言えるように)
    if (b.lids.length < QUERY_LIMITS.lidsPerGroup) b.lids.push(lid);
  };

  return {
    feed(rows) {
      for (const row of rows) {
        scanned += 1;
        const { meta } = parseFrontmatter(row.head);
        for (const [k, value] of Object.entries(meta)) {
          // ⚠ 値を持たない key は「束ねられない」ので目録に出さない
          if (valuesOf(value).length === 0) continue;
          count.set(k, (count.get(k) ?? 0) + 1);
        }
        if (key === null) continue;
        const values = valuesOf(meta[key]);
        if (values.length === 0) {
          take(UNSET, row.lid);
          continue;
        }
        // ⚠ 同じ値が 2 回書いてあっても 1 件として数える(`tags: [a, a]`)
        for (const value of [...new Set(values)]) take(value, row.lid);
      }
    },
    finish() {
      const keys = [...count.entries()]
        .map(([k, n]) => ({ key: k, count: n }))
        // 並びは **件数の多い順 → key の字順**。⚠ 件数だけで並べると、同数の key の順が
        // 走査順(= entry_order)で揺れて、開くたびに目録の並びが変わる
        .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const groups = [...buckets.entries()]
        .map(([value, b]) => ({ value, total: b.total, lids: b.lids }))
        // 並びは **件数の多い順 → 値の字順**、ただし**未設定は必ず最後**
        // (「持っていないもの」が先頭に来ると表が読めない)
        .sort((a, b) => {
          if (a.value === UNSET) return 1;
          if (b.value === UNSET) return -1;
          return b.total - a.total || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0);
        });
      return {
        keys: {
          keys: keys.slice(0, QUERY_LIMITS.keys),
          omittedKeys: Math.max(0, keys.length - QUERY_LIMITS.keys),
          scanned,
        },
        groups:
          key === null
            ? null
            : {
                groups: groups.slice(0, QUERY_LIMITS.groups),
                omittedGroups: Math.max(0, groups.length - QUERY_LIMITS.groups),
                scanned,
              },
      };
    },
  };
}

/**
 * 束ねられる key の目録を作る(**1 まとめで渡す版**)。
 * ⚠ 規則は `createQueryScan` 1 か所 ── ここは薄い包みである(判定を 2 か所に生やさない)。
 */
export function collectKeys(rows: readonly QueryRow[]): KeyResult {
  const scan = createQueryScan(null);
  scan.feed(rows);
  return scan.finish().keys;
}

/**
 * 指定の key で束ねる(**1 まとめで渡す版**)。
 * ⚠ 走査順は呼び側の並び(= `entry_order`)を保つ ── 組の中の lid が
 * 一覧と同じ順に並ぶので、user が「さっき見たもの」を見失わない。
 */
export function groupByKey(rows: readonly QueryRow[], key: string): GroupResult {
  const scan = createQueryScan(key);
  scan.feed(rows);
  // ⚠ key を渡しているので `groups` は必ず在る
  return scan.finish().groups!;
}
