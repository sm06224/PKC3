// 上流 LibreOffice(sha 0c031979)`vcl/source/app/salusereventlist.cxx` の抜粋(原文のまま。include の頭 20〜33 /
// ctor 35〜39 / DispatchUserEvents 59〜136)。`patch-lo-uev-trace.py` と `patch-lo-idles-trace.py` の錨が当たることを見る(build はしない)。

#include <salusereventlist.hxx>
#include <salwtype.hxx>

#include <algorithm>
#include <cstdlib>
#include <exception>
#include <typeinfo>

#include <com/sun/star/uno/Exception.hpp>
#include <tools/debug.hxx>
#include <comphelper/diagnose_ex.hxx>
#include <sal/log.hxx>
#include <sal/types.h>
#include <svdata.hxx>

SalUserEventList::SalUserEventList()
    : m_bAllUserEventProcessedSignaled( true )
    , m_aProcessingThread(0)
{
}


bool SalUserEventList::DispatchUserEvents( bool bHandleAllCurrentEvents )
{
    bool bWasEvent = false;
    oslThreadIdentifier aCurId = osl::Thread::getCurrentIdentifier();

    DBG_TESTSOLARMUTEX();
    std::unique_lock aResettableListGuard(m_aUserEventsMutex);

    if (!m_aUserEvents.empty())
    {
        if (bHandleAllCurrentEvents)
        {
            if (m_aProcessingUserEvents.empty())
                m_aProcessingUserEvents.swap(m_aUserEvents);
            else
                m_aProcessingUserEvents.splice(m_aProcessingUserEvents.end(), m_aUserEvents);
        }
        else if (m_aProcessingUserEvents.empty())
        {
            m_aProcessingUserEvents.push_back( m_aUserEvents.front() );
            m_aUserEvents.pop_front();
        }
    }

    if (HasUserEvents_NoLock())
    {
        bWasEvent = true;
        m_aProcessingThread = aCurId;

        SalUserEvent aEvent( nullptr, nullptr, SalEvent::NONE );
        do {
            if (m_aProcessingUserEvents.empty() || aCurId != m_aProcessingThread)
                break;
            aEvent = m_aProcessingUserEvents.front();
            m_aProcessingUserEvents.pop_front();

            // remember to reset the guard before break or continue the loop
            aResettableListGuard.unlock();

            if ( !isFrameAlive( aEvent.m_pFrame ) )
            {
                if ( aEvent.m_nEvent == SalEvent::UserEvent )
                    delete static_cast< ImplSVEvent* >( aEvent.m_pData );
                aResettableListGuard.lock();
                continue;
            }

            /*
            * Current policy is that scheduler tasks aren't allowed to throw an exception.
            * Because otherwise the exception is caught somewhere totally unrelated.
            * TODO Ideally we could capture a proper backtrace and feed this into breakpad,
            *   which is do-able, but requires writing some assembly.
            * See also Scheduler::CallbackTaskScheduling
            */
#ifdef IOS
            ProcessEvent( aEvent );
#else
            // the noexcept here means that (a) we abort and (b) debuggers will
            // likely trigger at the throw site instead of here, making the debugging
            // experience better when something goes wrong.
            auto process = [&aEvent, this] () noexcept { ProcessEvent(aEvent); };
            process();
#endif
            aResettableListGuard.lock();
            if (!bHandleAllCurrentEvents)
                break;
        }
        while( true );
    }

    if ( !m_bAllUserEventProcessedSignaled && !HasUserEvents_NoLock() )
    {
        m_bAllUserEventProcessedSignaled = true;
        TriggerAllUserEventsProcessed();
    }

    return bWasEvent;
}
