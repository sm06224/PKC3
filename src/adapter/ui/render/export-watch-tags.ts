/**
 * 🔴 **書き出す前に確かめるタグ**(#1966 4-5)の保存(この端末だけ)。初期値は `private, 社外秘`(user 裁定 2026-11-16)。
 * ⚠ 読むたびに保存を見る(システムの画面と書き出しの点検の 2 か所が読む)。⚠ 空の配列は「確かめない」(初期値に戻さない)。
 * ⚠ 保存の形は文字列の配列の JSON(`isWatchTagsJson`)。読めない形は初期値。
 */
import { parseWatchTags, readWatchTags } from '@features/export/export-check';

export const EXPORT_WATCH_TAGS_KEY = 'pkc3.export-watch-tags';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class ExportWatchTagsStore {
  /** 保存が読めない / 書けない環境の控え(`null` = まだ決めていない = 初期値)。 */
  private fallback: string | null = null;
  private saveFailed = false;

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage()) {}

  private raw(): string | null {
    // 🔴 保存が無い環境では控えを読む(`?.` では `catch` に入らない)
    if (this.storage === null || this.saveFailed) return this.fallback;
    try {
      return this.storage.getItem(EXPORT_WATCH_TAGS_KEY);
    } catch {
      return this.fallback;
    }
  }

  /** 確かめるタグ(空なら確かめない)。 */
  tags(): string[] {
    return readWatchTags(this.raw());
  }

  /** 欄に出す字(読点区切り)。 */
  text(): string {
    return this.tags().join(', ');
  }

  /** @returns 書けたか(書けなくてもこの session では効く) */
  set(raw: string): boolean {
    // ⚠ 保存は文字列の配列の JSON(設定ファイルの取り込みが形を検べられるように)
    const value = JSON.stringify(parseWatchTags(raw));
    this.fallback = value;
    try {
      if (this.storage === null) return false;
      this.storage.setItem(EXPORT_WATCH_TAGS_KEY, value);
      this.saveFailed = false;
      return true;
    } catch {
      this.saveFailed = true;
      return false;
    }
  }
}

export const appExportWatchTags = new ExportWatchTagsStore();
