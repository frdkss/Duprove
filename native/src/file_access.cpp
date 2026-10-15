#include "file_access.h"
#include <limits>
#include <stdexcept>
#ifdef _WIN32
#include <windows.h>
#else
#include <cerrno>
#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace {
[[noreturn]] void failed() { throw std::runtime_error("FILE_ACCESS_FAILED"); }
#ifdef _WIN32
// Use extended-length names at the Win32 boundary, independent of registry or
// executable manifests. Keep ordinary paths for exclusions, identity and reports.
std::wstring nativePath(const fs::path& path) {
  auto normalized=path.lexically_normal();
  normalized.make_preferred();
  const auto value=normalized.native();
  if(value.rfind(L"\\\\?\\",0)==0) return value;
  if(value.rfind(L"\\\\",0)==0) return L"\\\\?\\UNC\\"+value.substr(2);
  return L"\\\\?\\"+value;
}
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE v = INVALID_HANDLE_VALUE) : value(v) {}
  ~Handle() { if(value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
};
FileInfo metadata(HANDLE h) {
  BY_HANDLE_FILE_INFORMATION v{};
  FILE_BASIC_INFO basic{};
  if(!GetFileInformationByHandle(h,&v) || !GetFileInformationByHandleEx(h,FileBasicInfo,&basic,sizeof(basic))) failed();
  FileInfo result;
  if(v.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) return result;
  result.kind = (v.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? FileInfo::Kind::directory : FileInfo::Kind::regular;
  result.device = std::to_string(v.dwVolumeSerialNumber);
  result.id = result.device + ":" + std::to_string(v.nFileIndexHigh) + ":" + std::to_string(v.nFileIndexLow);
  const auto size = (uint64_t(v.nFileSizeHigh)<<32) | v.nFileSizeLow;
  if(size > uint64_t(INT64_MAX)) failed();
  result.size = int64_t(size);
  result.modified = basic.LastWriteTime.QuadPart;
  result.changed = basic.ChangeTime.QuadPart;
  return result;
}
bool volumeMount(const fs::path& path) {
  auto value = nativePath(path);
  if(value.empty() || value.back()!=L'\\') value+=L'\\';
  wchar_t name[MAX_PATH];
  return GetVolumeNameForVolumeMountPointW(value.c_str(),name,MAX_PATH)!=0;
}
#else
FileInfo metadata(const struct stat& v) {
  FileInfo result;
  if(!S_ISREG(v.st_mode) && !S_ISDIR(v.st_mode)) return result;
  result.kind = S_ISDIR(v.st_mode) ? FileInfo::Kind::directory : FileInfo::Kind::regular;
  result.device = std::to_string(v.st_dev);
  result.id = result.device + ":" + std::to_string(v.st_ino);
  result.size = v.st_size;
#ifdef __APPLE__
  result.modified = int64_t(v.st_mtimespec.tv_sec)*1000000000 + v.st_mtimespec.tv_nsec;
  result.changed = int64_t(v.st_ctimespec.tv_sec)*1000000000 + v.st_ctimespec.tv_nsec;
#else
  result.modified = int64_t(v.st_mtim.tv_sec)*1000000000 + v.st_mtim.tv_nsec;
  result.changed = int64_t(v.st_ctim.tv_sec)*1000000000 + v.st_ctim.tv_nsec;
#endif
  return result;
}
#endif
}

bool FileInfo::same(const FileInfo& other) const {
  return kind==other.kind && id==other.id && size==other.size && modified==other.modified && changed==other.changed;
}

struct Directory::Impl {
  fs::path path;
  FileInfo info;
#ifdef _WIN32
  struct Pin { fs::path path; std::shared_ptr<Handle> handle; };
  std::vector<Pin> parents;
  HANDLE search = INVALID_HANDLE_VALUE;
  WIN32_FIND_DATAW entry{};
  bool started=false, ended=false;
  ~Impl() { if(search!=INVALID_HANDLE_VALUE) FindClose(search); }
#else
  int fd = -1;
  DIR* entries = nullptr;
  ~Impl() { if(entries) closedir(entries); if(fd>=0) close(fd); }
#endif
};
Directory::Directory(const fs::path& raw,const Directory* preceding) : impl(std::make_unique<Impl>()) {
  const auto path = raw.lexically_normal();
  if(!path.is_absolute()) failed();
  impl->path=path;
#ifdef _WIN32
  auto component=path.root_path();
  auto pin=[&](const fs::path& p) {
    const auto index=impl->parents.size();
    if(preceding && index<preceding->impl->parents.size() && preceding->impl->parents[index].path==p) {
      // These handles deny FILE_SHARE_DELETE, so the entire shared prefix is
      // still the same directory chain, not a cached pathname lookup.
      impl->parents.push_back(preceding->impl->parents[index]);
      return;
    }
    const auto systemPath=nativePath(p);
    auto handle=std::make_shared<Handle>(CreateFileW(systemPath.c_str(),FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
    if(handle->value==INVALID_HANDLE_VALUE) failed();
    auto info=metadata(handle->value);
    if(info.kind==FileInfo::Kind::skip && volumeMount(p)) {
      handle=std::make_shared<Handle>(CreateFileW(systemPath.c_str(),FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS,nullptr));
      if(handle->value==INVALID_HANDLE_VALUE) failed();
      info=metadata(handle->value);
    }
    if(info.kind!=FileInfo::Kind::directory) failed();
    impl->parents.push_back({p,std::move(handle)});
  };
  pin(component);
  for(const auto& part:path.relative_path()) { if(part.empty() || part==L".") continue; component/=part; pin(component); }
  impl->info=metadata(impl->parents.back().handle->value);
#else
  (void)preceding; // POSIX descriptors do not prevent ancestor replacement.
  impl->fd=open("/",O_RDONLY|O_DIRECTORY|O_CLOEXEC);
  if(impl->fd<0) failed();
  for(const auto& part:path.relative_path()) {
    if(part.empty() || part==".") continue;
    const int next=openat(impl->fd,part.c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    if(next<0) failed();
    close(impl->fd); impl->fd=next;
  }
  struct stat v{};
  if(fstat(impl->fd,&v)) failed();
  impl->info=metadata(v);
#endif
}
Directory::~Directory() = default;
const FileInfo& Directory::info() const { return impl->info; }
bool Directory::inspect(const fs::path& name,FileInfo& result) const {
  if(name.empty() || name!=name.filename() || name=="." || name=="..") return false;
#ifdef _WIN32
  const auto systemPath=nativePath(impl->path/name);
  Handle handle(CreateFileW(systemPath.c_str(),FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,nullptr));
  if(handle.value==INVALID_HANDLE_VALUE) return false;
  try { result=metadata(handle.value); return true; } catch(...) { return false; }
#else
  struct stat v{};
  if(fstatat(impl->fd,name.c_str(),&v,AT_SYMLINK_NOFOLLOW)) return false;
  result=metadata(v); return true;
#endif
}
bool Directory::next(FileEntry& result) {
#ifdef _WIN32
  if(impl->ended) return false;
  for(;;) {
    if(!impl->started) {
      impl->started=true;
      const auto pattern=nativePath(impl->path/L"*");
      impl->search=FindFirstFileExW(pattern.c_str(),FindExInfoBasic,&impl->entry,FindExSearchNameMatch,nullptr,FIND_FIRST_EX_LARGE_FETCH);
      if(impl->search==INVALID_HANDLE_VALUE) { if(GetLastError()==ERROR_FILE_NOT_FOUND) { impl->ended=true; return false; } failed(); }
    } else if(!FindNextFileW(impl->search,&impl->entry)) {
      if(GetLastError()!=ERROR_NO_MORE_FILES) failed();
      impl->ended=true; return false;
    }
    const fs::path name(impl->entry.cFileName);
    if(name==L"." || name==L"..") continue;
    result={impl->path/name,{},false};
    // Filter links and system directories before opening or enumerating them.
    if((impl->entry.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT) || excluded(result.path)) return true;
    result.error=!inspect(name,result.info); return true;
  }
#else
  if(!impl->entries) {
    const int copy=dup(impl->fd);
    if(copy<0) failed();
    impl->entries=fdopendir(copy);
    if(!impl->entries) { close(copy); failed(); }
  }
  for(;;) {
    errno=0;
    auto* entry=readdir(impl->entries);
    if(!entry) { if(errno) failed(); return false; }
    const fs::path name(entry->d_name);
    if(name=="." || name=="..") continue;
    result={impl->path/name,{},false};
    if(excluded(result.path) || (entry->d_type!=DT_REG && entry->d_type!=DT_DIR && entry->d_type!=DT_UNKNOWN)) return true;
    result.error=!inspect(name,result.info); return true;
  }
#endif
}

struct FileReader::Impl {
  std::unique_ptr<Directory> ownedParent;
  Directory* parent=nullptr;
#ifdef _WIN32
  Handle handle;
#else
  int fd=-1;
  ~Impl() { if(fd>=0) close(fd); }
#endif
  explicit Impl(const fs::path& path,Directory* pinnedParent) {
#ifdef _WIN32
    if(pinnedParent) { parent=pinnedParent;return; }
#else
    (void)pinnedParent; // POSIX directory handles do not pin ancestors against rename.
#endif
    ownedParent=std::make_unique<Directory>(path.parent_path());parent=ownedParent.get();
  }
};
FileReader::FileReader(const fs::path& path,Directory* pinnedParent) : impl(std::make_unique<Impl>(path,pinnedParent)) {
  if(excluded(path)) failed();
  if(impl->parent->impl->path!=path.parent_path().lexically_normal()) failed();
#ifdef _WIN32
  const auto systemPath=nativePath(path);
  impl->handle.value=CreateFileW(systemPath.c_str(),GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,
    nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_SEQUENTIAL_SCAN,nullptr);
  if(impl->handle.value==INVALID_HANDLE_VALUE || GetFileType(impl->handle.value)!=FILE_TYPE_DISK) failed();
#else
  impl->fd=openat(impl->parent->impl->fd,path.filename().c_str(),O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
  if(impl->fd<0) failed();
#endif
  if(info().kind!=FileInfo::Kind::regular) failed();
}
FileReader::~FileReader() = default;
FileInfo FileReader::info() const {
#ifdef _WIN32
  return metadata(impl->handle.value);
#else
  struct stat v{};
  if(fstat(impl->fd,&v)) failed();
  return metadata(v);
#endif
}
size_t FileReader::read(char* buffer,size_t length) {
  size_t total=0;
  while(total<length) {
#ifdef _WIN32
  DWORD n=0;
  if(!ReadFile(impl->handle.value,buffer+total,DWORD(std::min(length-total,size_t(MAXDWORD))),&n,nullptr)) failed();
#else
  ssize_t n;
  do { n=::read(impl->fd,buffer+total,length-total); } while(n<0 && errno==EINTR);
  if(n<0) failed();
#endif
    if(n==0) break;
    total+=size_t(n);
  }
  return total;
}
bool inspectFile(const fs::path& path,FileInfo& result) {
  try { if(excluded(path)) return false; Directory parent(path.parent_path()); return parent.inspect(path.filename(),result); }
  catch(...) { return false; }
}
Directory* DirectoryCursor::parent(const fs::path& path) {
#ifdef _WIN32
  const auto wanted=path.parent_path().lexically_normal();
  if(!directory || wanted!=parentPath) {
    try { directory=std::make_unique<Directory>(wanted,directory.get());parentPath=wanted; }
    catch(...) { directory.reset();throw; }
  }
  return directory.get();
#else
  (void)path;
  return nullptr;
#endif
}
bool DirectoryCursor::inspect(const fs::path& path,FileInfo& result) {
  try {
    if(excluded(path)) return false;
    auto* pinned=parent(path);
    return pinned ? pinned->inspect(path.filename(),result) : inspectFile(path,result);
  } catch(...) { return false; }
}
