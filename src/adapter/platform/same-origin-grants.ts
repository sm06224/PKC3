/**
 * 🔴 **「素のまま起動」の許可を憶える**(#301。user 裁定 2026-08-21)。
 *
 * > 「**同じハッシュのアプリ登録済みの URL もしくは HTML に関しては永続化
 * > (文字通りの永続化、期間とかない)**」(user 2026-08-21)
 *
 * ## 何を憶えるのか
 *
 * 憶えるのは **添付の中身のハッシュ**(`ast-<sha256>`)だけである。lid ではない。
 *
 * 🔴 **鍵を lid にしてはいけない。** 本文の編集・履歴の復元・ゴミ箱からの復元は
 *   **lid を保ったまま中身を入れ替える** ── lid で憶えると、許可した覚えのない
 *   bytes が「許可済み」として同じ場所で走る。
 * 🔑 `asset-key.ts` の key は既に **中身の SHA-256**(`identifyAsset`)なので、
 *   1 バイト違えば別の鍵になり、許可は自動的に外れて**また聞く**。
 *   これが user 裁定の「同じハッシュの」の実体である。
 * ⚠ **採番 key は憶えない**(`isContentKey` が偽)── 64MB 超と PKC2 由来の
 *   古い鍵は中身を指していないので、「同じハッシュ」を名乗れない。
 *
 * ## 憶えるのは「アプリとして登録した」ものだけ
 *
 * 登録していない添付は今までどおり**毎回聞く**(呼び側 `main.ts` が判定する)。
 * user 裁定の「アプリ登録済みの」がこれ。
 *
 * ## 🔴 この保存はアプリ自身が書き換えられる。それを承知で保存している
 *
 * 素のまま起動したアプリは PKC3 と同じ origin で走るので、**localStorage も
 * IndexedDB も OPFS も、sqlite すら書ける**(`store-proxy.ts` は送り主を検めない)。
 * つまり **偽造できない置き場は存在しない** ── 別 origin も取れない
 * (`sm06224.github.io` は user site なので repo を分けても 1 origin)。
 *
 * 🔑 だから「どこに置くか」で安全は買えない。買えるのは次の 2 つだけで、
 *   両方ともここに実装してある:
 *   ① **中身が変わったら許可が外れる**(鍵が内容ハッシュ)
 *   ② **一覧を見せて取り消せる**(`list` / `revoke` ── 設定の面が使う)
 * ⚠ 増える危険は「一度許した相手が、次からは**黙って**同じ権利に戻る」ことである
 *   (許した時点で既にノート全部に手が届いているので、権利そのものは増えない)。
 *
 * ⚠ container に入れない ── ノートのデータではなく**この端末の判断**である。
 *   入れると、書き出した md を配った相手の許可まで書き換わる。
 */

import { AssetGrants } from '@adapter/platform/asset-grants';

const KEY = 'pkc3.same-origin-grants';

/**
 * 素のまま起動の許可。
 *
 * 🔑 **機構は `asset-grants.ts` に在る**(2026-08-25 に寄せた)── 拡張の許可(#195)が
 * 同じ形を必要としたので、**同じ判定を 2 か所に生やさない**ためである(CLAUDE.md §7)。
 * ここに残すのは「**この許可は何か**」だけ。
 */
export class SameOriginGrants extends AssetGrants {
  constructor(storage?: ConstructorParameters<typeof AssetGrants>[1]) {
    super(KEY, ...(storage === undefined ? [] : ([storage] as const)));
  }
}

/** test / 設定の面が場所を名指しできるように出す。 */
export const SAME_ORIGIN_GRANTS_KEY = KEY;

/**
 * 🔴 **「聞くか / 憶えるか」の判断を 1 か所に置く**(#301)。
 *
 * ⚠ この判断を `main.ts` に直書きすると、**どの test からも実行されない**
 *   (CLAUDE.md §2「どの test からも実行されない file に判断を書かない」)──
 *   `main.ts` は原文を `readFileSync` で読む test しか持たないので、
 *   「登録済みかどうかで憶え先が変わる」型の取り違えが**全 test 緑のまま**通る。
 * 🔑 だから器はここ。`main.ts` は **聞く UI** と **登録済みかの問い合わせ**だけ持つ。
 */
export class SameOriginGate {
  /**
   * 登録していない添付の記憶(lid)。
   * ⚠ **保存しない** ── closure と同じ寿命でよい。読み込み直せば消えるので、
   *   「lid を保ったまま中身が入れ替わる」より先に記憶のほうが消える。
   */
  private readonly session = new Set<string>();

  constructor(private readonly grants: SameOriginGrants = new SameOriginGrants()) {}

  /** もう聞かなくてよいか。⚠ 登録済みは**中身のハッシュ**、それ以外は lid で見る。 */
  allows(opts: { lid: string; assetKey: string | null | undefined; registered: boolean }): boolean {
    if (opts.registered && this.grants.isGranted(opts.assetKey)) return true;
    return this.session.has(opts.lid);
  }

  /**
   * 許された ── **どこに憶えるかを決めて憶える**。
   * 戻り値は憶えた先(`'hash'` = ずっと / `'session'` = この画面を開いている間だけ)。
   * ⚠ 登録済みでも**採番 key なら `'session'` に落ちる**(中身を指していないので
   *   「同じハッシュの」を名乗れない)── 黙って永続化しない。
   */
  remember(opts: {
    lid: string;
    assetKey: string | null | undefined;
    registered: boolean;
  }): 'hash' | 'session' {
    if (opts.registered && this.grants.grant(opts.assetKey)) return 'hash';
    this.session.add(opts.lid);
    return 'session';
  }

  /** 憶えている中身の一覧(設定の面が使う)。 */
  list(): readonly string[] {
    return this.grants.list();
  }

  /** 1 件外す。⚠ この画面の記憶(lid 側)は触らない ── 別物である。 */
  revoke(assetKey: string): void {
    this.grants.revoke(assetKey);
  }
}
