/**
 * 🔴 **本文のリンクが指す先を、1 か所で解く**(2026-08-08。user 裁定「任せます」)。
 *
 * ## なぜ要ったか
 *
 * markdown は 3 種類のアプリ内リンクに `data-pkc-action` を焼いているのに、
 * **binder に受け手が 1 つも無かった** ── 押しても無言で何も起きない。
 * 記法だけ PKC2 から移植して、受け手を置き忘れた形である(焼く側のコメントが
 * PKC2 の `action-binder` を指したまま残っていた)。
 *
 * | 記法 | 焼く action | いま |
 * |---|---|---|
 * | `[題名](entry:<lid>[#frag])` | `navigate-entry-ref` | **条件なしで焼かれる** |
 * | `@[card](entry:<lid>)` / `@[card](pkc://<cid>/entry/<lid>)` | `navigate-card-ref` | **条件なしで焼かれる** |
 * | `[x](pkc://<cid>/asset/<key>)` | `navigate-asset-ref` | 焼かれる。**受け手が無い**(下記) |
 *
 * ## ⚠ `navigate-asset-ref` はここでは扱わない
 *
 * 焼く条件(`currentContainerId`)は **Issue #100 段① で配線した**ので、
 * `pkc://<自分>/asset/<key>` は `navigate-asset-ref` として焼かれるように
 * なった。残っているのは**受け手**である ── asset の key から
 * 「その添付を持つ entry」を引く逆引き(段②)が要るので、`repo-hygiene` の
 * `KNOWN_DEAD` に**別主題**として残してある。
 * ⚠ 逆引きに `scanAssetRefs` を流用しない ── あちらは false-keep 側(広く拾う)
 *   に倒した判定で、ここは**誤爆しない側**(狭く当てる)が要る。
 *
 * ## 🔑 規則を 1 つに寄せる
 *
 * `entry:` と card の target は**同じ形**(card は `entry:` か
 * `pkc://<cid>/entry/<lid>`)なので、判定を 2 か所に生やさない
 * (CLAUDE.md「同じ判定が 2 か所に生えたら、規則を 1 つに寄せる」)。
 *
 * ⚠ **pure module**。DOM も dispatch も触らない。
 */
import { parseEntryRef, parseSectionFragment } from './entry-ref';
import { parsePortablePkcReference } from '@features/link/permalink';

/** リンクが指す先。⚠ **fragment は「解けた文字列」ではなく生のまま**運ぶ。 */
export type LinkTarget =
  | {
      readonly kind: 'entry';
      readonly lid: string;
      /** `#` を含む。無ければ空文字。⚠ `#h/` 以外はまだ**使い道が無い**(下記)。 */
      readonly fragment: string;
      /**
       * 🔴 **飛ぶ先の見出しの id**(#579)── `#h/<見出しの id>` のときだけ。他の形は `null`。
       * ⚠ 解くのは `parseSectionFragment` 1 か所(`entry:` と `pkc://` で 2 本にしない)。
       */
      readonly section: string | null;
      /** 別のコンテナを指している(このアプリでは開けない)。 */
      readonly foreign: boolean;
    }
  | { readonly kind: 'invalid'; readonly raw: string };

/**
 * 🔴 **fragment は運ぶ。使うのは `#h/`(見出し)だけ**(#579 で 1 形を使うようになった)。
 *
 * `parseEntryRef` は 8 形を解くが、**PKC3 の描画結果に飛び先が実在するのは
 * `#h/<見出しの id>` だけ**である(`h1`〜`h3` に描画が刻む id)── `#log/…` `#day/…` が指す
 * `<article id="log-…">` / `<section id="day-…">` を出す実装は `src` に 0 件で、
 * textlog は markdown の節へ変換される作りだからである。
 *
 * ⚠ だから **1 段目は「lid まで開く」に割り切る**。
 * 🔑 「解けないなら何もしない」にしてはいけない ── PKC2 から取り込んだ本文には
 * `entry:c-log#2026-07-01-090000` の形が実在するので、fragment を理由に断ると
 * **今日も無反応のまま**になる(= 動線が戻らない)。
 */
export function parseLinkTarget(raw: string, selfContainerId = ''): LinkTarget {
  if (typeof raw !== 'string' || raw === '') return { kind: 'invalid', raw: String(raw) };

  if (raw.startsWith('pkc://')) {
    const p = parsePortablePkcReference(raw);
    // ⚠ asset の携帯参照はここでは開けない(所有者の逆引きが要る ── 別主題)
    if (p === null || p.kind !== 'entry') return { kind: 'invalid', raw };
    return {
      kind: 'entry',
      lid: p.targetId,
      fragment: p.fragment ?? '',
      section: parseSectionFragment(p.fragment ?? ''),
      // ⚠ 自分のコンテナ id を渡されていないときは**外と見なさない**
      //   (既定で断ると全部断ることになる)。
      // 🔑 描画側は Issue #100 段① で cid を受け取ったので、
      //   `navigate-entry-ref` に焼かれる `pkc://` は**必ず同一コンテナ**である。
      //   ここへ外の id が来る道は `@[card](pkc://<外>/entry/<lid>)` だけ ──
      //   card は cid を見ずに焼くため(**受け手側の cid 配線は未了**)。
      foreign: selfContainerId !== '' && p.containerId !== selfContainerId,
    };
  }

  const p = parseEntryRef(raw);
  if (p.kind === 'invalid') return { kind: 'invalid', raw };
  /**
   * ⚠ **7 形すべてから lid を取り出す**(`invalid` 以外)。
   * 形ごとに分岐を書くと、新しい形が増えたとき**静かに落ちる**側へ倒れる。
   */
  const hash = raw.indexOf('#');
  return {
    kind: 'entry',
    lid: p.lid,
    fragment: hash === -1 ? '' : raw.slice(hash),
    section: p.kind === 'section' ? p.id : null,
    foreign: false,
  };
}
