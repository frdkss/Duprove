#include "content.h"
#include "storage.h"
#include <picosha2.h>
#include <iomanip>
#include <sstream>

namespace content {
const char* statusName(Status status) {
  switch(status) {
    case Status::ready:return "ready"; case Status::empty:return "empty";
    case Status::unsupported:return "unsupported"; case Status::invalid:return "invalid";
    case Status::protectedFile:return "protected"; case Status::limit:return "limit";
    case Status::unavailable:return "unavailable"; case Status::stopped:return "stopped";
  }
  return "invalid";
}
namespace {
std::string hex(uint64_t value) { std::ostringstream out; out<<std::hex<<std::setw(16)<<std::setfill('0')<<value; return out.str(); }
FileInfo record(Query& row,int start) {
  FileInfo info; info.kind=FileInfo::Kind::regular;
  info.size=row.num(start);info.modified=row.num(start+1);info.changed=row.num(start+2);info.id=row.str(start+3);return info;
}
}
Value read(const fs::path& path,const FileInfo& expected,int root,ScanContext& context) {
  Value value;
  try {
    const auto ext=extension(path);
    const bool text=ext==".txt" || ext==".md" || ext==".markdown" || ext==".docx";
    const bool image=ext==".png" || ext==".jpg" || ext==".jpeg";
    if(!context.waitFor(root)) { value.status=Status::stopped; return value; }
    if(context.fileSkipped(utf8(path))) { value.status=Status::unavailable; return value; }
    if(expected.size==0) { value.status=Status::empty; return value; }
    if(!text && !image) return value;
    value.kind=text ? "text" : "image";
    const auto limit=text && ext!=".docx" ? maxTextBytes : maxFileBytes;
    if(expected.size<0) { value.status=Status::unavailable;return value; }
    if(uint64_t(expected.size)>limit) { value.status=Status::limit;return value; }
    FileReader file(path);
    if(!file.info().same(expected)) throw Failure{Status::unavailable};
    std::vector<unsigned char> bytes(size_t(expected.size));
    size_t offset=0;
    while(offset<bytes.size()) {
      if(!context.waitFor(root)) throw Failure{Status::stopped};
      const auto amount=std::min(size_t(262144),bytes.size()-offset);
      if(file.read(reinterpret_cast<char*>(bytes.data()+offset),amount)!=amount) throw Failure{Status::unavailable};
      offset+=amount; context.accountRead(root,amount);
      if(!file.info().same(expected)) throw Failure{Status::unavailable};
    }
    char extra;
    if(file.read(&extra,1) || !file.info().same(expected)) throw Failure{Status::unavailable};
    value=text ? decodeText(bytes,ext) : decodeImage(bytes,ext);
    context.throttle();
    if(!context.waitFor(root)) throw Failure{Status::stopped};
    if(!file.info().same(expected) || !current(utf8(path),expected)) throw Failure{Status::unavailable};
    if(value.status==Status::ready) value.hash=text ? picosha2::hash256_hex_string(value.text) : hex(value.imageHash);
  } catch(const Failure& failure) { value.status=failure.status; }
  catch(const std::bad_alloc&) { value.status=Status::limit; }
  catch(const std::exception&) { value.status=Status::unavailable; }
  return value;
}
void compareFiles(DB& db,ScanContext& context,json& states,const std::function<void(const std::string&,int)>& invalid,
                  const std::function<void()>& progress) {
  db.exec("CREATE TABLE content_files(path TEXT PRIMARY KEY,kind TEXT,status TEXT,hash TEXT,width INTEGER,height INTEGER);"
          "CREATE INDEX ix_content_hash ON content_files(kind,status,hash);"
          "CREATE TABLE content_matches(left_path TEXT,right_path TEXT,kind TEXT,PRIMARY KEY(left_path,right_path));");
  auto unavailable=[&](const std::string& path,int root,Status status) {
    put(db,"UPDATE content_files SET status=? WHERE path=?",{statusName(status),path});
    if(status==Status::unavailable) invalid(path,root);
  };
  for(auto& state:states) if(state["phase"]!="error" && state["phase"]!="stopped") state["phase"]="content";
  context.emit({{"type","progress"},{"disks",states}});
  {
    Transaction transaction(db);
    Query files(db,"SELECT path,root,size,mtime,ctime,identity FROM files ORDER BY rowid");
    size_t batch=0;
    while(files.next()) {
      const auto path=files.str(0); const int root=int(files.num(1));
      context.currentFile(root,path);
      const auto value=read(fs::u8path(path),record(files,2),root,context);
      put(db,"INSERT INTO content_files VALUES(?,?,?,?,?,?)",{path,value.kind,statusName(value.status),value.hash,value.width,value.height});
      if(value.status==Status::unavailable) invalid(path,root);
      if(++batch%128==0) transaction.checkpoint();
      context.fileProgress(root);
      progress();
    }
    transaction.commit();
  }
  for(size_t root=0;root<states.size();++root) if(states[root]["phase"]=="content") {
    auto& state=states[root]; state["phase"]="content_comparing";state["percent"]=0;
    Query number(db,"SELECT count(*) FROM files f JOIN content_files c ON c.path=f.path WHERE f.root=? AND c.status='ready'",{root});number.next();
    state["work"]["operation"]="content_comparing";state["work"]["done"]=0;state["work"]["total"]=number.num(0);state["work"]["current"]="";
  }
  context.fileProgress=[](int) {};
  context.emit({{"type","progress"},{"disks",states}});
  Transaction transaction(db);
  Query files(db,"SELECT f.path,f.root,f.size,f.mtime,f.ctime,f.identity,f.gid,f.rowid,c.kind,c.hash FROM files f JOIN content_files c ON c.path=f.path WHERE c.status='ready' ORDER BY f.rowid");
  size_t batch=0;
  while(files.next()) {
    const auto path=files.str(0); const int root=int(files.num(1)); const auto expected=record(files,2);
    context.currentFile(root,path);
    struct Advance {
      json& state;
      ~Advance() { auto& w=state["work"];w["done"]=w["done"].get<int64_t>()+1;state["percent"]=100.0*w["done"].get<int64_t>()/std::max(int64_t(1),w["total"].get<int64_t>()); }
    } advance{states[root]};
    if(!context.waitFor(root)) { unavailable(path,root,Status::stopped);continue; }
    const auto left=read(fs::u8path(path),expected,root,context);
    if(left.status!=Status::ready) { unavailable(path,root,left.status==Status::stopped ? Status::stopped : Status::unavailable);continue; }
    if(left.hash!=files.str(9)) { unavailable(path,root,Status::unavailable);continue; }
    Query candidates(db,"SELECT f.path,f.root,f.size,f.mtime,f.ctime,f.identity,c.width,c.height,c.hash FROM files f JOIN content_files c ON c.path=f.path "
      "WHERE c.status='ready' AND c.kind=? AND f.rowid<? AND (f.gid=0 OR f.gid<>?) AND (?='image' OR c.hash=?) ORDER BY f.rowid",
      {left.kind,files.num(7),files.num(6),left.kind,left.hash});
    while(candidates.next()) {
      if(!context.waitFor(root)) { unavailable(path,root,Status::stopped);break; }
      const auto other=candidates.str(0); const int otherRoot=int(candidates.num(1)); const auto otherInfo=record(candidates,2);
      if(!context.waitFor(otherRoot)) { unavailable(other,otherRoot,Status::stopped);continue; }
      if(left.kind=="image" && !imageCandidate(left.width,left.height,left.imageHash,unsigned(candidates.num(6)),unsigned(candidates.num(7)),std::stoull(candidates.str(8),nullptr,16))) continue;
      const auto right=read(fs::u8path(other),otherInfo,otherRoot,context);
      progress();
      if(right.status!=Status::ready) { unavailable(other,otherRoot,right.status==Status::stopped ? Status::stopped : Status::unavailable);continue; }
      if(right.hash!=candidates.str(8)) { unavailable(other,otherRoot,Status::unavailable);continue; }
      const bool same=left.kind=="text" ? left.text==right.text : similarImages(left,right);
      if(!same) continue;
      // A warning is only for unequal bytes, even if no exact group was assigned.
      if(expected.size==otherInfo.size) {
        const auto bytes=equalBytes(fs::u8path(path),expected,fs::u8path(other),otherInfo,root,context,otherRoot);
        if(bytes==ByteMatch::equal) continue;
        if(bytes==ByteMatch::leftUnavailable) { unavailable(path,root,Status::unavailable);break; }
        if(bytes==ByteMatch::rightUnavailable) { unavailable(other,otherRoot,Status::unavailable);continue; }
        if(bytes==ByteMatch::stopped) {
          if(context.controls[root]==2) { unavailable(path,root,Status::stopped);break; }
          unavailable(other,otherRoot,Status::stopped);continue;
        }
      }
      if(!current(path,expected)) { unavailable(path,root,Status::unavailable);break; }
      if(!current(other,otherInfo)) { unavailable(other,otherRoot,Status::unavailable);continue; }
      put(db,"INSERT INTO content_matches VALUES(?,?,?)",{other,path,left.kind});
      progress();
    }
    if(++batch%128==0) transaction.checkpoint();
    progress();
  }
  transaction.commit();
}
void validate(DB& db,ScanContext& context,const std::function<void(const std::string&,int)>& invalid) {
  Transaction transaction(db);
  Query files(db,"SELECT f.path,f.root,f.size,f.mtime,f.ctime,f.identity,c.status FROM files f JOIN content_files c ON c.path=f.path");
  while(files.next()) {
    const int root=int(files.num(1)); const auto path=files.str(0);
    context.currentFile(root,path);context.waitFor(root);
    if(context.controls[root]==2) put(db,"UPDATE content_files SET status='stopped' WHERE path=?",{path});
    else if(files.str(6)=="ready" && !current(path,record(files,2))) {
      put(db,"UPDATE content_files SET status='unavailable' WHERE path=?",{path});invalid(path,root);
    }
    context.fileProgress(root);
  }
  db.exec("DELETE FROM content_matches WHERE left_path IN (SELECT path FROM content_files WHERE status<>'ready') OR right_path IN (SELECT path FROM content_files WHERE status<>'ready')");
  transaction.commit();
}
json result(DB& db,bool enabled) {
  json output={{"enabled",enabled},{"policy_version",1},{"complete",true},{"files",json::object()},
    {"warning_pairs",{{"text",0},{"image",0}}},{"warnings",json::array()}};
  if(!enabled) return output;
  for(auto status:{Status::ready,Status::empty,Status::unsupported,Status::invalid,Status::protectedFile,Status::limit,Status::unavailable,Status::stopped}) output["files"][statusName(status)]=0;
  Query counts(db,"SELECT status,count(*) FROM content_files GROUP BY status");
  while(counts.next()) {
    output["files"][counts.str(0)]=counts.num(1);
    if(counts.str(0)=="unavailable" || counts.str(0)=="stopped") output["complete"]=false;
  }
  Query pairs(db,"SELECT m.kind,a.rowid,a.root,a.ext,a.cat,b.rowid,b.root,b.ext,b.cat FROM content_matches m JOIN files a ON a.path=m.left_path JOIN files b ON b.path=m.right_path ORDER BY a.rowid,b.rowid");
  while(pairs.next()) {
    const auto kind=pairs.str(0);
    output["warning_pairs"][kind]=output["warning_pairs"][kind].get<int64_t>()+1;
    json members=json::array();
    for(int index:{1,5}) members.push_back({{"id",pairs.num(index)},{"disk",pairs.num(index+1)},{"extension",pairs.str(index+2)},{"category",pairs.str(index+3)}});
    output["warnings"].push_back({{"status","warn"},{"kind",kind},{"files",members}});
  }
  return output;
}
}
