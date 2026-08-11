/**
 * 添付の**版の台帳**(#88 / O4)。
 *
 * 🔴 user 裁定 2026-08-11:「**アセットの履歴は全バイトにならざるを得ないよね?
 * ならば容量 Limit と世代 Limit の両方を制約にしたい / 明示的スナップショットと
 * 自動履歴は区別したい**」。
 *
 * ## 置き場は frontmatter ── 新しい保管庫を作らない
 *
 * `attachment.history` に 1 版 = 1 行で持つ。別の保管庫に置く案から乗り換えた理由:
 *
 * | | 別の保管庫 | frontmatter |
 * |---|---|---|
 * | GC の「まだ使われている」判定 | **書き足す**(片方だけ見るとフォーク先が消える) | **key が本文に出るので既存の広い走査が拾う** |
 * | バックアップに入るか | 入れる処理が要る | **本文なので入る** |
 * | 版の増減そのものの履歴 | 無い | **テキスト履歴に残る** |
 *
 * ## 🔴 列には「過去の版」だけを入れる
 *
 * いまの版は `attachment.asset_key` に在り、**この列には入らない**。
 * こうすると「いまの版は絶対に落ちない」が**規則ではなく構造**になる ──
 * 落としようがない(CLAUDE.md「ガードは代替物で満たせない条件にする」の同型)。
 *
 * ## 🔴 列から外すことと、bytes を消すことは別
 *
 * 上限で版を列から外しても、**bytes はここでは消さない**。その `assetKey` は
 * 別のノートの本文・別の添付の台帳・フォーク先の「いまの版」が**まだ指している
 * かもしれない**。実際に消すのは既存の「使っていない添付を消す」だけで、判定は
 * そこ 1 か所のまま ── 誤差は **keep 側にしか出ない**。
 *
 * ⚠ **pure module**。browser API も storage も触らない。
 */
import { parseFrontmatter, type FrontmatterValue } from '@features/markdown/frontmatter';

/** frontmatter の key。⚠ **1 か所**(綴りを 2 通り作らない)。 */
export const VERSIONS_KEY = 'attachment.history';

/**
 * 🔴 **既定の上限**(user 裁定 2026-08-11「両方を制約にしたい」)。
 *
 * ⚠ **出発点であって規律ではない** ── user 指示「予算は手違いの検出であって、
 * サイズを守らせる規律ではない」と同じ扱いで、設定から引き上げられる形にする。
 * 根拠: Office 文書は 0.1〜5MB が大半 / 200MB は Office 一式(77MB)と同じ桁で、
 * ブラウザの quota に対して十分小さい。
 */
export const DEFAULT_KEEP_GENERATIONS = 5;
export const DEFAULT_HISTORY_BYTES = 200 * 1024 * 1024;

export interface AttachmentVersion {
  /** ISO 8601。⚠ **並び順の鍵**でもある(古い順に落とす)。 */
  readonly savedAt: string;
  /** `auto` = 保存で自動に増えた / `pinned` = user が「この版を残す」を押した。 */
  readonly kind: 'auto' | 'pinned';
  readonly assetKey: string;
  readonly bytes: number;
  /** user が付けた名前。無ければ空。⚠ **`|` を含んでよい**(最後に置くため)。 */
  readonly label: string;
}

/**
 * 1 版を 1 行にする。
 *
 * ⚠ **ラベルは最後**に置く ── `|` を含んでよくするため。逃がし文字を作らない
 * (逃がし文字は「戻し忘れ」を必ず生む)。
 * ⚠ 前の 4 つは `|` を含まない(ISO 日時 / 列挙 / `ast-…` / 数字)。
 */
export function serializeVersion(v: AttachmentVersion): string {
  return [v.savedAt, v.kind, v.assetKey, String(Math.max(0, Math.trunc(v.bytes))), v.label].join('|');
}

/** 1 行を版に戻す。**読めない行は `null`**(壊れた行で全部を捨てない)。 */
export function parseVersion(line: string): AttachmentVersion | null {
  const parts = line.split('|');
  if (parts.length < 4) return null;
  const [savedAt, kind, assetKey, bytes] = parts as [string, string, string, string];
  if (savedAt === '' || assetKey === '') return null;
  if (kind !== 'auto' && kind !== 'pinned') return null;
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return null;
  return {
    savedAt,
    kind,
    assetKey,
    bytes: Math.trunc(n),
    // ⚠ 4 個目より後ろは**全部ラベル**(`|` を含んだラベルを壊さない)
    label: parts.slice(4).join('|'),
  };
}

/**
 * 本文から版の列を読む。**古い順**(`savedAt` の昇順)で返す。
 *
 * ⚠ 読めない行は黙って落とす ── 1 行壊れただけで履歴が全部消えるほうが害が大きい。
 * ⚠ 並べ替えは**ここでやる**(書いた順に依存しない)。
 */
export function readVersions(body: string): AttachmentVersion[] {
  const { meta } = parseFrontmatter(body);
  const raw = meta[VERSIONS_KEY];
  const lines: string[] = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === 'string')
    : typeof raw === 'string' && raw !== ''
      ? [raw] // ⚠ 1 件だけのとき配列に見えない書き方をされても拾う
      : [];
  return lines
    .map(parseVersion)
    .filter((v): v is AttachmentVersion => v !== null)
    .sort((a, b) => (a.savedAt < b.savedAt ? -1 : a.savedAt > b.savedAt ? 1 : 0));
}

/**
 * `spliceFrontmatterKeys` へ渡す値にする。
 * ⚠ **空の列は key ごと消す**(`undefined`)── 空の配列を残すと本文に無意味な行が出る。
 */
export function versionsValue(list: readonly AttachmentVersion[]): FrontmatterValue | undefined {
  return list.length === 0 ? undefined : list.map(serializeVersion);
}

export interface EvictLimits {
  /** 1 添付あたりの自動履歴の世代。 */
  readonly keepGenerations?: number;
  /** 台帳全体の合計バイト。⚠ `reservedBytes` を**含めた**上限である。 */
  readonly maxTotalBytes?: number;
  /**
   * 🔴 **ここに渡されていない添付が既に使っているバイト**(2026-08-11、変異試験で判明)。
   *
   * ⚠ これが無いと、容量の上限が**この呼び出しに渡した添付の中だけ**で閉じる ──
   * ほかの添付が 150MB 持っていても気づかず、全体では上限を超える。
   * 🔑 予約分は**数えるが落とさない** ── 保存した添付の履歴を削るのが「保存の副作用」
   * として自然であり、無関係なノートの履歴を巻き添えで消すのは驚きが大きい。
   * 収まらなければ `overBudget` で言う(黙って諦めない)。
   */
  readonly reservedBytes?: number;
}

export interface EvictResult<T> {
  /** 残す版(入力と同じ形で返す)。 */
  readonly keep: readonly T[];
  /** 列から外す版。⚠ **bytes をここで消さない**(module の注記)。 */
  readonly dropped: readonly T[];
  /**
   * 🔴 **上限に収まらなかったか。** `pinned` だけで容量を超えているときは
   * これ以上落とせない ── 黙って諦めず、呼び側が user へ言えるようにする。
   */
  readonly overBudget: boolean;
}

/**
 * 🔴 **世代と容量の両方を当てる**(user 裁定「両方を制約にしたい」)。
 *
 * ⚠ **片方だけでは守れない** ── 世代だけなら 50MB × 5 世代が通り、
 * 容量だけなら 1KB の版が何千も残る。
 *
 * 手順:
 *  ① 添付ごとに、`auto` が世代上限を超えた分を**古い順**に外す
 *  ② それでも合計が容量上限を超えていたら、**全体で古い順**にさらに外す
 *  ③ `pinned` は①②のどちらでも外さない。⚠ ただし**合計には数える**
 *     (数えないと、pin を積むほど自動履歴が押し出されない = 上限が嘘になる)
 *
 * @param groups 添付ごとの版の列(`readVersions` の出力をそのまま渡す)
 */
export function evictVersions<T extends AttachmentVersion>(
  groups: ReadonlyMap<string, readonly T[]>,
  limits: EvictLimits = {},
): Map<string, EvictResult<T>> {
  const keepGen = limits.keepGenerations ?? DEFAULT_KEEP_GENERATIONS;
  const maxBytes = limits.maxTotalBytes ?? DEFAULT_HISTORY_BYTES;
  // ⚠ 予約分は落とせないが、上限の消費としては**先に効く**
  const reserved = Math.max(0, limits.reservedBytes ?? 0);

  const kept = new Map<string, T[]>();
  const dropped = new Map<string, T[]>();
  for (const [lid, list] of groups) {
    // ⚠ 古い順に並べてから数える(呼び側の並びに依存しない)
    const asc = [...list].sort((a, b) => (a.savedAt < b.savedAt ? -1 : a.savedAt > b.savedAt ? 1 : 0));
    const autos = asc.filter((v) => v.kind === 'auto');
    const over = Math.max(0, autos.length - Math.max(0, keepGen));
    const cut = new Set(autos.slice(0, over));
    kept.set(lid, asc.filter((v) => !cut.has(v)));
    dropped.set(lid, [...cut]);
  }

  // ② 容量。⚠ **pinned も数える**が、落とすのは `auto` だけ
  const total = (): number => {
    let n = reserved;
    for (const list of kept.values()) for (const v of list) n += v.bytes;
    return n;
  };
  if (total() > maxBytes) {
    // 全体を古い順に並べ、`auto` だけを順に外す
    const candidates: { lid: string; v: T }[] = [];
    for (const [lid, list] of kept) for (const v of list) if (v.kind === 'auto') candidates.push({ lid, v });
    candidates.sort((a, b) => (a.v.savedAt < b.v.savedAt ? -1 : a.v.savedAt > b.v.savedAt ? 1 : 0));
    for (const { lid, v } of candidates) {
      if (total() <= maxBytes) break;
      kept.set(lid, kept.get(lid)!.filter((x) => x !== v));
      dropped.get(lid)!.push(v);
    }
  }

  const over = total() > maxBytes;
  const out = new Map<string, EvictResult<T>>();
  for (const [lid, list] of kept) {
    out.set(lid, { keep: list, dropped: dropped.get(lid) ?? [], overBudget: over });
  }
  return out;
}

/** 台帳の合計バイト(画面に出す用)。⚠ `pinned` も数える。 */
export function totalHistoryBytes(groups: Iterable<readonly AttachmentVersion[]>): number {
  let n = 0;
  for (const list of groups) for (const v of list) n += v.bytes;
  return n;
}
