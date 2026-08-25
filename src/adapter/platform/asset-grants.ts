/**
 * 🔴 **「この中身を許した」を憶える台帳**(#301 の機構を #195 と共有する)。
 *
 * ## なぜ 1 か所に寄せたか(2026-08-25)
 *
 * 許可は 2 種類ある ── **素のまま起動**(#301)と **拡張として口を開ける**(#195)。
 * ⚠ どちらも「**どの中身を許したか**」を憶える同じ形なので、別々に書くと
 * **同じ判定が 2 か所**に生える(CLAUDE.md §7)── 片方だけ直した日に、
 * もう片方が黙って古い規則で動く。だから**機構はここ 1 つ**にして、
 * 種類ごとの「なぜ」は呼び側の file に書く。
 *
 * ## 🔴 鍵は **lid ではなく中身の SHA-256**
 *
 * 本文の編集・履歴の復元・ごみ箱からの復元は **lid を保ったまま中身を入れ替える**
 * ── lid で憶えると、**許可した覚えのない bytes** が「許可済み」として同じ場所で走る。
 * 🔑 `asset-key.ts` の key は既に中身の SHA-256(`identifyAsset`)なので、
 * 1 バイト違えば別の鍵になり、許可は**自動的に外れてまた聞く**。
 * ⚠ **採番 key は憶えない**(`isContentKey` が偽)── 64MB 超と PKC2 由来の古い鍵は
 * 中身を指していないので、「同じハッシュ」を名乗れない。
 *
 * ## 🔴 container に入れない ── **この端末の判断**である
 *
 * ⚠ 入れると、**書き出した md を配った相手の許可まで書き換わる**。
 * 「このアプリにノートの一覧を見せてよい」は、その人がその端末で下した判断であって、
 * ノートに付いてまわる属性ではない。
 *
 * ## ⚠ この保存は、許したアプリ自身が書き換えられる
 *
 * 素のまま起動したアプリは PKC3 と同じ origin で走るので localStorage も IDB も書ける。
 * 🔑 だから「どこに置くか」で安全は買えない。買えるのは 2 つだけで、両方ここに在る:
 * ① **中身が変わったら許可が外れる**(鍵が内容ハッシュ)
 * ② **一覧を見せて取り消せる**(`list` / `revoke` ── 設定の面が使う)
 */

import { isContentKey } from '@adapter/platform/storage/asset-key';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readGrantStorage(): Store | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    // プライベートモード等 ── 憶えられないだけで、起動そのものは動く
    return null;
  }
}

/**
 * 中身の鍵で許可を憶える台帳。
 *
 * ⚠ **毎回読む**(憶えておいて差分で更新、をしない)。呼ばれるのは判断の瞬間だけ
 *   なので、打鍵ごとの `getItem` を避ける理屈はここには効かない。
 *   毎回読めば**別のタブでの取り消しがそのまま効く**(同期の仕掛けが要らない)。
 */
export class AssetGrants {
  constructor(
    /** ⚠ 種類ごとに**別の鍵**(混ぜると、片方を取り消したら両方消える)。 */
    private readonly storageKey: string,
    private readonly storage: Store | null = readGrantStorage(),
  ) {}

  /**
   * 憶えている許可の一覧(内容ハッシュの鍵)。
   * ⚠ **読むときに検める** ── 壊れた値・採番 key・配列でないものは黙って捨てる
   *   (アプリが書き換えられる置き場なので、読み側で必ず絞る)。
   */
  list(): readonly string[] {
    const raw = this.storage?.getItem(this.storageKey);
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
   *   呼び側に `?? undefined` を書かせない(同じ変換を 2 か所に生やさない)。
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
    this.write(this.list().filter((k) => k !== assetKey));
  }

  /** 全部外す。 */
  revokeAll(): void {
    this.write([]);
  }

  private write(keys: readonly string[]): void {
    if (this.storage === null) return;
    try {
      // ⚠ 空になったら**鍵ごと消す**(要らない行を残さない ── KeymapStore と同じ作法)
      if (keys.length === 0) this.storage.removeItem(this.storageKey);
      else this.storage.setItem(this.storageKey, JSON.stringify(keys));
    } catch {
      // 容量超過等 ── 憶えられないだけ。次回また聞くので安全側に落ちる
    }
  }
}
