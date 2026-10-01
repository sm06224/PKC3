/**
 * 🔴 **本文の `@2026-10-15` の右に「あと3日」「5日前」を薄く添える**(#1225)。
 *
 * ## 作り(理由は #1225 のコメント)
 *
 * - **原文も描画結果も変えない** ── 読む面で描いた後に、`.pkc-date-link` へ属性
 *   (`data-pkc-rel="あと3日"`)を差すだけ。字は CSS の `::after` が出す
 *   (選択・コピーに入らない / 日をまたいでも描画結果を捨てなくてよい)。
 * - 面は**読む面の本文だけ**(`.pkc-date-link` は `interactiveDates` の面にしか出ない)。
 *   書き出した HTML・印刷・別窓には属性が付かない ── 「5日前」が書き出した日で凍る事故を避ける。
 * - 出すのは **単日**だけ(`data-pkc-date-kind` が付く期間・繰り返しには出さない)。
 *   チェック項目の行は**済んでいない(`- [ ]`)ときだけ**。地の文は出す。
 *
 * ⚠ **既定は入**(`date-links.ts` と同じ ── 見え方が変わるので切れる)。
 * ⚠ flag ではない(正規設定)/ container に入れない(この端末の読み方)。
 * ⚠ 常駐タイマーは立てない ── 日が変わったら、画面に**戻ってきたとき**(`visibilitychange` の
 *   `visible`)に計算し直す(`watchRelativeDays`)。
 */
import { relativeDayLabel } from '@features/schedule/relative-days';
import { shortcutDate } from '@features/schedule/date-shortcuts';

const KEY = 'pkc3.relative-days';

/** 差す属性(CSS の `::after` が読む)。 */
export const REL_ATTR = 'data-pkc-rel';

function readStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class RelativeDaysStore {
  /** 保存が読めない環境の控え(この session では効いている)。⚠ 既定は入。 */
  private fallback = true;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = readStorage(),
  ) {}

  /**
   * ⚠ **読むたびに保存を見る**(書き手が複数)。
   * 🔴 **切にした人だけが `'0'` を書く** ── 何も書いていない人は入である
   *   (`=== '1'` で読むと、**既定が切に化ける**)。
   */
  enabled(): boolean {
    // 🔴 **保存が無い環境では控えを読む**(`?.` は `null` で例外を投げず、控えへ入らない)
    if (this.storage === null) return this.fallback;
    try {
      return this.storage.getItem(KEY) !== '0';
    } catch {
      return this.fallback;
    }
  }

  setEnabled(on: boolean): void {
    this.fallback = on;
    try {
      this.storage?.setItem(KEY, on ? '1' : '0');
    } catch {
      // 保存できないだけ ── この session では効いている(控えが持つ)
    }
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く。 */
export const appRelativeDays = new RelativeDaysStore();

/** この日付の右へ添えてよい形か(単日 + 済んだ項目でない)。 */
function eligible(span: HTMLElement): boolean {
  // 期間・繰り返しは出さない(描く側が `data-pkc-date-kind` を焼く)
  if (span.hasAttribute('data-pkc-date-kind')) return false;
  /**
   * 🔴 **チェック項目の行が済んでいれば出さない**(Gemini 裁定 2026-10-01 ① B)。
   * ⚠ 「いちばん近い `li`」が**その日付の行**である ── 入れ子の中の別の項目の日付は、
   *   外側の項目の済み・未了に左右されない。
   */
  const li = span.closest('li');
  if (li !== null && li.classList.contains('pkc-task-item')) {
    for (const box of li.querySelectorAll<HTMLInputElement>('.pkc-task-checkbox')) {
      if (box.closest('li') === li) return !box.checked;
    }
  }
  return true;
}

/**
 * 読む面の日付へ「あとN日」を差す(冪等)。⚠ **描画のたびに呼ぶ**(塊が差し替わると新しい
 * 字には属性が無い)。⚠ 出さない形には**属性を外す**(済ませた後・設定を切った後に残さない)。
 */
export function applyRelativeDays(root: ParentNode, today: string): void {
  for (const span of root.querySelectorAll<HTMLElement>('.pkc-date-link')) {
    const date = span.getAttribute('data-pkc-date');
    const label = date !== null && eligible(span) ? relativeDayLabel(date, today) : null;
    if (label === null) span.removeAttribute(REL_ATTR);
    else if (span.getAttribute(REL_ATTR) !== label) span.setAttribute(REL_ATTR, label);
  }
}

/** 差した属性を全部外す(設定を切ったとき)。 */
export function clearRelativeDays(root: ParentNode): void {
  for (const span of root.querySelectorAll<HTMLElement>(`.pkc-date-link[${REL_ATTR}]`)) {
    span.removeAttribute(REL_ATTR);
  }
}

/** 設定に従って差す / 外す。⚠ 読む面の描画後と、日が変わった後の両方がここを通る。 */
export function syncRelativeDays(root: ParentNode, now: Date = new Date()): void {
  if (appRelativeDays.enabled()) applyRelativeDays(root, shortcutDate('today', now));
  else clearRelativeDays(root);
}

/**
 * 画面に戻ってきたとき(`visible`)に計算し直す。⚠ **常駐タイマーは立てない**。
 * 返す関数で外せる。
 */
export function watchRelativeDays(doc: Document, root: ParentNode, now: () => Date = () => new Date()): () => void {
  const onVisible = (): void => {
    if (doc.visibilityState === 'visible') syncRelativeDays(root, now());
  };
  doc.addEventListener('visibilitychange', onVisible);
  return () => doc.removeEventListener('visibilitychange', onVisible);
}
