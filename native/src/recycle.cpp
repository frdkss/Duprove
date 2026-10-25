#include "recycle.h"
#ifdef _WIN32
#include <windows.h>
#include <shellapi.h>
#include <shobjidl.h>
#include <wrl/client.h>
#include <wrl/implements.h>
#include <functional>

namespace {
class RecycleSink final : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,IFileOperationProgressSink> {
 public:
  explicit RecycleSink(std::function<bool()> check):check_(std::move(check)) {}
  bool recycled=false;
  HRESULT STDMETHODCALLTYPE PreDeleteItem(DWORD flags,IShellItem*) override {
    // Reject items which the shell would destroy instead of recycling.
    if(!(flags&TSF_DELETE_RECYCLE_IF_POSSIBLE)) return E_ABORT;
    try { return check_()?S_OK:E_ABORT; } catch(...) { return E_ABORT; }
  }
  HRESULT STDMETHODCALLTYPE PostDeleteItem(DWORD,IShellItem*,HRESULT result,IShellItem*) override { recycled=SUCCEEDED(result);return S_OK; }
  HRESULT STDMETHODCALLTYPE StartOperations() override { return S_OK; }
  HRESULT STDMETHODCALLTYPE FinishOperations(HRESULT) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PreRenameItem(DWORD,IShellItem*,LPCWSTR) override { return E_ABORT; }
  HRESULT STDMETHODCALLTYPE PostRenameItem(DWORD,IShellItem*,LPCWSTR,HRESULT,IShellItem*) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PreMoveItem(DWORD,IShellItem*,IShellItem*,LPCWSTR) override { return E_ABORT; }
  HRESULT STDMETHODCALLTYPE PostMoveItem(DWORD,IShellItem*,IShellItem*,LPCWSTR,HRESULT,IShellItem*) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PreCopyItem(DWORD,IShellItem*,IShellItem*,LPCWSTR) override { return E_ABORT; }
  HRESULT STDMETHODCALLTYPE PostCopyItem(DWORD,IShellItem*,IShellItem*,LPCWSTR,HRESULT,IShellItem*) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PreNewItem(DWORD,IShellItem*,LPCWSTR) override { return E_ABORT; }
  HRESULT STDMETHODCALLTYPE PostNewItem(DWORD,IShellItem*,LPCWSTR,LPCWSTR,DWORD,HRESULT,IShellItem*) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE UpdateProgress(UINT,UINT) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE ResetTimer() override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PauseTimer() override { return S_OK; }
  HRESULT STDMETHODCALLTYPE ResumeTimer() override { return S_OK; }
 private:
  std::function<bool()> check_;
};
}
const char* recycleWindows(const fs::path& candidate,const FileInfo& candidateInfo,const fs::path& original,const FileInfo& originalInfo) {
  try {
    // Pin directory chains throughout the shell operation and check the exact
    // files again inside PreDeleteItem. This is not a pathname-atomic API.
    if(candidateInfo.id==originalInfo.id) return "refused";
    Directory candidateParent(candidate.parent_path()),originalParent(original.parent_path());
    // Keep the original's non-delete-sharing reader open. The candidate reader
    // used for hashing has closed, so it cannot block the requested recycle.
    FileReader originalFile(original,&originalParent);
    auto current=[&] {
      FileInfo a,b;
      return originalFile.info().same(originalInfo) && candidateParent.inspect(candidate.filename(),a) && a.same(candidateInfo)
        && originalParent.inspect(original.filename(),b) && b.same(originalInfo);
    };
    if(!current()) return "refused";
    const auto initialized=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED|COINIT_DISABLE_OLE1DDE);
    if(FAILED(initialized)) return "refused";
    struct Uninitialize { ~Uninitialize(){CoUninitialize();} } uninitialize;
    Microsoft::WRL::ComPtr<IFileOperation> operation;
    if(FAILED(CoCreateInstance(CLSID_FileOperation,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&operation)))) return "refused";
    // No elevation prompt, no connected HTML resource folders, no permanent
    // deletion. The progress sink also vetoes non-recyclable items.
    constexpr DWORD flags=FOF_SILENT|FOF_NOCONFIRMATION|FOF_NOERRORUI|FOF_NO_CONNECTED_ELEMENTS
      |FOFX_EARLYFAILURE|FOFX_RECYCLEONDELETE|FOFX_ADDUNDORECORD;
    static_assert((flags&(FOFX_SHOWELEVATIONPROMPT|FOFX_REQUIREELEVATION))==0,"Recycle must never request elevation");
    if(FAILED(operation->SetOperationFlags(flags))) return "refused";
    Microsoft::WRL::ComPtr<IShellItem> item;
    if(FAILED(SHCreateItemFromParsingName(candidate.c_str(),nullptr,IID_PPV_ARGS(&item)))) return "refused";
    auto sink=Microsoft::WRL::Make<RecycleSink>(current);
    if(!sink || FAILED(operation->DeleteItem(item.Get(),sink.Get()))) return "refused";
    const auto performed=operation->PerformOperations();
    BOOL aborted=TRUE;
    const auto queried=operation->GetAnyOperationsAborted(&aborted);
    if(SUCCEEDED(performed) && SUCCEEDED(queried) && !aborted && sink->recycled) return "trashed";
    return current()?"refused":"uncertain";
  } catch(...) { return "uncertain"; }
}
#else
const char* recycleWindows(const fs::path&,const FileInfo&,const fs::path&,const FileInfo&) { return "refused"; }
#endif
