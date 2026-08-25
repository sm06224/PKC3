/**
 * 🔴 **拡張へ渡す「見取り図」**(#195 / C-5 段①)。
 *
 * 設計は `docs/development/pkc-extension-host-design-2026-08.md`。
 * user go は 2026-08-25(「B-2 と C-5 両方 go でいいよ」)。
 *
 * ## 🔴 いちばん大事な決まり ── **本文は 1 バイトも入れない**
 *
 * 拡張(隔離した窓の中のアプリ)へ既定で流れるのは**メタ情報だけ**である。
 * ⚠ これは礼儀ではなく**封じ込めの本体**である ── PKC2 も spec に MUST と書いていた
 * (`docs/spec/pkc-message-api-v2.md` §3.8「body/assets/revisions を含まない」)。
 * 実体を渡すのは **user のジェスチャがあったときだけ**(段②)で、
 * 🚫 **拡張から取りに行く口は作らない**。
 *
 * 🔑 だから型の側で塞ぐ ── `EntryMeta` に `body` は**そもそも無い**
 * (`core/model/entry-meta.ts` の設計)ので、ここは**写す列を名指しする**だけで
 * 「うっかり本文を載せる」形が構成できない。
 * ⚠ ただし `bodyChars`(本文の文字数)は**別の判断が要る** ── 下記。
 *
 * ## 🔑 pure module
 *
 * DOM も DB も窓も知らない。だから **unit がそのまま届く**。
 */
import type { EntryMeta } from '@core/model/entry-meta';

/**
 * 見取り図の 1 行。⚠ **`EntryMeta` をそのまま渡さない** ── 渡すと、
 * 後から `EntryMeta` に足した列が**黙って拡張まで流れる**(次に足す人は
 * 拡張のことなど考えない)。**写す列をここに名指しする**のが門である。
 */
export interface ExtEntry {
  readonly lid: string;
  readonly title: string;
  readonly archetype: string;
  /** ISO 文字列。⚠ 無ければ `null`(欠けていることを潰さない)。 */
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  /** フレーバー抽出列(本文の frontmatter 由来)。 */
  readonly status: string | null;
  readonly date: string | null;
  readonly archived: boolean;
}

/** 見取り図。⚠ **切ったかどうかを一緒に運ぶ**(黙って切らない)。 */
export interface ExtProjection {
  readonly entries: readonly ExtEntry[];
  /** 切る前の総数。 */
  readonly total: number;
  /** 🔴 上限で切ったか。⚠ 切ったなら拡張にそう言う(「無い」と読ませない)。 */
  readonly truncated: boolean;
}

/**
 * 1 度に渡す行数の上限。
 *
 * ⚠ **本文を持たない行なので軽い**が、それでも上限は要る ── 10 万件のノートを
 *   持つ人の窓で、隔離した相手に 10 万行を渡す理由が無い。
 * 🔑 段② で「続きをくれ」を足すときは、ここを**増やす**のではなく
 *   **頁を渡す**(上限そのものは残す)。
 */
export const EXT_PROJECTION_MAX = 5000;

/**
 * 🔴 **`bodyChars` を渡さない**(段① の判断)。
 *
 * ⚠ 「文字数は本文ではない」ので**渡してもよさそう**に見える ── 実際
 * `EntryMeta` の docstring も「数だけでは本文を復元できない」と書いている。
 * 🔑 それでも渡さないのは、**渡す理由が段① に 1 つも無い**からである
 * (拡張が読めるだけの段で、長さで何かを決める用事は起きていない)。
 * ⚠ **足すのは後からできるが、外すのはできない** ── 一度渡すと、それを読む
 * 拡張が現れた瞬間に外せなくなる(user 裁定 2026-08-07 の「動線を減らすな」の
 * 向きが**外側にも効く**)。要ると分かった段で足す。
 */
export const EXT_OMITTED: readonly string[] = ['bodyChars'];

/** `EntryMeta` を見取り図の 1 行にする。⚠ **口はここ 1 つ**(§7)。 */
export function extEntryOf(meta: EntryMeta): ExtEntry {
  return {
    lid: meta.lid,
    title: meta.title,
    archetype: meta.archetype,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    status: meta.status,
    date: meta.date,
    archived: meta.archived,
  };
}

/**
 * 見取り図を組む。
 *
 * ⚠ 並びは**渡された順のまま**(`entryOrder` で並べ直さない)── 呼び側の
 *   常駐の集約が既に並べてあるので、ここで 2 つ目の並べ方を作らない。
 */
export function buildProjection(metas: Iterable<EntryMeta>): ExtProjection {
  const all = [...metas];
  return {
    entries: all.slice(0, EXT_PROJECTION_MAX).map(extEntryOf),
    total: all.length,
    truncated: all.length > EXT_PROJECTION_MAX,
  };
}
