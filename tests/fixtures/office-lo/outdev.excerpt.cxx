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

#include <sal/log.hxx>
#include <comphelper/processfactory.hxx>
#include <tools/debug.hxx>
#include <tools/mapunit.hxx>

#include <vcl/graph.hxx>
#include <tools/lazydelete.hxx>
#include <vcl/metaact.hxx>
#include <vcl/toolkit/unowrap.hxx>
#include <vcl/rendercontext/AntialiasingFlags.hxx>
#include <vcl/rendercontext/DrawModeFlags.hxx>
#include <vcl/svapp.hxx>
#include <vcl/sysdata.hxx>
#include <vcl/virdev.hxx>

#include <CoordinateMapper.hxx>
#include <ImplOutDevData.hxx>
#include <font/PhysicalFontFaceCollection.hxx>
#include <salgdi.hxx>
#include <window.h>

#include <com/sun/star/awt/DeviceCapability.hpp>
#include <com/sun/star/awt/DeviceInfo.hpp>
#include <com/sun/star/awt/XWindow.hpp>
#include <com/sun/star/rendering/CanvasFactory.hpp>
#include <com/sun/star/rendering/XSpriteCanvas.hpp>

#ifdef DISABLE_DYNLOADING
// Linking all needed LO code into one .so/executable, these already
// exist in the tools library, so put them in the anonymous namespace
// here to avoid clash...
namespace {
#endif
#ifdef DISABLE_DYNLOADING
}
#endif

using namespace ::com::sun::star::uno;
// [excerpt: lines 60-241 omitted]

SystemGraphicsData OutputDevice::GetSystemGfxData() const
{
    if (!mpGraphics && !AcquireGraphics())
        return SystemGraphicsData();
    assert(mpGraphics);

#if USE_HEADLESS_CODE
    if (OUTDEV_WINDOW == GetOutDevType())
        mpGraphics->ApplyFullDamage();
#endif

    return mpGraphics->GetGraphicsData();
}
