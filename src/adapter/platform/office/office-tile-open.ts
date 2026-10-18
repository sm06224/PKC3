/**
 * 🔴 **Office のタイルを押したとき、保存していない文書の控えがあれば戻す口**(台帳 #1852 束 A1。依頼 367 A)。
 *
 * 窓は、添付から開いた文書だけでなく、**手元のファイルを開いた文書・Office の中で新しく作った文書**の控えも書いている
 * (棚の名前は窓ごとの `w-…`、`meta.json` の `lid` は空)。直す前は、それを戻す口が無く、確認が一度も出ないまま 7 日で消えていた。
 *
 * ## 2 つの口
 *
 * 1. **手元のファイルを開くとき**(OS から受けて控えてあるファイル): 同じ名前・同じ大きさのファイルの控えが
 *    そのファイルより新しければ、添付と同じ確認(一時保存した内容で開く / 保存済みの版で開く)を出す
 * 2. **何も控えていないとき**: 持ち主の居ない控え(新しく作った文書など)を「保存していない文書」として並べる
 *
 * ## 守ること
 *
 * - ⚠ **窓が開いていそうなときは訊かない。** 窓は自分の保存していない変更を自分で確かめる(添付の入口と同じ作法)。
 *   生きている窓の棚(いま書いている最中)を「保存していない文書」として出さないためでもある
 * - ⚠ **訊いている間に「やめる」を選んでも、控えたファイルを失わない**(`take()` は開くと決めてから)
 * - ⚠ **控えは、戻した窓の次の控え(または保存)が書けてから消す。** 戻した文書は別の窓の棚に書かれ直すので、
 *   すぐ消すと、窓が落ちた直後の数秒の編集が両方なくなる。`afterRestore` の合図で消す
 * - ⚠ 全部**投げない**。確認を出せない・読めない・消えたときは、今までどおり(控えを触らず)開く
 *
 * 🔑 `main.ts` に書かない(原文を読む test しか無い面)。ここへ取り出して判断そのものを test する。
 */
import {
  type OrphanShadowAnswer,
  SHADOW_GONE_LIST_NOTICE,
  SHADOW_GONE_NOTICE,
  SHADOW_OPENED_LOCAL_NOTICE,
  SHADOW_OPENED_UNLINKED_NOTICE,
  SHADOW_UNTITLED,
} from '../../../features/office/office-shadow';
import type { LocalOfficeFiles } from './local-office-files';
import type { LocalShadowQuery, OfficeShadows, OrphanShadow } from './office-shadow-shelf';
import type { OfficeWindow } from './office-window';

export interface OfficeTileDeps {
  readonly officeWindow: Pick<OfficeWindow, 'isProbablyOpen' | 'open' | 'provideDocument'>;
  readonly local: Pick<LocalOfficeFiles, 'peek' | 'take' | 'reread'>;
  readonly shadows: Pick<
    OfficeShadows,
    'mayHaveLocal' | 'findLocal' | 'orphans' | 'readById' | 'discardById'
  >;
  /** 手元のファイルの控えを訊く(添付と同じ確認)。`null` = やめる。 */
  readonly askLocal: (at: number) => Promise<'shadow' | 'saved' | null>;
  /** 「保存していない文書」の一覧を出す。`null` = やめる。 */
  readonly askList: (orphans: readonly OrphanShadow[]) => Promise<OrphanShadowAnswer | null>;
  /** 控えが無かった(または訊かない)ときの今までの開き方(同期)。 */
  readonly openPlain: () => void;
  /** 状態の行へ一言。 */
  readonly notify: (text: string) => void;
  /** 戻した控えの棚の名前を預ける(次の控えか保存が書けたら `discardById` する ── 呼び側の配線)。 */
  readonly afterRestore: (id: string) => void;
}

/** 控えの拡張子に名前を合わせる(`報告.doc` の控えが `.docx` のときなど)。名前が無ければ呼び名を使う。 */
export function restoredName(docName: string, ext: string): string {
  const base = docName === '' ? SHADOW_UNTITLED : docName;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return ext === '' ? base : `${stem}.${ext}`;
}

/**
 * Office のタイルを押した。⚠ **click ハンドラの同期の中から呼ぶこと**(控えを訊かない道は同期で窓を開ける)。
 * @returns 控えを訊く道へ入ったか(test の観測点)
 */
export function openOfficeTile(deps: OfficeTileDeps): boolean {
  if (!deps.officeWindow.isProbablyOpen()) {
    const peek = deps.local.peek();
    if (peek !== null) {
      if (deps.shadows.mayHaveLocal(peek)) {
        void localThenOpen(deps, peek);
        return true;
      }
    } else if (deps.shadows.orphans().length > 0) {
      void listThenOpen(deps);
      return true;
    }
  }
  deps.openPlain();
  return false;
}

async function localThenOpen(deps: OfficeTileDeps, q: LocalShadowQuery): Promise<void> {
  try {
    const offer = await deps.shadows.findLocal(q);
    if (offer === null) {
      deps.openPlain();
      return;
    }
    let answer: 'shadow' | 'saved' | null;
    try {
      answer = await deps.askLocal(offer.at);
    } catch {
      // 確認を出せなかった ── 控えは触らず、今までどおり保存済みの版で開く(控えは残る)
      deps.openPlain();
      return;
    }
    if (answer === null) return; // やめる: 控えたファイルも一時保存も、そのまま残す
    if (answer === 'saved') {
      await deps.shadows.discardById(offer.id);
      deps.openPlain();
      return;
    }
    const bytes = await deps.shadows.readById(offer.id);
    const staged = bytes === null || bytes.byteLength === 0 ? null : deps.local.take();
    if (bytes === null || bytes.byteLength === 0 || staged === null) {
      // 控えが読めなかった(消えた / 空)── 保存済みの版で開く。開けなくしない
      deps.notify(SHADOW_GONE_NOTICE);
      deps.openPlain();
      return;
    }
    deps.officeWindow.open({ name: staged.name, expectDocument: true });
    deps.officeWindow.provideDocument(
      staged.name,
      bytes,
      staged.token,
      [],
      // 窓が作り直されたら、元のファイルの「いま」を渡す(控えは次の控えが書き直す)
      () => deps.local.reread(staged.token),
      true,
      // 🔴 元のファイルの大きさを窓へ持たせる(次の控えも「このファイルの控え」と突き合わせられる)
      staged.bytes.byteLength,
    );
    deps.notify(SHADOW_OPENED_LOCAL_NOTICE);
    deps.afterRestore(offer.id);
  } catch {
    deps.openPlain();
  }
}

async function listThenOpen(deps: OfficeTileDeps): Promise<void> {
  try {
    const orphans = deps.shadows.orphans();
    let answer: OrphanShadowAnswer | null;
    try {
      answer = await deps.askList(orphans);
    } catch {
      deps.openPlain();
      return;
    }
    if (answer === null) return;
    if (answer.kind === 'skip') {
      deps.openPlain();
      return;
    }
    if (answer.kind === 'erase') {
      for (const o of orphans) await deps.shadows.discardById(o.id);
      deps.openPlain();
      return;
    }
    const picked = orphans.find((o) => o.id === answer.id);
    const bytes = picked === undefined ? null : await deps.shadows.readById(picked.id);
    if (picked === undefined || bytes === null || bytes.byteLength === 0) {
      deps.notify(SHADOW_GONE_LIST_NOTICE);
      deps.openPlain();
      return;
    }
    const name = restoredName(picked.docName, picked.ext);
    deps.officeWindow.open({ name, expectDocument: true });
    // 合言葉は空 ── 保存すると新しい添付のノートになる(元の持ち主は居ない)
    deps.officeWindow.provideDocument(name, bytes, '', [], null, true, picked.size);
    deps.notify(SHADOW_OPENED_UNLINKED_NOTICE);
    deps.afterRestore(picked.id);
  } catch {
    deps.openPlain();
  }
}
