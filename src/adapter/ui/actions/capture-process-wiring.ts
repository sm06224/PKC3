/**
 * 🔴 **仕上げの段取りの配線**(#952 着地前レビュー 🔴1)。
 *
 * `main.ts` はどの test からも実行されない(CLAUDE.md §2)── 「別のタブの編集中のノートへ足さない」(`lock`)と
 * 「仕上げている間にタブを閉じる・読み直すと『離れますか』」(`setWriting`)と「切り出し・取り出し・文字起こしと同時に走らない」
 * (`gate`)を `main.ts` に直書きすると、渡し忘れても tsc も test も黙る(文字起こしでは渡していたのに、仕上げでは落ちていた)。
 * ⚠ だから**必須の口を型で要求する関数**に出す。`tests/adapter/capture-process-wiring.test.ts` が、この関数と、
 *   `main.ts` がこの関数を通っていること(source 読み)を守る。
 */
import type { EditLockPort } from '@adapter/state/edited-elsewhere';
import type { CaptureJobGate } from './capture-job-gate';
import { createCaptureProcessor, type CaptureProcessDeps, type CaptureProcessor } from './capture-process';

/** 「離れますか」の確認に数える仕事の名前(`unloadGuard.setWriting` の第 2 引数)。 */
export const PROCESS_WRITING_KEY = 'process';

export interface CaptureProcessPorts extends Omit<CaptureProcessDeps, 'gate' | 'lock' | 'onActive'> {
  /** 🔴 録ったものへの重い仕事を 1 本ずつにする門。⚠ 必須(切り出し・取り出し・文字起こしと同じ物を渡す)。 */
  readonly gate: CaptureJobGate;
  /** 🔴 別のタブ・窓が編集中のノートへは足さない(#1087)。⚠ 必須。 */
  readonly lock: EditLockPort;
  /** 🔴 仕上げている間 / 預かった結果が書かれるまで、タブを閉じる前に確認する(`unloadGuard.setWriting`)。⚠ 必須。 */
  readonly setWriting: (active: boolean, key: string) => void;
}

export function createWiredCaptureProcessor(ports: CaptureProcessPorts): CaptureProcessor {
  const { setWriting, ...rest } = ports;
  return createCaptureProcessor({
    ...rest,
    onActive: (active) => setWriting(active, PROCESS_WRITING_KEY),
  });
}
