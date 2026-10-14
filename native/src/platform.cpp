#include "platform.h"
#include <algorithm>
#include <fstream>
#include <sstream>
#include <cstdlib>
#ifdef _WIN32
#include <windows.h>
#include <shlobj.h>
#else
#include <sys/stat.h>
#endif
std::string utf8(const fs::path& p) { return p.u8string(); }
static std::string lower(std::string s) { for(auto& c:s) if(c>='A'&&c<='Z') c+=32; return s; }
static bool within(const fs::path& p,const fs::path& base) {
  if(base.empty()) return false;
  auto a=p.lexically_normal(), b=base.lexically_normal();
  auto i=a.begin(); for(auto j=b.begin();j!=b.end();++j,++i) {
    if(i==a.end()) return false;
#ifdef _WIN32
    if(lower(utf8(*i))!=lower(utf8(*j))) return false;
#else
    if(*i!=*j) return false;
#endif
  } return true;
}
json drives() {
  json out=json::array();
  auto add=[&](const fs::path& p) { std::error_code ec; auto s=fs::space(p,ec); if(!ec) out.push_back({{"path",utf8(p)},{"name",utf8(p)},{"capacity",s.capacity},{"available",s.available}}); };
#ifdef _WIN32
  wchar_t buffer[512]; auto n=GetLogicalDriveStringsW(512,buffer);
  if(n && n<512) for(auto p=buffer;*p;p+=wcslen(p)+1) { auto t=GetDriveTypeW(p); if(t==DRIVE_FIXED||t==DRIVE_REMOVABLE||t==DRIVE_REMOTE) add(fs::path(p)); }
#elif defined(__APPLE__)
  add("/"); std::error_code ec; for(auto& e:fs::directory_iterator("/Volumes",ec)) if(e.is_directory(ec)&&e.path()!="/Volumes/Macintosh HD") add(e.path());
#else
  std::ifstream in("/proc/self/mounts"); std::string dev,mount,type,rest;
  while(in>>dev>>mount>>type) { std::getline(in,rest); if(mount=="/"||dev.rfind("/dev/",0)==0||type=="cifs"||type=="nfs"||type.rfind("fuse.",0)==0) {
    for(auto esc: {std::pair{"\\040"," "}, {"\\011","\t"},{"\\134","\\"}}) { size_t pos; while((pos=mount.find(esc.first))!=std::string::npos) mount.replace(pos,4,esc.second); }
    if(!excluded(fs::u8path(mount))) add(fs::u8path(mount));
  }}
#endif
  return out;
}
bool excluded(const fs::path& p) {
  auto name=lower(utf8(p.filename()));
  if(name==".git"||name=="$recycle.bin"||name=="system volume information") return true;
#ifdef _WIN32
  auto attrs=GetFileAttributesW(p.c_str());
  if(attrs!=INVALID_FILE_ATTRIBUTES && (attrs&FILE_ATTRIBUTE_REPARSE_POINT)) return true;
  wchar_t win[MAX_PATH]; GetWindowsDirectoryW(win,MAX_PATH); if(within(p,win)) return true;
  auto rel=p.lexically_relative(p.root_path()); auto first=rel.begin();
  if(first!=rel.end()) { auto part=lower(utf8(*first)); if(part=="program files"||part=="program files (x86)"||part=="programdata"||part=="recovery"||part=="$windows.~bt") return true; }
  if(name=="pagefile.sys"||name=="hiberfil.sys"||name=="swapfile.sys") return true;
#else
  for(auto s:{"/proc","/sys","/dev","/run","/boot","/usr","/bin","/sbin","/lib","/lib64","/etc","/var","/System","/Library","/private"}) if(within(p,s)) return true;
#endif
  return false;
}
std::string identity(const fs::path& p) {
#ifdef _WIN32
  auto h=CreateFileW(p.c_str(),0,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
  if(h==INVALID_HANDLE_VALUE) return ""; BY_HANDLE_FILE_INFORMATION info{}; bool ok=GetFileInformationByHandle(h,&info); CloseHandle(h); if(!ok)return "";
  return std::to_string(info.dwVolumeSerialNumber)+":"+std::to_string(info.nFileIndexHigh)+":"+std::to_string(info.nFileIndexLow);
#else
  struct stat info{}; if(lstat(p.c_str(),&info)!=0)return ""; return std::to_string(info.st_dev)+":"+std::to_string(info.st_ino);
#endif
}
static std::vector<std::pair<fs::path,std::string>> known() {
  std::vector<std::pair<fs::path,std::string>> out;
#ifdef _WIN32
  const KNOWNFOLDERID* ids[]={&FOLDERID_Downloads,&FOLDERID_Documents,&FOLDERID_Videos,&FOLDERID_Pictures,&FOLDERID_Music,&FOLDERID_Desktop};
  const char* names[]={"downloads","documents","videos","pictures","music","desktop"};
  for(int i=0;i<6;i++) { PWSTR path=nullptr; if(SUCCEEDED(SHGetKnownFolderPath(*ids[i],0,nullptr,&path))) {out.emplace_back(fs::path(path),names[i]); CoTaskMemFree(path);} }
#else
  const char* home=getenv("HOME"); if(!home)return out;
  std::ifstream in(fs::path(home)/".config/user-dirs.dirs"); std::string line;
  const std::pair<const char*,const char*> dirs[]={{"DOWNLOAD","downloads"},{"DOCUMENTS","documents"},{"VIDEOS","videos"},{"PICTURES","pictures"},{"MUSIC","music"},{"DESKTOP","desktop"}};
  while(std::getline(in,line)) for(auto d:dirs) if(line.rfind(std::string("XDG_")+d.first+"_DIR=",0)==0) {
    auto a=line.find('"'),b=line.rfind('"'); if(a==std::string::npos||a==b)continue; auto value=line.substr(a+1,b-a-1); if(value.rfind("$HOME",0)==0)value.replace(0,5,home);
    if(fs::u8path(value)!=fs::path(home))out.emplace_back(fs::u8path(value),d.second);
  }
  if(out.empty()) for(auto d:{std::pair{"Downloads","downloads"},{"Documents","documents"},{"Movies","videos"},{"Pictures","pictures"},{"Music","music"},{"Desktop","desktop"}})out.emplace_back(fs::path(home)/d.first,d.second);
#endif
  return out;
}
std::string category(const fs::path& p) { static auto folders=known(); for(auto& f:folders)if(within(p,f.first))return f.second; return "custom"; }
std::string extension(const fs::path& p) {
  auto name=lower(utf8(p.filename()));
  for(auto ext:{".tar.gz",".tar.bz2",".tar.xz",".tar.zst"}) { auto n=std::string(ext).size(); if(name.size()>n && name.compare(name.size()-n,n,ext)==0)return ext; }
  auto ext=lower(utf8(p.extension())); if(ext.empty()||ext==".")return "none";
  if(ext.size()>20)return "other";
  for(char c:ext) if(!(c=='.'||(c>='a'&&c<='z')||(c>='0'&&c<='9')))return "other";
  return ext;
}
