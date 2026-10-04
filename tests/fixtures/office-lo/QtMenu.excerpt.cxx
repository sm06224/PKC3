// 上流 LibreOffice(sha 0c031979)`vcl/qt5/QtMenu.cxx` の抜粋(原文のまま。行 685〜702 / 932〜949)。
// `patch-lo-menu-trace.py` の錨が当たることを見る(build はしない)。

void QtMenu::slotMenuTriggered(QtMenuItem* pQItem)
{
    if (!pQItem)
        return;

    QtMenu* pSalMenu = pQItem->mpParentMenu;
    QtMenu* pTopLevel = pSalMenu->GetTopLevel();

    Menu* pMenu = pSalMenu->GetMenu();
    auto mnId = pQItem->mnId;

    // HACK to allow HandleMenuCommandEvent to "not-set" the checked button
    // LO expects a signal before an item state change, so reset the check item
    if (pQItem->mpAction->isCheckable()
        && (!pQItem->mpActionGroup || pQItem->mpActionGroup->actions().size() <= 1))
        pQItem->mpAction->setChecked(!pQItem->mpAction->isChecked());
    pTopLevel->GetMenu()->HandleMenuCommandEvent(pMenu, mnId);
}

bool QtMenu::ShowNativePopupMenu(FloatingWindow* pWin, const tools::Rectangle& rRect,
                                 FloatWinPopupFlags nFlags)
{
    assert(mpQMenu);
    DoFullMenuUpdate(mpVCLMenu);
    mpQMenu->setTearOffEnabled(bool(nFlags & FloatWinPopupFlags::AllowTearOff));

    const VclPtr<vcl::Window> xParent = pWin->ImplGetWindowImpl()->mpRealParent;
    AbsoluteScreenPixelRectangle aFloatRect = FloatingWindow::ImplConvertToAbsPos(xParent, rRect);

    QtFrame* pFrame = static_cast<QtFrame*>(pWin->ImplGetFrame());
    assert(pFrame);

    const QRect aRect = toQRect(aFloatRect, 1 / pFrame->devicePixelRatioF());
    mpQMenu->exec(aRect.bottomLeft());

    return true;
}
