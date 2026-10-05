// 上流 LibreOffice(sha 0c031979)`vcl/qt5/QtInstance.cxx` の抜粋(原文のまま。CreateSalSystem〜TriggerUserEventProcessing の 450〜545)。
// `patch-lo-uev-trace.py`(#1344 の 5 種)と `patch-lo-idles-trace.py` の錨が当たることを見る(build はしない)。

SalSystem* QtInstance::CreateSalSystem() { return new QtSystem; }

bool QtInstance::ImplYield(bool bWait, bool bHandleAllCurrentEvents)
{
    // Re-acquire the guard for user events when called via Q_EMIT ImplYieldSignal
    SolarMutexGuard aGuard;
    bool wasEvent = DispatchUserEvents(bHandleAllCurrentEvents);
    if (!bHandleAllCurrentEvents && wasEvent)
        return true;

    /**
     * Quoting the Qt docs: [QAbstractEventDispatcher::processEvents] processes
     * pending events that match flags until there are no more events to process.
     */
    SolarMutexReleaser aReleaser;
    QAbstractEventDispatcher* dispatcher = QAbstractEventDispatcher::instance(qApp->thread());
    if (bWait && !wasEvent)
        wasEvent = dispatcher->processEvents(QEventLoop::WaitForMoreEvents);
    else
        wasEvent = dispatcher->processEvents(QEventLoop::AllEvents) || wasEvent;
    return wasEvent;
}

bool QtInstance::DoYield(bool bWait, bool bHandleAllCurrentEvents)
{
    bool bWasEvent = false;
    if (qApp->thread() == QThread::currentThread())
    {
        bWasEvent = ImplYield(bWait, bHandleAllCurrentEvents);
        if (bWasEvent)
            m_aWaitingYieldCond.set();
    }
#if defined __EMSCRIPTEN__ && ENABLE_QT6 && HAVE_EMSCRIPTEN_JSPI                                   \
    && !HAVE_EMSCRIPTEN_PROXY_TO_PTHREAD
    else if (pthread_self() == m_emscriptenThreadingData->eventHandlerThread)
    {
        SolarMutexReleaser release;
        struct Args
        {
            QtInstance* This;
            bool bWait;
            bool bHandleAllCurrentEvents;
            bool& bWasEvent;
        };
        (void)emscripten_promise_await(emscripten_proxy_promise(
            m_emscriptenThreadingData->proxyingQueue.queue, emscripten_main_runtime_thread_id(),
            [](void* p) {
                Args const& args = *static_cast<Args*>(p);
                args.bWasEvent = args.This->DoYield(args.bWait, args.bHandleAllCurrentEvents);
            },
            &o3tl::temporary<Args>({ this, bWait, bHandleAllCurrentEvents, bWasEvent })));
    }
#endif
    else
    {
        {
            SolarMutexReleaser aReleaser;
            bWasEvent = Q_EMIT ImplYieldSignal(false, bHandleAllCurrentEvents);
        }
        if (!bWasEvent && bWait)
        {
            m_aWaitingYieldCond.reset();
            SolarMutexReleaser aReleaser;
            m_aWaitingYieldCond.wait();
            bWasEvent = true;
        }
    }
    return bWasEvent;
}

bool QtInstance::AnyInput(VclInputFlags nType)
{
    bool bResult = false;
    if (nType & VclInputFlags::TIMER)
        bResult |= (m_pTimer && m_pTimer->remainingTime() == 0);
    if (nType & VclInputFlags::OTHER)
        bResult |= !m_bSleeping;
    return bResult;
}

void QtInstance::AddToRecentDocumentList(const OUString&, const OUString&, const OUString&) {}

#ifndef __EMSCRIPTEN__
OpenGLContext* QtInstance::CreateOpenGLContext() { return new QtOpenGLContext; }
#endif

bool QtInstance::IsMainThread() const
{
    return !qApp || (qApp->thread() == QThread::currentThread());
}

void QtInstance::TriggerUserEventProcessing()
{
    QAbstractEventDispatcher* dispatcher = QAbstractEventDispatcher::instance(qApp->thread());
    dispatcher->wakeUp();
}
