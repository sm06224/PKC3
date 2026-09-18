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
 * ## 🚫 関係と履歴は拾わない ── ⚠ **添付は拾う**(#1005 で直した)
 *
 * 関係・履歴は**索引を使う形でしか引けない**ので、壊れた DB では同じ `rc 11` で落ちる
 * (`db-rescue.ts` の実測表)。だから**空で返し、拾えなかったと明記する**。
 * 🔴 **黙って 0 件にしない** ── user は「リンクが消えた」ことに気づけない。
 *
 * ## 🔴 添付を「拾えない」に混ぜていたのは誤りだった(user 指摘 2026-09-17)
 *
 * ⚠ ここは長らく **関係・添付・履歴の 3 つを 1 つの理由で**片付けていた ──
 * 「索引を使う形でしか引けない」。🔴 **添付の bytes には当たっていない。**
 *
 * | | どこに在るか | 壊れた DB で読めるか |
 * |---|---|---|
 * | 関係・履歴 | **sqlite にしか無い** | 🚫 読めない(理由は当たっている) |
 * | 添付の **meta** | sqlite の `assets` 表 | ⚠ 読めないことがある |
 * | 🔑 **添付の bytes** | **IndexedDB(`pkc3-assets`)** | 🟢 **読める ── sqlite を 1 度も通らない** |
 *
 * 🔴 **帰結は実害だった**:拾い出しが添付を 1 バイトも出さないまま、
 * 「中身を捨てる」(#986 段③)が**その bytes を消していた** ──
 * つまり**一度も壊れていない添付を、案内どおりに進んだ人が 100% 失う**。
 *
 * 🔑 **meta は Blob 自身から組み直せる**(`type` / `size`)ので、`assets` 表が
 * 読めなくても実用上の欠けはほぼ無い。⚠ `hash` だけは持てない ── **でっち上げず `null`**。
 * ⚠ 表示名は**拾った本文の中**に在る(`![名前](asset:<key>)`)ので、ここでは要らない。
 */
import type { ArchiveSource } from '../export/pkc3-archive';
// ⚠ 実行時の値にバイト単位を付けるのは `human-bytes.ts` の仕事(門が在る)
import { humanBytes } from '../human-bytes';

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

/**
 * 🔑 **添付の実体を読む口**(#1005)。⚠ **sqlite を 1 度も通らない**
 * (`AssetBlobStore` は IndexedDB を直に読む)── だから壊れた DB でも拾える。
 * ⚠ **省略可**:渡されなければ今までどおり添付を出さない(壊れる方向へ倒れない)。
 */
export interface RescueAssets {
  /** この入れ物の添付の鍵を全部。⚠ 落ちたら呼び側が握って空にする。 */
  listKeys(cid: string): Promise<string[]>;
  /** 1 件の bytes。⚠ 無ければ `null`(**捨てずに数える**)。 */
  get(cid: string, assetKey: string): Promise<Blob | null>;
}

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
  /** 🔑 **zip に入れた添付の件数**(#1005)。 */
  readonly assets: number;
  /** 入れた添付の合計 bytes。⚠ 0 件なら 0。 */
  readonly assetBytes: number;
  /**
   * 🔴 **鍵は在るのに bytes が取れなかった件数**(#1005)。
   * ⚠ **0 と混ぜない** ── 「添付が無い人」と「添付が読めなかった人」は別である。
   */
  readonly assetMissing: number;
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
  /**
   * 🔑 **添付の実体を読む口**(#1005)。⚠ 渡さなければ添付を出さない
   *   (今までどおり)── **壊れる方向へ倒れない**。
   */
  readonly assets?: RescueAssets;
}): { readonly source: ArchiveSource; readonly stats: () => RescueStats } {
  type Meta = Awaited<ReturnType<ArchiveSource['listEntryMetas']>>[number];
  const metas: Meta[] = [];
  /** 🔑 一覧に載せた lid(2 周目で「知らない行」を捨てるため)。 */
  const known = new Set<string>();
  /** 🔴 本文が届いた lid ── 届かなかった数を出すために数える。 */
  const gotBody = new Set<string>();
  /** 🔑 zip に入れた添付(#1005)── `getAssetBlob` が読み直す鍵と、数えた量。 */
  const tookAssets = new Set<string>();
  let assetBytes = 0;
  /** 🔴 鍵は在るのに bytes が取れなかった数。⚠ **0 件と混ぜない**。 */
  let assetMissing = 0;
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
      /**
       * 🔴 **前へ進まない相手で回り続けない**(2026-09-16。**2 度目の直し**)。
       *
       * ⚠ 1 稿目は `listBodies` の側にだけ打ち切りを置いたが、
       *   🔴 **一覧を集める側(meta)には 1 つも無かった** ── そちらは
       *   `stopAfterBytes` すら渡らないので、`done` が立たない相手だと
       *   **永久に回る**(自分で書いた test が固まって分かった)。
       * 🔑 だから**両方の周回に効く所**、つまりこの輪の中へ置く。
       * ⚠ 壊れた DB は「同じ所を返し続ける」形もありうる ── 検出ではなく
       *   **起こらなくする**側で守る(§7「衝突は、起こらなくするほうが強い」)。
       */
      const before = after;
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
      // 🔴 位置が 1 つも進まなかったら、そこで打ち切る(上の docstring)
      if (after <= before) {
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
      const wasAt = bodyAfter;
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
      /**
       * 🔴 **前へ進んでいない回で `done: false` を返さない**(2026-09-16)。
       *
       * ⚠ `writeArchive` は `done` が立つまで呼び続けるので、
       *   **1 行も返さず `done: false`** を返すと**永久に回る**。
       * 🔴 変異試験で実際に固まった(`HUNG`)── CLAUDE.md §3:
       *   「**門が 1 つ消えただけで固まるなら、門の置き方が悪い**。
       *   `SURVIVED` より `HUNG` のほうが重い(製品が壊れうる形をしている)」。
       * 🔑 だから**輪を構造から消す** ── 位置が進まず行も無ければ、
       *   そこで打ち切って**下の埋め戻しへ落とす**(黙って回り続けない)。
       * ⚠ 検出ではなく**起こらなくする**側の直しである(§7 の規律)。
       */
      if (!bodyDone && bodyAfter <= wasAt && rows.length === 0) bodyDone = true;
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
    /**
     * 🔴 **添付は拾う**(#1005。user 指摘 2026-09-17)。
     *
     * ⚠ ここは長らく `[]` を返していた ── 理由は「索引を使う形でしか引けない」
     *   だったが、🔑 **bytes は IndexedDB に在り、sqlite を 1 度も通らない**ので
     *   その理由が当たらない(`AssetBlobStore.listKeys` / `.get`)。
     * 🔑 **meta は Blob 自身から組む** ── `type` と `size` は Blob が持っている。
     *   ⚠ `hash` は**持てないので `null`**(でっち上げない)。
     * ⚠ **鍵は在るのに bytes が取れない**回を数えて外へ出す(黙って減らさない)。
     */
    listAssetMetas: async () => {
      const ports = opts.assets;
      if (ports === undefined) return [];
      tookAssets.clear();
      assetBytes = 0;
      assetMissing = 0;
      // ⚠ 一覧が引けないのは「0 件」ではない ── そこで止めず、添付だけ諦める
      const keys = await ports.listKeys(opts.cid).catch((): string[] => []);
      const out: Array<{ key: string; mime: string | null; size: number | null; hash: string | null }> = [];
      for (const key of keys) {
        const blob = await ports.get(opts.cid, key).catch((): Blob | null => null);
        if (blob === null) {
          assetMissing += 1;
          continue;
        }
        tookAssets.add(key);
        assetBytes += blob.size;
        // ⚠ 空文字の `type` は「分からない」── `null` にして書出し側の既定へ委ねる
        out.push({ key, mime: blob.type === '' ? null : blob.type, size: blob.size, hash: null });
      }
      return out;
    },
    /**
     * ⚠ **一覧に載せた鍵だけ**返す ── 載せていない鍵を返すと、
     *   `writeArchive` の「meta と bytes の数が合う」前提が崩れる。
     */
    getAssetBlob: async (key) => {
      const ports = opts.assets;
      if (ports === undefined || !tookAssets.has(key)) return null;
      return ports.get(opts.cid, key).catch((): Blob | null => null);
    },
    // 🚫 下の 3 つは**sqlite にしか無く、索引を使う形でしか引けない**ので拾えない。
    //    ⚠ 空で返すが、**拾えなかったことは `stats()` の外で必ず字にする**。
    listRelations: async () => [],
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
      assets: tookAssets.size,
      assetBytes,
      assetMissing,
    }),
  };
}

/**
 * 画面に出す 1 行。⚠ **拾えなかった物を必ず並べる**。
 *
 * 🔴 **2026-09-17(#1005)に「添付は戻せません」を消した** ── 添付を拾うように
 *   なったので、⚠ **残し続けると嘘になる**(この字は user の判断材料である)。
 */
export function rescueArchiveSummary(s: RescueStats): string {
  const head = `${s.entries} 件を拾って、取り込める形で書き出しました`;
  // 🔑 添付は**入った件数と量**で言う(「入れました」だけでは足りるか判断できない)
  const got =
    s.assets > 0 ? `。添付も ${s.assets} 件(${humanBytes(s.assetBytes)})入れました` : '';
  const miss: string[] = [];
  if (s.skipped > 0) miss.push(`読めなかった区画 ${s.skipped}`);
  if (s.empty > 0) miss.push(`空だった区画 ${s.empty}`);
  if (s.bodyMissing > 0) miss.push(`本文が読めなかったノート ${s.bodyMissing} 件`);
  // 🔴 **鍵は在るのに中身が取れなかった添付**は、黙って減らさない
  if (s.assetMissing > 0) miss.push(`中身が取れなかった添付 ${s.assetMissing} 件`);
  // 🔴 つながりと履歴は**この道では拾えない** ── 黙って 0 件にしない
  const lost = '⚠ ノート同士のつながりと履歴は、この方法では戻せません。';
  const body = miss.length === 0 ? head : `${head}(${miss.join(' / ')})`;
  return `${body}${got}。${lost}`;
}

/**
 * 🔴 **この画面で、拾って書き出したか**(#986 段③)。
 *
 * ⚠ **真偽で持たない ── 件数で持つ。** 「書き出した」という印だけでは
 *   **0 件のファイルを書き出した人**も「済んだ」側に並んでしまう
 *   (壊れ方によっては実際に 0 件で出る ── #971 段③ の実測)。
 * 🔑 だから捨てる前の窓には**拾えた件数をそのまま**出し、
 *   「これで足りるか」を user に決めさせる。
 *
 * ⚠ **この端末に残さない**(`localStorage` に置かない)── 覚えさせると
 *   **半年前に 1 度書き出した**人が今日も「済み」に見える。
 *   見たいのは「**いま開いているこの画面で**拾ったか」である。
 */
let written: { readonly at: number; readonly stats: RescueStats } | null = null;

/** 書き出せた直後に呼ぶ。⚠ **書き出しが成功した枝でだけ**呼ぶ(頼んだ時点ではない)。 */
export function noteRescueWritten(stats: RescueStats, at: number): void {
  written = { at, stats };
}

/** この画面で拾って書き出した記録(まだなら `null`)。 */
export function lastRescueWritten(): { readonly at: number; readonly stats: RescueStats } | null {
  return written;
}

/** ⚠ test 用 ── module の変数なので、test どうしが影響し合わないように戻せる口を置く。 */
export function forgetRescueWritten(): void {
  written = null;
}
