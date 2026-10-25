// 上流 LibreOffice(sha d2b3fd7f169b、libreoffice-26-8)`vcl/qt5/QtMenu.cxx` の抜粋(原文のまま。行 30〜44 / 839〜851)。
// `patch-lo-qt-menu-scroll.py` の錨が当たることを見る(build はしない)。

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

// LO SalMenuButtonItem::mnId is sal_uInt16, so we go with -2, as -1 has a special meaning as automatic id
constexpr int CLOSE_BUTTON_ID = -2;
const QString gButtonGroupKey("QtMenu::ButtonGroup");

// …

void QtMenu::connectHelpSignalSlots(QMenu* pMenu, QtMenuItem* pSalMenuItem)
{
    // connect hovered signal of the menu's own action
    QAction* pAction = pMenu->menuAction();
    assert(pAction);
    connect(pAction, &QAction::hovered, this, [pSalMenuItem] { slotMenuHovered(pSalMenuItem); });

    // connect slot to handle Help key (F1)
    connectHelpShortcut(pMenu);

    // enable tooltips, Qt doesn't show them for menu entries by default
    pMenu->setToolTipsVisible(true);
}
