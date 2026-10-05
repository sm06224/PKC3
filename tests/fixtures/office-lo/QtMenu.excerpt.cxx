// 上流 LibreOffice(sha 0c031979)`vcl/qt5/QtMenu.cxx` の抜粋(原文のまま。行 10〜40 / 685〜702 / 932〜949)。
// `patch-lo-menu-trace.py` / `patch-lo-uev-trace.py` / `patch-lo-popup-wake.py` の錨が当たることを見る(build はしない)。
// 行 10〜40 は #1344 で足した(popup-wake の include の錨 `#include <sal/config.h>` が file の頭に在る)。
#include <sal/config.h>

#include <QtCustomStyle.hxx>
#include <QtFrame.hxx>
#include <QtInstance.hxx>
#include <QtMainWindow.hxx>
#include <QtMenu.hxx>
#include <QtMenu.moc>
#include <QtTools.hxx>
#include <bitmaps.hlst>
#include <strings.hrc>
#include <window.h>

#include <o3tl/safeint.hxx>
#include <vcl/qt/QtUtils.hxx>
#include <vcl/svapp.hxx>
#include <vcl/themecolors.hxx>
#include <vcl/toolkit/floatwin.hxx>

#if QT_VERSION >= QT_VERSION_CHECK(6, 0, 0)
#include <QtGui/QActionGroup>
#include <QtGui/QShortcut>
#else
#include <QtWidgets/QActionGroup>
#include <QtWidgets/QShortcut>
#endif
#include <QtWidgets/QButtonGroup>
#include <QtWidgets/QHBoxLayout>
#include <QtWidgets/QMenuBar>
#include <QtWidgets/QPushButton>
#include <QtWidgets/QStyle>

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
