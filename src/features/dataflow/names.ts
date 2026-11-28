/**
 * 🔴 **名前の同一視**(#2115 PR-2)。
 *
 * SQLite は ASCII の大文字小文字を区別せずに表の名前を引く(`Sales` と `sales` は同じ表)。
 * だから「同じ名前か」「参照しているか」は ASCII だけを畳んで比べる。
 * ⚠ 畳むのは ASCII だけ ── sqlite の照合と同じ(`É` と `é` は別の名前)。`csvColumnNames` の畳み方と揃える。
 */
export function foldName(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** 名前 → 正規の綴り(最初に名乗った字)の控え。 */
export class NameBook {
  private readonly byFold = new Map<string, string>();

  /** 既に誰かが名乗っていれば、その正規の綴りを返す。 */
  owner(name: string): string | undefined {
    return this.byFold.get(foldName(name));
  }

  /** 名乗る。⚠ 既に在れば `false`(上書きしない)。 */
  claim(name: string): boolean {
    const k = foldName(name);
    if (this.byFold.has(k)) return false;
    this.byFold.set(k, name);
    return true;
  }

  names(): string[] {
    return [...this.byFold.values()];
  }
}
