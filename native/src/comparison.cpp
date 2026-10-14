#include "comparison.h"
#include <picosha2.h>
#include "storage.h"
#include <algorithm>
std::string digest(const fs::path& path,const FileInfo& expected,int root,ScanContext& context) {
  try {
    FileReader file(path);
    if(!file.info().same(expected)) return "";
    picosha2::hash256_one_by_one hash;
    std::array<unsigned char,262144> buffer;
    int64_t total=0;
    for(;;) {
      if(!context.waitFor(root)) return "";
      const auto n=file.read(reinterpret_cast<char*>(buffer.data()),buffer.size());
      total+=int64_t(n);
      if(total>expected.size) return "";
      if(!n) break;
      hash.process(buffer.begin(),buffer.begin()+n);
      context.throttle();
    }
    if(total!=expected.size || !file.info().same(expected)) return "";
    hash.finish(); return picosha2::get_hash_hex_string(hash);
  } catch(const std::exception&) { return ""; }
}
ByteMatch equalBytes(const fs::path& a,const FileInfo& expectedA,const fs::path& b,const FileInfo& expectedB,
                     int root,ScanContext& context,int otherRoot) {
  std::unique_ptr<FileReader> x,y;
  try { x=std::make_unique<FileReader>(a); if(!x->info().same(expectedA)) return ByteMatch::leftUnavailable; }
  catch(const std::exception&) { return ByteMatch::leftUnavailable; }
  try { y=std::make_unique<FileReader>(b); if(!y->info().same(expectedB)) return ByteMatch::rightUnavailable; }
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
    context.throttle();
  }
}
bool current(const std::string& path,const FileInfo& expected) {
  FileInfo info;
  return inspectFile(fs::u8path(path),info) && info.same(expected);
}

void groupExactFiles(DB& db,ScanContext& context,const std::function<void(const std::string&,int)>& invalid,
                     const std::function<void()>& progress) {
  auto record=[](Query& row,int start) {
    FileInfo info; info.kind=FileInfo::Kind::regular;
    info.size=row.num(start); info.modified=row.num(start+1); info.changed=row.num(start+2); info.id=row.str(start+3);
    return info;
  };
  // Metadata orders work locally; neither name nor mtime can discard a copy.
  db.exec("CREATE INDEX IF NOT EXISTS ix_comparison ON files(hash,size,gid);");
  int64_t nextGroup=1;
  Transaction transaction(db);
  Query rows(db,"SELECT path,root,size,mtime,ctime,identity,hash FROM files WHERE hash<>'' AND size>0 ORDER BY size,name,mtime,path");
  Query assign(db,"UPDATE files SET gid=? WHERE path=?");
  size_t batch=0;
  while(rows.next()) {
    const int root=int(rows.num(1));
    if(!context.waitFor(root)) continue;
    const auto path=rows.str(0);
    const auto expected=record(rows,2);
    if(!current(path,expected)) { invalid(path,root); continue; }
    int64_t group=0,previous=-1;
    bool unavailable=false;
    Query candidates(db,"SELECT path,gid,root,size,mtime,ctime,identity FROM files WHERE hash=? AND size=? AND gid>0 ORDER BY gid",{rows.str(6),expected.size});
    while(candidates.next()) {
      const auto candidateGroup=candidates.num(1);
      const auto candidateRoot=int(candidates.num(2));
      if(candidateGroup==previous || context.controls[candidateRoot]==2) continue;
      const auto candidate=candidates.str(0);
      const auto candidateInfo=record(candidates,3);
      if(!current(candidate,candidateInfo)) { invalid(candidate,candidateRoot); continue; }
      const auto match=equalBytes(fs::u8path(path),expected,fs::u8path(candidate),candidateInfo,root,context,candidateRoot);
      if(match==ByteMatch::leftUnavailable) { invalid(path,root); unavailable=true; break; }
      if(match==ByteMatch::rightUnavailable) { invalid(candidate,candidateRoot); continue; }
      if(match==ByteMatch::stopped) { if(context.controls[root]==2) break; continue; }
      previous=candidateGroup;
      if(match==ByteMatch::equal) { group=candidateGroup; break; }
    }
    if(unavailable || context.controls[root]==2) continue;
    if(!current(path,expected)) { invalid(path,root); continue; }
    if(!group) group=nextGroup++;
    assign.reset(); assign.bind(1,group); assign.bind(2,path); assign.next();
    if(++batch%256==0) transaction.checkpoint();
    progress();
  }
  transaction.commit();
}
