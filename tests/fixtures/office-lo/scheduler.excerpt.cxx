/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
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

#include <cassert>
#include <cstdlib>
#include <exception>
#include <typeinfo>

#include <com/sun/star/uno/Exception.hpp>
#include <config_emscripten.h>
#include <config_vclplug.h>
#include <sal/log.hxx>
#include <sal/types.h>
#include <svdata.hxx>
#include <tools/time.hxx>
#include <tools/debug.hxx>
#include <comphelper/diagnose_ex.hxx>
#include <comphelper/configuration.hxx>
#include <vcl/TaskStopwatch.hxx>
#include <vcl/scheduler.hxx>
#include <vcl/idle.hxx>
#include <saltimer.hxx>
#include <salinst.hxx>
#include <comphelper/emscriptenthreading.hxx>
#include <comphelper/profilezone.hxx>
#include <comphelper/lok.hxx>
#include <schedulerimpl.hxx>

// ---- [excerpt] upstream lines 46-386 omitted ----

static ImplSchedulerData* DropSchedulerData(
    ImplSchedulerContext &rSchedCtx, ImplSchedulerData * const pPrevSchedulerData,
    const ImplSchedulerData * const pSchedulerData, const int nTaskPriority)
{
    assert( pSchedulerData );
    if ( pPrevSchedulerData )
        assert( pPrevSchedulerData->mpNext == pSchedulerData );
    else
        assert(rSchedCtx.mpFirstSchedulerData[nTaskPriority] == pSchedulerData);

    ImplSchedulerData * const pSchedulerDataNext = pSchedulerData->mpNext;
    if ( pPrevSchedulerData )
        pPrevSchedulerData->mpNext = pSchedulerDataNext;
    else
        rSchedCtx.mpFirstSchedulerData[nTaskPriority] = pSchedulerDataNext;
    if ( !pSchedulerDataNext )
        rSchedCtx.mpLastSchedulerData[nTaskPriority] = pPrevSchedulerData;
    return pSchedulerDataNext;
}

void Scheduler::CallbackTaskScheduling()
{
    ImplSVData *pSVData = ImplGetSVData();
    ImplSchedulerContext &rSchedCtx = pSVData->maSchedCtx;

#if !(defined __EMSCRIPTEN__ && ENABLE_QT6 && HAVE_EMSCRIPTEN_JSPI && !HAVE_EMSCRIPTEN_PROXY_TO_PTHREAD)
    //TODO: While the special Emscripten Qt6 JSPI/non-PROXY_TO_PTHREAD mode doesn't lock the
    // SolarMutex in QtTimer::timeoutActivated, but only down below when calling pTask->Invoke(),
    // that looks too brittle in general, so treat that special mode specially here.
    DBG_TESTSOLARMUTEX();
#endif

    SchedulerGuard aSchedulerGuard;
    if ( !rSchedCtx.mbActive || InfiniteTimeoutMs == rSchedCtx.mnTimerPeriod )
        return;

    sal_uInt64 nTime = tools::Time::GetSystemTicks();
    // Allow for decimals, so subtract in the compare (needed at least on iOS)
    if ( nTime < rSchedCtx.mnTimerStart + rSchedCtx.mnTimerPeriod -1)
    {
        int nSleep = rSchedCtx.mnTimerStart + rSchedCtx.mnTimerPeriod - nTime;
        UpdateSystemTimer(rSchedCtx, nSleep, true, nTime);
        return;
    }

    ImplSchedulerData* pSchedulerData = nullptr;
    ImplSchedulerData* pPrevSchedulerData = nullptr;
    ImplSchedulerData *pMostUrgent = nullptr;
    ImplSchedulerData *pPrevMostUrgent = nullptr;
    int                nMostUrgentPriority = 0;
    sal_uInt64         nMinPeriod = InfiniteTimeoutMs;
    sal_uInt64         nReadyPeriod = InfiniteTimeoutMs;
    unsigned           nTasks = 0;
    int                nTaskPriority = 0;

    for (; nTaskPriority < PRIO_COUNT; ++nTaskPriority)
    {
        // Related: tdf#152703 Eliminate potential blocking during live resize
        // Only higher priority tasks need to be fired to redraw the window
        // so skip firing potentially long-running tasks, such as the Writer
        // idle layout timer, when a window is in live resize
        if ( nTaskPriority == static_cast<int>(TaskPriority::LOWEST) && ( ImplGetSVData()->mpWinData->mbIsLiveResize || ImplGetSVData()->mpWinData->mbIsWaitingForNativeEvent ) )
            continue;

        pSchedulerData = rSchedCtx.mpFirstSchedulerData[nTaskPriority];
        pPrevSchedulerData = nullptr;
        while (pSchedulerData)
        {
            ++nTasks;
            const Timer *timer = dynamic_cast<Timer*>( pSchedulerData->mpTask );
            if ( timer )
                SAL_INFO( "vcl.schedule", tools::Time::GetSystemTicks() << " "
                        << pSchedulerData << " " << *pSchedulerData << " " << *timer );
            else if ( pSchedulerData->mpTask )
                SAL_INFO( "vcl.schedule", tools::Time::GetSystemTicks() << " "
                        << pSchedulerData << " " << *pSchedulerData
                        << " " << *pSchedulerData->mpTask );
            else
                SAL_INFO( "vcl.schedule", tools::Time::GetSystemTicks() << " "
                        << pSchedulerData << " " << *pSchedulerData << " (to be deleted)" );

            // Should the Task be released from scheduling?
            assert(!pSchedulerData->mbInScheduler);
            if (!pSchedulerData->mpTask || !pSchedulerData->mpTask->IsActive())
            {
                ImplSchedulerData * const pSchedulerDataNext =
                    DropSchedulerData(rSchedCtx, pPrevSchedulerData, pSchedulerData, nTaskPriority);
                if ( pSchedulerData->mpTask )
                    pSchedulerData->mpTask->mpSchedulerData = nullptr;
                delete pSchedulerData;
                pSchedulerData = pSchedulerDataNext;
                continue;
            }

            assert(pSchedulerData->mpTask);
            if (pSchedulerData->mpTask->IsActive())
            {
                nReadyPeriod = pSchedulerData->mpTask->UpdateMinPeriod( nTime );
                if (ImmediateTimeoutMs == nReadyPeriod)
                {
                    if (!pMostUrgent)
                    {
                        pPrevMostUrgent = pPrevSchedulerData;
                        pMostUrgent = pSchedulerData;
                        nMostUrgentPriority = nTaskPriority;
                    }
                    else
                    {
                        nMinPeriod = ImmediateTimeoutMs;
                        break;
                    }
                }
                else if (nMinPeriod > nReadyPeriod)
                    nMinPeriod = nReadyPeriod;
            }

            pPrevSchedulerData = pSchedulerData;
            pSchedulerData = pSchedulerData->mpNext;
        }

        if (ImmediateTimeoutMs == nMinPeriod)
            break;
    }

    if (InfiniteTimeoutMs != nMinPeriod)
        SAL_INFO("vcl.schedule",
                 "Calculated minimum timeout as " << nMinPeriod << " of " << nTasks << " tasks");
    UpdateSystemTimer(rSchedCtx, nMinPeriod, true, nTime);

    if ( !pMostUrgent )
        return;

    SAL_INFO( "vcl.schedule", tools::Time::GetSystemTicks() << " "
              << pMostUrgent << "  invoke-in  " << *pMostUrgent->mpTask );

    Task *pTask = pMostUrgent->mpTask;

    comphelper::ProfileZone aZone( pTask->GetDebugName() );

    assert(!pMostUrgent->mbInScheduler);
    pMostUrgent->mbInScheduler = true;

    // always push the stack, as we don't traverse the whole list to push later
    DropSchedulerData(rSchedCtx, pPrevMostUrgent, pMostUrgent, nMostUrgentPriority);
    pMostUrgent->mpNext = rSchedCtx.mpSchedulerStack;
    rSchedCtx.mpSchedulerStack = pMostUrgent;
    rSchedCtx.mpSchedulerStackTop = pMostUrgent;

    // high priority idle handlers have smaller numerical values for mePriority
    bool bIsLowerPriorityIdle = pMostUrgent->mePriority >= TaskPriority::HIGH_IDLE;

#ifdef MACOSX
    // tdf#165277 On macOS, only delay priorities lower than POST_PAINT
    // macOS bugs tdf#157312 and tdf#163945 were fixed by firing the
    // Skia flush task with TaskPriority::POST_PAINT.
    // The problem is that this method often executes within an
    // NSTimer and NSTimers are always fired while LibreOffice is in
    // -[NSApp nextEventMatchingMask:untilDate:inMode:dequeue:].
    // Since fetching the next native event doesn't handle pending
    // events until *after* all of the pending NSTimers have fired,
    // calling SalInstance::AnyInput() will almost always return true
    // due to the pending events that will be handled immediately
    // after all of the pending NSTimers have fired.
    // The result is that the Skia flush task is frequently delayed
    // and, in cases like tdf#165277, a user's attempts to get
    // LibreOffice to paint the window through key and mouse events
    // leads to an endless delaying of the Skia flush task.
    // After experimenting with both Skia/Metal and Skia/Raster,
    // tdf#165277 requires the Skia flush task to run immediately
    // before the TaskPriority::POST_PAINT tasks. After that, all
    // TaskPriority::POST_PAINT tasks must run so the Skia flush
    // task now uses the TaskPriority::SKIA_FLUSH priority on macOS.
    // One positive side effect of this change is that live resizing
    // on macOS is now much smoother. Even with Skia disabled (which
    // does not paint using a task but does use tasks to handle live
    // resizing), the content resizes much more quickly when a user
    // rapidly changes window's size.
    if (bIsLowerPriorityIdle && pMostUrgent->mePriority <= TaskPriority::POST_PAINT)
        bIsLowerPriorityIdle = false;
#endif

    // invoke the task
    Unlock();

    // Delay invoking tasks with idle priorities as long as there are user input or repaint events
    // in the OS event queue. This will often effectively compress such events and repaint only
    // once at the end, improving performance in cases such as repeated zooming with a complex document.
    bool bDelayInvoking
        = bIsLowerPriorityIdle
          && (rSchedCtx.mnIdlesLockCount > 0
              || Application::AnyInput(VclInputFlags::MOUSE | VclInputFlags::KEYBOARD | VclInputFlags::PAINT));

    /*
    * Current policy is that scheduler tasks aren't allowed to throw an exception.
    * Because otherwise the exception is caught somewhere totally unrelated.
    * TODO Ideally we could capture a proper backtrace and feed this into breakpad,
    *   which is do-able, but requires writing some assembly.
    * See also SalUserEventList::DispatchUserEvents
    */
    try
    {
        if (bDelayInvoking)
            SAL_INFO( "vcl.schedule", tools::Time::GetSystemTicks()
                      << " idle priority task " << pTask->GetDebugName()
                      << " delayed, system events pending" );
        else
        {
            // prepare Scheduler object for deletion after handling
            pTask->SetDeletionFlags();
#if defined __EMSCRIPTEN__ && ENABLE_QT6 && HAVE_EMSCRIPTEN_JSPI && !HAVE_EMSCRIPTEN_PROXY_TO_PTHREAD
            if (pTask->DecideTransferredExecution())
            {
                auto & data = comphelper::emscriptenthreading::getData();
                (void) emscripten_proxy_promise(
                    data.proxyingQueue.queue, data.eventHandlerThread,
                    [](void * p) {
                        auto const pTask = static_cast<Task *>(p);
                        SolarMutexGuard g;
                        pTask->Invoke();
                    },
                    pTask);
            }
            else
            {
                SolarMutexGuard g;
                pTask->Invoke();
            }
#else
            pTask->Invoke();
#endif
        }
    }
    catch (css::uno::Exception&)
    {
        TOOLS_WARN_EXCEPTION("vcl.schedule",
                             "Uncaught exception for task '" << pTask->GetDebugName() << "'");
        std::abort();
    }
    catch (std::exception& e)
    {
        SAL_WARN("vcl.schedule", "Uncaught " << typeid(e).name() << " " << e.what());
        std::abort();
    }
    catch (...)
    {
        SAL_WARN("vcl.schedule", "Uncaught exception during Task::Invoke()!");
        std::abort();
    }
    Lock();

    assert(pMostUrgent->mbInScheduler);
    pMostUrgent->mbInScheduler = false;

    SAL_INFO( "vcl.schedule", tools::Time::GetSystemTicks() << " "
              << pMostUrgent << "  invoke-out" );

    // pop the scheduler stack
    pSchedulerData = rSchedCtx.mpSchedulerStack;
    assert(pSchedulerData == pMostUrgent);
    rSchedCtx.mpSchedulerStack = pSchedulerData->mpNext;

    // coverity[check_after_deref : FALSE] - pMostUrgent->mpTask is initially pMostUrgent->mpTask, but Task::Invoke can clear it
    const bool bTaskAlive = pMostUrgent->mpTask && pMostUrgent->mpTask->IsActive();
    if (!bTaskAlive)
    {
        if (pMostUrgent->mpTask)
            pMostUrgent->mpTask->mpSchedulerData = nullptr;
        delete pMostUrgent;
    }
    else
        AppendSchedulerData(rSchedCtx, pMostUrgent);

    // this just happens for nested calls, which renders all accounting
    // invalid, so we just enforce a rescheduling!
    if (rSchedCtx.mpSchedulerStackTop != pSchedulerData)
    {
        UpdateSystemTimer( rSchedCtx, ImmediateTimeoutMs, true,
                           tools::Time::GetSystemTicks() );
    }
    else if (bTaskAlive)
    {
        pMostUrgent->mnUpdateTime = nTime;
        nReadyPeriod = pMostUrgent->mpTask->UpdateMinPeriod( nTime );
        if ( nMinPeriod > nReadyPeriod )
            nMinPeriod = nReadyPeriod;
        UpdateSystemTimer( rSchedCtx, nMinPeriod, false, nTime );
    }
}

// ---- [excerpt] upstream lines 675-690 omitted ----

void Task::Start(const bool bStartTimer)
{
    ImplSVData *const pSVData = ImplGetSVData();
    ImplSchedulerContext &rSchedCtx = pSVData->maSchedCtx;

    SchedulerGuard aSchedulerGuard;
    if ( !rSchedCtx.mbActive )
        return;

    // is the task scheduled in the correct priority queue?
    // if not we have to get a new data object, as we don't want to traverse
    // the whole list to move the data to the correct list, as the task list
    // is just single linked.
    // Task priority doesn't change that often AFAIK, or we might need to
    // start caching ImplSchedulerData objects.
    if (mpSchedulerData && mpSchedulerData->mePriority != mePriority)
    {
        mpSchedulerData->mpTask = nullptr;
        mpSchedulerData = nullptr;
    }
    mbActive = true;

    if ( !mpSchedulerData )
    {
        // insert Task
        ImplSchedulerData* pSchedulerData = new ImplSchedulerData;
        pSchedulerData->mpTask            = this;
        pSchedulerData->mbInScheduler     = false;
        // mePriority is set in AppendSchedulerData
        mpSchedulerData = pSchedulerData;

        AppendSchedulerData( rSchedCtx, pSchedulerData );
        SAL_INFO( "vcl.schedule", tools::Time::GetSystemTicks()
                  << " " << mpSchedulerData << "  added      " << *this );
    }
    else
        SAL_INFO( "vcl.schedule", tools::Time::GetSystemTicks()
                  << " " << mpSchedulerData << "  restarted  " << *this );

    mpSchedulerData->mnUpdateTime  = tools::Time::GetSystemTicks();

    if (bStartTimer)
        Task::StartTimer(0);
}

// ---- [excerpt] upstream lines 735-769 omitted ----

Task::Task( const char *pDebugName )
    : mpSchedulerData( nullptr )
    , mpDebugName( pDebugName )
    , mePriority( TaskPriority::DEFAULT )
    , mbActive( false )
    , mbStatic( false )
{
    assert(mpDebugName);
}

Task::Task( const Task& rTask )
    : mpSchedulerData( nullptr )
    , mpDebugName( rTask.mpDebugName )
    , mePriority( rTask.mePriority )
    , mbActive( false )
    , mbStatic( false )
{
    assert(mpDebugName);
    if ( rTask.IsActive() )
        Start();
}

Task::~Task()
{
    if ( !IsStatic() )
    {
        SchedulerGuard aSchedulerGuard;
        if ( mpSchedulerData )
            mpSchedulerData->mpTask = nullptr;
    }
    else
        assert(nullptr == mpSchedulerData || comphelper::IsFuzzing() || comphelper::LibreOfficeKit::isActive());
}
