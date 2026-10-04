// 上流 LibreOffice(sha 0c031979)`vcl/source/app/svapp.cxx` の抜粋(原文のまま。include の頭 20〜26 / PostUserEvent 1064〜1086)。
// `patch-lo-uev-trace.py` の錨が当たることを見る(build はしない)。

#include <config_features.h>
#include <config_version.h>

#include <i18nlangtag/languagetag.hxx>
#include <osl/diagnose.h>
#include <osl/file.hxx>
#include <osl/thread.hxx>

ImplSVEvent * Application::PostUserEvent( const Link<void*,void>& rLink, void* pCaller,
                                          bool bReferenceLink )
{
    vcl::Window* pDefWindow = ImplGetDefaultWindow();
    if ( pDefWindow == nullptr )
        return nullptr;

    std::unique_ptr<ImplSVEvent> pSVEvent(new ImplSVEvent);
    pSVEvent->mpData    = pCaller;
    pSVEvent->maLink    = rLink;
    pSVEvent->mpWindow  = nullptr;
    pSVEvent->mbCall    = true;
    if (bReferenceLink)
    {
        SolarMutexGuard aGuard;
        pSVEvent->mpInstanceRef = static_cast<vcl::Window *>(rLink.GetInstance());
    }

    auto pTmpEvent = pSVEvent.get();
    if (!pDefWindow->ImplGetFrame()->PostEvent( std::move(pSVEvent) ))
        return nullptr;
    return pTmpEvent;
}
