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

import { isContentKey } from '@adapter/platform/storage/asset-key';

const KEY = 'pkc3.same-origin-grants';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function readStorage(): Store | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    // プライベートモード等 ── 憶えられないだけで、起動そのものは動く
    return null;
  }
}

/**
 * 許可の台帳。
 *
 * ⚠ **毎回読む**(憶えておいて差分で更新、をしない)。呼ばれるのは
 *   「アプリを起動する瞬間」だけなので、`KeymapStore` が打鍵ごとの
 *   `getItem` を避けるために持っている cache の理屈はここには効かない。
 *   毎回読めば**別のタブでの取り消しがそのまま効く**(同期の仕掛けが要らない)。
 */
export class SameOriginGrants {
  constructor(private readonly storage: Store | null = readStorage()) {}

  /**
   * 憶えている許可の一覧(内容ハッシュの鍵)。
   * ⚠ **読むときに検める** ── 壊れた値・採番 key・配列でないものは黙って捨てる
   *   (アプリが書き換えられる置き場なので、読み側で必ず絞る)。
   */
  list(): readonly string[] {
    const raw = this.storage?.getItem(KEY);
    if (raw === null || raw === undefined) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((k): k is string => typeof k === 'string' && isContentKey(k));
    } catch {
      return [];
    }
  }

  /**
   * この中身は許可済みか。⚠ 鍵が無い / 採番 key なら常に偽(= また聞く)。
   * ⚠ `null` も受ける ── 添付の frontmatter 側は `string | null` で持っているので、
   *   呼び側 2 か所で `?? undefined` を書かせない(同じ変換を 2 か所に生やさない)。
   *
   * ⚠ **ここの `isContentKey` を外す変異は生き延びる**(2026-08-21 の変異試験 N2)──
   *   `list()` が読むときに落とし、`grant()` が書くときにも落とすので、
   *   **採番 key は一覧に入りようがない**。つまり**等価変異**であって、test の穴ではない。
   * 🔑 それでも残すのは 2 つの理由による: ① 保存を読まずに返る(fail closed の早道)
   *   ② `list()` の絞りを性能都合で外した日に、ここが最後の砦として残る。
   */
  isGranted(assetKey: string | null | undefined): boolean {
    if (assetKey === null || assetKey === undefined || !isContentKey(assetKey)) return false;
    return this.list().includes(assetKey);
  }

  /**
   * 許可を憶える。**戻り値は「憶えたか」** ── 呼び側が user に言い分けられるように。
   * ⚠ 採番 key は憶えない(中身を指していないので「同じハッシュ」を名乗れない)。
   */
  grant(assetKey: string | null | undefined): boolean {
    if (
      assetKey === null ||
      assetKey === undefined ||
      !isContentKey(assetKey) ||
      this.storage === null
    )
      return false;
    const next = this.list();
    if (next.includes(assetKey)) return true;
    this.write([...next, assetKey]);
    return true;
  }

  /** 許可を外す。⚠ 次に開くときはまた聞く。 */
  revoke(assetKey: string): void {
    const next = this.list().filter((k) => k !== assetKey);
    this.write(next);
  }

  /** 全部外す。 */
  revokeAll(): void {
    this.write([]);
  }

  private write(keys: readonly string[]): void {
    if (this.storage === null) return;
    try {
      // ⚠ 空になったら**鍵ごと消す**(要らない行を残さない ── KeymapStore と同じ作法)
      if (keys.length === 0) this.storage.removeItem(KEY);
      else this.storage.setItem(KEY, JSON.stringify(keys));
    } catch {
      // 容量超過等 ── 憶えられないだけ。次回また聞くので安全側に落ちる
    }
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
