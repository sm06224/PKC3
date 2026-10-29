/**
 * 🔴 **Office の窓では外部の画像が出ないことを、初回だけ必ず見せる**(#88 の user 指示 2026-08-09
 * 「オフィス機能を利用時は外部画像読み込みが使用不能になることをマニュアルに記載してください / 注意喚起導線は初回のみ必ず表示」)。
 *
 * ## 「使用不能」の条件を確かめた結果(COEP が `credentialless` になって前提が変わった)
 *
 * - 当時の懸念は COEP `require-corp` で「CORP を返さない外部画像が全部落ちる」こと。いまは `credentialless`
 *   (`sw/coi-headers.ts`。値は `tests/adapter/coi-headers.test.ts` が pin)── **PKC3 本体のノートの外部画像は、
 *   Office を使っても使わなくても、これまでどおり確認のうえ読み込める**。
 * - なお出ない場面 = **Office の窓の中**。窓の中の LibreOffice は外のネットワークへ取りに行かないので、文書に
 *   **アドレスでリンクしてある画像**は出ない(文書に埋め込まれた画像は出る)。案内はその場面でだけ出す。
 *
 * ## 既読の持ち方
 *
 * ⚠ 既読にするのは **「Office で開く」を押した**ときだけ ── 設定を切った・案内を読み飛ばしただけの user を
 *   既読にしない(2026-08-08 に全 tests 緑のまま通した「設定を切っただけで既読」型の取り違えを作らない)。
 * ⚠ container に入れない(その端末で見たかどうか)。設定の持ち出しにも乗せない(`settings-file.ts` の `SKIPPED_KEYS`)。
 * ⚠ 読めない環境でも落ちない(`storage === null` を先に見る。`?.` だけに頼ると `catch` に入らない)。
 */

const KEY = 'pkc3.office-image-note';

/** 案内の字(添付の画面の「Office で開く」の隣に出す 1 行)。 */
export const OFFICE_IMAGE_NOTE =
  'Office のウィンドウでは、アドレスでリンクしてある外部の画像は表示されません(文書に埋め込まれた画像は表示されます)。' +
  'ノートの外部画像は、これまでどおり確認のうえ読み込めます。この案内は初回だけ出します。';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class OfficeImageNoteStore {
  private fallback = false;
  private saveFailed = false;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /** もう見せたか(読むたびに保存を見る ── 別のタブが既読にした回を拾う)。 */
  seen(): boolean {
    if (this.storage === null || this.saveFailed) return this.fallback;
    try {
      return this.storage.getItem(KEY) === '1';
    } catch {
      return this.fallback;
    }
  }

  markSeen(): void {
    this.fallback = true;
    this.saveFailed = false;
    try {
      this.storage?.setItem(KEY, '1');
    } catch {
      this.saveFailed = true;
    }
  }
}

/** アプリ共有の 1 個。 */
export const appOfficeImageNote = new OfficeImageNoteStore();
