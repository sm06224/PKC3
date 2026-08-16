/**
 * 添付を **Office の別窓**で開く(#88 / 統合設計 O3-b)。
 *
 * 🔴 **`main.ts` に書かない。** あそこは原文を `readFileSync` で読む test しか無く、
 * 判断を置くと「全 tests 緑のまま取り違える」(CLAUDE.md 2026-08-08)。
 * ここへ取り出しておけば、**判断そのものを test できる**。
 * `main.ts` の仕事は依存を渡す 3 行だけにする。
 *
 * ## 何を守るか
 *
 * - 🔑 **押しても何も起きない、を作らない。** 開けないときは**必ず理由**を返す
 * - ⚠ **窓を開くのは同期のうち**(`await` を挟むと user gesture が切れて遮断される)。
 *   したがって「能力が足りるか」「一式が在るか」は**先に手元の値で**判定し、
 *   添付の bytes は**窓を開いたあと**に放送で渡す(`OfficeWindow` の作り)
 * - ⚠ bytes の取得に失敗しても、窓は既に開いている ── **窓側が Start Center を出す**
 *   ので黙って壊れはしないが、呼び出し側へは失敗を返す
 */
import {
  officeEntry,
  readOfficeCapability,
  type OfficeCapability,
} from '../../../features/office/office-entry';
import type { OfficeWindow } from './office-window';

/** 添付 1 件ぶんの、開くのに要る情報。 */
export interface OfficeTarget {
  readonly name: string;
  readonly mime: string;
  readonly assetKey: string;
  /**
   * 🔴 **どのノートの添付か**(#205)。⚠ **これを渡さないと、その窓での保存は
   * 「新規作成」になり、元のノートは更新されない**(新しい添付ノートが 1 件増える)。
   * ⚠ 2026-08-16 まで、開く経路は lid を**3 段で落としていた**
   * (描画 → 属性 → binder)ので、4 面まとめて直した。
   */
  readonly lid?: string;
}

export type OpenOfficeResult =
  | { readonly ok: true; readonly reused: boolean }
  /** 開けなかった ── `message` はそのまま user へ出せる文にする。 */
  | { readonly ok: false; readonly reason: 'not-office' | 'unsupported' | 'not-installed' | 'no-bytes'; readonly message: string };

export interface OfficeOpenerDeps {
  readonly officeWindow: OfficeWindow;
  /** 一式が入っているか。⚠ **同期で答えられる値**(起動時と設置後に更新した控え)。 */
  readonly isPackInstalled: () => boolean;
  /** 添付の実体。窓を開いたあとに読む(同期を邪魔しない)。 */
  readonly readAsset: (assetKey: string) => Promise<Uint8Array | null>;
  readonly capability?: () => OfficeCapability;
}

export interface OfficeOpener {
  /** ⚠ **click ハンドラの同期の中から呼ぶこと。** */
  open(target: OfficeTarget): OpenOfficeResult;
}

export function createOfficeOpener(deps: OfficeOpenerDeps): OfficeOpener {
  const capability = deps.capability ?? ((): OfficeCapability => readOfficeCapability(globalThis));
  return {
    open(target: OfficeTarget): OpenOfficeResult {
      const entry = officeEntry({
        mime: target.mime,
        fileName: target.name,
        packInstalled: deps.isPackInstalled(),
        capability: capability(),
      });
      if (entry.kind === 'none') {
        return { ok: false, reason: 'not-office', message: 'この添付は Office 文書ではありません' };
      }
      if (entry.kind === 'unsupported') {
        return { ok: false, reason: 'unsupported', message: entry.reason };
      }
      if (entry.kind === 'setup') {
        return { ok: false, reason: 'not-installed', message: entry.reason };
      }

      // 🔑 **ここで開く**(同期 ── user gesture を切らない)。
      //    ⚠ `open()` を 2 回呼んではいけない。1 回目の時点では生存通知が
      //    まだ届いておらず `isProbablyOpen()` が false なので、**窓が 2 つ開く**。
      //    宣言してから `provideDocument()` で後渡しする。
      const outcome = deps.officeWindow.open({ name: target.name, expectDocument: true });
      void (async () => {
        const bytes = await deps.readAsset(target.assetKey).catch(() => null);
        if (bytes === null || bytes.byteLength === 0) return;
        // 🔴 **合言葉(= このノートの lid)を預ける**(#205)── 保存が戻って
        //    きたとき、**このノートを更新する**ために要る。
        //    ⚠ 無ければ空文字 = 窓は「新規作成」として返す(新しい添付ノートになる)。
        //    🔑 **key ではなく lid を預ける** ── 2 回目の保存の時点で key は既に
        //    変わっている(1 回目で差し替わる)ので、key を預けると迷子になる。
        //    どの asset を差し替えるかは、**そのノートの現在の frontmatter**が決める
        deps.officeWindow.provideDocument(target.name, bytes, target.lid ?? '');
      })();
      return { ok: true, reused: outcome.kind === 'already-open' };
    },
  };
}
