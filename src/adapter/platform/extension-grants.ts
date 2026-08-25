/**
 * 🔴 **「この拡張にノートの見取り図を見せてよい」を憶える**(#195 / C-5 段①)。
 *
 * 設計は `docs/development/pkc-extension-host-design-2026-08.md`。
 *
 * ## なぜ frontmatter に置かないのか(2026-08-25 に設計を変えた)
 *
 * doc §7 B は当初「**そのアプリの設定**(= 添付の frontmatter)」と書いていた。
 * ⚠ **間違いである。** `same-origin-grants.ts` が同じ問題を先に解いていて、
 * 答えは逆だった:
 *
 * > ⚠ container に入れない ── ノートのデータではなく**この端末の判断**である。
 * > 入れると、書き出した md を配った相手の許可まで書き換わる。
 *
 * 🔴 拡張の許可では**もっと強く効く** ── frontmatter に置くと、そのノートを
 * 書き出して誰かに渡した瞬間、**相手の PKC3 でも「このアプリは一覧を読んでよい」が
 * 立つ**。許可は配ってはいけない。
 *
 * ## 何を許すのか ── **見取り図だけ**(段①)
 *
 * 許しても流れるのは `ext-projection.ts` の**メタ情報だけ**である
 * (本文・添付・履歴は 1 バイトも流れない)。
 * ⚠ 実体を渡すのは段② で、そちらは**この許可とは別に user のジェスチャが要る** ──
 * つまりこの許可は「**送ってよい**」ではなく「**見取り図を見せてよい**」である。
 * 🔑 名前と説明をその通りに書く ── 広く読める名前を付けると、次に足す人が
 * 「もう許してあるから」で実体まで流す。
 *
 * ## 鍵・置き場・取り消し
 *
 * 機構は `asset-grants.ts`(中身の SHA-256 で憶える / 端末ローカル / 一覧と取り消し)。
 * ⚠ **鍵は素のまま起動とは別**にする ── 混ぜると、素のまま起動を取り消した人の
 * 拡張の口まで黙って閉じる(逆も同じ)。
 */

import { AssetGrants } from '@adapter/platform/asset-grants';

const KEY = 'pkc3.extension-grants';

/** 拡張として口を開けた中身の台帳。 */
export class ExtensionGrants extends AssetGrants {
  constructor(storage?: ConstructorParameters<typeof AssetGrants>[1]) {
    super(KEY, ...(storage === undefined ? [] : ([storage] as const)));
  }
}

/** test / 設定の面が場所を名指しできるように出す。 */
export const EXTENSION_GRANTS_KEY = KEY;

/**
 * アプリ共有の 1 個。
 * ⚠ 面ごとに `new` すると、片方で取り消しても片方が古い答えを返す ── ではなく、
 *   **毎回 localStorage を読む**作りなのでどちらでも同じ結果になる。それでも
 *   1 個に寄せるのは「どれが正本か」を読み手に迷わせないためである。
 * ⚠ test は自分で `new ExtensionGrants(fakeStorage)` を渡す。
 */
export const appExtensionGrants = new ExtensionGrants();
