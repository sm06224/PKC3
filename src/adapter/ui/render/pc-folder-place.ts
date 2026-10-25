/**
 * 🔴 **PC タブで開いていた階層を、この端末に憶える**(#215)。
 *
 * 憶えるのは**フォルダ名の並び**だけ(根のフォルダ名 + そこからのサブフォルダ名)。
 * ⚠ **handle は憶えない**(`local-folder.ts` の「このセッションだけ」── 昔繋いだフォルダへの権限を黙って持ち続けない)。
 * 読み込み直したあと同じ名前のフォルダを選び直すと、憶えた階層へ戻る(辿れなければ辿れた所まで)。
 *
 * ⚠ **container に入れない**(ノートのデータではなく、この端末の見え方)。
 * ⚠ **設定ファイルの持ち出しには乗せない**(`settings-file.ts` の `SKIPPED_KEYS` に why つき)。
 * ⚠ 値は JSON(`{r, p}`)。**壊れた値は「憶えていない」**(`null`)。
 * ⚠ 読めない環境でも落ちない ── `storage === null` を先に見る(`?.` では `catch` に入らない)。
 */
import type { FolderPlace, FolderPlaceMemory } from '@adapter/platform/local-folder';

const KEY = 'pkc3.pc-folder-place';
/** 憶える階層の深さの上限(壊れた値・巨大な値で重くしない)。 */
const MAX_DEPTH = 64;

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function parse(raw: string | null): FolderPlace | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    const r = o['r'];
    if (typeof r !== 'string' || r === '') return null;
    const p = o['p'];
    if (!Array.isArray(p) || p.length > MAX_DEPTH || !p.every((x) => typeof x === 'string' && x !== '')) return null;
    return { root: r, path: p as string[] };
  } catch {
    return null;
  }
}

export class PcFolderPlaceStore implements FolderPlaceMemory {
  /** 保存が読めない環境の控え(この session では効いている)。 */
  private fallback: FolderPlace | null = null;

  /** 🔴 直近の書き込みが失敗したか(容量不足など)。真の間は読みも控えを返す。 */
  private saveFailed = false;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  get(): FolderPlace | null {
    try {
      if (this.storage === null || this.saveFailed) return this.fallback;
      return parse(this.storage.getItem(KEY));
    } catch {
      return this.fallback;
    }
  }

  set(place: FolderPlace): void {
    this.fallback = place;
    this.saveFailed = false;
    try {
      this.storage?.setItem(KEY, JSON.stringify({ r: place.root, p: place.path }));
    } catch {
      // 🔴 書けなかった ── 次に書けるまで、読みは控え(書いた値)を返す(戻らない)
      this.saveFailed = true;
    }
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く。 */
export const appPcFolderPlace = new PcFolderPlaceStore();
