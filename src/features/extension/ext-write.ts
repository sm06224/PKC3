/**
 * 🔴 **拡張からの書き戻し**(#195 / C-5 段③)。
 *
 * 設計は `docs/development/pkc-extension-host-design-2026-08.md`。
 *
 * ## 語彙は 1 語だけ ── **増やさないことが仕様である**
 *
 * 🚫 PKC2 は write op が **9 種**まで育ち、さらに DSL まで生えた
 * (`docs/spec/pkc-message-api-v2.md`)。⚠ 1 語ずつは全部もっともらしく、
 * **どれも「あと 1 つだけ」だった**。だからここは**足す前に読む場所**を作る:
 *
 * | 語 | 何ができるか |
 * |---|---|
 * | `setBody` | 🔴 **渡された 1 件の本文を書き戻す**。それだけ |
 *
 * 🚫 **作成は無い** ── 新規は C-4 の `pkc.createEntry`(帯に出る形)を通る。
 *   2 つ目の作成口を作らない(#195 の段取りに明記)。
 * 🚫 **削除は無い** ── 取り消せない操作を、user が見ていない所で撃たせない。
 * 🚫 **題名・関係・タグの書換は無い** ── 本文が正本なので、frontmatter に
 *   書けば結果として変わる。**口を増やさずに同じことができる**。
 *
 * ## 🔴 書けるのは「user が渡した 1 件」だけ
 *
 * 段② の「取りに行く口は作らない」と**同じ 1 つの原理**である ──
 * user のジェスチャ(情報ペインの「このアプリへ送る」)が、
 * **その 1 件について読みと書きの両方**を許す。渡していない lid は
 * **語彙として正しくても拒否する**。
 *
 * ⚠ だから拡張は「PKC3 の中を書き換える」ことはできない ── できるのは
 *   **手渡された物を直して返す**ことだけである。
 *
 * ## 🔴 1 件でも不正なら**全体拒否**
 *
 * ⚠ 部分適用は user から見て**いちばん分からない負け方**である ──
 *   「3 件送ったのに 2 件だけ変わった」を後から見分ける手段が無い。
 * 🔑 だから**書く前に全部検める**。検めるのは形・重複・上限・**渡した覚え**の 4 つ。
 *
 * ⚠ **これと「別の窓が書き替えていた」は別の話**である(こちらは書込の最中に
 *   しか分からない)── そちらは `extension-host` 側が `expectHash` で見て、
 *   起きたら残りを止めて**件数つきで断る**。ここが約束するのは
 *   「**不正な依頼では 1 バイトも書かない**」までである。
 *
 * 🔑 **pure module**。窓も DOM も storage も知らない。
 */

/** 書き戻しの 1 手。⚠ **語はこれだけ**(上の表)。 */
export interface ExtWriteOp {
  readonly op: 'setBody';
  readonly lid: string;
  readonly body: string;
}

/** 検めた結果。⚠ **なぜ断ったか**を必ず持たせる(無言で捨てない)。 */
export type ExtWriteParsed =
  | { readonly ok: true; readonly ops: readonly ExtWriteOp[] }
  | { readonly ok: false; readonly why: string };

/**
 * 1 度に受ける手の数。
 * ⚠ 上限を置く理由は「重いから」ではない(不可侵指示 2026-08-03)── **渡した
 *   覚えのある件数を超える依頼は、そもそも筋が通らない**からである。
 *   渡した集合そのものが自然な上限なので、これは**その外側の桁**の門である。
 */
export const EXT_WRITE_OPS_MAX = 100;

/**
 * 拡張から来た書き戻しの依頼を検める。
 *
 * @param data 港から来た生の値(何が入っているか分からない)
 * @param delivered 🔴 **user がこの拡張へ渡した lid の集合**。ここに無い lid は拒否
 *
 * ⚠ **`delivered` を optional にしない** ── 渡し忘れると「誰でも何でも書ける」
 *   側へ倒れる。tsc に止めさせる。
 */
export function parseExtWrite(data: unknown, delivered: ReadonlySet<string>): ExtWriteParsed {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return { ok: false, why: '封筒が object ではありません' };
  const raw = (data as { ops?: unknown }).ops;
  if (!Array.isArray(raw)) return { ok: false, why: 'ops が配列ではありません' };
  if (raw.length === 0) return { ok: false, why: 'ops が空です' };
  if (raw.length > EXT_WRITE_OPS_MAX)
    return { ok: false, why: `ops が多すぎます(${raw.length} > ${EXT_WRITE_OPS_MAX})` };
  const ops: ExtWriteOp[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    const at = `ops[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item))
      return { ok: false, why: `${at} が object ではありません` };
    const o = item as { op?: unknown; lid?: unknown; body?: unknown };
    if (o.op !== 'setBody')
      return {
        ok: false,
        why:
          `${at}: 「${String(o.op)}」は在りません(意図的です)。` +
          '書き戻せるのは setBody 1 つだけで、新規作成は pkc.createEntry を通ります。',
      };
    if (typeof o.lid !== 'string' || o.lid === '')
      return { ok: false, why: `${at}: lid がありません` };
    if (typeof o.body !== 'string') return { ok: false, why: `${at}: body が文字列ではありません` };
    /**
     * ⚠ **同じ lid を 2 回書かせない** ── どちらが残るかは順番次第で、
     *   拡張の作者からも user からも見えない(黙って片方が消える)。
     */
    if (seen.has(o.lid)) return { ok: false, why: `${at}: 同じノートが 2 回あります` };
    /**
     * 🔴 **渡した覚えのない lid は拒否する。**
     * ⚠ これが段② の「取りに行く口は作らない」と**同じ原理**である ──
     *   user のジェスチャが許したのは、その 1 件についてだけである。
     */
    if (!delivered.has(o.lid))
      return {
        ok: false,
        why: `${at}: このノートは渡されていません(user が「このアプリへ送る」で渡した物だけ書き戻せます)`,
      };
    seen.add(o.lid);
    ops.push({ op: 'setBody', lid: o.lid, body: o.body });
  }
  return { ok: true, ops };
}
