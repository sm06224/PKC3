/**
 * 🔴 **拾い出したノートを「戻せる形」で束ねる**(#986。user 指示 2026-09-16)。
 *
 * ## user の求め
 *
 * **原因が特定できなくても、元の状態へ戻せるようにすること。**
 *
 * ## ⚠ 直す前は、取り出せても戻せなかった
 *
 * 拾い出し(#971 段③)が書いていたのは **`## 題名` を並べた巨大な .md 1 枚**で、
 * 🔴 取り込むと**ノートは 1 件しか増えない**(素の .md は 1 ファイル = 1 ノート)。
 * ⚠ つまり**拾えた 4000 件が、戻すと 1 件になっていた**。
 * 🔑 `pkc3-archive.ts` 自身が「**復元できないバックアップはバックアップではない**」と
 *   書いており、直す前の拾い出しはまさにそれに当たっていた。
 *
 * ## 🔑 だから writer は作らない ── 既に在る可逆な形へ流し込む
 *
 * `pkc3-archive` は **PKC3 の全形式のうち唯一可逆**で、読む口(`readArchive`)も
 * 取り込みの受け口(`import-pkc2.ts`)も既に在る。⚠ その `writeArchive` は
 * **`ArchiveSource` という差し替え可能な口**から読むので、
 * 🔑 **拾い出しをその口に嵌めれば、実績のある writer がそのまま使える**
 * (新しい書き出し器を作ると、また「読み戻せるか」を 1 から確かめる羽目になる)。
 *
 * ## ⚠ なぜ 2 周舐めるのか
 *
 * 拾い出しは 1 行に `{lid, title, archetype, body}` を**まとめて**返すが、
 * `writeArchive` は **一覧(meta)を先に全部**受け取ってから、**本文を刻んで**取りに来る。
 * 🔴 1 周で済ませようとすると**全本文を heap に抱える**ことになり、
 *   `writeArchive` が「本文の総量ぶん heap が線形に増える」のを直した意味が消える。
 * 🔑 だから **① meta だけ集める ② 本文をもう一度取りに行く** の 2 周にする。
 * ⚠ 復旧は「まれに 1 回やる操作」なので、時間より**常駐量と確実さ**を採る。
 *
 * ## ⚠ 2 周目が 1 周目と同じ行を返すとは限らない
 *
 * 壊れ方によって読める区画は変わりうる。だから
 * 🔑 **本文が来なかった lid を数えて外へ出す** ── 黙って空本文で埋めない
 *   (「拾えた件数」を「全部」と読ませない、という #971 段③ の規律と同じ向き)。
 *
 * ## 🚫 関係・添付・履歴は拾わない
 *
 * ⚠ どれも**索引を使う形でしか引けない** ── 壊れた DB では同じ `rc 11` で落ちる
 *   (`db-rescue.ts` の実測表)。だから**空で返し、拾えなかったと明記する**。
 * 🔴 **黙って 0 件にしない** ── user は「リンクが消えた」ことに気づけない。
 */
import type { ArchiveSource } from '../export/pkc3-archive';

/** 拾い出しの 1 ページ(`storage-worker` の `rescueEntries` が返す形)。 */
export interface RescuePageLike {
  readonly rows: ReadonlyArray<{
    readonly rowid: number;
    readonly lid: string;
    readonly title: string;
    readonly archetype: string;
    readonly body: string;
  }>;
  readonly lastRowid: number;
  readonly skipped: number;
  readonly empty: number;
  readonly maxRowid: number | null;
  readonly done: boolean;
}

export type RescuePick = (afterRowid: number, chunks: number) => Promise<RescuePageLike>;

/** 拾い出しの成果。⚠ **拾えなかった数を必ず連れて歩く**。 */
export interface RescueStats {
  /** 一覧に載せた件数(1 周目)。 */
  readonly entries: number;
  /** 読めなかった区画の数。 */
  readonly skipped: number;
  /** 空で返った区画の数(⚠ 壊れているときは**これが大半**)。 */
  readonly empty: number;
  /** 🔴 **2 周目で本文が来なかった件数**(空本文で戻る)。 */
  readonly bodyMissing: number;
}

/** ⚠ 1 回に頼む区画の数(既存の拾い出しと同じ ── 大きくすると 1 応答が重い)。 */
const CHUNKS = 20;

/** 進み具合を外へ出す(画面が「止まった」と読まれないように)。 */
export interface RescueProgress {
  (seen: number, maxRowid: number | null, phase: 'meta' | 'body'): void;
}

/**
 * 拾い出しを `ArchiveSource` の口に嵌める。
 *
 * ⚠ `writeArchive` は **`listEntryMetas` → `listBodies`(繰り返し)** の順で呼ぶ。
 *   この実装はその順番に**依存している**(1 周目の結果を 2 周目で使う)ので、
 *   🔑 順番が変わったら `listBodies` が空を返す ── そこは test で留める。
 */
export function rescueArchiveSource(opts: {
  readonly cid: string;
  readonly title: string;
  readonly pick: RescuePick;
  readonly onProgress?: RescueProgress;
}): { readonly source: ArchiveSource; readonly stats: () => RescueStats } {
  type Meta = Awaited<ReturnType<ArchiveSource['listEntryMetas']>>[number];
  const metas: Meta[] = [];
  /** 🔑 一覧に載せた lid(2 周目で「知らない行」を捨てるため)。 */
  const known = new Set<string>();
  /** 🔴 本文が届いた lid ── 届かなかった数を出すために数える。 */
  const gotBody = new Set<string>();
  /** ⚠ 本文の代わりに印を入れて出した lid(数えるのは `gotBody` と分ける)。 */
  const placeheld = new Set<string>();
  let skipped = 0;
  let empty = 0;
  /** 2 周目の位置。⚠ `writeArchive` の `after` は使わない(こちらが rowid で進む)。 */
  let bodyAfter = 0;
  let bodyDone = false;

  const drain = async (
    phase: 'meta' | 'body',
    take: (page: RescuePageLike) => void,
    stopAfterBytes?: number,
  ): Promise<void> => {
    let after = phase === 'meta' ? 0 : bodyAfter;
    let bytes = 0;
    for (;;) {
      const page = await opts.pick(after, CHUNKS);
      take(page);
      if (phase === 'meta') {
        skipped += page.skipped;
        empty += page.empty;
      }
      for (const r of page.rows) bytes += r.body.length;
      after = page.lastRowid;
      opts.onProgress?.(after, page.maxRowid, phase);
      // ⚠ 打ち切りは既存の拾い出しと**同じ条件**にする(2 通りの規則を作らない)
      if (page.done || page.lastRowid <= 0) {
        if (phase === 'body') bodyDone = true;
        break;
      }
      if (stopAfterBytes !== undefined && bytes >= stopAfterBytes) break;
    }
    if (phase === 'body') bodyAfter = after;
  };

  const source: ArchiveSource = {
    cid: opts.cid,
    title: opts.title,
    listEntryMetas: async () => {
      metas.length = 0;
      known.clear();
      await drain('meta', (page) => {
        for (const r of page.rows) {
          // ⚠ 同じ lid が 2 度来たら後を捨てる(壊れた DB では起こりうる)
          if (known.has(r.lid)) continue;
          known.add(r.lid);
          metas.push({
            lid: r.lid,
            title: r.title,
            archetype: r.archetype,
            // ⚠ 拾い出しは時刻を持っていない ── **でっち上げない**(null で出す)
            created_at: null,
            updated_at: null,
            // 🔑 並びは拾った順(壊れた DB で元の順番は読めない)
            entry_order: metas.length + 1,
            status: null,
            date: null,
            archived: 0,
          });
        }
      });
      return metas;
    },
    listBodies: async (_after, maxBytes) => {
      if (bodyDone && placeheld.size + gotBody.size >= known.size) return { rows: [], done: true };
      const rows: Array<{ lid: string; body: string }> = [];
      if (!bodyDone) {
        await drain(
          'body',
          (page) => {
            for (const r of page.rows) {
              if (!known.has(r.lid) || gotBody.has(r.lid)) continue;
              gotBody.add(r.lid);
              rows.push({ lid: r.lid, body: r.body });
            }
          },
          maxBytes,
        );
      }
      if (!bodyDone) return { rows, done: false, next: { entryOrder: 0, lid: '' } };
      /**
       * 🔴 **本文が来なかったノートを、題名ごと消さない**(test が捕まえた)。
       *
       * ⚠ `writeArchive` は **本文の側から entry を組む**(`listBodies` の行を
       *   `metaOf` で引く)ので、本文が 1 件も来ない lid は**書き出されない** ──
       *   一覧に在るのに**アーカイブから丸ごと消える**。
       * 🔴 それは user から見ると「そのノートは元から無かった」に見える
       *   ── いちばん気づけない失い方である。
       * 🔑 だから**印を入れた本文で出す** ── 空本文にもしない
       *   (空だと「中身が無いノート」と「本文が失われたノート」を見分けられない)。
       */
      for (const m of metas) {
        if (gotBody.has(m.lid) || placeheld.has(m.lid)) continue;
        placeheld.add(m.lid);
        rows.push({
          lid: m.lid,
          body: `# ${m.title}\n\n⚠ このノートの本文は読み出せませんでした(壊れた所に当たっています)。\n`,
        });
      }
      return { rows, done: true };
    },
    // 🚫 下の 4 つは**索引を使う形でしか引けない**ので、壊れた DB では拾えない。
    //    ⚠ 空で返すが、**拾えなかったことは `stats()` の外で必ず字にする**。
    listRelations: async () => [],
    listAssetMetas: async () => [],
    getAssetBlob: async () => null,
    listRevisionLids: async () => [],
    getRevisionChain: async () => [],
  };

  return {
    source,
    stats: () => ({
      entries: metas.length,
      skipped,
      empty,
      bodyMissing: metas.length - gotBody.size,
    }),
  };
}

/** 画面に出す 1 行。⚠ **拾えなかった物を必ず並べる**。 */
export function rescueArchiveSummary(s: RescueStats): string {
  const head = `${s.entries} 件を拾って、取り込める形で書き出しました`;
  const miss: string[] = [];
  if (s.skipped > 0) miss.push(`読めなかった区画 ${s.skipped}`);
  if (s.empty > 0) miss.push(`空だった区画 ${s.empty}`);
  if (s.bodyMissing > 0) miss.push(`本文が読めなかったノート ${s.bodyMissing} 件`);
  // 🔴 関係・添付・履歴は**この道では拾えない** ── 黙って 0 件にしない
  const lost = '⚠ ノート同士のつながり・添付・履歴は、この方法では戻せません。';
  return miss.length === 0 ? `${head}。${lost}` : `${head}(${miss.join(' / ')})。${lost}`;
}
