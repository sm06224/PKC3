/**
 * 🔴 **Office の窓が書いた「編集の控え(影)」を、本体が読む・消す**(#1228 段 2)。
 *
 * ⚠ **書く側はここに居ない。** `public/office/office-shadow.js`(素の JS)が
 * `<棚>/<ノートの合言葉>/<13 桁の時刻>.<拡張子>` へ**最新 1 つだけ**置く(`meta.json` を添える)。
 * 別 realm・別 process なので、共有できるのは**棚の名前と file の綴りだけ** ──
 * `tests/adapter/office-shadow-shelf.test.ts` が**窓の file を読んで**突き合わせる。
 *
 * ## 守る 4 つ
 *
 * 1. 🔴 **控えは「ノートの合言葉 = 棚の名前」で引く。** `meta.json` は補助(無くても控えは引ける)── 窓が
 *    `meta.json` を書き損ねても、**user の唯一の控えを引けなくしない**
 * 2. 🔴 **消すのは「保存済みの版で開く」を選んだとき・7 日を過ぎたときだけ。** 古く見える(正本より古い)だけでは
 *    消さない ── 正本の更新時刻は**題名を直しただけでも動く**ので、そこから消すと控えを失う
 * 3. **書いている最中の棚を消さない。** 窓は `shelve` で名前を先に作るので、新しすぎる名前の棚は触らない
 * 4. **無い環境で落とさない。** OPFS が無い / 棚が無いは「控えが無い」(`null` / 空)
 */
import {
  OFFICE_SHADOW_META,
  OFFICE_SHADOW_SHELF,
  isShadowExpired,
  isShadowNewer,
  parseShadowName,
  shadowShelfId,
} from '../../../features/office/office-shadow';

/** 棚の中の控え 1 つ(⚠ bytes は入っていない)。 */
export interface ShadowEntry {
  /** 棚の名前(ノートの合言葉を安全な綴りにした物)。 */
  readonly id: string;
  /** 控えの file 名(`<13 桁>.<拡張子>`)。 */
  readonly file: string;
  /** 書いた時刻(ms。file 名から)。 */
  readonly at: number;
  readonly ext: string;
  /** `meta.json` が書いた元の文書の名前。無ければ `''`。 */
  readonly docName: string;
  /** `meta.json` が書いたノートの合言葉。無ければ `''`。 */
  readonly lid: string;
}

interface OpfsFile {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}
interface OpfsFileHandle {
  getFile(): Promise<OpfsFile>;
}
/** OPFS の棚(必要な分だけ。⚠ lib.dom の型に縛られない)。 */
export interface ShadowDir {
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<ShadowDir>;
  getFileHandle(name: string): Promise<OpfsFileHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterable<[string, { kind: string }]>;
}
export interface ShadowStorage {
  getDirectory(): Promise<ShadowDir>;
}

/** 棚を開く。⚠ 棚が無い / OPFS が無い環境では `null`(= 控えは 1 つも無い)。作らない。 */
export async function openShadowShelf(storage?: ShadowStorage): Promise<ShadowDir | null> {
  const s =
    storage ??
    (globalThis.navigator as unknown as { storage?: ShadowStorage } | undefined)?.storage;
  if (!s || typeof s.getDirectory !== 'function') return null;
  try {
    const root = await s.getDirectory();
    return await root.getDirectoryHandle(OFFICE_SHADOW_SHELF, { create: false });
  } catch {
    return null;
  }
}

async function readText(dir: ShadowDir, name: string): Promise<string | null> {
  try {
    return await (await (await dir.getFileHandle(name)).getFile()).text();
  } catch {
    return null;
  }
}

/** 棚 1 つの最新の控え(無ければ `null`)。 */
async function newestIn(id: string, dir: ShadowDir): Promise<ShadowEntry | null> {
  let best: { file: string; at: number; ext: string } | null = null;
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file') continue;
    const p = parseShadowName(name);
    if (p !== null && (best === null || p.at > best.at)) best = { file: name, ...p };
  }
  if (best === null) return null;
  let docName = '';
  let lid = '';
  const text = await readText(dir, OFFICE_SHADOW_META);
  if (text !== null) {
    try {
      const m = JSON.parse(text) as Record<string, unknown>;
      // ⚠ 知らない版は読まない(控えそのものは引ける ── 補助が読めないだけ)
      if (m.v === 1) {
        if (typeof m.name === 'string') docName = m.name;
        if (typeof m.lid === 'string') lid = m.lid;
      }
    } catch {
      /* meta が壊れていても控えは引く */
    }
  }
  return { id, file: best.file, at: best.at, ext: best.ext, docName, lid };
}

/** 棚の全部の最新の控え。 */
export async function listShadows(shelf: ShadowDir): Promise<ShadowEntry[]> {
  const out: ShadowEntry[] = [];
  const ids: string[] = [];
  for await (const [name, handle] of shelf.entries()) {
    if (handle.kind === 'directory') ids.push(name);
  }
  for (const id of ids) {
    try {
      const e = await newestIn(id, await shelf.getDirectoryHandle(id));
      if (e !== null) out.push(e);
    } catch {
      /* 見ている間に消えた ── 見なかったことにする */
    }
  }
  return out;
}

/**
 * 🔴 そのノート(lid)の控え。⚠ `meta.json` に別のノートの合言葉が書いてあれば**取り違えない**
 * (棚の名前は綴りを潰すので、別のノートが同じ棚へ落ちうる)。
 */
export async function findShadow(shelf: ShadowDir, lid: string): Promise<ShadowEntry | null> {
  const id = shadowShelfId(lid);
  if (id === null) return null;
  let dir: ShadowDir;
  try {
    dir = await shelf.getDirectoryHandle(id);
  } catch {
    return null;
  }
  const e = await newestIn(id, dir);
  if (e === null) return null;
  if (e.lid !== '' && e.lid !== lid) return null;
  return e;
}

/** 控えの bytes。読めなければ `null`(消えた / 空)。⚠ 消さない。 */
export async function readShadow(
  shelf: ShadowDir,
  e: ShadowEntry,
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const dir = await shelf.getDirectoryHandle(e.id);
    const buf = await (await (await dir.getFileHandle(e.file)).getFile()).arrayBuffer();
    return buf.byteLength > 0 ? new Uint8Array(buf) : null;
  } catch {
    return null;
  }
}

/** そのノートの控えを棚ごと消す。⚠ 冪等(無くても落ちない)。 */
export async function discardShadow(shelf: ShadowDir, lid: string): Promise<boolean> {
  const id = shadowShelfId(lid);
  if (id === null) return false;
  try {
    await shelf.removeEntry(id, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 🔴 **起動時の掃除: 7 日を過ぎた控えの棚を消す。**
 *
 * ⚠ 消すのは**期限切れだけ**(上の 2)。`meta.json` が無い棚も**控えは引ける**ので消さない
 * (消すと、窓が `meta.json` を書き損ねた user の唯一の控えを失う)。⚠ 控えの無い空の棚は触らない
 * (窓がいま最初の控えを書いている最中かもしれない ── 棚を先に作る)。
 * @returns 消した棚の数
 */
export async function sweepShadows(
  shelf: ShadowDir,
  opts: { now?: () => number } = {},
): Promise<number> {
  const now = (opts.now ?? ((): number => Date.now()))();
  let removed = 0;
  for (const e of await listShadows(shelf)) {
    if (!isShadowExpired(e.at, now)) continue;
    try {
      await shelf.removeEntry(e.id, { recursive: true });
      removed += 1;
    } catch {
      /* 競争に負けた ── 次の起動で消える */
    }
  }
  return removed;
}

// ───────────────────────── 「Office で開く」の入口が使う束 ─────────────────────────

export interface OfficeShadowDeps {
  /** 棚を開く(既定は `openShadowShelf()`)。⚠ 呼ぶたびに引く(棚は窓が作る)。 */
  readonly openShelf?: () => Promise<ShadowDir | null>;
  /**
   * 🔴 **添付の中身**が最後に保存された時刻(ms)。⚠ ノートの `updatedAt` ではない(題名を直しただけで動き、
   *   控えの門が黙って閉じる ── UX レビュー 2026-10-03)。判断は `attachmentSavedAt`(features)。`null` = 分からない → 訊く。
   */
  readonly savedAt: (lid: string) => Promise<number | null>;
  readonly now?: () => number;
}

/** 確認に出す 1 件。 */
export interface ShadowOffer {
  readonly at: number;
  readonly ext: string;
}

export interface OfficeShadows {
  /**
   * **同期で**答える: そのノートの控えが在るかもしれないか。⚠ 偽のときは今までどおり**同期で窓を開ける**
   * (ポップアップ遮断に当たらない)── 偽陽性は構わない(訊く側へ 1 回寄り道するだけ)が、**偽陰性は
   * 控えを黙って見逃す**ので、`refresh` を窓の放送のたびに呼ぶ。
   */
  mayHave(lid: string): boolean;
  /** 棚を読み直して「在るかもしれない」の控えを作り直す。投げない。 */
  refresh(): Promise<void>;
  /** 起動時: 期限切れを消して `refresh`。投げない。 */
  sweep(): Promise<void>;
  /** 訊くべき控え(正本より新しい物だけ)。無ければ `null`。投げない。 */
  find(lid: string): Promise<ShadowOffer | null>;
  /** 控えの bytes。無ければ `null`。投げない。 */
  readBytes(lid: string): Promise<Uint8Array<ArrayBuffer> | null>;
  /** 控えを消す(「保存済みの版で開く」)。投げない。 */
  discard(lid: string): Promise<void>;
}

export function createOfficeShadows(deps: OfficeShadowDeps): OfficeShadows {
  const openShelf = deps.openShelf ?? ((): Promise<ShadowDir | null> => openShadowShelf());
  const now = deps.now ?? ((): number => Date.now());
  /**
   * 🔴 **訊く値打ちのある控え**の棚名 → 控えの時刻。⚠ 棚の名前の集合では**ない**(1 稿目はそうだった ──
   *   添付より古い控えの棚が在るだけで `mayHave` が真になり、最初の押しが `await find` の**後**に窓を開いていた。
   *   Chromium は通すが、Safari 等では遮断 = 無言の dead click。着地前レビュー 2026-10-03)。
   * 🔑 `refresh` で「期限内 かつ 添付の保存時刻より新しい」物だけを入れる ── `mayHave` は**同期**でそれを見る。
   * ⚠ 起動直後(`refresh` が終わるまで)は空 ── その間に押されても同期で開く(控えは棚に残る)。
   */
  let worth = new Map<string, number>();
  /** `refresh` の世代 ── 遅い読み取りが、後から走った新しい結果を潰さない(偽陰性 = 控えを黙って見逃す、を作らない)。 */
  let gen = 0;
  const refresh = async (): Promise<void> => {
    const mine = ++gen;
    try {
      const shelf = await openShelf();
      const next = new Map<string, number>();
      if (shelf !== null) {
        for (const e of await listShadows(shelf)) {
          if (isShadowExpired(e.at, now())) continue;
          // meta に lid が無い棚(古い窓が書いた)は相手の時刻が分からない → 訊く側へ倒す(`savedAt(null)` と同じ)
          const saved = e.lid === '' ? null : await deps.savedAt(e.lid);
          if (isShadowNewer(e.at, saved)) next.set(e.id, e.at);
        }
      }
      if (mine === gen) worth = next;
    } catch {
      /* 読めなかった ── 前の控えのまま */
    }
  };
  /** 訊く物が無かった ── 「在るかもしれない」から外す(次に控えが書かれれば窓の放送で `refresh` が戻す)。 */
  const forget = (lid: string): void => {
    const id = shadowShelfId(lid);
    if (id !== null) worth.delete(id);
  };
  return {
    mayHave: (lid) => {
      const id = shadowShelfId(lid);
      if (id === null) return false;
      const at = worth.get(id);
      return at !== undefined && !isShadowExpired(at, now());
    },
    refresh,
    sweep: async () => {
      try {
        const shelf = await openShelf();
        if (shelf !== null) await sweepShadows(shelf, { now });
      } catch {
        /* 掃除に失敗しても起動は続ける */
      }
      await refresh();
    },
    find: async (lid) => {
      try {
        const shelf = await openShelf();
        const e = shelf === null ? null : await findShadow(shelf, lid);
        // 🔴 古い(正本より前の)控えは**訊かないだけ**で消さない(上の 2)
        if (e !== null && !isShadowExpired(e.at, now()) && isShadowNewer(e.at, await deps.savedAt(lid))) {
          return { at: e.at, ext: e.ext };
        }
      } catch {
        /* 読めなかった ── 控えは無いものとして今までどおり開く */
      }
      forget(lid);
      return null;
    },
    readBytes: async (lid) => {
      try {
        const shelf = await openShelf();
        if (shelf === null) return null;
        const e = await findShadow(shelf, lid);
        return e === null ? null : await readShadow(shelf, e);
      } catch {
        return null;
      }
    },
    discard: async (lid) => {
      try {
        const shelf = await openShelf();
        if (shelf !== null) await discardShadow(shelf, lid);
      } catch {
        /* 消せなかった ── 控えは残り、次に開くときまた訊く */
      }
      forget(lid);
    },
  };
}
