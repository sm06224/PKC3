// 模型(足場)── LO / Qt の型のうち、`vcl/qt5/QtTransferable.cxx` と `QtClipboard.cxx` の
// 抜粋が触る形だけを写した物。⚠ **型検査と走らせるための足場であって、本物ではない**
// (本物の Qt / LO の header は、この箱に無い)。
//
// 🔑 振る舞いは本物と同じ向きにしてある:
//   - `o3tl::getToken` は本物と同じく、区切りで切って index を進める(最後は -1)
//   - `QMimeData` の既定の `formats()` は無い(`QtMimeData` が必ず上書きする)
// ⚠ 本物と違う所:文字は ASCII しか持たない / `QString` は std::string の薄い包み。
//
// この file は test が `sal/config.h` として include 先へ写す(抜粋の先頭が
// `#include <sal/config.h>` なので、そこで読み込まれる)。
#pragma once

#include <cassert>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

#define QT_VERSION_CHECK(a, b, c) (((a) << 16) | ((b) << 8) | (c))
#ifndef QT_VERSION
#define QT_VERSION QT_VERSION_CHECK(6, 9, 0)
#endif
#define Q_EMIT
#define QStringLiteral(x) QString(x)

typedef int sal_Int32;
typedef unsigned int sal_uInt32;
typedef signed char sal_Int8;
typedef char16_t sal_Unicode;

// ── OUString / OString ─────────────────────────────────────────────
class OString
{
    std::string m_s;

public:
    explicit OString(std::string s)
        : m_s(std::move(s))
    {
    }
    const char* getStr() const { return m_s.c_str(); }
    sal_Int32 getLength() const { return static_cast<sal_Int32>(m_s.size()); }
};

class OUString
{
    std::u16string m_s;

public:
    OUString() = default;
    OUString(const char* p)
    {
        for (; *p; ++p)
            m_s.push_back(static_cast<char16_t>(static_cast<unsigned char>(*p)));
    }
    OUString(const char16_t* p)
        : m_s(p)
    {
    }
    operator std::u16string_view() const { return m_s; }
    OString toUtf8() const
    {
        std::string o;
        for (char16_t c : m_s)
            o.push_back(c < 0x80 ? static_cast<char>(c) : '?');
        return OString(o);
    }
    const sal_Unicode* getStr() const { return m_s.c_str(); }
    sal_Int32 getLength() const { return static_cast<sal_Int32>(m_s.size()); }
    bool operator==(const OUString& r) const { return m_s == r.m_s; }
};

const int RTL_TEXTENCODING_UTF8 = 1;
inline int osl_getThreadTextEncoding() { return 2; }
inline OString OUStringToOString(const OUString& r, int) { return r.toUtf8(); }

namespace o3tl
{
// 本物と同じ向き ── nToken は 0 しか使わない。区切りで切り、index を進める(最後は -1)。
inline std::u16string_view getToken(std::u16string_view s, sal_Int32, sal_Unicode c, sal_Int32& idx)
{
    if (idx < 0)
        return {};
    const std::size_t e = s.find(c, static_cast<std::size_t>(idx));
    std::u16string_view r;
    if (e == std::u16string_view::npos)
    {
        r = s.substr(static_cast<std::size_t>(idx));
        idx = -1;
    }
    else
    {
        r = s.substr(static_cast<std::size_t>(idx), e - static_cast<std::size_t>(idx));
        idx = static_cast<sal_Int32>(e + 1);
    }
    return r;
}
}

// ── css::uno / css::datatransfer ───────────────────────────────────
namespace css::uno
{
enum TypeClass
{
    TypeClass_VOID,
    TypeClass_STRING,
    TypeClass_SEQUENCE
};

template <class T> class Sequence
{
    std::vector<T> m_v;

public:
    Sequence() = default;
    Sequence(std::vector<T> v)
        : m_v(std::move(v))
    {
    }
    const T* begin() const { return m_v.data(); }
    const T* end() const { return m_v.data() + m_v.size(); }
    bool hasElements() const { return !m_v.empty(); }
    sal_Int32 getLength() const { return static_cast<sal_Int32>(m_v.size()); }
    const T& operator[](sal_Int32 i) const { return m_v[static_cast<std::size_t>(i)]; }
    const T* getConstArray() const { return m_v.data(); }
};

class Any
{
    TypeClass m_t = TypeClass_VOID;
    OUString m_str;
    Sequence<sal_Int8> m_seq;

public:
    Any() = default;
    explicit Any(OUString s)
        : m_t(TypeClass_STRING)
        , m_str(std::move(s))
    {
    }
    explicit Any(Sequence<sal_Int8> s)
        : m_t(TypeClass_SEQUENCE)
        , m_seq(std::move(s))
    {
    }
    TypeClass getValueTypeClass() const { return m_t; }
    bool hasValue() const { return m_t != TypeClass_VOID; }
    void operator>>=(OUString& r) const { r = m_str; }
    void operator>>=(Sequence<sal_Int8>& r) const { r = m_seq; }
};

template <class T> class Reference
{
    std::shared_ptr<T> m_p;

public:
    Reference() = default;
    Reference(T* p)
        : m_p(p)
    {
    }
    Reference(std::shared_ptr<T> p)
        : m_p(std::move(p))
    {
    }
    bool is() const { return m_p != nullptr; }
    T* operator->() const { return m_p.get(); }
    T* get() const { return m_p.get(); }
};
}

namespace css::datatransfer
{
struct DataFlavor
{
    OUString MimeType;
    OUString HumanPresentableName;
    int DataType = 0;
};

struct XTransferable
{
    virtual ~XTransferable() = default;
    virtual css::uno::Sequence<DataFlavor> getTransferDataFlavors() = 0;
    virtual css::uno::Any getTransferData(const DataFlavor& rFlavor) = 0;
};

namespace clipboard
{
struct XClipboardOwner
{
    virtual ~XClipboardOwner() = default;
};
}
}

namespace cppu
{
template <class T> struct UnoType
{
    static int get() { return 0; }
};
}

// ── Qt(足りる分だけ)──────────────────────────────────────────────
struct QLatin1String
{
    const char* p;
    explicit QLatin1String(const char* s)
        : p(s)
    {
    }
};
struct QLatin1Char
{
    char c;
    explicit QLatin1Char(char ch)
        : c(ch)
    {
    }
};

class QString
{
    std::string m_s;

public:
    QString() = default;
    QString(const char* s)
        : m_s(s)
    {
    }
    explicit QString(std::string s)
        : m_s(std::move(s))
    {
    }
    bool operator==(const QString& r) const { return m_s == r.m_s; }
    bool operator==(const QLatin1String& r) const { return m_s == r.p; }
    // 本物の `section(sep, start, end)` のうち、`start == end == 0`(最初の区切りの前)だけ。
    QString section(QLatin1Char sep, int, int) const
    {
        const std::size_t e = m_s.find(sep.c);
        return QString(e == std::string::npos ? m_s : m_s.substr(0, e));
    }
    bool startsWith(const char* p) const { return m_s.rfind(p, 0) == 0; }
    const std::string& str() const { return m_s; }
};

class QStringList
{
    std::vector<QString> m_v;

public:
    QStringList() = default;
    explicit QStringList(const QString& s)
        : m_v{ s }
    {
    }
    QStringList& operator<<(const QString& s)
    {
        m_v.push_back(s);
        return *this;
    }
    bool isEmpty() const { return m_v.empty(); }
    void clear() { m_v.clear(); }
    long size() const { return static_cast<long>(m_v.size()); }
    bool contains(const QString& s) const
    {
        for (const QString& r : m_v)
            if (r == s)
                return true;
        return false;
    }
    const QString* begin() const { return m_v.data(); }
    const QString* end() const { return m_v.data() + m_v.size(); }
};

struct QMetaType
{
};

class QByteArray
{
    std::string m_s;

public:
    QByteArray() = default;
    QByteArray(const char* p, int n)
        : m_s(p, static_cast<std::size_t>(n))
    {
    }
    long size() const { return static_cast<long>(m_s.size()); }
    const std::string& str() const { return m_s; }
};

// 🔑 本物の `QImage::loadFromData` と同じ向き ── PNG の署名が無ければ読めない(false)。
class QImage
{
    bool m_ok = false;
    std::string m_bytes;

public:
    bool loadFromData(const QByteArray& b, const char*)
    {
        m_ok = b.str().rfind("\x89PNG", 0) == 0;
        m_bytes = b.str();
        return m_ok;
    }
    bool isNull() const { return !m_ok; }
    const std::string& bytes() const { return m_bytes; }
};

class QVariant
{
public:
    enum Kind
    {
        Invalid,
        String,
        Bytes,
        Image
    };

private:
    Kind m_k = Invalid;
    QString m_str;
    QByteArray m_bytes;
    QImage m_img;

public:
    QVariant() = default;
    explicit QVariant(const QString& s)
        : m_k(String)
        , m_str(s)
    {
    }
    template <class T> static QVariant fromValue(const T& v)
    {
        QVariant r;
        if constexpr (std::is_same_v<T, QByteArray>)
        {
            r.m_k = Bytes;
            r.m_bytes = v;
        }
        else
        {
            r.m_k = Image;
            r.m_img = v;
        }
        return r;
    }
    Kind kind() const { return m_k; }
    QByteArray toByteArray() const { return m_k == Bytes ? m_bytes : QByteArray(); }
    const QImage& image() const { return m_img; }
};

class QMimeData
{
public:
    virtual ~QMimeData() = default;
};

QString toQString(const OUString& r);
OUString toOUString(const QString& r);

// ── QtMimeData(`QtTransferable.hxx` の宣言のうち、使う所)──────────────────
class QtMimeData : public QMimeData
{
    const css::uno::Reference<css::datatransfer::XTransferable> m_aContents;
    mutable bool m_bHaveNoCharset;
    mutable bool m_bHaveUTF8;
    mutable QStringList m_aMimeTypeList;

    QVariant retrieveData(const QString& mimeType, QMetaType type) const;

public:
    explicit QtMimeData(const css::uno::Reference<css::datatransfer::XTransferable>& aContents)
        : m_aContents(aContents)
        , m_bHaveNoCharset(false)
        , m_bHaveUTF8(false)
    {
    }
    bool hasFormat(const QString& mimeType) const;
    QStringList formats() const;
    // 走らせる harness が、private の `retrieveData` を呼ぶための口(本物には無い)
    QVariant pkc3Retrieve(const QString& t) const { return retrieveData(t, QMetaType()); }
};

inline QString toQString(const OUString& r)
{
    return QString(std::string(r.toUtf8().getStr()));
}
inline OUString toOUString(const QString& r)
{
    return OUString(r.str().c_str());
}

// ── QtClipboard(`QtClipboard.cxx` の `setContents` が触る所)────────────────
namespace osl
{
struct Mutex
{
};
class ClearableMutexGuard
{
public:
    explicit ClearableMutexGuard(Mutex&) {}
    void clear() {}
};
}

enum QClipboardMode
{
    Clipboard_Mode
};
struct QClipboard
{
    void setMimeData(QMimeData* p, QClipboardMode) { delete p; }
};
struct QApplication
{
    static QClipboard* clipboard()
    {
        static QClipboard c;
        return &c;
    }
};

class QtClipboard
{
    osl::Mutex m_aMutex;
    css::uno::Reference<css::datatransfer::XTransferable> m_aContents;
    css::uno::Reference<css::datatransfer::clipboard::XClipboardOwner> m_aOwner;
    bool m_bDoClear = false;
    bool m_bOwnClipboardChange = false;
    QClipboardMode m_eClipboardMode = Clipboard_Mode;
    void clearClipboard() {}

public:
    void setContents(
        const css::uno::Reference<css::datatransfer::XTransferable>& xTrans,
        const css::uno::Reference<css::datatransfer::clipboard::XClipboardOwner>& xClipboardOwner);
};
