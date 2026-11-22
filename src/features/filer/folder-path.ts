/**
 * フォルダのパス(`ルート/資料/下`)と、フォルダの対応づけ(#1982 A4。パンくずの「パスを直接打つ」入力)。
 *
 * 🔴 **同名フォルダを黙って取り違えない**: 同じ道の字で 2 つ以上のフォルダに当たるときは**入らない**
 *   (`ambiguous`)── 候補の表示(`label`)に「同名の n 番目・中に m 件」を足し、**候補を選ばせる**。
 *   ⚠ あいまい一致(部分一致・大小文字の無視)では入らない。入るのは**字が完全に一致**したときだけ
 *   (部分一致は候補を絞る(`filterFolderPathCandidates`)ためだけに使う)。
 * 🔑 入れるのは `canEnterScope`(フォルダとスマートフォルダ)── パンくずの `enter-folder` と同じ集合。
 *   ゴミ箱のフォルダは `entryMetas` に居ない(別の表)ので、ここへは出ない。
 *   スマートフォルダは中へ入れるだけで親にはなれないので、**道の末尾にだけ**現れる。
 * ⚠ 道の継ぎ目は `/`。題名に `/` を含むフォルダもあるので、**道を分割して木を辿らず**、
 *   「全フォルダの道の字」と**字で突き合わせる**(`a/b` という題名と `a` の下の `b` は同じ字 → あいまいになる)。
 */
import type { EntryMeta, Relation } from '@core/model/entry-meta';
import { buildStructuralChildrenIndex, resolveCanonicalParents } from '@features/relation/tree';
import { SMART_ARCHETYPE } from '@features/smart/smart-spec';

export const FOLDER_PATH_ROOT = 'ルート';
/** 題名が空(空白・区切りの字だけ)のフォルダの、道での字。空だと道が親と同じ字になり、ルートと取り違える。 */
export const FOLDER_PATH_UNTITLED = '（無題）';

export interface FolderPathCandidate {
  /** `null` = ルート。 */
  lid: string | null;
  /** 道の字(`ルート/資料/下`)。同名は同じ字になる。 */
  path: string;
  /** 候補の表示と、打ち込む字。道が重なるものだけ「同名の n 番目・中に m 件」を足して**見分けが付く**ようにする。 */
  label: string;
  /** 同じ道の字を持つ候補が 2 つ以上あるか。 */
  ambiguous: boolean;
}

export type FolderPathResolution =
  | { kind: 'ok'; lid: string | null; path: string }
  | { kind: 'ambiguous'; path: string; candidates: FolderPathCandidate[] }
  | { kind: 'none' };

/** 区切りを `/` に揃え、各段の前後の空白と空の段(末尾の `/`・`//`)を落とす。 */
export function normalizeFolderPath(text: string): string {
  return text
    .replace(/[／›]/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .join('/');
}

const joinPath = (parentPath: string, title: string): string =>
  `${parentPath}/${normalizeFolderPath(title) === '' ? FOLDER_PATH_UNTITLED : title}`;

/** ルートを先頭に、フォルダを画面の並び(深さ優先・各段は並び順)で。 */
export function listFolderPathCandidates(
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): FolderPathCandidate[] {
  const parentOf = resolveCanonicalParents(metas, relations);
  const children = buildStructuralChildrenIndex(metas, relations);
  const enterable = (m: EntryMeta): boolean => m.archetype === 'folder' || m.archetype === SMART_ARCHETYPE;
  const rows: { lid: string; path: string; childCount: number }[] = [];
  const seen = new Set<string>();
  const walk = (parentLid: string | null, parentPath: string): void => {
    const kids = parentLid === null ? rootChildren(metas, parentOf) : children(parentLid);
    for (const m of kids) {
      if (!enterable(m) || seen.has(m.lid)) continue; // 輪の防御
      seen.add(m.lid);
      const path = joinPath(parentPath, m.title);
      rows.push({ lid: m.lid, path, childCount: children(m.lid).length });
      if (m.archetype === 'folder') walk(m.lid, path);
    }
  };
  walk(null, FOLDER_PATH_ROOT);
  // 輪の中に居て木から辿れないフォルダも出す(出さないと、そこへ入れない)
  for (const m of metas.values()) {
    if (!enterable(m) || seen.has(m.lid)) continue;
    seen.add(m.lid);
    rows.push({ lid: m.lid, path: joinPath(FOLDER_PATH_ROOT, m.title), childCount: children(m.lid).length });
  }
  const norm = (p: string): string => normalizeFolderPath(p);
  const groups = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const k = norm(r.path);
    const g = groups.get(k);
    if (g) g.push(i);
    else groups.set(k, [i]);
  });
  const out: FolderPathCandidate[] = [
    { lid: null, path: FOLDER_PATH_ROOT, label: FOLDER_PATH_ROOT, ambiguous: false },
  ];
  rows.forEach((r, i) => {
    const g = groups.get(norm(r.path))!;
    const ambiguous = g.length > 1;
    const label = ambiguous
      ? `${r.path} 〔同名 ${g.indexOf(i) + 1} 番目・中に ${r.childCount} 件〕`
      : r.path;
    out.push({ lid: r.lid, path: r.path, label, ambiguous });
  });
  return out;
}

function rootChildren(
  metas: ReadonlyMap<string, EntryMeta>,
  parentOf: ReadonlyMap<string, string>,
): EntryMeta[] {
  const out: EntryMeta[] = [];
  for (const m of metas.values()) if (!parentOf.has(m.lid)) out.push(m);
  return out.sort((a, b) => a.entryOrder - b.entryOrder || a.lid.localeCompare(b.lid));
}

/** いまの場所の道の字(パンくずの表示と同じ。入力欄の初期値)。 */
export function currentFolderPathText(
  scopeLid: string | null,
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): string {
  if (scopeLid === null) return FOLDER_PATH_ROOT;
  const hit = listFolderPathCandidates(metas, relations).find((c) => c.lid === scopeLid);
  // 同名のときは見分けの付く表示(`label`)を初期値にする ── 道の字のままだと、そのまま Enter で「あいまい」になる
  return hit?.label ?? FOLDER_PATH_ROOT;
}

/** 打った字をフォルダへ。字が完全に一致したときだけ `ok`(あいまい一致では入らない)。 */
export function resolveFolderPath(
  text: string,
  metas: ReadonlyMap<string, EntryMeta>,
  relations: readonly Relation[],
): FolderPathResolution {
  const cands = listFolderPathCandidates(metas, relations);
  const typed = normalizeFolderPath(text);
  // ルートは常に一意に解決する(題名がルートと同じ字になるフォルダが居ても取り違えない)
  if (typed === '' || typed === FOLDER_PATH_ROOT) return { kind: 'ok', lid: null, path: FOLDER_PATH_ROOT };
  // ① 候補の表示そのもの(同名を見分ける「〔同名 n 番目…〕」付き)── 候補を選んだ場合
  const byLabel = cands.filter((c) => normalizeFolderPath(c.label) === typed);
  if (byLabel.length === 1) return { kind: 'ok', lid: byLabel[0]!.lid, path: byLabel[0]!.path };
  // ② 道の字。「ルート/」は省いてもよい(`資料/下`)。字が完全に一致する物があればそちらを先に
  const tryPath = (p: string): FolderPathCandidate[] =>
    cands.filter((c) => normalizeFolderPath(c.path) === p);
  let hits = tryPath(typed === '' ? FOLDER_PATH_ROOT : typed);
  if (hits.length === 0) hits = tryPath(`${FOLDER_PATH_ROOT}/${typed}`);
  if (hits.length === 1) return { kind: 'ok', lid: hits[0]!.lid, path: hits[0]!.path };
  if (hits.length > 1) return { kind: 'ambiguous', path: hits[0]!.path, candidates: hits };
  return { kind: 'none' };
}

/** 打った字で候補を絞る(部分一致・大小文字を無視)。入る先の判定ではない ── 候補を並べるだけ。 */
export function filterFolderPathCandidates(
  cands: readonly FolderPathCandidate[],
  text: string,
  limit = 50,
): FolderPathCandidate[] {
  const typed = normalizeFolderPath(text).toLowerCase();
  const out: FolderPathCandidate[] = [];
  for (const c of cands) {
    if (typed === '' || normalizeFolderPath(c.label).toLowerCase().includes(typed)) {
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}
