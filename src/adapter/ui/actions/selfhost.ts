/**
 * 「自分のパソコンで動かす」一式を組んで落とす(#532 段 B の実行部)。
 *
 * 🔴 **writer だけ増やしても user は 1 件も落とせない**(P6b で確立した規律)。
 * ここで「一覧を読む → 配っている物を取る → zip に詰める → 落とす」まで 1 本に通す。
 *
 * ⚠ **取りに行く先は相対**(`./precache.json` / `./assets/…`)── `base: './'` で
 * 組んであるので、`/dev/` でも sub-path でも同じ 1 本で通る(門は #532 S1)。
 * ⚠ Service Worker が precache しているので、**多くは網に出ずに cache から返る**。
 */
import { ZipWriter } from '@features/export/zip-writer';
import {
  PRECACHE_LIST_FILE,
  parsePrecacheList,
} from '@features/selfhost/precache-list';
import {
  OPTIONAL_EXTRA_FILES,
  planSiteFiles,
  selfhostExtras,
  selfhostZipName,
  siteEntryName,
  SELFHOST_ORIGIN,
  type SelfhostSource,
} from '@features/selfhost/bundle';

export interface SelfhostDeps {
  /** 相対 path を取りに行く。⚠ 実配線は `fetch`(SW の cache に当たる)。 */
  fetchFile(path: string): Promise<Response>;
  /** 生成した Blob を user に渡す。 */
  download(name: string, blob: Blob): void;
  /**
   * 進み具合と結果を画面に出す。
   * ⚠ **optional にしない** ── 落とすまでに 8 MB ぶん集めるので、
   *   無言だと user には「押したのに何も起きない」に見える(いちばん多い苦情の形)。
   */
  notify(message: string): void;
  /** 日付の刻印(zip の名前に入れる)。 */
  stamp(): string;
  /**
   * 🔴 **この一式が、どこの・いつの・どの版から作られたか**(#532 段 C)。
   *
   * ⚠ **optional にしない** ── 配線を落としても tsc が黙ると、
   *   `はじめに.txt` から**元の住所が消える**。そのとき user は
   *   「どこへ戻れば新しい物が取れるか」を知る術を失い、
   *   **古い版を使い続けていることに気づけない**(段 B で実際に配った誤りの形)。
   */
  source: SelfhostSource;
}

/**
 * 一式を組んで落とす。
 *
 * @throws 一覧が読めない / 空 / 取りに行けなかった file がある
 *   ⚠ **取りこぼしを黙って捨てない** ── 1 file 欠けた一式は、起動してから
 *   「白い画面」になる。落ちる場所は**組んでいるあいだ**であるべきである。
 */
export async function downloadSelfhostBundle(deps: SelfhostDeps): Promise<void> {
  deps.notify('自分のパソコンで動かす一式を組んでいます…');
  const listRes = await deps.fetchFile(`./${PRECACHE_LIST_FILE}`);
  if (!listRes.ok) {
    throw new Error(`${PRECACHE_LIST_FILE} を読めません(HTTP ${String(listRes.status)})`);
  }
  const files = planSiteFiles(parsePrecacheList(await listRes.text()));

  const zip = new ZipWriter();
  for (const [name, text] of selfhostExtras(deps.source)) {
    await zip.add(name, [text]);
  }
  const missing: string[] = [];
  for (const path of files) {
    const res = await deps.fetchFile(`./${path}`);
    if (!res.ok) {
      missing.push(path);
      continue;
    }
    await zip.add(siteEntryName(path), [await res.blob()]);
  }
  /**
   * ⚠ **在れば入れる**(`portable-template.html`)── 配る workflow が後から置く物なので、
   *   無い配信もある。取れなかったことは**欠品に数えない**。
   */
  for (const path of OPTIONAL_EXTRA_FILES) {
    const res = await deps.fetchFile(`./${path}`);
    if (res.ok) await zip.add(siteEntryName(path), [await res.blob()]);
  }
  if (missing.length > 0) {
    // ⚠ 欠けたまま渡さない ── 欠けた一式は「起動しない」形でしか症状が出ない
    throw new Error(
      `配っている物を ${String(missing.length)} 件取れませんでした: ${missing.slice(0, 5).join(', ')}`,
    );
  }
  deps.download(selfhostZipName(deps.stamp()), zip.finish());
  deps.notify(
    `一式を落としました。中の start-windows.cmd(Mac / Linux は start-mac-linux.sh)を開くと、${SELFHOST_ORIGIN} で使えます`,
  );
}
