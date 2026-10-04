/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4; fill-column: 100 -*- */
/*
 * This file is part of the LibreOffice project.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * This file incorporates work covered by the following license notice:
 *
 *   Licensed to the Apache Software Foundation (ASF) under one or more
 *   contributor license agreements. See the NOTICE file distributed
 *   with this work for additional information regarding copyright
 *   ownership. The ASF licenses this file to you under the Apache
 *   License, Version 2.0 (the "License"); you may not use this file
 *   except in compliance with the License. You may obtain a copy of
 *   the License at http://www.apache.org/licenses/LICENSE-2.0 .
 */

#include <sal/config.h>
#include <config_emscripten.h>
#include <config_vclplug.h>

// ---- [excerpt] upstream lines 23-74 omitted ----

#include <QtGui/QStyleHints>

// ---- [excerpt] upstream lines 76-449 omitted ----

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

void QtInstance::ProcessEvent(SalUserEvent aEvent)
{
#if defined __EMSCRIPTEN__ && ENABLE_QT6 && HAVE_EMSCRIPTEN_JSPI                                   \
    && !HAVE_EMSCRIPTEN_PROXY_TO_PTHREAD
    SolarMutexReleaser release;
    (void)emscripten_promise_await(
        emscripten_proxy_promise(m_emscriptenThreadingData->proxyingQueue.queue,
                                 m_emscriptenThreadingData->eventHandlerThread,
                                 [](void* p) {
                                     auto& aEvent = *static_cast<SalUserEvent*>(p);
                                     SolarMutexGuard g;
                                     aEvent.m_pFrame->CallCallback(aEvent.m_nEvent, aEvent.m_pData);
                                 },
                                 &aEvent));
#else
    aEvent.m_pFrame->CallCallback(aEvent.m_nEvent, aEvent.m_pData);
#endif
}

// ---- [excerpt] upstream lines 565-767 omitted ----

std::unique_ptr<QApplication> QtInstance::CreateQApplication()
{

// ---- [excerpt] upstream lines 770-818 omitted ----

    std::unique_ptr<QApplication> pQApp
        = std::make_unique<QApplication>(m_nFakeArgc, m_pFakeArgv.get());

    QApplication::setQuitOnLastWindowClosed(false);
    return pQApp;
}

bool QtInstance::DoExecute(int& nExitCode)
{
