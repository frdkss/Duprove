#include "traversal.h"
#include "file_access.h"
#include "diagnostics.h"
#include "user_dirs.h"
#include <unordered_set>

void discover(DB& db,const std::vector<std::string>& roots,const fs::path& workingDirectory,
              json& states,ScanContext& context,const std::function<void()>& progress) {
  std::unordered_set<std::string> boundaries;
  for(const auto& mount:mountPaths()) boundaries.insert(pathKey(mount));
  for(const auto& root:roots) boundaries.insert(pathKey(fs::u8path(root)));
  const auto folders=knownFolders();
  db.exec("CREATE TEMP TABLE dirs(id INTEGER PRIMARY KEY,path TEXT UNIQUE,identity TEXT UNIQUE,root INTEGER,done INTEGER DEFAULT 0);"
          "CREATE INDEX temp.ix_pending_dirs ON dirs(root,done,id);");
  Query enqueue(db,"INSERT OR IGNORE INTO dirs(path,identity,root) VALUES(?,?,?)");
  Query pending(db,"SELECT id,path,identity FROM dirs WHERE root=? AND done=0 ORDER BY id LIMIT 1");
  Query finish(db,"UPDATE dirs SET done=1 WHERE id=?");
  // First selected root owns hard links; the inventory is rebuilt for cache validation.
  Query file(db,"INSERT OR IGNORE INTO files(path,identity,root,size,mtime,ctime,ext,cat,name,seen) VALUES(?,?,?,?,?,?,?,?,?,1)");
  auto queue=[&](const fs::path& path,const FileInfo& info,int root) {
    enqueue.reset(); enqueue.bind(1,utf8(path)); enqueue.bind(2,info.id); enqueue.bind(3,root); enqueue.next();
    if(sqlite3_changes(db.db)) states[root]["work"]["total"]=states[root]["work"]["total"].get<int64_t>()+1;
  };
  for(size_t index=0;index<roots.size();++index) {
    const int root=int(index);
    auto& state=states[index];
    state["work"]={{"operation","discovering"},{"current",""},{"done",0},{"total",0},{"unit","directories"},{"read_bytes",0}};
    const auto base=fs::u8path(roots[index]);
    auto error=[&](const char* code) { recordIssue(state,code,"discovering"); };
    std::string device,rootIdentity;
    FileInfo rootInfo;
    try {
      if(excluded(base) || pathWithin(base,workingDirectory)) throw std::runtime_error("EXCLUDED_ROOT");
      Directory directory(base);
      rootInfo=directory.info(); device=rootInfo.device; rootIdentity=rootInfo.id;
    } catch(const std::exception&) { state["phase"]="error"; error("root_unavailable"); continue; }
    queue(base,rootInfo,root);
    std::unordered_set<std::string> devices{device};
#ifdef __APPLE__
    // The APFS Data volume is part of the logical startup disk via firmlinks.
    if(base=="/") { try { Directory data("/System/Volumes/Data"); devices.insert(data.info().device); } catch(const std::exception&) {} }
#endif
    state["phase"]="discovering";
    state["percent"]=0;
    context.emit({{"type","progress"},{"disks",states}});
    Transaction transaction(db);
    size_t batch=0;
    std::unique_ptr<Directory> directory;
    while(context.waitFor(root)) {
      pending.reset(); pending.bind(1,root);
      if(!pending.next()) break;
      const auto id=pending.num(0);
      const auto path=fs::u8path(pending.str(1));
      state["work"]["current"]=utf8(path);
      const auto expected=pending.str(2);
      pending.reset();
      // Only filesystem failures are recoverable; database errors abort the job.
      try { directory=std::make_unique<Directory>(path,directory.get()); }
      catch(const std::exception&) { error("directory_unavailable"); directory.reset(); }
      if(directory && (directory->info().id!=expected || !devices.count(directory->info().device))) { error("directory_changed"); directory.reset(); }
      if(directory) {
        const auto cat=folderCategory(path,folders);
        while(context.waitFor(root)) {
          FileEntry entry;
          try { if(!directory->next(entry)) break; }
          catch(const std::exception&) { error("enumeration_failed"); break; }
          if(entry.error) error("metadata_unavailable");
          else if(entry.info.kind!=FileInfo::Kind::skip && !pathWithin(entry.path,workingDirectory)) {
            // Prepare filesystem-derived values separately from database work:
            // path/metadata errors skip one entry; index errors must propagate.
            std::string encodedPath,key,name,ext;
            try {
              encodedPath=utf8(entry.path); key=pathKey(entry.path);
              if(entry.info.kind==FileInfo::Kind::regular) {
                name=utf8(entry.path.filename());
                ext=entry.info.size==0 ? std::string("empty") : extension(entry.path);
              }
            } catch(const std::exception&) { error("metadata_unavailable"); continue; }
            if(entry.info.kind==FileInfo::Kind::directory) {
              // Hidden, virtual and bind mounts are boundaries too.
              if(!boundaries.count(key) && devices.count(entry.info.device)) queue(entry.path,entry.info,root);
            } else if(devices.count(entry.info.device) && !boundaries.count(key)) {
              file.reset(); file.bind(1,encodedPath); file.bind(2,entry.info.id); file.bind(3,root);
              file.bind(4,entry.info.size); file.bind(5,entry.info.modified); file.bind(6,entry.info.changed);
              file.bind(7,ext); file.bind(8,cat);
              file.bind(9,name); file.next();
              if(sqlite3_changes(db.db)) {
                state["files"]=state["files"].get<int64_t>()+1;
                state["types"][ext]=state["types"].value(ext,int64_t(0))+1;
                if(entry.info.size==0) state["empty"]=state["empty"].get<int64_t>()+1;
              }
            }
          }
          if(++batch%1024==0) { transaction.checkpoint(); progress(); context.throttle(); }
        }
      }
      if(context.controls[root]!=2) {
        finish.reset(); finish.bind(1,id); finish.next();
        auto& work=state["work"];
        work["done"]=work["done"].get<int64_t>()+1;
        // The frontier grows during traversal; this is an estimate, never completion.
        state["percent"]=std::min(99.0,100.0*work["done"].get<int64_t>()/work["total"].get<int64_t>());
      }
      progress();
    }
    directory.reset();
    transaction.commit();
    try { Directory check(base); if(check.info().id!=rootIdentity) error("directory_changed"); }
    catch(const std::exception&) { error("directory_unavailable"); }
    state["phase"]=context.controls[root]==2 ? "stopped" : "waiting";
    state["percent"]=nullptr;
  }
}
