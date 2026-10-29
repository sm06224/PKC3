/**
 * 🔴 **録ったものを仕上げる段取り**(#952 A2・A4・A5・B1・B4・B5・B6、#674)。
 *
 * 「音/動画」の行の道具(`PROCESS_TOOLS`)を 1 本の段取りで走らせる。作りは `capture-extract.ts`(動画から取り出す)
 * と `capture-transcribe.ts`(文字にする)に揃えた:
 *
 * - **元を上書きしない** ── 作るのは新しい添付か、元のノートの本文の**末尾への追記**だけ(`attachOne` / `APPEND_TO_ENTRY` の 1 本ずつ)
 * - 🔴 **添付は元と同じフォルダへ**。読んでいるノートも選択も動かさない(`keepSelection`)
 * - 🔴 **黙って終わらない** ── 断る・作る物が無い・保存できない、どれも理由を出す
 * - 🔴 **2 本同時に走らせない**(重い。切り出し・取り出し・文字起こしが走っている間も断る)
 * - 🔴 **編集中は預かる**(追記のとき。`createWritableQueue`)── 捨てない
 * - 🔑 重い所は**道具が持つ口(ワーカー)**。ここは `Blob` を参照で渡すだけで、bytes を開かない
 *
 * ⚠ **判定を `main.ts` へ出さない**(CLAUDE.md §2:あちらはどの test からも実行されない)。
 */
import { captureBusyText, type CaptureJobGate } from './capture-job-gate';
import { errorText } from '@features/error-text';
import type { Dispatcher } from '@adapter/state/dispatcher';
import { appendUnlessEditedElsewhere, type EditLockPort } from '@adapter/state/edited-elsewhere';
import { EDIT_ELSEWHERE_ERROR } from '@features/message/caution-events';
import type { CaptureItem } from '@features/capture/capture-item';
import { canProcess, processedCaptureName, processToolOf, type ProcessTool } from '@features/capture/capture-process';
import type { AttachItem, AttachedOne } from './attach';
import { canWriteBody, createWritableQueue } from './writable-queue';

/** 道具が返す結果。⚠ 断る・何も作らないは**値で返る**(例外にしない。例外は想定外の失敗)。 */
export type ProcessOutput =
  | {
      readonly kind: 'attach';
      /** 作った添付(1 件以上)。`tag` は名前に入れる語、`ext` は拡張子の差し替え(省略 = 元のまま)。 */
      readonly items: readonly {
        readonly tag: string;
        readonly blob: Blob;
        readonly mime: string;
        readonly ext?: string;
      }[];
      /** 完了の知らせ(「…しました」)。 */
      readonly summary: string;
    }
  | {
      readonly kind: 'note';
      /** `## …` の見出し行。 */
      readonly heading: string;
      readonly text: string;
      readonly summary: string;
    }
  | { readonly kind: 'refused'; readonly text: string }
  /** 利用者が「やめる」を押して途中で抜けた。⚠ 失敗ではない(赤い字にしない)── 知らせの 1 文だけ言い、何も作らない。 */
  | { readonly kind: 'cancelled'; readonly text: string }
  /** 道具が自分で書き込みまで済ませた(やめた回を含む)。⚠ 知らせは道具の側の書込が出す ── ここでは何も言わない。 */
  | { readonly kind: 'done' };

export interface ToolContext {
  readonly item: CaptureItem;
  readonly blob: Blob;
  /** 進み具合の知らせ(ステータス)。 */
  readonly progress: (text: string) => void;
  /** そのノートの本文(`null` = 読めない)。話者の一覧など、本文を読む道具が使う。 */
  readonly readBody: () => Promise<string | null>;
}

export type ToolRunner = (ctx: ToolContext) => Promise<ProcessOutput>;

const BUSY_BODY_TEXT =
  'いま本文に書き込めないので、結果を保存できません。編集を終えるか少し待ってから、もう一度押してください。';
const SETTLE_MS = 10_000;

export interface CaptureProcessDeps {
  readonly dispatcher: Dispatcher;
  readonly readBlob: (assetKey: string) => Promise<Blob | null>;
  readonly readBody: (lid: string) => Promise<string | null>;
  /** 道具ごとの実体。⚠ 無い道具は「このタブの PKC3 が古い」と断る。 */
  readonly tools: Partial<Record<ProcessTool, ToolRunner>>;
  readonly parentOf: (lid: string) => string | null;
  readonly attach: (
    item: AttachItem,
    place: { readonly parentLid: string | null; readonly keepSelection: boolean },
  ) => Promise<AttachedOne | null>;
  readonly notify: (text: string) => void;
  /** 🔴 録ったものへの重い仕事を 1 本ずつにする門(両方向に断る)。省略 = 門なし(単体の test)。 */
  readonly gate?: CaptureJobGate;
  readonly lock?: EditLockPort;
  readonly onActive?: (active: boolean) => void;
}

export interface CaptureProcessor {
  run(lid: string, tool: ProcessTool): Promise<void>;
  readonly busy: boolean;
}

export function createCaptureProcessor(deps: CaptureProcessDeps): CaptureProcessor {
  let running = false;
  const queue = createWritableQueue(deps.dispatcher);
  /**
   * 🔴 **本文への追記を預かっている `lid × 道具`**(着地前レビュー ⚠5)。預かっている間に同じ道具をもう一度押すと、
   * 同じ結果が**2 回**足される ── 預かりが解けて書けるまで断る(別の道具・別のノートは通す)。
   */
  const pending = new Set<string>();
  const fail = (error: string): void => deps.dispatcher.dispatch({ type: 'OP_FAILED', error });

  return {
    get busy(): boolean {
      return running;
    },
    async run(lid: string, toolId: ProcessTool): Promise<void> {
      const spec = processToolOf(toolId);
      const runner = deps.tools[toolId];
      if (spec === undefined || runner === undefined) {
        fail('このタブの PKC3 が古いままのため、この操作はできません。再読み込みしてください');
        return;
      }
      // ⚠ 2 本目は**断る**(黙って無視しない ── 押したのに何も起きないのと同じになる)
      if (running || deps.dispatcher.getState().captureTrimBusy) {
        fail('いま別の仕上げか切り出しをしています。終わるまで待ってください。');
        return;
      }
      const item = (deps.dispatcher.getState().captureItems ?? []).find((i) => i.lid === lid);
      if (item === undefined || item.assetKey === null) {
        fail('この添付が見つかりませんでした。');
        return;
      }
      const pendingKey = `${lid}\u0000${toolId}`;
      if (pending.has(pendingKey)) {
        fail(`「${item.name}」への「${spec.label}」の結果は、編集中なので保留しています。編集を終えると足すので、もう一度押す必要はありません。`);
        return;
      }
      // 話者の一覧が本文にあるかの門だけは本文を読んで決める(他は mime だけの粗い門)
      if (toolId !== 'fix-speakers' && !canProcess(item, toolId)) {
        fail(`「${spec.label}」は、この形の${item.kind === 'video' ? '動画' : '録音'}にはまだ使えません。`);
        return;
      }
      // 🔴 切り出し・取り出し・文字起こし・仕上げは 1 本ずつ(どれが走っていても他を断る)
      const leaveGate = deps.gate?.tryEnter('仕上げ');
      if (deps.gate !== undefined && leaveGate === null) {
        fail(captureBusyText(deps.gate.current));
        return;
      }
      running = true;
      deps.onActive?.(true);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        deps.onActive?.(false);
      };
      let holdsActive = false;
      let finished = false;
      deps.notify(spec.busyText);
      const say = (text: string): void => {
        finished = true;
        deps.notify(text);
      };
      try {
        const blob = await deps.readBlob(item.assetKey);
        if (blob === null) {
          fail('この添付の中身が見つかりませんでした。');
          return;
        }
        const out = await runner({
          item,
          blob,
          progress: (t) => deps.notify(t),
          readBody: () => deps.readBody(lid),
        });
        if (out.kind === 'refused') {
          fail(out.text);
          return;
        }
        if (out.kind === 'done') return; // finally が進行中の字を消す
        if (out.kind === 'cancelled') {
          say(out.text);
          return;
        }
        if (out.kind === 'attach') {
          if (!canWriteBody(deps.dispatcher)) {
            fail(BUSY_BODY_TEXT);
            return;
          }
          // 🔴 置き場は元の添付と同じフォルダ。⚠ 読んでいるノートも選択も動かさない
          const parentLid = deps.parentOf(lid);
          const names: string[] = [];
          for (const made of out.items) {
            const name = processedCaptureName(item.name, made.tag, made.ext);
            // ⚠ 空き容量が足りない等の理由は `attachOne` が先に出す ── 撃つ前の値を控え、変わっていたら残す
            const errorBefore = deps.dispatcher.getState().error;
            const attached = await deps.attach(
              {
                name,
                type: made.mime,
                size: made.blob.size,
                blob: made.blob.type === made.mime ? made.blob : made.blob.slice(0, made.blob.size, made.mime),
              },
              { parentLid, keepSelection: true },
            );
            if (attached === null) {
              if (deps.dispatcher.getState().error === errorBefore) {
                fail(canWriteBody(deps.dispatcher) ? '結果を保存できませんでした。' : BUSY_BODY_TEXT);
              }
              return;
            }
            names.push(name);
          }
          // 🔴 一覧を集め直す(`capture-extract.ts` と同じ。この一覧は開いた瞬間に 1 度集めるだけ)
          deps.dispatcher.dispatch({ type: 'REFRESH_CAPTURE_SCAN' });
          say(`${out.summary}:${names.map((n) => `「${n}」`).join('、')}`);
          return;
        }
        // note ── 元のノートの本文の末尾へ足す
        const write = async (): Promise<void> => {
          try {
            const r = await appendUnlessEditedElsewhere(
              deps.dispatcher,
              deps.lock ?? {},
              lid,
              out.text,
              out.heading,
              SETTLE_MS,
            );
            if (!r.ok) {
              if (r.reason === 'refused' && r.error === EDIT_ELSEWHERE_ERROR) {
                say(`「${item.name}」への「${spec.label}」の結果は、別のタブまたはウィンドウで編集中なので足していません。そちらを保存するか閉じてから、もう一度押してください`);
              } else if (!deps.dispatcher.getState().entryMetas.has(lid)) {
                say(`「${item.name}」への「${spec.label}」の結果は、書き先のノートが見つからなかったので足していません`);
              } else if (r.reason === 'timeout') {
                say(`「${item.name}」への「${spec.label}」の結果を足せたかどうか確かめられませんでした。ノートを開いて確かめてください`);
              } else if (r.reason === 'failed') {
                say(`「${item.name}」への「${spec.label}」の結果を足せませんでした(${r.error ?? '保存できませんでした'})`);
              }
              return;
            }
            deps.dispatcher.dispatch({ type: 'REFRESH_CAPTURE_SCAN' });
            say(`「${item.name}」に${out.summary}`);
          } finally {
            pending.delete(pendingKey);
            if (holdsActive) release();
          }
        };
        let writing: Promise<void> = Promise.resolve();
        const held = queue.push(() => (writing = write()), lid);
        holdsActive = held;
        if (held) pending.add(pendingKey);
        await writing;
        if (held) say(`「${item.name}」の「${spec.label}」の結果は、編集中なのでまだ足していません。編集を終えると、ノートの末尾に足します`);
      } catch (e: unknown) {
        fail(`「${spec.label}」を行えませんでした(${errorText(e)})`);
      } finally {
        if (!finished) deps.notify('');
        // ⚠ **必ず解く** ── 解かないと、1 度失敗しただけで以後ずっと断るようになる
        running = false;
        leaveGate?.();
        if (!holdsActive) release();
      }
    },
  };
}

