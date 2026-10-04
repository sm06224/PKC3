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

#include <o3tl/safeint.hxx>
#include <tools/debug.hxx>
#include <tools/time.hxx>
#include <sal/log.hxx>

static bool ImplHandleExtTextInput( vcl::Window* pWindow,
                                    const OUString& rText,
                                    const ExtTextInputAttr* pTextAttr,
                                    sal_Int32 nCursorPos, sal_uInt16 nCursorFlags )
{
    ImplSVData* pSVData = ImplGetSVData();
    vcl::Window*     pChild = nullptr;

    int nTries = 200;
    while( nTries-- )
    {
        pChild = pSVData->mpWinData->mpExtTextInputWin;
        if ( !pChild )
        {
            pChild = ImplGetKeyInputWindow( pWindow );
            if ( !pChild )
                return false;
        }
        if( !pChild->ImplGetWindowImpl()->mpFrameData->mnFocusId )
            break;

        if (comphelper::LibreOfficeKit::isActive())
        {
            SAL_WARN("vcl", "Failed to get ext text input context");
            break;
        }
        Application::Yield();
    }

    // If it is the first ExtTextInput call, we inform the information
    // and allocate the data, which we must store in this mode
    ImplWinData* pWinData = pChild->ImplGetWinData();
    if ( !pChild->ImplGetWindowImpl()->mbExtTextInput )
    {
        pChild->ImplGetWindowImpl()->mbExtTextInput = true;
        pWinData->mpExtOldText = OUString();
        pWinData->mpExtOldAttrAry.reset();
        pSVData->mpWinData->mpExtTextInputWin = pChild;
        ImplCallCommand( pChild, CommandEventId::StartExtTextInput );
    }

    // be aware of being recursively called in StartExtTextInput
    if ( !pChild->ImplGetWindowImpl()->mbExtTextInput )
        return false;

    // Test for changes
    bool bOnlyCursor = false;
    sal_Int32 nMinLen = std::min( pWinData->mpExtOldText->getLength(), rText.getLength() );
    sal_Int32 nDeltaStart = 0;
    while ( nDeltaStart < nMinLen )
    {
        if ( (*pWinData->mpExtOldText)[nDeltaStart] != rText[nDeltaStart] )
            break;
        nDeltaStart++;
    }
    if ( pWinData->mpExtOldAttrAry || pTextAttr )
    {
        if ( !pWinData->mpExtOldAttrAry || !pTextAttr )
            nDeltaStart = 0;
        else
        {
            sal_Int32 i = 0;
            while ( i < nDeltaStart )
            {
                if ( pWinData->mpExtOldAttrAry[i] != pTextAttr[i] )
                {
                    nDeltaStart = i;
                    break;
                }
                i++;
            }
        }
    }
    if ( (nDeltaStart >= nMinLen) &&
         (pWinData->mpExtOldText->getLength() == rText.getLength()) )
        bOnlyCursor = true;

    // Call Event and store the information
    CommandExtTextInputData aData( rText, pTextAttr,
                                   nCursorPos, nCursorFlags,
                                   bOnlyCursor );
    *pWinData->mpExtOldText = rText;
    pWinData->mpExtOldAttrAry.reset();
    if ( pTextAttr )
    {
        pWinData->mpExtOldAttrAry.reset( new ExtTextInputAttr[rText.getLength()] );
        std::copy_n(pTextAttr, rText.getLength(), pWinData->mpExtOldAttrAry.get());
    }
    return !ImplCallCommand( pChild, CommandEventId::ExtTextInput, &aData );
}

static void ImplHandleUserEvent( ImplSVEvent* pSVEvent )
{
    if ( pSVEvent )
    {
        if ( pSVEvent->mbCall )
        {
            pSVEvent->maLink.Call( pSVEvent->mpData );
        }

        delete pSVEvent;
    }
}

