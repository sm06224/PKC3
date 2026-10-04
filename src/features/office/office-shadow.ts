/**
 * 🔴 **Office の「編集の控え(影)」を、次に開くとき戻せるか**の判断(#1228 段 2)。
 *
 * 控えは**窓が書く**(`public/office/office-shadow.js`。素の JS ── 別 realm・別 process)。
 * ここは**読む側**の判断だけを持つ: どの棚が「この添付の控え」か / 訊くべきか / 古すぎて消すか / 画面の字。
 * ⚠ 棚の名前・meta の綴りは窓と**同じでなければ機構ごと死ぬ**ので、`tests/adapter/office-shadow-shelf.test.ts`
 * が**窓の file を読んで**突き合わせる(`office-stage.ts` と同じ作法)。
 *
 * ## 裁定(Gemini、#1228。変えない)
 *
 * - **Q1 = A** 次に「Office で開く」を押したとき、保存していない控えが在れば**必ず**確認を出す
 *   (「保存していない編集を戻して開く」/「保存済みの版で開く」。普通に閉じた場合も訊く)
 * - **Q2 = A** 控えは「保存済みの版で開く」を選ぶか、新しい窓で普通に保存して添付へ入るまで残す。**上限 7 日**
 *
 * ⚠ **pure module**。browser API を持たない。
 */
import { readVersions } from '@features/flavor/attachment-versions';

/** 控えの棚(OPFS のルート直下)。⚠ 窓の `SHELF_DIR` と同じ綴り(test が突合)。 */
export const OFFICE_SHADOW_SHELF = 'pkc3-office-shadow';

/** 棚に添える記録の名前。⚠ 窓の `META_NAME` と同じ綴り。 */
export const OFFICE_SHADOW_META = 'meta.json';

/** 控えを残す上限(7 日。裁定 Q2 = A)。これより古い控えは起動時に消す。 */
export const SHADOW_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 棚の中の控えの名前(13 桁の時刻 + 拡張子)。⚠ 窓の `SHADOW_NAME_RE` と同じ形。 */
const SHADOW_NAME_RE = /^([0-9]{13})\.([A-Za-z0-9]+)$/;

/** 合言葉の前置き(手元の file)。⚠ `office-launch.ts` の `LOCAL_PREFIX` と同じ。 */
const LOCAL_TOKEN_PREFIX = 'local:';

/**
 * そのノート(lid)の控えが入る棚の名前。窓の `safeId(token, …)` と**同じ規則**(test が突合)。
 * @returns 棚を持てない(空 / 手元の file)なら `null`
 */
export function shadowShelfId(lid: string): string | null {
  if (lid === '' || lid.startsWith(LOCAL_TOKEN_PREFIX)) return null;
  const t = lid.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return t === '' ? null : t;
}

/** 控えの file 名 → `{ at, ext }`。控えの名前でなければ `null`(`meta.json` などを取り違えない)。 */
export function parseShadowName(name: string): { at: number; ext: string } | null {
  const m = SHADOW_NAME_RE.exec(name);
  return m === null ? null : { at: Number(m[1]), ext: m[2]!.toLowerCase() };
}

/**
 * 🔴 **訊くべきか**。控えが**正本の添付より新しい**ときだけ(同じ時刻は訊かない)。
 * @param shadowAt 控えを書いた時刻(ms)
 * @param assetSavedAt **添付の中身**が最後に保存された時刻(ms。`attachmentSavedAt`)。`null` = 分からない →
 *   **訊く側へ倒す**(分からないのに黙って見送るより、1 度訊くほうが害が小さい)
 */
export function isShadowNewer(shadowAt: number, assetSavedAt: number | null): boolean {
  if (assetSavedAt === null || !Number.isFinite(assetSavedAt)) return true;
  return shadowAt > assetSavedAt;
}

/**
 * 🔴 **添付の中身が最後に保存された時刻**(ms)。控えと比べる相手は**これ**である。
 *
 * ⚠ ノートの `updatedAt` と比べてはいけない(1 稿目はそうしていた ── UX レビュー 2026-10-03、PR #1320)。
 *   `updatedAt` は**題名・タグ・説明を直しただけでも動く**ので、「保存し忘れたかも」と気づいた人が
 *   ノートを 1 度触ると、控えの門が**黙って閉じる**(7 日で消えるまで取り出す道が無い)。
 * 🔑 添付の中身が替わるのは save-back だけで、そのとき `attachment.history`(frontmatter)に
 *   **差し替えた時刻**(`savedAt`)が積まれる(`asset-replace-plan.ts`)── その最新が「最後に保存された時刻」。
 *   1 度も差し替えていない添付は履歴が無いので、**ノートの作成時刻**(= 添付を入れた時刻)に落とす。
 *   どちらも無ければ `null`(= 訊く側へ倒す)。
 * @param body 添付ノートの本文(`null` = 読めなかった)
 * @param createdAt 添付ノートの作成時刻(ISO。`entryMetas.createdAt`)
 */
export function attachmentSavedAt(body: string | null, createdAt: string | null): number | null {
  let latest: number | null = null;
  if (body !== null) {
    for (const v of readVersions(body)) {
      const t = Date.parse(v.savedAt);
      if (Number.isFinite(t) && (latest === null || t > latest)) latest = t;
    }
  }
  if (latest !== null) return latest;
  const c = createdAt === null ? NaN : Date.parse(createdAt);
  return Number.isFinite(c) ? c : null;
}

/** 控えが上限(7 日)を過ぎたか。 */
export function isShadowExpired(shadowAt: number, now: number): boolean {
  return now - shadowAt > SHADOW_MAX_AGE_MS;
}

/** 経過を相対で言う(「1 分以内」「12 分前」「3 時間前」「2 日前」)。⚠ 未来の時刻(時計のずれ)は「1 分以内」。 */
export function shadowAgo(at: number, now: number): string {
  const min = Math.floor((now - at) / 60_000);
  if (min < 1) return '1 分以内';
  if (min < 60) return `${min} 分前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 時間前`;
  return `${Math.floor(h / 24)} 日前`;
}

/** 確認の題名。 */
export const SHADOW_DIALOG_TITLE = '保存していない編集があります';

/** 確認の押し所(裁定の字。⚠ そのまま使う)。 */
export const SHADOW_OPEN_SHADOW_LABEL = '保存していない編集を戻して開く';
export const SHADOW_OPEN_SAVED_LABEL = '保存済みの版で開く';

/**
 * 確認の説明(1 行)。⚠ 「保存済みの版で開く」を選ぶと保存していない編集が消えることを**先に言う**
 * (選んだ後に消えると分かるのでは、失う側を黙って選ばせることになる)。
 */
export function shadowDialogNote(at: number, now: number): string {
  return `${shadowAgo(at, now)}の、保存していない編集が残っています。どちらで開いても、保存するまで添付は変わりません。保存済みの版で開くと、その編集は消えます。`;
}

/** 控えの版で開くと決めたとき、本体の状態の行に出す一言。 */
export const SHADOW_OPENED_NOTICE =
  '保存していない編集を Office で開きます。保存すると、添付の中身が入れ替わります(前の中身は残ります)';

/** 控えの版を頼まれたのに、控えが読めなかった(消えた / 空)。保存済みの版で開く。 */
export const SHADOW_GONE_NOTICE = '保存していない編集を読めませんでした。保存済みの版で開きます';
