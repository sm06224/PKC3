/** @vitest-environment node */
/**
 * `build/office-wasm/qtbase-patch-backspace.py` を検める(#433)。
 *
 * > user 報告 2026-08-26:「**バックスペース１回でなぜか２文字消える**」
 * > user 追加:「**Office の窓です / 日本語入力していて気づきました**」
 *
 * ## 🔴 これは実機のログで確定した直しである(2026-08-28)
 *
 * user が `office.inputLog` を ON にして採った console(1 打鍵ぶん):
 *
 *     Key callback "Backspace" 9
 *     processKey as KeyEvent
 *     bool QWasmWindow::processKeyForInputContext(const KeyEvent &)   ← ① LO へ 1 回目
 *     void inputCallback(...) inputType : "deleteContentBackward"     ← ② LO へ 2 回目
 *
 * ## ⚠ ここで検められること / 検められないこと
 *
 * 🔴 **compile も実行もできない**(emsdk も Qt ツリーもこの箱に無い)。
 *   だからここが見るのは **patch の道具としての正しさ**だけである:
 *
 * | 見る | 見ない |
 * |---|---|
 * | 錨に当たって、**期待した字が入る** | その C++ が**コンパイルできるか** |
 * | **2 度当てても壊れない**(冪等) | 実機で**本当に 1 文字になるか** |
 * | 🔴 **錨が無ければ落ちる**(黙って素通りしない) | 上流 6.9 が形を変えていないか |
 *
 * ⚠ 上流の形が変わったことは**焼くときに patch 自身が落ちて**教える
 *   (`hits != 1` で `exit 1`)── ここでその代わりはできない。
 * 🔑 実機で効いたかは **#433 段③**(焼いて、日本語入力中に Backspace)で見る。
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = 'build/office-wasm/qtbase-patch-backspace.py';
const DIR = 'src/plugins/platforms/wasm';

/**
 * 🔴 **上流 6.9 の実物から切り出した断片**(2026-08-28 に
 * `raw.githubusercontent.com/qt/qtbase/6.9` から落として写した)。
 * ⚠ **要約しない** ── 錨は字面で当たるので、1 バイトでも整えると
 * 「fixture では当たるのに実物では当たらない」が起きる。
 */
const HDR = `class QWasmInputContext : public QPlatformInputContext
{
public:
    void insertText(QString inputStr, bool replace = false);

    bool usingTextInput() const { return m_inputMethodAccepted; }
    void setFocusObject(QObject *object) override;

private:
    QString m_preeditString;
    int m_replaceSize = 0;

    bool m_visibleInputPanel = false;
    bool m_inputMethodAccepted = false;
    QObject *m_focusObject = nullptr;
};
`;

const WIN = `void QWasmWindow::handleKeyForInputContextEvent(const emscripten::val &event)
{
    const QWasmInputContext *wasmInput = QWasmIntegration::get()->wasmInputContext();
    if (wasmInput) {
        const auto keyString = QString::fromStdString(event["key"].as<std::string>());
        qCDebug(qLcQpaWasmInputContext) << "Key callback" << keyString << keyString.size();
        if (keyString == "Unidentified") {
            return;
        } else if (keyString.size() != 1) {
            ; // fallthrough
        } else if (wasmInput->inputMethodAccepted()) {
            return;
        }
    }

    qCDebug(qLcQpaWasmInputContext) << "processKey as KeyEvent";
    if (processKeyForInputContext(*KeyEvent::fromWebWithDeadKeyTranslation(event, m_deadKeySupport)))
        event.call<void>("preventDefault");
    event.call<void>("stopImmediatePropagation");
}
`;

const CTX = `static void inputCallback(emscripten::val event)
{
    emscripten::val inputType = event["inputType"];
    if (inputType != emscripten::val::null()) {
        const auto inputTypeString = inputType.as<std::string>();
        if (!inputTypeString.compare("deleteContentBackward")) {
            QWindowSystemInterface::handleKeyEvent(0,
                                                   QEvent::KeyPress,
                                                   Qt::Key_Backspace,
                                                   Qt::NoModifier);
            event.call<void>("stopImmediatePropagation");
            return;
        } else if (!inputTypeString.compare("deleteContentForward")) {
            QWindowSystemInterface::handleKeyEvent(0,
                                                   QEvent::KeyPress,
                                                   Qt::Key_Delete,
                                                   Qt::NoModifier);
            event.call<void>("stopImmediatePropagation");
            return;
        }
    }
}
`;

interface Tree {
  dir: string;
  read(rel: string): string;
}

function tree(over: Partial<Record<'h' | 'win' | 'ctx', string>> = {}): Tree {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-qt-bs-'));
  mkdirSync(join(dir, DIR), { recursive: true });
  writeFileSync(join(dir, DIR, 'qwasminputcontext.h'), over.h ?? HDR);
  writeFileSync(join(dir, DIR, 'qwasmwindow.cpp'), over.win ?? WIN);
  writeFileSync(join(dir, DIR, 'qwasminputcontext.cpp'), over.ctx ?? CTX);
  return { dir, read: (rel) => readFileSync(join(dir, DIR, rel), 'utf-8') };
}

/** patch を回す。⚠ **落ちても投げない**(exit を検めたいので自分で拾う)。 */
function run(dir: string): { code: number; out: string } {
  try {
    const out = execFileSync('python3', [SCRIPT, dir], { encoding: 'utf-8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('Backspace の二重配送を止める patch(#433)', () => {
  it('🔴 3 つの file すべてに当たり、期待した字が入る', () => {
    const t = tree();
    try {
      const r = run(t.dir);
      expect(r.code, `落ちた: ${r.out}`).toBe(0);

      // ① 印を持つ場所(ヘッダ)
      const h = t.read('qwasminputcontext.h');
      expect(h, '印を取る口が無い').toContain('bool pkc3TakeDeleteKeySent()');
      expect(h, '印そのものが無い').toContain('bool m_pkc3DeleteKeySent = false;');
      // ⚠ **公開側**に置く(private に落ちると呼べない)── `private:` より前に在ること
      expect(
        h.indexOf('pkc3TakeDeleteKeySent'),
        '取る口が private 側に落ちている',
      ).toBeLessThan(h.indexOf('private:'));

      // ② keydown 側:**渡す直前**に印を立てる(渡した後だと input に間に合わない)
      const win = t.read('qwasmwindow.cpp');
      expect(win, '印を立てていない').toContain('pkc3NoteDeleteKeySent()');
      expect(
        win.indexOf('pkc3NoteDeleteKeySent'),
        '印を立てるのが LO へ渡した後になっている',
      ).toBeLessThan(win.indexOf('if (processKeyForInputContext('));
      // ⚠ keydown のときだけ(keyup で立て直すと input より後になって効かない)
      expect(win, 'keydown に限っていない').toContain('event["type"].as<std::string>() == "keydown"');
      expect(win, 'Delete を見ていない').toContain('pkc3Key == "Backspace" || pkc3Key == "Delete"');

      // ③ input 側:**合成の前**に帰す(後だと 2 回撃ってから帰ることになる)
      const ctx = t.read('qwasminputcontext.cpp');
      const back = ctx.indexOf('deleteContentBackward');
      const fwd = ctx.indexOf('deleteContentForward');
      const firstTake = ctx.indexOf('pkc3TakeDeleteKeySent', back);
      expect(firstTake, 'Backspace 側で印を見ていない').toBeGreaterThan(back);
      expect(firstTake, 'Backspace の枝を越えて Delete 側に入っている').toBeLessThan(fwd);
      expect(
        firstTake,
        '合成した後に帰している(それでは 2 文字消えたままである)',
      ).toBeLessThan(ctx.indexOf('Qt::Key_Backspace'));
      // 🔴 **両側を直す**(片側だけは CLAUDE.md「対称の反対側を必ず疑う」に反する)
      expect(
        ctx.indexOf('pkc3TakeDeleteKeySent', fwd),
        'Delete 側を直していない',
      ).toBeGreaterThan(fwd);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('⚠ 2 度当てても壊れない(冪等)', () => {
    const t = tree();
    try {
      expect(run(t.dir).code).toBe(0);
      const once = t.read('qwasminputcontext.cpp');
      const again = run(t.dir);
      expect(again.code, `2 度目で落ちた: ${again.out}`).toBe(0);
      expect(again.out, '2 度目に SKIP と言っていない').toContain('SKIP');
      expect(t.read('qwasminputcontext.cpp'), '2 度目で字が増えた').toBe(once);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  /**
   * 🔴 **空振り防止の本体** ── 上流が形を変えたら**落ちる**こと。
   * ⚠ 黙って素通りすると、**直っていない一式を「直った」と思って焼く**ことになる
   *   (数時間を捨てたうえ、user の手元では症状が残る)。
   */
  it('🔴 錨が無ければ落ちる(黙って素通りしない)', () => {
    for (const [name, over] of [
      ['ヘッダ', { h: HDR.replace('bool usingTextInput() const { return m_inputMethodAccepted; }', '') }],
      ['keydown 側', { win: WIN.replace('qCDebug(qLcQpaWasmInputContext) << "processKey as KeyEvent";', '') }],
      ['input 側', { ctx: CTX.replace('deleteContentBackward', 'deleteSomethingElse') }],
    ] as const) {
      const t = tree(over);
      try {
        const r = run(t.dir);
        expect(r.code, `${name}: 錨が無いのに通った`).not.toBe(0);
        expect(r.out, `${name}: 何が食い違ったか言っていない`).toContain('錨が');
      } finally {
        rmSync(t.dir, { recursive: true, force: true });
      }
    }
  });
});
