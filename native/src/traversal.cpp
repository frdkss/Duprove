#include "traversal.h"
static int64_t stamp(const fs::path& p){return fs::last_write_time(p).time_since_epoch().count();}
void discover(DB& db,const std::vector<std::string>& roots,const fs::path& workingDirectory,json& states,ScanContext& context,const std::function<void()>& progress){
 const int count=int(roots.size());
 const auto working=workingDirectory;
 db.exec("CREATE TEMP TABLE dirs(path TEXT PRIMARY KEY,root INTEGER,done INTEGER DEFAULT 0);");
 for(int root=0;root<count;root++){
  auto base=fs::u8path(roots[root]);if(!fs::is_directory(base)||excluded(base)){states[root]["phase"]="error";states[root]["errors"]=1;continue;}
  put(db,"INSERT OR IGNORE INTO dirs(path,root) VALUES(?,?)",{utf8(base),root});states[root]["phase"]="discovering";context.emit({{"type","progress"},{"disks",states}});
  while(context.waitFor(root)){
   std::string directory;{Query q(db,"SELECT path FROM dirs WHERE root=? AND done=0 LIMIT 1",{root});if(!q.next())break;directory=q.str(0);}
   std::error_code ec;fs::directory_iterator it(fs::u8path(directory),fs::directory_options::skip_permission_denied,ec),end;
   db.exec("BEGIN");int batch=0;
   while(it!=end && context.waitFor(root)){
    auto entry=*it;auto p=entry.path();auto relative=p.lexically_relative(working);bool isWork=!relative.empty()&&*relative.begin()!="..";
    bool otherRoot=false;for(int k=0;k<count;k++)if(k!=root&&p==fs::u8path(roots[k]))otherRoot=true;
    try{if(!isWork&&!otherRoot&&!excluded(p)&&!entry.is_symlink()){
     if(entry.is_directory())put(db,"INSERT OR IGNORE INTO dirs(path,root) VALUES(?,?)",{utf8(p),root});
     else if(entry.is_regular_file()){
      auto id=identity(p);if(!id.empty()){
       auto size=entry.file_size();auto time=stamp(p);auto ext=size==0?"empty":extension(p);
       put(db,"INSERT INTO files(path,identity,root,size,mtime,ext,cat,seen) VALUES(?,?,?,?,?,?,?,1) ON CONFLICT DO UPDATE SET root=excluded.root,seen=1,hash=CASE WHEN files.size=excluded.size AND files.mtime=excluded.mtime AND files.identity=excluded.identity THEN files.hash ELSE '' END,norm=CASE WHEN files.size=excluded.size AND files.mtime=excluded.mtime THEN files.norm ELSE '' END,size=excluded.size,mtime=excluded.mtime,ext=excluded.ext,cat=excluded.cat",{utf8(p),id,root,size,time,ext,category(p)});
      }
     }
    }}catch(...){states[root]["errors"]=states[root]["errors"].get<int>()+1;}
    it.increment(ec);if(ec){states[root]["errors"]=states[root]["errors"].get<int>()+1;break;}
    if(++batch%256==0){db.exec("COMMIT; BEGIN");progress();context.throttle();}
   }
   db.exec("COMMIT");if(context.controls[root]!=2)put(db,"UPDATE dirs SET done=1 WHERE path=?",{directory});progress();
  }
  states[root]["phase"]=context.controls[root]==2?"stopped":"hashing";
 }
}
