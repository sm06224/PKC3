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
 * | `[x](pkc://<cid>/asset/<key>)` | `navigate-asset-ref` | **1 度も焼かれない**(下記) |
 *
 * ## ⚠ `navigate-asset-ref` はここでは扱わない
 *
 * 焼く条件が `currentContainerId` を要求するのに、**`src/adapter/` からも
 * `main.ts` からも 1 件も渡していない**(既定 `''`)ので、必ず別の枝
 * (`pkc-portable-reference-placeholder`、action 無し)へ落ちる。しかも PKC3 に
 * `pkc://` を**生成する経路が無い**。受け手だけ書いても**呼ばれない**ので、
 * cid の配線と key→lid の逆引きが要る**別主題**として `repo-hygiene` の
 * `KNOWN_DEAD` に残してある。
 *
 * ## 🔑 規則を 1 つに寄せる
 *
 * `entry:` と card の target は**同じ形**(card は `entry:` か
 * `pkc://<cid>/entry/<lid>`)なので、判定を 2 か所に生やさない
 * (CLAUDE.md「同じ判定が 2 か所に生えたら、規則を 1 つに寄せる」)。
 *
 * ⚠ **pure module**。DOM も dispatch も触らない。
 */
import { parseEntryRef } from './entry-ref';
import { parsePortablePkcReference } from '@features/link/permalink';

/** リンクが指す先。⚠ **fragment は「解けた文字列」ではなく生のまま**運ぶ。 */
export type LinkTarget =
  | {
      readonly kind: 'entry';
      readonly lid: string;
      /** `#` を含む。無ければ空文字。⚠ いまは**使い道が無い**(下記)。 */
      readonly fragment: string;
      /** 別のコンテナを指している(このアプリでは開けない)。 */
      readonly foreign: boolean;
    }
  | { readonly kind: 'invalid'; readonly raw: string };

/**
 * 🔴 **fragment は運ぶが、まだ使わない。**
 *
 * `parseEntryRef` は 7 形を解くが、**PKC3 の描画結果に飛び先が実在するのは
 * 2 形だけ**である(`entry` と ASCII の `legacy`)── `#log/…` `#day/…` が指す
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
      // ⚠ 自分のコンテナ id を渡されていないときは**外と見なさない** ──
      //   いまアプリは cid を描画へ渡していないので、既定で断ると全部断る
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
    foreign: false,
  };
}
