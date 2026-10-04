#include <sal/config.h>

#include <QtInstance.hxx>
#include <QtTransferable.hxx>
#include <QtTransferable.moc>

#include <o3tl/string_view.hxx>
#include <sal/log.hxx>
#include <tools/debug.hxx>
#include <vcl/qt/QtUtils.hxx>

#include <QtWidgets/QApplication>

#include <cassert>

static bool lcl_textMimeInfo(std::u16string_view rMimeString, bool& bHaveNoCharset,
                             bool& bHaveUTF16, bool& bHaveUTF8)
{
    sal_Int32 nIndex = 0;
    if (o3tl::getToken(rMimeString, 0, ';', nIndex) == u"text/plain")
    {
        std::u16string_view aToken(o3tl::getToken(rMimeString, 0, ';', nIndex));
        if (aToken == u"charset=utf-16")
            bHaveUTF16 = true;
        else if (aToken == u"charset=utf-8")
            bHaveUTF8 = true;
        else if (aToken.empty())
            bHaveNoCharset = true;
        else // we just handle UTF-16 and UTF-8, everything else is "bytes"
            return false;
        return true;
    }
    return false;
}
QStringList QtMimeData::formats() const
{
    if (!m_aMimeTypeList.isEmpty())
        return m_aMimeTypeList;

    // For the Qt6 Wasm backend, as a hack report only a single format for now: "text/plain" if
    // aFormats contains any "text/plain" entries, or else (randomly) the first entry (if any) of
    // aFormats.  This is for two reasons:  For one,
    // <https://github.com/qt/qtbase/commit/f0be152896471aa392bb1b2b649b66feb31480cc> "wasm: improve
    // clipboard support" has a commented-out "break;" ("Clipboard write is only supported with one
    // ClipboardItem at the moment but somehow this still works?") in the loop in
    // QWasmClipboard::writeToClipboardApi, and multiple formats would make that not work and would
    // indeed cause a NotAllowedError ("Failed to execute 'write' on 'Clipboard': Support for
    // multiple ClipboardItems is not implemented.") at least with Chrome 131.  And for another,
    // <https://github.com/qt/qtbase/commit/f0be152896471aa392bb1b2b649b66feb31480cc> "wasm: improve
    // clipboard support" also has code to "prefer html over text" in
    // QWasmClipboard::writeToClipboardApi, so if we reported both "text/plain" and "text/html",
    // that code would pick "text/html", but the HTML provided by LO apparently always contains a
    // trailing "</p>", so would always add a newline when pasted.

    const css::uno::Sequence<css::datatransfer::DataFlavor> aFormats
        = m_aContents->getTransferDataFlavors();
    QStringList aList;
    bool bHaveUTF16 = false;

    for (const auto& rFlavor : aFormats)
    {
#if !(QT_VERSION >= QT_VERSION_CHECK(6, 0, 0) && defined __EMSCRIPTEN__)
        aList << toQString(rFlavor.MimeType);
#endif
        lcl_textMimeInfo(rFlavor.MimeType, m_bHaveNoCharset, bHaveUTF16, m_bHaveUTF8);
    }

    // we provide a locale encoded and a UTF-8 variant, if missing
    if (m_bHaveNoCharset || bHaveUTF16 || m_bHaveUTF8)
    {
#if QT_VERSION >= QT_VERSION_CHECK(6, 0, 0) && defined __EMSCRIPTEN__
        aList << QStringLiteral("text/plain");
#else
        // if there is a text representation from LO point of view, it'll be UTF-16
        assert(bHaveUTF16);
        if (!m_bHaveUTF8)
            aList << QStringLiteral("text/plain;charset=utf-8");
        if (!m_bHaveNoCharset)
            aList << QStringLiteral("text/plain");
#endif
    }
#if QT_VERSION >= QT_VERSION_CHECK(6, 0, 0) && defined __EMSCRIPTEN__
    else if (aFormats.hasElements())
    {
        aList << toQString(aFormats[0].MimeType);
    }
#endif

    m_aMimeTypeList = aList;
    return m_aMimeTypeList;
}

#if QT_VERSION < QT_VERSION_CHECK(6, 0, 0)
QVariant QtMimeData::retrieveData(const QString& mimeType, QVariant::Type) const
#else
QVariant QtMimeData::retrieveData(const QString& mimeType, QMetaType) const
#endif
{
    if (!hasFormat(mimeType))
        return QVariant();

    css::datatransfer::DataFlavor aFlavor;
    aFlavor.MimeType = toOUString(mimeType);
    aFlavor.DataType = cppu::UnoType<css::uno::Sequence<sal_Int8>>::get();

    bool bWantNoCharset = false, bWantUTF16 = false, bWantUTF8 = false;
    if (lcl_textMimeInfo(aFlavor.MimeType, bWantNoCharset, bWantUTF16, bWantUTF8))
    {
        if ((bWantNoCharset && !m_bHaveNoCharset) || (bWantUTF8 && !m_bHaveUTF8))
        {
            aFlavor.MimeType = "text/plain;charset=utf-16";
            aFlavor.DataType = cppu::UnoType<OUString>::get();
        }
        else if (bWantUTF16)
            aFlavor.DataType = cppu::UnoType<OUString>::get();
    }

    css::uno::Any aValue;

    try
    {
        // tdf#129809 take a reference in case m_aContents is replaced during this call
        css::uno::Reference<css::datatransfer::XTransferable> xCurrentContents(m_aContents);
        aValue = xCurrentContents->getTransferData(aFlavor);
    }
    catch (...)
    {
    }

    QByteArray aByteArray;
    if (aValue.getValueTypeClass() == css::uno::TypeClass_STRING)
    {
        OUString aString;
        aValue >>= aString;

        if (bWantUTF8)
        {
            OString aUTF8String(OUStringToOString(aString, RTL_TEXTENCODING_UTF8));
            aByteArray = QByteArray(aUTF8String.getStr(), aUTF8String.getLength());
        }
        else if (bWantNoCharset)
        {
            OString aLocaleString(OUStringToOString(aString, osl_getThreadTextEncoding()));
            aByteArray = QByteArray(aLocaleString.getStr(), aLocaleString.getLength());
        }
        else if (bWantUTF16)
        {
            aByteArray = QByteArray(reinterpret_cast<const char*>(aString.getStr()),
                                    aString.getLength() * 2);
        }
        else
            return QVariant(toQString(aString));
    }
    else
    {
        css::uno::Sequence<sal_Int8> aData;
        aValue >>= aData;
        aByteArray
            = QByteArray(reinterpret_cast<const char*>(aData.getConstArray()), aData.getLength());
    }
    return QVariant::fromValue(aByteArray);
}

bool QtMimeData::hasFormat(const QString& mimeType) const { return formats().contains(mimeType); }

/* vim:set shiftwidth=4 softtabstop=4 expandtab cinoptions=b1,g0,N-s cinkeys+=0=break: */
