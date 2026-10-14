#include "scanner.h"
#include "storage.h"
#include "comparison.h"
#include "traversal.h"
#include "report.h"
#include <chrono>
#include <unordered_set>
using namespace std::chrono_literals;
namespace {
FileInfo record(Query& row,int start) {
  FileInfo result;
  result.kind=FileInfo::Kind::regular;
  result.size=row.num(start); result.modified=row.num(start+1); result.changed=row.num(start+2); result.id=row.str(start+3);
  return result;
}
}
int scan(const json& job,ScanContext& context) {
  auto roots=job.at("roots").get<std::vector<std::string>>();
  if(roots.empty() || roots.size()>context.controls.size()) throw std::runtime_error("INVALID_ROOTS");
  std::unordered_set<std::string> unique;
  for(auto& root:roots) {
    const auto path=fs::u8path(root);
    if(!path.is_absolute() || root.find('\0')!=std::string::npos) throw std::runtime_error("INVALID_ROOT");
    for(const auto& part:path) if(part=="..") throw std::runtime_error("INVALID_ROOT");
    root=utf8(path.lexically_normal());
    if(!unique.insert(pathKey(fs::u8path(root))).second) throw std::runtime_error("DUPLICATE_ROOT");
  }
  if(job.value("content",false)) throw std::runtime_error("CONTENT_POLICY_UNDEFINED");
  const auto dbPath=fs::u8path(job.at("database").get<std::string>()).lexically_normal();
  if(!dbPath.is_absolute() || dbPath.filename().empty() || excluded(dbPath)) throw std::runtime_error("INVALID_DATABASE");
  fs::create_directories(dbPath.parent_path());
  // Validate the private working directory separately; it is never traversed.
  Directory working(dbPath.parent_path());
  std::error_code ec;
  const auto status=fs::symlink_status(dbPath,ec);
  if(!ec && status.type()!=fs::file_type::not_found && status.type()!=fs::file_type::regular) throw std::runtime_error("INVALID_DATABASE");
  DB db(utf8(dbPath));
  db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE; "
          "CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,identity TEXT UNIQUE,root INTEGER,size INTEGER,mtime INTEGER,ctime INTEGER DEFAULT 0,ext TEXT,cat TEXT,hash TEXT DEFAULT '',norm TEXT DEFAULT '',gid INTEGER DEFAULT 0,seen INTEGER DEFAULT 0); "
          "CREATE INDEX IF NOT EXISTS ix_size ON files(size); CREATE INDEX IF NOT EXISTS ix_hash ON files(hash); CREATE INDEX IF NOT EXISTS ix_gid ON files(gid); CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);");
  bool hasChangeTime=false;
  { Query columns(db,"PRAGMA table_info(files)"); while(columns.next()) if(columns.str(1)=="ctime") hasChangeTime=true; }
  if(!hasChangeTime) db.exec("ALTER TABLE files ADD COLUMN ctime INTEGER DEFAULT 0");
  // Rebuild this scan's inventory. Durable resume/cache validation belongs to stage 5.
  db.exec("DELETE FROM files;");
  const int count=int(roots.size());
  json states=json::array();
  for(auto& root:roots) states.push_back({{"path",root},{"phase","waiting"},{"files",0},{"empty",0},{"duplicate_members",0},{"duplicate_groups",0},{"errors",0},{"percent",nullptr},{"types",json::object()}});
  auto send=[&] { context.emit({{"type","progress"},{"disks",states}}); };
  auto last=std::chrono::steady_clock::now();
  auto progress=[&] { if(std::chrono::steady_clock::now()-last>250ms) { send(); last=std::chrono::steady_clock::now(); } };
  auto error=[&](int root) { states[root]["errors"]=states[root]["errors"].get<int64_t>()+1; };
  discover(db,roots,dbPath.parent_path(),states,context,progress);
  Query invalidate(db,"UPDATE files SET hash='',gid=0 WHERE path=?");
  auto invalid=[&](const std::string& path,int root) { invalidate.reset(); invalidate.bind(1,path); invalidate.next(); error(root); };
  // Materialize candidate sizes once, shared by all selected roots.
  db.exec("CREATE TEMP TABLE candidate_sizes(size INTEGER PRIMARY KEY); INSERT INTO candidate_sizes SELECT size FROM files WHERE size>0 GROUP BY size HAVING count(*)>1;");
  Query saveHash(db,"UPDATE files SET hash=? WHERE path=?");
  {
    Transaction transaction(db);
    size_t batch=0;
    for(int root=0;root<count;++root) {
      if(context.controls[root]==2 || states[root]["phase"]=="error") continue;
      states[root]["phase"]="hashing"; send();
      Query rows(db,"SELECT path,size,mtime,ctime,identity FROM files WHERE root=? AND size IN (SELECT size FROM candidate_sizes)",{root});
      while(rows.next() && context.waitFor(root)) {
        const auto path=rows.str(0);
        const auto expected=record(rows,1);
        const auto hash=digest(fs::u8path(path),expected,root,context);
        if(!hash.empty() && current(path,expected)) { saveHash.reset(); saveHash.bind(1,hash); saveHash.bind(2,path); saveHash.next(); }
        else if(context.controls[root]!=2) invalid(path,root);
        if(++batch%256==0) transaction.checkpoint();
        progress();
      }
      states[root]["phase"]=context.controls[root]==2 ? "stopped" : "comparing";
    }
    transaction.commit();
  }
  // Equality predicates followed by gid order: avoid sorting all previous
  // members for every file in a large duplicate group.
  db.exec("CREATE INDEX IF NOT EXISTS ix_comparison ON files(hash,size,gid);");
  int64_t nextGroup=1;
  {
    Transaction transaction(db);
    Query rows(db,"SELECT path,root,size,mtime,ctime,identity,hash FROM files WHERE hash<>'' AND size>0 ORDER BY path");
    Query assign(db,"UPDATE files SET gid=? WHERE path=?");
    size_t batch=0;
    while(rows.next()) {
      const int root=int(rows.num(1));
      if(!context.waitFor(root)) continue;
      const auto path=rows.str(0);
      const auto expected=record(rows,2);
      if(!current(path,expected)) { invalid(path,root); continue; }
      int64_t group=0,previous=-1;
      Query candidates(db,"SELECT path,gid,root,size,mtime,ctime,identity FROM files WHERE hash=? AND size=? AND gid>0 ORDER BY gid",{rows.str(6),expected.size});
      while(candidates.next()) {
        const auto candidateGroup=candidates.num(1);
        const auto candidateRoot=int(candidates.num(2));
        if(candidateGroup==previous || context.controls[candidateRoot]==2) continue;
        const auto candidate=candidates.str(0);
        const auto candidateInfo=record(candidates,3);
        if(!current(candidate,candidateInfo)) { invalid(candidate,candidateRoot); continue; }
        previous=candidateGroup;
        if(equalBytes(fs::u8path(path),expected,fs::u8path(candidate),candidateInfo,root,context)) { group=candidateGroup; break; }
      }
      if(!current(path,expected)) { invalid(path,root); continue; }
      if(!group) group=nextGroup++;
      assign.reset(); assign.bind(1,group); assign.bind(2,path); assign.next();
      if(++batch%256==0) transaction.checkpoint();
      progress();
    }
    transaction.commit();
  }
  // Recheck confirmed group members before reporting; changes cannot retain stale matches.
  {
    Transaction transaction(db);
    Query members(db,"SELECT path,root,size,mtime,ctime,identity FROM files WHERE gid IN (SELECT gid FROM files WHERE gid>0 GROUP BY gid HAVING count(*)>1)");
    while(members.next()) if(!current(members.str(0),record(members,2))) invalid(members.str(0),int(members.num(1)));
    for(int root=0;root<count;++root) if(context.controls[root]==2) put(db,"UPDATE files SET gid=0 WHERE root=?",{root});
    transaction.commit();
  }
  bool complete=true;
  for(int root=0;root<count;++root) {
    Query types(db,"SELECT ext,count(*) FROM files WHERE root=? GROUP BY ext",{root});
    int64_t total=0;
    while(types.next()) { states[root]["types"][types.str(0)]=types.num(1); total+=types.num(1); }
    states[root]["files"]=total; states[root]["empty"]=states[root]["types"].value("empty",int64_t(0));
    if(context.controls[root]==2) { states[root]["phase"]="stopped"; complete=false; }
    else if(states[root]["phase"]=="error" || states[root]["errors"].get<int64_t>()>0) { states[root]["phase"]="error"; complete=false; }
    else { states[root]["phase"]="completed"; states[root]["percent"]=100; }
  }
  json report=buildReport(db,count,complete);
  for(int root=0;root<count;++root) {
    states[root]["duplicate_members"]=report["statistics"]["disks"][root]["duplicate_members"];
    states[root]["duplicate_groups"]=report["statistics"]["disks"][root]["duplicate_groups"];
  }
  send(); context.emit({{"type","result"},{"report",report},{"disks",states}}); return 0;
}
