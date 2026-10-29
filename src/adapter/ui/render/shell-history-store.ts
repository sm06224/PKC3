/**
 * コマンドシェルの履歴をこの端末に保存する(#274。「履歴(↑↓・端末に保存)」)。
 *
 * ⚠ **コレクションに入れない** ── 何を打ったかは作業の都合で、ノートのデータではない(`pkc3.calc-draft` /
 *   検索語の記録と同じ分け方)。⚠ **設定ファイルに載せない**(`settings-file.ts` の「運ばない鍵」)── 題名や SQL の字が入りうる。
 * ⚠ 読めない環境(プライベートモード等)でも落ちない ── 控え(この session の間だけ)に落ちる。
 */
import { SHELL_HISTORY_MAX } from '@features/shell/history';

export const SHELL_HISTORY_STORAGE_KEY = 'pkc3.shell-history';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function readStorage(): Store | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class ShellHistoryStore {
  private fallback: string[] = [];
  private saveFailed = false;

  constructor(private readonly storage: Store | null = readStorage()) {}

  /** 新しいものが先頭。壊れた保存・文字列でない要素は落とす。 */
  get(): string[] {
    if (this.storage === null || this.saveFailed) return [...this.fallback];
    try {
      const raw = this.storage.getItem(SHELL_HISTORY_STORAGE_KEY);
      if (raw === null) return [];
      const v: unknown = JSON.parse(raw);
      if (!Array.isArray(v)) return [];
      return v.filter((x): x is string => typeof x === 'string' && x !== '').slice(0, SHELL_HISTORY_MAX);
    } catch {
      return [...this.fallback];
    }
  }

  set(list: readonly string[]): void {
    this.fallback = [...list];
    this.saveFailed = false;
    try {
      if (list.length === 0) this.storage?.removeItem(SHELL_HISTORY_STORAGE_KEY);
      else this.storage?.setItem(SHELL_HISTORY_STORAGE_KEY, JSON.stringify(list));
    } catch {
      // 書けなかった ── 次に書けるまで、読みは控え(書いた値)を返す
      this.saveFailed = true;
    }
  }
}

export const appShellHistory = new ShellHistoryStore();
