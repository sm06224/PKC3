/**
 * 🔴 **「開く」で編集に入るか**(user 裁定 2026-08-18)。
 *
 * > 「**Enter は閲覧を開始、インライン編集で常に開くは設定でトグル可能にすること**」
 *
 * ⚠ **既定は閲覧**(オフ)── 押しただけで編集に入ると、読むつもりの user が
 * 気づかないうちに下書きを抱える(そのまま別の行へ移ろうとして断られる)。
 * ⚠ **flag ではない**(正規設定)── 開放先は user で、畳む予定も無い
 * (`editor-mode` / `notices` と同じ扱い。flag の 15 枠は使わない)。
 * ⚠ **container に入れない** ── ノートのデータではなく、この端末の開き方である。
 *
 * 🔑 効く先は **「開く」の一手だけ**(フォルダの表の `Enter`)。行を 1 回押した
 * ときの選択には効かない ── そちらは「選ぶ」であって「開く」ではない。
 */

const KEY = 'pkc3.open-in-edit';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class OpenInEditStore {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback = false;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /**
   * ⚠ **読むたびに保存を見る**(`EditorModeStore` と同じ理由)── 書き手が複数
   * (設定 UI / smoke の仕込み)なので、読み捨てにすると外からの書込が
   * 再読込まで効かない。
   */
  enabled(): boolean {
    try {
      return this.storage?.getItem(KEY) === '1';
    } catch {
      return this.fallback;
    }
  }

  setEnabled(on: boolean): void {
    this.fallback = on;
    try {
      this.storage?.setItem(KEY, on ? '1' : '0');
    } catch {
      // 保存できないだけ ── この session では効いている(控えが持つ)
    }
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く(`appEditorMode` と同じ規律)。 */
export const appOpenInEdit = new OpenInEditStore();
