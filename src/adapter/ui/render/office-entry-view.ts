/**
 * 添付の器に置く **Office の入口**を描く(#88 / 統合設計 O3-c)。
 *
 * 🔴 user 裁定 2026-08-10「**少なくとも閲覧はしーむれすたいけんにしたいなぁ**」──
 * 添付を開いた画面に、**余計な手順なしで読める導線**が常に在ることが「シームレス」の
 * 中身である(面そのものは別窓 ── 同 裁定「**別タブでも構いません / 見やすければ
 * いいのだ**」)。
 *
 * ## この module は「決める」を持たない
 *
 * 何を出すかは `features/office/office-entry.ts` の純粋関数が決める。ここは
 * **その答えを DOM にするだけ**。判定を 2 か所に書かない
 * (CLAUDE.md「判定を増やさない。誤差の向きを両側に使い回さない」)。
 *
 * ## 🔑 出すのは「押せる」か「理由」のどちらかだけ
 *
 * ⚠ **ボタンだけ出して押しても何も起きない、を作らない**。この repo が繰り返し
 * 踏んできた形(2026-08-07「保存直後の編集が無言の dead click になっていた」)なので、
 * 使えない・入っていないときは**ボタンを出さず、名指しの理由**を出す。
 */
import {
  officeEntry,
  readOfficeCapability,
  type OfficeCapability,
} from '@features/office/office-entry';
import { iconButton } from './icons';

/** 入口を決めるのに要る「いまの状態」。⚠ **同期で答えられる**ことが条件。 */
export interface OfficeAvailabilitySource {
  /** 一式(約 77MB)が配備済みか。 */
  isInstalled(): boolean;
  capability(): OfficeCapability;
}

/**
 * アプリ共有の 1 個。
 *
 * ⚠ 配備の有無は **IDB を読まないと分からない = 非同期**だが、入口を描くのは
 * click ハンドラと同じ同期の世界である。だからここは**控え**を持ち、
 * 起動時と設置 / 削除の直後に `setInstalled()` で合わせる。
 * ⚠ 合わせ忘れると「入れたのに設置カードが出たまま」になる ── 更新する側は
 * 必ず `center.invalidateDetail()` → `render()` まで面倒を見ること。
 */
export class OfficeAvailability implements OfficeAvailabilitySource {
  private installed = false;

  isInstalled(): boolean {
    return this.installed;
  }

  /** @returns 値が変わったか(変わったときだけ描き直せばよい)。 */
  setInstalled(on: boolean): boolean {
    if (this.installed === on) return false;
    this.installed = on;
    return true;
  }

  capability(): OfficeCapability {
    return readOfficeCapability(globalThis);
  }
}

export const appOfficeAvailability = new OfficeAvailability();

export interface OfficeAttachment {
  readonly name: string;
  readonly mime: string;
  readonly assetKey: string;
}

/**
 * 添付 1 件ぶんの入口を組む。**Office の添付でなければ `null`**(何も出さない)。
 *
 * ⚠ 返るのは 1 要素だけ ── 呼び側は**置き場所を選ばない**(添付の情報の器へ
 * そのまま append する)。ボタンは行に並び、理由は次の行に落ちる。
 * ⚠ 開くのに要る 3 つ(key / 名前 / MIME)は**ボタンの属性に載せる** ──
 * 受け口(binder)は click の同期のうちに読む必要があり、本文を読み直す暇が無い
 * (`await` を挟むと user gesture が切れてポップアップ遮断に遭う)。
 */
export function buildOfficeEntry(
  att: OfficeAttachment,
  avail: OfficeAvailabilitySource = appOfficeAvailability,
): HTMLElement | null {
  const entry = officeEntry({
    mime: att.mime,
    fileName: att.name,
    packInstalled: avail.isInstalled(),
    capability: avail.capability(),
  });
  if (entry.kind === 'none') return null;

  if (entry.kind === 'open') {
    const btn = iconButton('open-office', entry.label, 'open-office');
    btn.setAttribute('data-pkc-office', '');
    btn.setAttribute('data-pkc-office-state', 'open');
    btn.setAttribute('data-pkc-asset-key', att.assetKey);
    btn.setAttribute('data-pkc-asset-name', att.name);
    btn.setAttribute('data-pkc-asset-mime', att.mime);
    // ⚠ 別窓であることを**押す前に**言う(勝手に窓が増えたように見せない)
    btn.title = '別の窓で開きます。PKC3 の編集はそのまま続けられます';
    return btn;
  }

  const note = document.createElement('p');
  note.setAttribute('data-pkc-office', '');
  note.setAttribute('data-pkc-office-state', entry.kind);
  note.setAttribute('data-pkc-field', 'office-note');
  note.textContent = entry.reason;
  return note;
}
