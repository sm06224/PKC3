// 上流 LibreOffice(sha d6226c1a)`vcl/qt5/QtInstance.cxx` の抜粋(原文のまま。`QtInstance::RunInMainThread` と `EmscriptenLightweightRunInMainThread_`、原文の 207〜266 行)。
// `patch-lo-hop-borrow.py`(#1408 (c))の錨が当たることを見る(build はしない)。

// this could be abstracted to be independent of Qt by passing in the
// event-trigger as another function parameter...
// it could also be a template of the return type, then it could return the
// result of func... but then how to handle the result in doAcquire?
void QtInstance::RunInMainThread(std::function<void()> func)
{
    DBG_TESTSOLARMUTEX();
    if (IsMainThread())
    {
        func();
        return;
    }
#if defined __EMSCRIPTEN__ && ENABLE_QT6 && HAVE_EMSCRIPTEN_JSPI                                   \
    && !HAVE_EMSCRIPTEN_PROXY_TO_PTHREAD
    if (pthread_self() == m_emscriptenThreadingData->eventHandlerThread)
    {
        EmscriptenLightweightRunInMainThread(func);
        return;
    }
#endif

    QtYieldMutex* const pMutex(static_cast<QtYieldMutex*>(GetYieldMutex()));
    {
        std::scoped_lock<std::mutex> g(pMutex->m_RunInMainMutex);
        assert(!pMutex->m_Closure);
        pMutex->m_Closure = std::move(func);
        // unblock main thread in case it is blocked on condition
        pMutex->m_isWakeUpMain = true;
        pMutex->m_InMainCondition.notify_all();
    }

    TriggerUserEventProcessing();
    {
        std::unique_lock<std::mutex> g(pMutex->m_RunInMainMutex);
        pMutex->m_ResultCondition.wait(g, [pMutex]() { return pMutex->m_isResultReady; });
        pMutex->m_isResultReady = false;
    }
}

void QtInstance::EmscriptenLightweightRunInMainThread_(std::function<void()> func)
{
#if defined __EMSCRIPTEN__ && ENABLE_QT6 && HAVE_EMSCRIPTEN_JSPI                                   \
    && !HAVE_EMSCRIPTEN_PROXY_TO_PTHREAD
    if (pthread_self() != emscripten_main_runtime_thread_id())
    {
        SolarMutexReleaser release;
        emscripten_sync_run_in_main_runtime_thread(
            EM_FUNC_SIG_RETURN_VALUE_V | EM_FUNC_SIG_WITH_N_PARAMETERS(1)
                | EM_FUNC_SIG_SET_PARAM(0, EM_FUNC_SIG_PARAM_P),
            +[](void* pf) {
                DBG_TESTNOTSOLARMUTEX();
                SolarMutexGuard g;
                (*static_cast<std::function<void()>*>(pf))();
            },
            &func);
        return;
    }
#endif
    func();
}
