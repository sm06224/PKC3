void QtClipboard::setContents(
    const css::uno::Reference<css::datatransfer::XTransferable>& xTrans,
    const css::uno::Reference<css::datatransfer::clipboard::XClipboardOwner>& xClipboardOwner)
{
    // it's actually possible to get a non-empty xTrans and an empty xClipboardOwner!
    osl::ClearableMutexGuard aGuard(m_aMutex);

    css::uno::Reference<css::datatransfer::clipboard::XClipboardOwner> xOldOwner(m_aOwner);
    css::uno::Reference<css::datatransfer::XTransferable> xOldContents(m_aContents);
    m_aContents = xTrans;
    m_aOwner = xClipboardOwner;

    m_bDoClear = !m_aContents.is();
    if (!m_bDoClear)
    {
        m_bOwnClipboardChange = true;
        QApplication::clipboard()->setMimeData(new QtMimeData(m_aContents), m_eClipboardMode);
        m_bOwnClipboardChange = false;
    }
    else
    {
        assert(!m_aOwner.is());
        Q_EMIT clearClipboard();
    }

    aGuard.clear();
// (抜粋の末尾。以降は原文に在るが、型検査に要らない。閉じの `}` だけ足してある)
}
