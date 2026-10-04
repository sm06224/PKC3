/**
 * `patch-lo-clipboard-png.py`(#121 の直し)と `patch-lo-clip-trace.py`(#121 の計装)の test が
 * **共有する足場**。
 *
 * ⚠ LO の実物は、この箱にも CI の unit にも無い。だから:
 *   - **錨の当たり**は、実物の `QtTransferable.cxx` / `QtClipboard.cxx` から**そのまま抜いた**抜粋
 *     (`tests/fixtures/office-lo/*.excerpt.cxx`)で見る(⚠ 合成した物ではない)
 *   - **型検査と走らせる**のは、Qt / LO の型を写した**模型**(`qt-model.hxx`)の上で行う
 *
 * 🔴 **この足場が言えること**: 当てた後の C++ が、模型の型で通ること / 模型の上で意図どおり動くこと。
 *   **言えないこと**: 本物の Qt / LO の header で通ること(焼かないと分からない)。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const REL_TR = 'vcl/qt5/QtTransferable.cxx';
export const REL_CB = 'vcl/qt5/QtClipboard.cxx';
export const EXCERPT_TR = readFileSync('tests/fixtures/office-lo/QtTransferable.excerpt.cxx', 'utf-8');
export const EXCERPT_CB = readFileSync('tests/fixtures/office-lo/QtClipboard.excerpt.cxx', 'utf-8');
const MODEL = readFileSync('tests/fixtures/office-lo/qt-model.hxx', 'utf-8');

export interface Root {
  dir: string;
  read: (rel: string) => string;
  write: (rel: string, body: string) => void;
  cleanup: () => void;
}

/** LO の root の形(`vcl/qt5/…`)を一時 dir に作る。既定は 2 file とも原文の抜粋。 */
export function makeRoot(files: Record<string, string> = {}): Root {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-clip-'));
  const put = (rel: string, body: string): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body, 'utf-8');
  };
  put(REL_TR, EXCERPT_TR);
  put(REL_CB, EXCERPT_CB);
  for (const [rel, body] of Object.entries(files)) put(rel, body);
  return {
    dir,
    read: (rel) => readFileSync(join(dir, rel), 'utf-8'),
    write: put,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** patch を当てる。`env` に `PKC3_CLIP_TRACE` を渡せる。 */
export function runPatch(
  script: string,
  dir: string,
  env: Record<string, string> = {},
): { code: number; out: string } {
  const r = spawnSync('python3', [script, dir], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    stdio: 'pipe',
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** `// 印` で終わる行(足した行)と、helper の塊を取り除く。 */
export function stripAdded(text: string, mark: string, helperTag?: string): string {
  let t = text;
  if (helperTag !== undefined) {
    const re = new RegExp(`// ${helperTag}-HELPER-BEGIN\\n[\\s\\S]*?// ${helperTag}-HELPER-END\\n\\n`, 'g');
    t = t.replace(re, '');
  }
  return t
    .split('\n')
    .filter((l) => !l.includes(mark))
    .join('\n');
}

/** 模型の include 先を作る(抜粋が `#include` する物を、中身の無い file で埋める)。 */
function incDir(dir: string): string {
  const inc = join(dir, 'inc');
  const put = (rel: string, body: string): void => {
    mkdirSync(dirname(join(inc, rel)), { recursive: true });
    writeFileSync(join(inc, rel), body, 'utf-8');
  };
  put('sal/config.h', MODEL);
  for (const f of [
    'QtInstance.hxx',
    'QtClipboard.hxx',
    'QtTransferable.hxx',
    'QtTransferable.moc',
    'o3tl/string_view.hxx',
    'sal/log.hxx',
    'tools/debug.hxx',
    'vcl/qt/QtUtils.hxx',
    'QtWidgets/QApplication',
    'QtGui/QImage',
  ]) {
    put(f, '');
  }
  // ⚠ 本物の `<emscripten/threading.h>` の代わり(`pthread_self` と同じ型を返す)
  put(
    'emscripten/threading.h',
    '#include <pthread.h>\ninline pthread_t emscripten_main_runtime_thread_id() { return pthread_self(); }\n',
  );
  return inc;
}

export interface Compiled {
  code: number;
  out: string;
}

/**
 * 当てた後の C++ を g++ で通す。`-Wall -Wextra -Werror`(**未使用関数も落とす**)。
 *
 * ⚠ `-fsyntax-only`(構文と型)と `-c`(未使用の関数などの警告は、構文だけでは出ない物がある)の
 *   両方を通す。`emscripten: true` なら `__EMSCRIPTEN__` を立てる(Qt6 の wasm の枝を有効にする)。
 */
export function compile(
  root: Root,
  rel: string,
  opts: { emscripten: boolean; mode: '-fsyntax-only' | '-c' },
): Compiled {
  const inc = incDir(root.dir);
  const args = [
    '-std=c++20',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-include',
    join(inc, 'sal/config.h'),
    '-I',
    inc,
    ...(opts.emscripten ? ['-D__EMSCRIPTEN__=1'] : []),
    opts.mode,
    '-x',
    'c++',
    join(root.dir, rel),
    ...(opts.mode === '-c' ? ['-o', join(root.dir, 'out.o')] : []),
  ];
  const r = spawnSync('g++', args, { encoding: 'utf-8', stdio: 'pipe' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** 当てた後の `rel`(既定は `QtTransferable.cxx`)の後ろへ harness をつなげ、組んで走らせる。stdout / stderr を返す。 */
export function build(
  root: Root,
  harness: string,
  opts: { emscripten: boolean; rel?: string },
): { code: number; out: string; err: string } {
  const inc = incDir(root.dir);
  const src = join(root.dir, 'harness.cxx');
  writeFileSync(src, `${root.read(opts.rel ?? REL_TR)}\n${harness}`, 'utf-8');
  const exe = join(root.dir, 'harness');
  const args = [
    '-std=c++20',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-include',
    join(inc, 'sal/config.h'),
    '-I',
    inc,
    ...(opts.emscripten ? ['-D__EMSCRIPTEN__=1'] : []),
    src,
    '-o',
    exe,
  ];
  try {
    execFileSync('g++', args, { stdio: 'pipe' });
  } catch (e) {
    const err = e as { stderr?: Buffer };
    return { code: -1, out: '', err: `compile 失敗:\n${err.stderr?.toString() ?? ''}` };
  }
  const r = spawnSync(exe, [], { encoding: 'utf-8', cwd: root.dir, stdio: 'pipe' });
  // ⚠ 計装は固定の path(/tmp/pkc3-clip.log)へも書く ── 走らせた後に残さない
  rmSync('/tmp/pkc3-clip.log', { force: true });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

/**
 * harness ── 本物の `QtMimeData` の 2 関数(`formats()` / `retrieveData()`)を、
 * **LO が渡す flavor の並び**で走らせる。
 *
 * 🔑 flavor の並びは `swdtflvr.cxx` の画像の transferable(**SVXB → OBJECTDESCRIPTOR → PNG →
 * GDIMETAFILE → BITMAP**)と同じ。PNG の中身は署名だけ(`\211PNG`)── 模型の `QImage` は
 * 署名が無いと読めない(本物と同じ向き)。
 */
export const HARNESS = String.raw`
#include <iostream>

static const char* const SVXB = "application/x-openoffice-svxb;windows_formatname=\"SVXB (StarView Bitmap/Animation)\"";
static const char* const OBJD = "application/x-openoffice-objectdescriptor-xml;windows_formatname=\"Star Object Descriptor (XML)\"";
static const char* const PNG = "image/png";
static const char* const GDI = "application/x-openoffice-gdimetafile;windows_formatname=\"GDIMetaFile\"";
static const char* const BMP = "image/bmp";

struct Fake : css::datatransfer::XTransferable
{
    std::vector<css::datatransfer::DataFlavor> fl;
    css::uno::Sequence<css::datatransfer::DataFlavor> getTransferDataFlavors() override
    {
        return css::uno::Sequence<css::datatransfer::DataFlavor>(fl);
    }
    css::uno::Any getTransferData(const css::datatransfer::DataFlavor& f) override
    {
        const std::u16string_view m(f.MimeType);
        if (m.rfind(u"image/png", 0) == 0)
        {
            const std::string b("\211PNG-bytes");
            std::vector<sal_Int8> v;
            for (char c : b)
                v.push_back(static_cast<sal_Int8>(c));
            return css::uno::Any(css::uno::Sequence<sal_Int8>(v));
        }
        if (m == u"text/plain;charset=utf-16")
            return css::uno::Any(OUString("hello"));
        throw 1; // 取り出せない型(retrieveData は黙って空を返す)
    }
};

static css::uno::Reference<css::datatransfer::XTransferable> make(std::vector<const char*> mimes)
{
    Fake* f = new Fake;
    for (const char* m : mimes)
        f->fl.push_back({ OUString(m), OUString(), 0 });
    return css::uno::Reference<css::datatransfer::XTransferable>(f);
}

static void list(const char* label, std::vector<const char*> mimes)
{
    QtMimeData md(make(mimes));
    std::printf("%s:", label);
    for (const QString& s : md.formats())
        std::printf(" [%s]", s.str().c_str());
    std::printf("\n");
}

static void get(const char* label, std::vector<const char*> mimes, const char* want)
{
    QtMimeData md(make(mimes));
    const QVariant v = md.pkc3Retrieve(QString(want));
    const char* kind = v.kind() == QVariant::Invalid  ? "invalid"
                       : v.kind() == QVariant::String ? "string"
                       : v.kind() == QVariant::Bytes  ? "bytes"
                                                      : "image";
    long n = v.kind() == QVariant::Bytes   ? v.toByteArray().size()
             : v.kind() == QVariant::Image ? static_cast<long>(v.image().bytes().size())
                                           : 0;
    std::printf("%s: %s %ld\n", label, kind, n);
}

int main()
{
    // ── formats() ──
    list("A", { SVXB, OBJD, PNG, GDI, BMP });        // Writer の画像
    list("B", { SVXB });                              // PNG が無い
    list("C", { SVXB, "image/png;x=y" });             // パラメータ付き
    list("D", { SVXB, OBJD, "image/jpeg" });          // image/png ではない画像
    list("E", { "text/plain;charset=utf-16", PNG });  // 字が在る
    list("F", {});                                    // 空
    list("G", { SVXB, "image/png2" });                // 基本型が違う(前方一致で拾わない)
    list("H", { PNG, SVXB });                         // PNG が先頭
    // ── retrieveData() ──
    get("R1", { SVXB, OBJD, PNG, GDI, BMP }, "application/x-qt-image");
    get("R2", { SVXB, OBJD, PNG, GDI, BMP }, "image/png");
    get("R3", { SVXB }, "application/x-qt-image");
    get("R4", { SVXB, OBJD, PNG, GDI, BMP }, SVXB);
    get("R5", { SVXB, "image/png;x=y" }, "application/x-qt-image");
    get("R6", { "text/plain;charset=utf-16", PNG }, "text/plain");
    return 0;
}
`;

/**
 * `QtClipboard::setContents` を走らせる harness(`rel: REL_CB` で `build` へ渡す)。
 * 🔑 メニュー経由の「コピー」が LO から Qt へ渡る入口 ── 計装の `setContents:enter` が出るかを見る。
 */
export const HARNESS_CB = String.raw`
struct FakeT : css::datatransfer::XTransferable
{
    int n;
    explicit FakeT(int c)
        : n(c)
    {
    }
    css::uno::Sequence<css::datatransfer::DataFlavor> getTransferDataFlavors() override
    {
        return css::uno::Sequence<css::datatransfer::DataFlavor>(
            std::vector<css::datatransfer::DataFlavor>(static_cast<std::size_t>(n)));
    }
    css::uno::Any getTransferData(const css::datatransfer::DataFlavor&) override { return css::uno::Any(); }
};

int main()
{
    QtClipboard c;
    css::uno::Reference<css::datatransfer::clipboard::XClipboardOwner> none;
    c.setContents(css::uno::Reference<css::datatransfer::XTransferable>(new FakeT(5)), none);
    c.setContents(css::uno::Reference<css::datatransfer::XTransferable>(), none);
    return 0;
}
`;
