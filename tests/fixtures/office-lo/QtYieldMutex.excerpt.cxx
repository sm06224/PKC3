// 上流 LibreOffice(sha d6226c1a)`vcl/qt5/QtInstance.cxx` の抜粋(原文のまま。include の 2 行 + `QtYieldMutex` の class と `IsCurrentThread` / `doAcquire` / `doRelease`、原文の 95〜205 行)。
// `patch-lo-yield-wait.py`(#1408)の錨が当たることを見る(build はしない)。


#include <condition_variable>
#include <mutex>

namespace
{
/// TODO: not much Qt specific here? could be generalised, esp. for OSX...
/// this subclass allows for the transfer of a closure for running on the main
/// thread, to handle all the thread affine stuff in Qt; the SolarMutex is
/// "loaned" to the main thread for the execution of the closure.
/// @note it doesn't work to just use "emit" and signals/slots to move calls to
/// the main thread, because the other thread has the SolarMutex; the other
/// thread (typically) cannot release SolarMutex, because then the main thread
/// will handle all sorts of events and whatnot; this design ensures that the
/// main thread only runs the passed closure (unless the closure releases
/// SolarMutex itself, which should probably be avoided).
class QtYieldMutex : public SalYieldMutex
{
public:
    /// flag only accessed on main thread:
    /// main thread has "borrowed" SolarMutex from another thread
    bool m_bNoYieldLock = false;
    /// members for communication from non-main thread to main thread
    std::mutex m_RunInMainMutex;
    std::condition_variable m_InMainCondition;
    bool m_isWakeUpMain = false;
    std::function<void()> m_Closure; ///< code for main thread to run
    /// members for communication from main thread to non-main thread
    std::condition_variable m_ResultCondition;
    bool m_isResultReady = false;

    virtual bool IsCurrentThread() const override;
    virtual void doAcquire(sal_uInt32 nLockCount) override;
    virtual sal_uInt32 doRelease(bool const bUnlockAll) override;
};
}

bool QtYieldMutex::IsCurrentThread() const
{
    QtInstance& rQtInstance = GetQtInstance();
    if (rQtInstance.IsMainThread() && m_bNoYieldLock)
    {
        return true; // main thread has borrowed SolarMutex
    }
    return SalYieldMutex::IsCurrentThread();
}

void QtYieldMutex::doAcquire(sal_uInt32 nLockCount)
{
    QtInstance& rQtInstance = GetQtInstance();
    if (!rQtInstance.IsMainThread())
    {
        SalYieldMutex::doAcquire(nLockCount);
        return;
    }
    if (m_bNoYieldLock)
    {
        return; // special case for main thread: borrowed from other thread
    }
    do // main thread acquire...
    {
        std::function<void()> func; // copy of closure on thread stack
        {
            std::unique_lock<std::mutex> g(m_RunInMainMutex);
            if (m_aMutex.tryToAcquire())
            {
                // if there's a closure, the other thread holds m_aMutex
                assert(!m_Closure);
                m_isWakeUpMain = false;
                --nLockCount; // have acquired once!
                ++m_nCount;
                break;
            }
            m_InMainCondition.wait(g, [this]() { return m_isWakeUpMain; });
            m_isWakeUpMain = false;
            std::swap(func, m_Closure);
        }
        if (func)
        {
            assert(!m_bNoYieldLock);
            m_bNoYieldLock = true; // execute closure with borrowed SolarMutex
            func();
            m_bNoYieldLock = false;
            std::scoped_lock<std::mutex> g(m_RunInMainMutex);
            assert(!m_isResultReady);
            m_isResultReady = true;
            m_ResultCondition.notify_all(); // unblock other thread
        }
    } while (true);
    SalYieldMutex::doAcquire(nLockCount);
}

sal_uInt32 QtYieldMutex::doRelease(bool const bUnlockAll)
{
    QtInstance& rQtInstance = GetQtInstance();
    if (rQtInstance.IsMainThread() && m_bNoYieldLock)
    {
        return 1; // dummy value
    }

    std::scoped_lock<std::mutex> g(m_RunInMainMutex);
    // read m_nCount before doRelease (it's guarded by m_aMutex)
    bool const isReleased(bUnlockAll || m_nCount == 1);
    sal_uInt32 nCount = SalYieldMutex::doRelease(bUnlockAll);
    if (isReleased && !rQtInstance.IsMainThread())
    {
        m_isWakeUpMain = true;
        m_InMainCondition.notify_all(); // unblock main thread
    }
    return nCount;
}
