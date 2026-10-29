/**
 * 🔴 **Office の窓では外部の画像が出ないことを、初回だけ必ず見せる**(#88 の user 指示 2026-08-09
 * 「オフィス機能を利用時は外部画像読み込みが使用不能になることをマニュアルに記載してください / 注意喚起導線は初回のみ必ず表示」)。
 *
 * ## 「使用不能」の条件を確かめた結果(COEP が `credentialless` になって前提が変わった)
 *
 * - 当時の懸念は COEP `require-corp` で「CORP を返さない外部画像が全部落ちる」こと。いまは `credentialless`
 *   (`sw/coi-headers.ts`。値は `tests/adapter/coi-headers.test.ts` が pin)── **PKC3 本体のノートの外部画像は、
 *   Office を使っても使わなくても、これまでどおり確認のうえ読み込める**。
 * - 出ないことがある場面 = **Office の窓の中**。アドレスでリンクしてある画像は、窓の中の文書では表示されないことが
 *   ある(文書に埋め込まれた画像は出る)。案内はその場面でだけ出す。
 *   ⚠ **窓の中の読み込みを止めている根拠はこの repo のコードに無い**(wasm の読み込み経路は凍結中で、確かめていない)。
 *   user 指示(2026-08-09)の事実を、**断定せず「ことがある」で**伝える。言い切れる根拠が見つかったら字を直す。
 *
 * ## 出す場所と既読の持ち方
 *
 * 🔴 出す・既読にするのは **`OfficeWindow.open()` の合流点 1 か所**(`announceOfficeImageNote`)── 添付の「Office で開く」・
 *   組み込みタイル・PC のファイル選択・控えの復元のどの入口から開いても、最初の 1 回だけ出る。
 * ⚠ 添付の画面の 1 行(`office-entry-view.ts`)は、押す前に見せるための予告。既読にはしない。
 * ⚠ 設定を切った・案内を読み飛ばしただけの user を既読にしない(2026-08-08 に全 tests 緑のまま通した
 *   「設定を切っただけで既読」型の取り違えを作らない)── 既読は「Office を開こうとした」ときだけ。
 * ⚠ container に入れない(その端末で見たかどうか)。設定の持ち出しにも乗せない(`settings-file.ts` の `SKIPPED_KEYS`)。
 * ⚠ 読めない環境でも落ちない(`storage === null` を先に見る。`?.` だけに頼ると `catch` に入らない)。
 */

const KEY = 'pkc3.office-image-note';

/** 案内の字(添付の画面の「Office で開く」の隣に出す 1 行)。 */
export const OFFICE_IMAGE_NOTE =
  'Office のウィンドウでは、アドレスでリンクしてある外部の画像が表示されないことがあります(文書に埋め込まれた画像は表示されます)。' +
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

  /** 見せたことにする。 */
  markSeen(): void {
    this.setSeen(true);
  }

  /** 見たかどうかを書く。⚠ 戻せる(`false`)── 片道の操作にしない(案内をもう一度出したいとき)。 */
  setSeen(seen: boolean): void {
    this.fallback = seen;
    this.saveFailed = false;
    try {
      this.storage?.setItem(KEY, seen ? '1' : '0');
    } catch {
      this.saveFailed = true;
    }
  }
}

/** アプリ共有の 1 個。 */
export const appOfficeImageNote = new OfficeImageNoteStore();

/**
 * Office を開こうとしたときの初回の案内。⚠ **初回だけ**(既読にして、二度目からは何も言わない)。
 * `OfficeWindow.open()` から呼ばれる ── 全入口の合流点(`office-window.ts` の `onOpen`)。
 * @returns 言ったか(test の観測点)
 */
export function announceOfficeImageNote(
  store: Pick<OfficeImageNoteStore, 'seen' | 'markSeen'>,
  say: (text: string) => void,
): boolean {
  if (store.seen()) return false;
  store.markSeen();
  say(OFFICE_IMAGE_NOTE);
  return true;
}
