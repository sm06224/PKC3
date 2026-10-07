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

#include <limits>
#include <string_view>

#include <com/sun/star/accessibility/AccessibleRelationType.hpp>
#include <com/sun/star/awt/XWindow.hpp>
#include <com/sun/star/awt/XVclWindowPeer.hpp>
#include <colorpicker.hxx>
#include <o3tl/safeint.hxx>

// ---- [excerpt] upstream lines 30-2182 omitted ----

SalInstanceScrolledWindow::SalInstanceScrolledWindow(VclScrolledWindow* pScrolledWindow,
                                                     SalInstanceBuilder* pBuilder,
                                                     bool bTakeOwnership,
                                                     bool bUserManagedScrolling)
    : SalInstanceContainer(pScrolledWindow, pBuilder, bTakeOwnership)
    , m_xScrolledWindow(pScrolledWindow)
    , m_bUserManagedScrolling(bUserManagedScrolling)
{
    ScrollBar& rVertScrollBar = m_xScrolledWindow->getVertScrollBar();
    m_aOrigVScrollHdl = rVertScrollBar.GetScrollHdl();
    rVertScrollBar.SetScrollHdl(LINK(this, SalInstanceScrolledWindow, VscrollHdl));
    ScrollBar& rHorzScrollBar = m_xScrolledWindow->getHorzScrollBar();
    m_aOrigHScrollHdl = rHorzScrollBar.GetScrollHdl();
    rHorzScrollBar.SetScrollHdl(LINK(this, SalInstanceScrolledWindow, HscrollHdl));
    m_xScrolledWindow->setUserManagedScrolling(m_bUserManagedScrolling);
}

// ---- [excerpt] upstream lines 2199-2390 omitted ----

SalInstanceScrolledWindow::~SalInstanceScrolledWindow()
{
    ScrollBar& rVertScrollBar = m_xScrolledWindow->getVertScrollBar();
    rVertScrollBar.SetScrollHdl(m_aOrigVScrollHdl);
}

IMPL_LINK(SalInstanceScrolledWindow, VscrollHdl, ScrollBar*, pScrollBar, void)
{
    signal_vadjustment_value_changed();
    if (!m_bUserManagedScrolling)
        m_aOrigVScrollHdl.Call(pScrollBar);
}

IMPL_LINK_NOARG(SalInstanceScrolledWindow, HscrollHdl, ScrollBar*, void)
{
    signal_hadjustment_value_changed();
    if (!m_bUserManagedScrolling)
        m_aOrigHScrollHdl.Call(&m_xScrolledWindow->getHorzScrollBar());
}
