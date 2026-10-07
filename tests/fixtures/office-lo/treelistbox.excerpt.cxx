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

/*
    TODO:
        - delete anchor in SelectionEngine when selecting manually
        - SelectAll( false ) => only repaint the deselected entries
*/

#include <accessibility/accessiblelistbox.hxx>

#include <vcl/toolkit/treelistbox.hxx>
#include <com/sun/star/accessibility/AccessibleStateType.hpp>
#include <vcl/help.hxx>
#include <vcl/salnativewidgets.hxx>
#include <vcl/svapp.hxx>
#include <vcl/builder.hxx>
#include <vcl/toolkit/edit.hxx>
#include <vcl/settings.hxx>
#include <vcl/commandevent.hxx>
#include <vcl/decoview.hxx>
#include <vcl/uitest/uiobject.hxx>
#include <sot/formats.hxx>
#include <comphelper/string.hxx>
#include <sal/log.hxx>
#include <tools/debug.hxx>

#include <vcl/toolkit/svlbitm.hxx>
#include <vcl/toolkit/treelistentry.hxx>
#include <vcl/toolkit/viewdataentry.hxx>

#include <SvLBoxButton.hxx>
#include <accel.hxx>
#include <svimpbox.hxx>
#include <window.h>

#include <set>
#include <string.h>
#include <vector>


// ---- [excerpt] upstream lines 57-830 omitted ----

const SvViewDataEntry* SvTreeListBox::GetViewData(const SvTreeListEntry* pEntry) const
{
    SvDataTable::const_iterator itr = m_DataTable.find(const_cast<SvTreeListEntry*>(pEntry));
    assert(itr != m_DataTable.end() && "Entry not in model or wrong view");
    if (itr == m_DataTable.end())
        return nullptr;
    return &itr->second;
}

// ---- [excerpt] upstream lines 839-3352 omitted ----

tools::Long SvTreeListBox::getPreferredDimensions(std::vector<tools::Long> &rWidths) const
{
    tools::Long nHeight = 0;
    rWidths.clear();
    SvTreeListEntry* pEntry = First();
    while (pEntry)
    {
        sal_uInt16 nCount = pEntry->ItemCount();
        sal_uInt16 nCurPos = 0;
        if (nCount > rWidths.size())
            rWidths.resize(nCount);
        while (nCurPos < nCount)
        {
            SvLBoxItem& rItem = pEntry->GetItem( nCurPos );
            auto nWidth = rItem.GetWidth(*this, pEntry);
            if (nWidth)
            {
                nWidth += SV_TAB_BORDER * 2;
                if (nWidth > rWidths[nCurPos])
                   rWidths[nCurPos] = nWidth;
            }
            ++nCurPos;
        }
        pEntry = Next( pEntry );
        nHeight += GetEntryHeight();
    }
    return nHeight;
}

Size SvTreeListBox::GetOptimalSize() const
{
    std::vector<tools::Long> aWidths;
    Size aRet(0, getPreferredDimensions(aWidths));
    for (tools::Long aWidth : aWidths)
        aRet.AdjustWidth(aWidth );

    sal_Int32 nLeftBorder(0), nTopBorder(0), nRightBorder(0), nBottomBorder(0);
    GetBorder(nLeftBorder, nTopBorder, nRightBorder, nBottomBorder);
    aRet.AdjustWidth(nLeftBorder + nRightBorder);
    aRet.AdjustHeight(nTopBorder + nBottomBorder);

    tools::Long nMinWidth = m_nMinWidthInChars * approximate_char_width();
    aRet.setWidth( std::max(aRet.Width(), nMinWidth) );

    if (GetStyle() & WB_VSCROLL)
        aRet.AdjustWidth(GetSettings().GetStyleSettings().GetScrollBarSize());

    return aRet;
}
