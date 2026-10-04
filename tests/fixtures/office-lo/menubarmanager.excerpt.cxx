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

#include <uielement/menubarmanager.hxx>
#include <uielement/styletoolbarcontroller.hxx>
#include <menuconfiguration.hxx>
#include <addonmenu.hxx>
#include <framework/addonsoptions.hxx>
#include <classes/fwkresid.hxx>
#include <strings.hrc>

#include <com/sun/star/frame/XDispatch.hpp>
#include <com/sun/star/lang/IndexOutOfBoundsException.hpp>
#include <com/sun/star/lang/DisposedException.hpp>
#include <com/sun/star/uno/XComponentContext.hpp>
#include <com/sun/star/uno/XCurrentContext.hpp>
#include <com/sun/star/frame/XPopupMenuController.hpp>
#include <com/sun/star/frame/thePopupMenuControllerFactory.hpp>

// ---- [excerpt] upstream lines 35-778 omitted ----

namespace
{
struct MenuExecData
{
    URL aTargetURL;
    std::vector<beans::PropertyValue> aArgs;
    Reference<XDispatch> xDispatch;
};

void AsyncMenuExecute(void* /*instance*/, void* data)
{
    std::unique_ptr<MenuExecData> pData(static_cast<MenuExecData*>(data));
    {
        SolarMutexReleaser aReleaser;
        pData->xDispatch->dispatch(pData->aTargetURL,
                                   comphelper::containerToSequence(pData->aArgs));
    }
}
}

IMPL_LINK( MenuBarManager, Select, Menu *, pMenu, bool )
{
    auto pData = std::make_unique<MenuExecData>();

    {
        SolarMutexGuard g;

        sal_uInt16 nCurItemId = pMenu->GetCurItemId();
        sal_uInt16 nCurPos    = pMenu->GetItemPos( nCurItemId );
        if ( pMenu == m_pVCLMenu &&
             pMenu->GetItemType( nCurPos ) != MenuItemType::SEPARATOR )
        {
            MenuItemHandler* pMenuItemHandler = GetMenuItemHandler( nCurItemId );
            if ( pMenuItemHandler && pMenuItemHandler->xMenuItemDispatch.is() )
            {
                pData->aTargetURL.Complete = pMenuItemHandler->aMenuItemURL;
                m_xURLTransformer->parseStrict( pData->aTargetURL );

                if ( pMenu->GetUserValue( nCurItemId ) )
                {
                    // addon menu item selected
                    pData->aArgs.push_back(
                        comphelper::makePropertyValue(u"Referer"_ustr, u"private:user"_ustr));
                }

                // pass along if SHIFT/CTRL/ALT/CMD keys are pressed down
                const VclPtr<vcl::Window> pWindow
                    = VCLUnoHelper::GetWindow(m_xFrame->getContainerWindow());
                const sal_Int16 nKeys
                    = pWindow ? pWindow->GetPointerState().mnState & KEY_MODIFIERS_MASK : 0;
                if (nKeys)
                    pData->aArgs.push_back(comphelper::makePropertyValue(u"KeyModifier"_ustr, nKeys));

                pData->xDispatch = pMenuItemHandler->xMenuItemDispatch;
            }
        }
    }

    if (pData->xDispatch.is())
    {
        Application::PostUserEvent(LINK_NONMEMBER(nullptr, AsyncMenuExecute), pData.release());
    }

    if ( !m_bHasMenuBar )
        // Standalone (non-native) popup menu doesn't fire deactivate event
        // in this case, so we have to reset the active flag here.
        m_bActive = false;

    return true;
}
