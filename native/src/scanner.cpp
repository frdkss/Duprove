#include "scanner.h"
#include "storage.h"
#include "comparison.h"
#include "content.h"
#include "traversal.h"
#include "report.h"
#include "load_profile.h"
#include "diagnostics.h"
#include "parallel_hash.h"
#include <chrono>
#include <unordered_set>
#include <thread>
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
  context.readBytes=0;context.reusedHashes=0;
  size_t hashWorkers=1;
  const int hashMemoryMiB=loadProfile(context.loadMode.load()).memoryMiB;
  const size_t bufferBudget=size_t(32)<<std::clamp(context.loadMode.load(),0,2);
  content::maxTextBytes=bufferBudget*1024*1024/128;
  content::maxFileBytes=bufferBudget*1024*1024/8;
  content::maxPixels=bufferBudget*1024*1024/64;
  content::decoderMemoryMiB=int(bufferBudget/4);
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
  const bool checkContent=job.value("content",false);
  const auto dbPath=fs::u8path(job.at("database").get<std::string>()).lexically_normal();
  if(!dbPath.is_absolute() || dbPath.filename().empty() || excluded(dbPath)) throw std::runtime_error("INVALID_DATABASE");
  fs::create_directories(dbPath.parent_path());
  const auto privateDirectory=fs::u8path(job.value("private_directory",utf8(dbPath.parent_path()))).lexically_normal();
  if(!privateDirectory.is_absolute() || !pathWithin(dbPath,privateDirectory)) throw std::runtime_error("INVALID_PRIVATE_DIRECTORY");
  Directory privateCheck(privateDirectory);
  // Validate the private working directory separately; it is never traversed.
  Directory working(dbPath.parent_path());
  std::error_code ec;
  const auto status=fs::symlink_status(dbPath,ec);
  if(!ec && status.type()!=fs::file_type::not_found && status.type()!=fs::file_type::regular) throw std::runtime_error("INVALID_DATABASE");
  DB db(utf8(dbPath));
  const int count=int(roots.size());
  json states=json::array();
  for(auto& root:roots) states.push_back({{"path",root},{"phase","waiting"},{"files",0},{"empty",0},{"duplicate_members",0},{"duplicate_groups",0},{"errors",0},{"percent",nullptr},{"types",json::object()}});
  auto send=[&] { context.emit({{"type","progress"},{"disks",states}}); };
  auto last=std::chrono::steady_clock::now();
  // SQLite may spend seconds sorting or grouping. This callback only publishes
  // in-memory state: querying the same connection here would be reentrant.
  std::function<void()> databasePulse=[&] {
    for(;;) {
      if(std::chrono::steady_clock::now()-last>250ms) { last=std::chrono::steady_clock::now();send(); }
      bool paused=false,running=false;
      for(int root=0;root<count;++root) { paused|=context.controls[root]==1;running|=context.controls[root]==0; }
      if(!paused || running) break;
      std::this_thread::sleep_for(25ms);
    }
  };
  sqlite3_progress_handler(db.db,10000,[](void* p) { (*static_cast<std::function<void()>*>(p))();return 0; },&databasePulse);
  struct ClearHandler { sqlite3* db; ~ClearHandler() { sqlite3_progress_handler(db,0,nullptr,nullptr); } } clearHandler{db.db};
  for(auto& state:states) state["work"]={{"operation","initializing"},{"current",""},{"done",0},{"total",nullptr},{"unit","files"},{"read_bytes",0}};
  send();
  db.exec(("PRAGMA cache_size=-"+std::to_string(loadProfile(context.loadMode.load()).databaseCacheMiB*1024)).c_str());
  db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=FILE; "
          "CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,identity TEXT UNIQUE,root INTEGER,size INTEGER,mtime INTEGER,ctime INTEGER DEFAULT 0,ext TEXT,cat TEXT,name TEXT DEFAULT '',hash TEXT DEFAULT '',norm TEXT DEFAULT '',gid INTEGER DEFAULT 0,seen INTEGER DEFAULT 0); "
          "CREATE INDEX IF NOT EXISTS ix_size ON files(size); CREATE INDEX IF NOT EXISTS ix_hash ON files(hash); CREATE INDEX IF NOT EXISTS ix_gid ON files(gid); CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);");
  bool hasChangeTime=false,hasName=false;
  { Query columns(db,"PRAGMA table_info(files)"); while(columns.next()) { if(columns.str(1)=="ctime") hasChangeTime=true; if(columns.str(1)=="name") hasName=true; } }
  if(!hasChangeTime) db.exec("ALTER TABLE files ADD COLUMN ctime INTEGER DEFAULT 0");
  if(!hasName) db.exec("ALTER TABLE files ADD COLUMN name TEXT DEFAULT ''");
  // Persist completed hashes across interruptions, but never trust old membership or inventory.
  // Copy and clear atomically: a crash here cannot lose the preceding checkpoint.
  {
    Transaction transaction(db);
    db.exec("CREATE TABLE IF NOT EXISTS hash_cache(path TEXT PRIMARY KEY,identity TEXT,size INTEGER,mtime INTEGER,ctime INTEGER,hash TEXT);"
            "INSERT OR REPLACE INTO hash_cache SELECT path,identity,size,mtime,ctime,hash FROM files WHERE hash<>'';"
            "DELETE FROM files; DROP TABLE IF EXISTS content_matches; DROP TABLE IF EXISTS content_files;");
    transaction.commit();
  }
  auto lastGroups=std::chrono::steady_clock::now();
  auto progress=[&] { if(std::chrono::steady_clock::now()-last>250ms) {
    if(std::chrono::steady_clock::now()-lastGroups>2s && std::any_of(states.begin(),states.end(),[](const json& state) { return state["phase"]=="comparing"; })) {
      std::vector<int64_t> members(count),counts(count);
      Query groups(db,"SELECT root,count(*),count(DISTINCT gid) FROM files WHERE gid IN (SELECT gid FROM files WHERE gid>0 GROUP BY gid HAVING count(*)>1) GROUP BY root");
      while(groups.next()) { members[groups.num(0)]=groups.num(1);counts[groups.num(0)]=groups.num(2); }
      for(int root=0;root<count;++root) { states[root]["duplicate_members"]=members[root];states[root]["duplicate_groups"]=counts[root]; }
      lastGroups=std::chrono::steady_clock::now();
    }
    send(); last=std::chrono::steady_clock::now();
  } };
  context.pulse=progress;
  // Avoid callbacks referencing this stack after scan returns (also on exception).
  struct Reset { ScanContext& c; ~Reset() { c.pulse=[]{};c.readProgress=[](int,size_t){};c.fileProgress=[](int){};c.currentFile=[](int,const std::string&){}; } } reset{context};
  auto work=[&](int root,const char* operation,const char* unit,json total) {
    const auto read=states[root].contains("work") ? states[root]["work"].value("read_bytes",uint64_t(0)) : 0;
    states[root]["work"]={{"operation",operation},{"current",""},{"done",0},{"total",total},{"unit",unit},{"read_bytes",read}};
  };
  context.currentFile=[&](int root,const std::string& path) { states[root]["work"]["current"]=path; };
  std::vector<int64_t> totals(count),done(count);
  auto update=[&](int root) {
    states[root]["percent"]=totals[root]>0 ? json(std::min(100.0,100.0*done[root]/totals[root])) : json(100);
    states[root]["work"]["done"]=std::min(done[root],totals[root]);states[root]["work"]["total"]=totals[root];
  };
  discover(db,roots,privateDirectory,states,context,progress);
  for(int root=0;root<count;++root) if(states[root]["phase"]=="waiting") work(root,"preparing","files",nullptr);
  send();
  Query invalidate(db,"UPDATE files SET hash='',gid=0 WHERE path=?");
  auto invalid=[&](const std::string& path,int root) { invalidate.reset(); invalidate.bind(1,path); invalidate.next(); recordIssue(states[root],"file_unavailable_or_changed"); };
  // Materialize candidate sizes once, shared by all selected roots.
  db.exec("CREATE TEMP TABLE candidate_sizes(size INTEGER PRIMARY KEY); INSERT INTO candidate_sizes SELECT size FROM files WHERE size>0 GROUP BY size HAVING count(*)>1;");
  Query saveHash(db,"UPDATE files SET hash=? WHERE path=?");
  Query cached(db,"SELECT hash FROM hash_cache WHERE path=? AND identity=? AND size=? AND mtime=? AND ctime=?");
  context.readProgress=[&](int root,size_t bytes) {
    states[root]["work"]["read_bytes"]=states[root]["work"]["read_bytes"].get<uint64_t>()+bytes;
    done[root]+=int64_t(bytes); update(root);
  };
  {
    Transaction transaction(db);
    size_t batch=0;
    auto checkpoint=std::chrono::steady_clock::now();
    for(int root=0;root<count;++root) {
      if(context.controls[root]==2 || states[root]["phase"]=="error") continue;
      Query size(db,"SELECT coalesce(sum(size),0),count(*) FROM files WHERE root=? AND size IN (SELECT size FROM candidate_sizes)",{root});size.next();totals[root]=size.num(0);
      states[root]["phase"]="hashing";work(root,"hashing","bytes",totals[root]);update(root);send();
      states[root]["work"]["files_done"]=0;states[root]["work"]["files_total"]=size.num(1);states[root]["work"]["cached_files"]=0;
      DirectoryCursor directory;
      std::unique_ptr<ParallelHasher> parallel;
      struct Pending { std::string path;FileInfo expected;std::future<HashResult> result; };
      std::deque<Pending> pending;
      auto flushRead=[&] {
        if(parallel) if(const auto bytes=parallel->takeReadBytes()) context.accountRead(root,size_t(bytes));
      };
      auto finish=[&](const std::string& path,const FileInfo& expected,const HashResult& result) {
        if(!result.hash.empty()) {
          saveHash.reset();saveHash.bind(1,result.hash);saveHash.bind(2,path);saveHash.next();
          if(result.cacheHit) { ++context.reusedHashes;states[root]["work"]["cached_files"]=states[root]["work"]["cached_files"].get<int64_t>()+1; }
        } else if(context.controls[root]!=2) invalid(path,root);
        // Read chunks from all workers are already counted. Credit only the
        // unconsumed remainder (cache hits or failed reads), exactly once.
        if(context.controls[root]!=2 || !result.hash.empty()) {
          done[root]+=expected.size-int64_t(result.readBytes);update(root);
          states[root]["work"]["files_done"]=states[root]["work"]["files_done"].get<int64_t>()+1;
        }
        if(++batch%loadProfile(context.loadMode.load()).hashBatch==0 || std::chrono::steady_clock::now()-checkpoint>1s) { transaction.checkpoint();checkpoint=std::chrono::steady_clock::now(); }
        progress();
      };
      auto receive=[&] {
        auto& next=pending.front();context.currentFile(root,next.path);
        while(next.result.wait_for(25ms)!=std::future_status::ready) { flushRead();progress(); }
        const auto result=next.result.get();flushRead();
        context.waitFor(root);
        finish(next.path,next.expected,result);pending.pop_front();
      };
      Query rows(db,"SELECT path,size,mtime,ctime,identity FROM files WHERE root=? AND size IN (SELECT size FROM candidate_sizes) ORDER BY path",{root});
      while(rows.next() && context.waitFor(root)) {
        // A runtime mode change drains at most two files per worker before
        // returning to serial throttled work. No unbounded background queue.
        if(parallel && context.loadMode!=2) {
          while(!pending.empty()) receive();
          parallel.reset();
        }
        if(!parallel && context.loadMode==2) {
          parallel=std::make_unique<ParallelHasher>(context,root,size_t(size.num(1)),hashMemoryMiB);
          hashWorkers=std::max(hashWorkers,parallel->size());
        }
        const auto path=rows.str(0);
        const auto expected=record(rows,1);
        cached.reset();cached.bind(1,path);cached.bind(2,expected.id);cached.bind(3,expected.size);cached.bind(4,expected.modified);cached.bind(5,expected.changed);
        std::string hash;
        const bool cacheHit=cached.next() && cached.str(0).size()==64;
        if(cacheHit) hash=cached.str(0);
        cached.reset();
        if(parallel) {
          pending.push_back({path,expected,parallel->submit(path,expected,std::move(hash))});
          if(pending.size()>=parallel->size()*2) receive();
        } else {
          context.currentFile(root,path);
          const auto before=context.readBytes;
          try {
            const auto filePath=fs::u8path(path);
            auto* parent=directory.parent(filePath);
            if(!cacheHit) hash=digest(filePath,expected,root,context,parent);
            if(!hash.empty() && !current(path,expected,&directory)) hash.clear();
          } catch(const std::exception&) { hash.clear(); }
          finish(path,expected,{hash,context.readBytes-before,cacheHit});
          context.throttle();
        }
      }
      while(!pending.empty()) receive();
      states[root]["phase"]=context.controls[root]==2 ? "stopped" : "waiting";
      states[root]["percent"]=nullptr;
    }
    transaction.commit();
  }
  context.readProgress=[&](int root,size_t bytes) { states[root]["work"]["read_bytes"]=states[root]["work"]["read_bytes"].get<uint64_t>()+bytes; };
  // Unique hashes cannot have exact copies. Avoid reopening and updating every
  // unique file during byte comparison, especially on a warm hash cache.
  db.exec("CREATE TEMP TABLE exact_candidates(hash TEXT,size INTEGER,PRIMARY KEY(hash,size));"
          "INSERT INTO exact_candidates SELECT hash,size FROM files WHERE hash<>'' AND size>0 GROUP BY hash,size HAVING count(*)>1;");
  for(int root=0;root<count;++root) {
    if(states[root]["phase"]=="waiting") states[root]["phase"]="comparing";
    Query number(db,"SELECT count(*) FROM files f JOIN exact_candidates c ON c.hash=f.hash AND c.size=f.size WHERE root=?",{root});number.next();totals[root]=number.num(0);done[root]=0;
    if(states[root]["phase"]=="comparing") { work(root,"comparing","files",totals[root]);update(root); } else states[root]["percent"]=nullptr;
  }
  context.fileProgress=[&](int root) { ++done[root];update(root); };
  send();
  groupExactFiles(db,context,invalid,progress);
  // Give content phases the confirmed exact-match counters, even on tiny fixtures.
  {
    Query groups(db,"SELECT root,count(*),count(DISTINCT gid) FROM files WHERE gid IN (SELECT gid FROM files WHERE gid>0 GROUP BY gid HAVING count(*)>1) GROUP BY root");
    while(groups.next()) { states[groups.num(0)]["duplicate_members"]=groups.num(1);states[groups.num(0)]["duplicate_groups"]=groups.num(2); }
  }
  if(checkContent) {
    for(int root=0;root<count;++root) { totals[root]=states[root]["files"].get<int64_t>();done[root]=0;if(states[root]["phase"]=="comparing") { work(root,"content","files",totals[root]);update(root); } }
    content::compareFiles(db,context,states,invalid,progress);
  }
  for(int root=0;root<count;++root) if(states[root]["phase"]!="error" && states[root]["phase"]!="stopped") {
    states[root]["phase"]="validating";states[root]["percent"]=nullptr;done[root]=0;
    work(root,"validating","files",nullptr);
    Query number(db,"SELECT count(*) FROM files WHERE root=? AND gid IN (SELECT gid FROM files WHERE gid>0 GROUP BY gid HAVING count(*)>1)",{root});number.next();totals[root]=number.num(0);
    if(checkContent) totals[root]+=states[root]["files"].get<int64_t>();
    work(root,"validating","files",totals[root]);update(root);
  }
  context.fileProgress=[&](int root) { ++done[root];update(root); };
  send();
  if(checkContent) content::validate(db,context,invalid);
  // Recheck confirmed group members before reporting; changes cannot retain stale matches.
  {
    Transaction transaction(db);
    Query members(db,"SELECT path,root,size,mtime,ctime,identity FROM files WHERE gid IN (SELECT gid FROM files WHERE gid>0 GROUP BY gid HAVING count(*)>1) ORDER BY path");
    DirectoryCursor validation;
    while(members.next()) {
      const int root=int(members.num(1));context.currentFile(root,members.str(0));
      if(context.waitFor(root) && !current(members.str(0),record(members,2),&validation)) invalid(members.str(0),root);
      context.fileProgress(root);
    }
    for(int root=0;root<count;++root) if(context.controls[root]==2) put(db,"UPDATE files SET gid=0 WHERE root=?",{root});
    transaction.commit();
  }
  bool complete=true;
  for(int root=0;root<count;++root) if(states[root]["phase"]=="validating") work(root,"saving","files",nullptr);
  for(int root=0;root<count;++root) {
    Query types(db,"SELECT ext,count(*) FROM files WHERE root=? GROUP BY ext",{root});
    int64_t total=0;
    while(types.next()) { states[root]["types"][types.str(0)]=types.num(1); total+=types.num(1); }
    states[root]["files"]=total; states[root]["empty"]=states[root]["types"].value("empty",int64_t(0));
    if(context.controls[root]==2) { states[root]["phase"]="stopped"; complete=false; }
    else if(states[root]["phase"]=="error" || states[root]["errors"].get<int64_t>()>0) { states[root]["phase"]="error"; complete=false; }
    // Keep validation visible until report construction has also finished.
  }
  json report=buildReport(db,count,complete);
  context.throttle();
  for(int root=0;root<count;++root) {
    states[root]["duplicate_members"]=report["statistics"]["disks"][root]["duplicate_members"];
    states[root]["duplicate_groups"]=report["statistics"]["disks"][root]["duplicate_groups"];
  }
  auto contentResult=content::result(db,checkContent);
  context.throttle();
  if(checkContent && !complete) contentResult["complete"]=false;
  // The current inventory is sufficient as the next cache after a successful scan.
  if(complete) db.exec("DROP TABLE hash_cache;");
  for(auto& state:states) if(state["phase"]=="validating") { state["phase"]="completed";state["percent"]=100; }
  send(); context.emit({{"type","result"},{"report",report},{"disks",states},{"content",contentResult},
    {"resources",{{"read_bytes",context.readBytes},{"reused_hashes",context.reusedHashes},{"hash_workers",hashWorkers}}}}); return 0;
}
