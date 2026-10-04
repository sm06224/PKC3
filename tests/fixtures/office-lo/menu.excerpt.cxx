// 上流 LibreOffice(sha 0c031979)`vcl/source/window/menu.cxx` の抜粋(原文のまま。ctor 150〜166 / ImplSelect 310〜329 /
// ImplCallSelect 2139〜2143 / ~PopupMenu 2727〜2730 / ImplFlushPendingSelect 2826〜2837 / Run 3000〜3010)。
// `patch-lo-menu-trace.py` の錨が当たることを見る(build はしない)。

Menu::Menu()
    : mpFirstDel(nullptr),
      pItemList(new MenuItemList),
      pStartedFrom(nullptr),
      m_pWindow(nullptr),
      nTitleHeight(0),
      nEventId(nullptr),
      mnHighlightedItemPos(ITEMPOS_INVALID),
      nMenuFlags(MenuFlags::NONE),
      nSelectedId(0),
      nImgOrChkPos(0),
      nTextPos(0),
      bCanceled(false),
      bInCallback(false),
      bKilled(false)
{
}

void Menu::ImplSelect()
{
    MenuItemData* pData = GetItemList()->GetData( nSelectedId );
    if ( pData && (pData->nBits & MenuItemBits::AUTOCHECK) )
    {
        bool bChecked = IsItemChecked( nSelectedId );
        if ( pData->nBits & MenuItemBits::RADIOCHECK )
        {
            if ( !bChecked )
                CheckItem( nSelectedId );
        }
        else
            CheckItem( nSelectedId, !bChecked );
    }

    // call select
    ImplSVData* pSVData = ImplGetSVData();
    pSVData->maAppData.mpActivePopupMenu = nullptr;        // if new execute in select()
    nEventId = Application::PostUserEvent( LINK( this, Menu, ImplCallSelect ) );
}

IMPL_LINK_NOARG(Menu, ImplCallSelect, void*, void)
{
    nEventId = nullptr;
    Select();
}

PopupMenu::~PopupMenu()
{
    disposeOnce();
}

void PopupMenu::ImplFlushPendingSelect()
{
    // is there still Select?
    Menu* pSelect = ImplFindSelectMenu();
    if (pSelect)
    {
        // Select should be called prior to leaving execute in a popup menu!
        Application::RemoveUserEvent( pSelect->nEventId );
        pSelect->nEventId = nullptr;
        pSelect->Select();
    }
}

bool PopupMenu::Run(const VclPtr<MenuFloatingWindow>& pWin, const bool bRealExecute, const bool bPreSelectFirst,
                    const FloatWinPopupFlags nPopupModeFlags, Menu* pSFrom, const tools::Rectangle& rRect)
{
    SalMenu* pMenu = ImplGetSalMenu();
    if (pMenu && bRealExecute && pMenu->ShowNativePopupMenu(pWin, rRect, nPopupModeFlags))
        return true;

    pWin->StartPopupMode(rRect, nPopupModeFlags);
    if (pSFrom)
    {
        sal_uInt16 aPos;
