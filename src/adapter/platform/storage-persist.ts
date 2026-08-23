/**
 * 🔴 **保存を「消えない」側へ置いてもらう**(#347、2026-08-23)。
 *
 * ## なぜ要るか
 *
 * origin の quota は **OPFS(= SQLite 本体)と共用**で、evictable な origin は
 * 空き容量が減ったときに**黙って消される**。user から見ると
 * 「昨日まで在ったノートが、今日は 1 件も無い」であり、
 * ⚠ **原因を名指しできない**(操作の失敗ではないので記録が残らない)。
 *
 * 同じ壊れ方は Office 一式で一度踏んでいる(#117、実測
 * `{"usageMB":196,"quotaMB":10436,"persisted":false}`)。そのとき足した対策が
 * **その経路にしか入っていなかった**というのが #347 である ──
 * だから口はここ 1 つにして、`office-pack-install.ts` からもここを呼ぶ
 * (同じ問いに答える口を 2 つ持たない。CLAUDE.md §7)。
 *
 * ## いつ頼むか
 *
 * 🔑 **最初の書込が成功したとき**に 1 度だけ。
 * ⚠ **boot では頼まない** ── 初回訪問はまだ何も持っていないので、
 * ブラウザが user に尋ねる実装では**断る理由しかない瞬間**に聞くことになる。
 * 「書いた」= その user が中身を持った瞬間である。
 *
 * ⚠ **拒否は失敗ではない**(`office-pack-install.ts` と同じ扱い)── アプリは
 * 動き続ける。分かったことを持っておいて、聞かれたら答える。
 */

/** `navigator.storage` のうち、ここが使う分だけ。 */
export interface PersistCapableStorage {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}

/**
 * いまの持ち場の状態。
 *
 * - `unknown` … まだ頼んでいない(= 何も分かっていない)
 * - `unsupported` … このブラウザに `persist` が無い(Safari など)
 * - `persisted` … 消えない側に居る
 * - `denied` … 頼んだが断られた ── **消えることがある**
 */
export type PersistState = 'unknown' | 'unsupported' | 'persisted' | 'denied';

/**
 * 永続化を頼む。⚠ **例外を投げない** ── 呼び側は保存の途中に居る。
 *
 * 🔑 **先に `persisted()` を見る** ── 既に消えない側なら `persist()` を呼ばない
 * (呼ぶと、ブラウザによっては user に尋ねる)。
 */
export async function requestPersist(store: PersistCapableStorage | undefined): Promise<PersistState> {
  if (!store || typeof store.persist !== 'function') return 'unsupported';
  try {
    if (typeof store.persisted === 'function' && (await store.persisted())) return 'persisted';
    return (await store.persist()) ? 'persisted' : 'denied';
  } catch {
    // ⚠ 落ちたことを `denied` と言わない ── 「断られた」と「聞けなかった」は別である
    return 'unknown';
  }
}

/**
 * **1 回だけ頼む**係。
 *
 * ⚠ 呼び側(保存の ack)は**書込のたびに**呼ぶので、ここが回数を持つ。
 * ⚠ 飛んでいる間にもう一度呼ばれても**二重に頼まない**(同じ約束を返す)。
 */
export class PersistOnce {
  private state: PersistState = 'unknown';
  private inflight: Promise<PersistState> | null = null;

  constructor(private readonly store: PersistCapableStorage | undefined) {}

  /** いま分かっていること(頼む前は `unknown`)。 */
  get current(): PersistState {
    return this.state;
  }

  /**
   * 🔴 **尋ねずに、いまの状態だけ聞く**(#347 の見せ方、user 裁定 2026-08-23
   * 「気になるから見るだけで」)。
   *
   * ⚠ `persisted()` は**問い合わせであって依頼ではない** ── ブラウザが user に
   * 尋ねることは無い。だから**起動時に呼んでよい**。
   * ⚠ 逆に `persist()`(尋ねうる口)はここでは呼ばない ── あちらは
   * **最初の書込のとき** 1 度だけである(初回訪問はまだ何も持っていないので、
   * 断る理由しかない瞬間に聞くことになる)。
   *
   * 🔑 **`false` を `denied` と書かない。** まだ頼んでいないので「断られた」では
   * なく、**分かっていない**(`unknown`)である ── ここを混ぜると、設定の面が
   * 「断られました」と嘘をつく。
   */
  async probe(): Promise<PersistState> {
    if (this.state !== 'unknown') return this.state;
    if (!this.store || typeof this.store.persist !== 'function') {
      this.state = 'unsupported';
      return this.state;
    }
    try {
      if (typeof this.store.persisted === 'function' && (await this.store.persisted()))
        this.state = 'persisted';
    } catch {
      // ⚠ 聞けなかっただけ ── `unknown` のままにする(次の書込で頼む)
    }
    return this.state;
  }

  /**
   * まだ頼んでいなければ頼む。⚠ **一度決まったら二度と頼まない** ──
   * `denied` でも聞き直さない(毎回の保存で user に尋ねることになる)。
   */
  ensure(): Promise<PersistState> {
    if (this.state !== 'unknown') return Promise.resolve(this.state);
    if (this.inflight !== null) return this.inflight;
    this.inflight = requestPersist(this.store).then((s) => {
      this.state = s;
      this.inflight = null;
      return s;
    });
    return this.inflight;
  }
}
