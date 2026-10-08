// Emscripten 4.0.10 の system/include/emscripten/threading_legacy.h から、EM_FUNC_SIGNATURE と
// emscripten_sync_run_in_main_runtime_thread(_)の宣言と macro を字のまま切り出した物
// (raw.githubusercontent.com/emscripten-core/emscripten/4.0.10/…、元の 28 行と 148-157 行と 178-180 行)。
// ⚠ 手で書き換えない ── tests/office-hop-borrow-patch.test.ts の g++ harness がこの字を取り込む。
//    emsdk の版は .github/workflows/office-wasm-build.yml の入力 `emsdk` の既定('4.0.10')と並べる(上げたらここも取り直す)。
//    要点は最後の #define: これは関数ではなく**可変長 macro**で、引数は `( )` でしか守られず `{ }` では守られない
//    (lambda の中の最上位カンマで引数が割れる)。
#define EM_FUNC_SIGNATURE unsigned int

// Runs the given function synchronously on the main Emscripten runtime thread.
// If this thread is the main thread, the operation is immediately performed,
// and the result is returned.
// If the current thread is not the main Emscripten runtime thread (but a
// pthread), the function
// will be proxied to be called by the main thread.
//  - Calling emscripten_sync_* functions requires that the application was
//    compiled with pthreads support enabled (-pthread) and that the
//    browser supports SharedArrayBuffer specification.
int emscripten_sync_run_in_main_runtime_thread_(EM_FUNC_SIGNATURE sig, void *func_ptr __attribute__((nonnull)), ...);

// Since we can't validate the function pointer type, allow implicit casting of
// functions to void* without complaining.
#define emscripten_sync_run_in_main_runtime_thread(sig, func_ptr, ...) emscripten_sync_run_in_main_runtime_thread_((sig), (void*)(func_ptr),##__VA_ARGS__)
