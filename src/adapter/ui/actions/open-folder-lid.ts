import type { AppState } from '@adapter/state/app-state';

/**
 * 🔴 **いま開いているフォルダの lid**(「新しく作るものは「X」に入ります」と同じ判定。依頼 340)。
 *
 * ⚠ ふつうのフォルダだけ ── ルート(`scopeLid === null`)・スマートフォルダ(条件で集まる場所)・消えたフォルダは `null`。
 * ⚠ 取り込みの入れ先は、ここで読んだ値を取り込みの間じゅう使う(`import-folder-home.ts`)。
 */
export function openFolderLid(st: Pick<AppState, 'scopeLid' | 'entryMetas'>): string | null {
  if (st.scopeLid === null) return null;
  const meta = st.entryMetas.get(st.scopeLid);
  return meta !== undefined && meta.archetype === 'folder' ? meta.lid : null;
}
