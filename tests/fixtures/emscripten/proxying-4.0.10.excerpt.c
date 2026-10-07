// Emscripten 4.0.10 の system/lib/pthread/proxying.c から、emscripten_proxy_finish と cancel_ctx の周りを
// 字のまま切り出した物(raw.githubusercontent.com/emscripten-core/emscripten/4.0.10/…、元の 321-362 行)。
// ⚠ 手で書き換えない ── emsdk-patch-proxying.py の錨はこの字で当たる。
void emscripten_proxy_finish(em_proxying_ctx* ctx) {
  if (ctx->kind == SYNC) {
    pthread_mutex_lock(&ctx->sync.mutex);
    ctx->sync.state = DONE;
    remove_active_ctx(ctx);
    pthread_mutex_unlock(&ctx->sync.mutex);
    pthread_cond_signal(&ctx->sync.cond);
  } else {
    // Schedule the callback on the caller thread. If the caller thread has
    // already died or dies before the callback is executed, then at least make
    // sure the context is freed.
    remove_active_ctx(ctx);
    if (!do_proxy(ctx->cb.queue,
                  ctx->cb.caller_thread,
                  (task){call_callback_then_free_ctx, free_ctx, ctx})) {
      free_ctx(ctx);
    }
  }
}

static void call_cancel_then_free_ctx(void* arg) {
  em_proxying_ctx* ctx = arg;
  ctx->cb.cancel(ctx->arg);
  free_ctx(ctx);
}

static void cancel_ctx(void* arg) {
  em_proxying_ctx* ctx = arg;
  if (ctx->kind == SYNC) {
    pthread_mutex_lock(&ctx->sync.mutex);
    ctx->sync.state = CANCELED;
    pthread_mutex_unlock(&ctx->sync.mutex);
    pthread_cond_signal(&ctx->sync.cond);
  } else {
    if (ctx->cb.cancel == NULL ||
        !do_proxy(ctx->cb.queue,
                  ctx->cb.caller_thread,
                  (task){call_cancel_then_free_ctx, free_ctx, ctx})) {
      free_ctx(ctx);
    }
  }
}
