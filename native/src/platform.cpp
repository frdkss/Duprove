#include "platform.h"
#include "mounts.h"
#include <algorithm>
#include <fstream>
#include <sstream>
#include <cstdlib>
#include <map>
#include <stdexcept>
#include "user_dirs.h"
#ifdef _WIN32
#include <windows.h>
#include <shlobj.h>
#else
#include <sys/stat.h>
#ifdef __APPLE__
#include <sys/param.h>
#include <sys/mount.h>
#endif
#endif
std::string utf8(const fs::path& p) { return p.u8string(); }
static std::string lower(std::string s) { for(auto& c:s) if(c>='A'&&c<='Z') c+=32; return s; }
bool pathWithin(const fs::path& p,const fs::path& base) {
  if(base.empty()) return false;
  auto a=p.lexically_normal(), b=base.lexically_normal();
  while(a.has_relative_path() && a.filename().empty()) a=a.parent_path();
  while(b.has_relative_path() && b.filename().empty()) b=b.parent_path();
  auto i=a.begin(); for(auto j=b.begin();j!=b.end();++j,++i) {
    if(i==a.end()) return false;
#ifdef _WIN32
    const auto x=i->native(), y=j->native();
    if(CompareStringOrdinal(x.c_str(),int(x.size()),y.c_str(),int(y.size()),TRUE)!=CSTR_EQUAL) return false;
#else
    if(*i!=*j) return false;
#endif
  } return true;
}
std::string pathKey(const fs::path& p) {
  auto normalized=p.lexically_normal();
  while(normalized.has_relative_path() && normalized.filename().empty()) normalized=normalized.parent_path();
#ifdef _WIN32
  auto value=normalized.native();
  const int n=LCMapStringEx(LOCALE_NAME_INVARIANT,LCMAP_UPPERCASE,value.data(),int(value.size()),nullptr,0,nullptr,nullptr,0);
  if(n>0) { std::wstring folded(size_t(n),L'\0'); LCMapStringEx(LOCALE_NAME_INVARIANT,LCMAP_UPPERCASE,value.data(),int(value.size()),folded.data(),n,nullptr,nullptr,0); return utf8(fs::path(folded)); }
#endif
  return utf8(normalized);
}
std::vector<fs::path> mountPaths() {
  std::vector<fs::path> result;
#ifdef _WIN32
  wchar_t name[MAX_PATH];
  const auto search=FindFirstVolumeW(name,MAX_PATH);
  if(search==INVALID_HANDLE_VALUE) throw std::runtime_error("MOUNT_LIST_UNAVAILABLE");
  do {
    DWORD needed=0;
    GetVolumePathNamesForVolumeNameW(name,nullptr,0,&needed);
    if(!needed) continue;
    std::vector<wchar_t> paths(needed);
    if(GetVolumePathNamesForVolumeNameW(name,paths.data(),needed,&needed))
      for(auto p=paths.data();*p;p+=wcslen(p)+1) result.emplace_back(p);
  } while(FindNextVolumeW(search,name,MAX_PATH));
  FindVolumeClose(search);
  const DWORD needed=GetLogicalDriveStringsW(0,nullptr);
  std::vector<wchar_t> letters(needed+1);
  if(needed && GetLogicalDriveStringsW(DWORD(letters.size()),letters.data()))
    for(auto p=letters.data();*p;p+=wcslen(p)+1) result.emplace_back(p);
#elif defined(__APPLE__)
  struct statfs* mounted=nullptr;
  const int count=getmntinfo(&mounted,MNT_NOWAIT);
  if(count<=0) throw std::runtime_error("MOUNT_LIST_UNAVAILABLE");
  for(int i=0;i<count;++i) result.emplace_back(mounted[i].f_mntonname);
#else
  std::ifstream in("/proc/self/mountinfo");
  if(!in) throw std::runtime_error("MOUNT_LIST_UNAVAILABLE");
  for(const auto& entry:mounts::readLinux(in)) result.push_back(fs::u8path(entry.path));
#endif
  return result;
}
json drives() {
  json out=json::array();
  auto add=[&](const fs::path& p) { std::error_code ec; if(!fs::is_directory(p,ec)||ec)return; auto s=fs::space(p,ec); if(!ec && s.capacity<=9007199254740991ULL) out.push_back({{"path",utf8(p)},{"name",utf8(p)},{"capacity",s.capacity},{"available",std::min(s.available,s.capacity)}}); };
#ifdef _WIN32
  std::map<std::string,fs::path> unique;
  for(const auto& path:mountPaths()) unique.emplace(pathKey(path),path);
  for(const auto& item:unique) { auto t=GetDriveTypeW(item.second.c_str()); if(t==DRIVE_FIXED||t==DRIVE_REMOVABLE||t==DRIVE_REMOTE) add(item.second); }
#elif defined(__APPLE__)
  struct statfs* mounted=nullptr;
  const int count=getmntinfo(&mounted,MNT_NOWAIT);
  if(count<=0) throw std::runtime_error("MOUNT_LIST_UNAVAILABLE");
  std::vector<mounts::Entry> entries;
  std::map<std::string,std::pair<uint64_t,uint64_t>> sizes;
  for(int i=0;i<count;++i) {
    const auto& item=mounted[i];
    const std::string mount=item.f_mntonname;
    if(!item.f_bsize || item.f_blocks>9007199254740991ULL/item.f_bsize)continue;
    const auto capacity=uint64_t(item.f_blocks)*item.f_bsize;
    const auto available=std::min(uint64_t(item.f_bavail),uint64_t(item.f_blocks))*item.f_bsize;
    entries.push_back({mount,item.f_mntfromname,item.f_fstypename,"/",
      std::to_string(item.f_fsid.val[0])+":"+std::to_string(item.f_fsid.val[1]),0,0,bool(item.f_flags&MNT_DONTBROWSE)});
    sizes[mount]={capacity,available};
  }
  for(const auto& entry:mounts::selectMac(entries)) {
    const auto size=sizes.at(entry.path);
    out.push_back({{"path",entry.path},{"name",entry.path},{"capacity",size.first},{"available",size.second}});
  }
#else
  std::ifstream in("/proc/self/mountinfo");
  if(!in) throw std::runtime_error("MOUNT_LIST_UNAVAILABLE");
  for(const auto& entry:mounts::selectLinux(mounts::readLinux(in))) add(fs::u8path(entry.path));
#endif
  return out;
}
bool excluded(const fs::path& p) {
  auto name=lower(utf8(p.filename()));
  for(const auto& part:p) { const auto s=lower(utf8(part)); if(s==".git"||s==".pytest_cache"||s=="$recycle.bin"||s=="system volume information") return true; }
#ifdef _WIN32
  static const auto windows=[] { wchar_t win[32768]; const auto n=GetWindowsDirectoryW(win,32768); return n && n<32768 ? fs::path(win) : fs::path(); }();
  if(pathWithin(p,windows)) return true;
  auto rel=p.lexically_relative(p.root_path()); auto first=rel.begin();
  if(first!=rel.end()) { auto part=lower(utf8(*first)); if(part=="program files"||part=="program files (x86)"||part=="programdata"||part=="recovery"||part=="$windows.~bt") return true; }
  if(name=="pagefile.sys"||name=="hiberfil.sys"||name=="swapfile.sys") return true;
#else
  if(mounts::systemPath(utf8(p.lexically_normal()))) return true;
#ifdef __APPLE__
  if(pathWithin(p,"/Applications")) return true;
#endif
#endif
  return false;
}
std::vector<std::pair<fs::path,std::string>> knownFolders() {
  std::vector<std::pair<fs::path,std::string>> out;
#ifdef _WIN32
  const KNOWNFOLDERID* ids[]={&FOLDERID_Downloads,&FOLDERID_Documents,&FOLDERID_Videos,&FOLDERID_Pictures,&FOLDERID_Music,&FOLDERID_Desktop};
  const char* names[]={"downloads","documents","videos","pictures","music","desktop"};
  for(int i=0;i<6;i++) { PWSTR path=nullptr; if(SUCCEEDED(SHGetKnownFolderPath(*ids[i],KF_FLAG_DONT_VERIFY,nullptr,&path))) {out.emplace_back(fs::path(path),names[i]); CoTaskMemFree(path);} }
#elif defined(__APPLE__)
  out=macKnownFolders();
#else
  const char* home=getenv("HOME"); if(!home)return out;
  const char* config=getenv("XDG_CONFIG_HOME");
  auto directory=config && fs::u8path(config).is_absolute() ? fs::u8path(config) : fs::u8path(home)/".config";
  std::ifstream in(directory/"user-dirs.dirs");
  out=readUserDirs(in,fs::u8path(home));
#endif
  std::stable_sort(out.begin(),out.end(),[](const auto& a,const auto& b){ return a.first.native().size()>b.first.native().size(); });
  return out;
}
std::string extension(const fs::path& p) {
  auto name=lower(utf8(p.filename()));
  for(auto ext:{".tar.gz",".tar.bz2",".tar.xz",".tar.zst"}) { auto n=std::string(ext).size(); if(name.size()>n && name.compare(name.size()-n,n,ext)==0)return ext; }
  auto ext=lower(utf8(p.extension())); if(ext.empty()||ext==".")return "none";
  return ext;
}
