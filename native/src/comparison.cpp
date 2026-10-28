#include "comparison.h"
#include "sha256.h"
#include "storage.h"
#include "load_profile.h"
#include <algorithm>
std::string digest(const fs::path& path,const FileInfo& expected,int root,ScanContext& context,Directory* pinnedParent) {
  try {
    FileReader file(path,pinnedParent);
    if(!file.info().same(expected)) return "";
    Sha256 hash;
    std::array<unsigned char,262144> buffer;
    int64_t total=0;
    for(;;) {
      if(!context.waitFor(root)) return "";
      const auto n=file.read(reinterpret_cast<char*>(buffer.data()),buffer.size());
      total+=int64_t(n);
      if(total>expected.size || !file.info().same(expected)) { if(n) context.accountRead(root,n);return ""; }
      if(!n) break;
      hash.process(buffer.data(),n);
      context.accountRead(root,n);
    }
    if(total!=expected.size || !file.info().same(expected)) return "";
    return hash.finish();
  } catch(const std::exception&) { return ""; }
}
ByteMatch equalBytes(const fs::path& a,const FileInfo& expectedA,const fs::path& b,const FileInfo& expectedB,
                     int root,ScanContext& context,int otherRoot,DirectoryCursor* left,DirectoryCursor* right) {
  std::unique_ptr<FileReader> x,y;
  try { x=std::make_unique<FileReader>(a,left ? left->parent(a) : nullptr); if(!x->info().same(expectedA)) return ByteMatch::leftUnavailable; }
  catch(const std::exception&) { return ByteMatch::leftUnavailable; }
  try { y=std::make_unique<FileReader>(b,right ? right->parent(b) : nullptr); if(!y->info().same(expectedB)) return ByteMatch::rightUnavailable; }
  catch(const std::exception&) { return ByteMatch::rightUnavailable; }
  auto stable=[&] {
    try { if(!x->info().same(expectedA)) return ByteMatch::leftUnavailable; }
    catch(const std::exception&) { return ByteMatch::leftUnavailable; }
    try { if(!y->info().same(expectedB)) return ByteMatch::rightUnavailable; }
    catch(const std::exception&) { return ByteMatch::rightUnavailable; }
    return ByteMatch::equal;
  };
  if(expectedA.size!=expectedB.size) return ByteMatch::different;
  std::array<char,262144> bx,by;
  int64_t total=0;
  for(;;) {
    if(!context.waitFor(root) || (otherRoot>=0 && !context.waitFor(otherRoot))) return ByteMatch::stopped;
    size_t nx,ny;
    try { nx=x->read(bx.data(),bx.size()); } catch(const std::exception&) { return ByteMatch::leftUnavailable; }
    try { ny=y->read(by.data(),by.size()); } catch(const std::exception&) { return ByteMatch::rightUnavailable; }
    context.accountRead(root,nx+ny);
    const auto stability=stable();
    if(stability!=ByteMatch::equal) return stability;
    if(int64_t(nx)>expectedA.size-total) return ByteMatch::leftUnavailable;
    if(int64_t(ny)>expectedB.size-total) return ByteMatch::rightUnavailable;
    if(nx!=ny || !std::equal(bx.begin(),bx.begin()+nx,by.begin())) {
      const auto result=stable();
      return result==ByteMatch::equal ? ByteMatch::different : result;
    }
    total+=int64_t(nx);
    if(!nx) {
      if(total!=expectedA.size) return ByteMatch::leftUnavailable;
      return stable();
    }
  }
}
bool current(const std::string& path,const FileInfo& expected,DirectoryCursor* cursor) {
  FileInfo info;
  return (cursor ? cursor->inspect(fs::u8path(path),info) : inspectFile(fs::u8path(path),info)) && info.same(expected);
}

void groupExactFiles(DB& db,ScanContext& context,const std::function<void(const std::string&,int)>& invalid,
                     const std::function<void()>& progress) {
  auto record=[](Query& row,int start) {
    FileInfo info; info.kind=FileInfo::Kind::regular;
    info.size=row.num(start); info.modified=row.num(start+1); info.changed=row.num(start+2); info.id=row.str(start+3);
    return info;
  };
  // Path order reuses parent chains; neither names nor timestamps discard copies.
  db.exec("CREATE INDEX IF NOT EXISTS ix_comparison ON files(hash,size,gid);");
  int64_t nextGroup=1;
  Transaction transaction(db);
  Query rows(db,"SELECT path,root,size,mtime,ctime,identity,hash FROM files WHERE hash<>'' AND size>0 AND (hash,size) IN (SELECT hash,size FROM files WHERE hash<>'' AND size>0 GROUP BY hash,size HAVING count(*)>1) ORDER BY path");
  Query assign(db,"UPDATE files SET gid=? WHERE path=?");
  Query candidates(db,"SELECT path,gid,root,size,mtime,ctime,identity FROM files WHERE hash=? AND size=? AND gid>0 ORDER BY gid");
  DirectoryCursor left,right;
  size_t batch=0;
  auto checkpoint=std::chrono::steady_clock::now();
  while(rows.next()) {
    const int root=int(rows.num(1));
    struct Advance { ScanContext& c;int root;~Advance() { c.fileProgress(root);c.throttle(); } } advance{context,root};
    if(!context.waitFor(root)) continue;
    const auto path=rows.str(0);
    if(context.fileSkipped(path)) continue;
    context.currentFile(root,path);
    const auto expected=record(rows,2);
    if(!current(path,expected,&left)) { invalid(path,root); continue; }
    int64_t group=0,previous=-1;
    bool unavailable=false;
    candidates.reset();candidates.bind(1,rows.str(6));candidates.bind(2,expected.size);
    while(candidates.next()) {
      const auto candidateGroup=candidates.num(1);
      const auto candidateRoot=int(candidates.num(2));
      if(candidateGroup==previous || context.controls[candidateRoot]==2) continue;
      const auto candidate=candidates.str(0);
      if(context.fileSkipped(candidate)) continue;
      const auto candidateInfo=record(candidates,3);
      if(!current(candidate,candidateInfo,&right)) { invalid(candidate,candidateRoot); continue; }
      const auto match=equalBytes(fs::u8path(path),expected,fs::u8path(candidate),candidateInfo,root,context,candidateRoot,&left,&right);
      if(match==ByteMatch::leftUnavailable) { invalid(path,root); unavailable=true; break; }
      if(match==ByteMatch::rightUnavailable) { invalid(candidate,candidateRoot); continue; }
      if(match==ByteMatch::stopped) { if(context.controls[root]==2) break; continue; }
      previous=candidateGroup;
      if(match==ByteMatch::equal) { group=candidateGroup; break; }
    }
    candidates.reset();
    if(unavailable || context.controls[root]==2) continue;
    if(!current(path,expected,&left)) { invalid(path,root); continue; }
    if(!group) group=nextGroup++;
    assign.reset(); assign.bind(1,group); assign.bind(2,path); assign.next();
    if(++batch%loadProfile(context.loadMode.load()).hashBatch==0 || std::chrono::steady_clock::now()-checkpoint>std::chrono::seconds(1)) {
      transaction.checkpoint();checkpoint=std::chrono::steady_clock::now();
    }
    progress();
  }
  transaction.commit();
}
