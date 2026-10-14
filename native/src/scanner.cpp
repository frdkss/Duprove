#include "scanner.h"
#include "storage.h"
#include "comparison.h"
#include "traversal.h"
#include "report.h"
#include <chrono>
using namespace std::chrono_literals;
int scan(const json& job,ScanContext& context){
 auto roots=job.at("roots").get<std::vector<std::string>>();
 if(roots.empty()||roots.size()>context.controls.size()) throw std::runtime_error("INVALID_ROOTS");
 for(const auto& root:roots) if(!fs::u8path(root).is_absolute()) throw std::runtime_error("INVALID_ROOT");
 if(job.value("content",false)) throw std::runtime_error("CONTENT_POLICY_UNDEFINED");
 auto dbPath=fs::u8path(job.at("database").get<std::string>());fs::create_directories(dbPath.parent_path()); DB db(utf8(dbPath));
 db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-4096; PRAGMA temp_store=FILE; CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,identity TEXT UNIQUE,root INTEGER,size INTEGER,mtime INTEGER,ext TEXT,cat TEXT,hash TEXT DEFAULT '',norm TEXT DEFAULT '',gid INTEGER DEFAULT 0,seen INTEGER DEFAULT 0); CREATE INDEX IF NOT EXISTS ix_size ON files(size); CREATE INDEX IF NOT EXISTS ix_hash ON files(hash); CREATE INDEX IF NOT EXISTS ix_gid ON files(gid); CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);");
 db.exec("UPDATE files SET seen=0,gid=0;");
 int count=int(roots.size());
 json states=json::array();for(auto& r:roots)states.push_back({{"path",r},{"phase","waiting"},{"files",0},{"empty",0},{"duplicate_members",0},{"duplicate_groups",0},{"errors",0},{"percent",nullptr},{"types",json::object()}});
 auto send=[&](){context.emit({{"type","progress"},{"disks",states}});};
 auto last=std::chrono::steady_clock::now();auto progress=[&](){if(std::chrono::steady_clock::now()-last>250ms){send();last=std::chrono::steady_clock::now();}};
 discover(db,roots,dbPath.parent_path(),states,context,progress);
 db.exec("DELETE FROM files WHERE seen=0;");
 for(int root=0;root<count;root++){
  Query types(db,"SELECT ext,count(*) FROM files WHERE root=? GROUP BY ext",{root});int64_t total=0;while(types.next()){states[root]["types"][types.str(0)]=types.num(1);total+=types.num(1);}states[root]["files"]=total;states[root]["empty"]=states[root]["types"].value("empty",int64_t(0));
 }
 for(int root=0;root<count;root++){
  if(context.controls[root]==2||states[root]["phase"]=="error")continue;
  states[root]["phase"]="hashing";send();
  int64_t total=0;{Query q(db,"SELECT count(*) FROM files WHERE root=? AND size>0 AND size IN (SELECT size FROM files WHERE size>0 GROUP BY size HAVING count(*)>1)",{root});q.next();total=q.num(0);}
  Query rows(db,"SELECT path,size,mtime,hash FROM files WHERE root=? AND size>0 AND size IN (SELECT size FROM files WHERE size>0 GROUP BY size HAVING count(*)>1)",{root});
  int64_t done=0;while(rows.next()&&context.waitFor(root)){
   auto p=rows.str(0);auto hash=rows.str(3);
   if(current(p,rows.num(1),rows.num(2))){if(hash.empty())hash=digest(fs::u8path(p),root,context);
    if(current(p,rows.num(1),rows.num(2)))put(db,"UPDATE files SET hash=? WHERE path=?",{hash,p});else put(db,"UPDATE files SET hash='',norm='' WHERE path=?",{p});
   }else {put(db,"UPDATE files SET hash='',norm='' WHERE path=?",{p});states[root]["errors"]=states[root]["errors"].get<int>()+1;}
   states[root]["percent"]=total?int(++done*80/total):80;progress();
  }
  states[root]["phase"]=context.controls[root]==2?"stopped":"comparing";
 }
 int64_t nextGroup=1; Query rows(db,"SELECT path,root,size,mtime,hash FROM files WHERE hash<>'' AND size>0 ORDER BY path");
 while(rows.next()){
  int root=int(rows.num(1));if(!context.waitFor(root))continue;auto p=rows.str(0);if(!current(p,rows.num(2),rows.num(3)))continue;
  int64_t group=0;Query candidates(db,"SELECT path,gid,size,mtime,root FROM files WHERE hash=? AND size=? AND gid>0 ORDER BY gid",{rows.str(4),rows.num(2)});
  int64_t previous=-1;while(candidates.next()){
   if(candidates.num(1)==previous||context.controls[size_t(candidates.num(4))]==2)continue;
   previous=candidates.num(1);
   if(current(candidates.str(0),candidates.num(2),candidates.num(3))&&equalBytes(fs::u8path(p),fs::u8path(candidates.str(0)),root,context)&&current(p,rows.num(2),rows.num(3))&&current(candidates.str(0),candidates.num(2),candidates.num(3))){group=candidates.num(1);break;}
  }
  if(!group)group=nextGroup++;
  put(db,"UPDATE files SET gid=? WHERE path=?",{group,p});progress();
 }
 for(int root=0;root<count;root++)if(context.controls[root]==2)put(db,"UPDATE files SET gid=0 WHERE root=?",{root});
 bool complete=true;
 for(int root=0;root<count;root++){
  if(context.controls[root]==2){states[root]["phase"]="stopped";complete=false;}else if(states[root]["phase"]=="error")complete=false;else{states[root]["phase"]="completed";states[root]["percent"]=100;}
 }
 json report=buildReport(db,count,complete);
 for(int root=0;root<count;root++) {
  states[root]["duplicate_members"]=report["statistics"]["disks"][root]["duplicate_members"];
  states[root]["duplicate_groups"]=report["statistics"]["disks"][root]["duplicate_groups"];
 }
 send();context.emit({{"type","result"},{"report",report},{"disks",states}});return 0;
}
