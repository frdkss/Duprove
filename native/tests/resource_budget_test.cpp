#include "storage_budget.h"
#include "scanner.h"
#include <iostream>
#include <limits>

using namespace std::chrono_literals;
namespace {
void require(bool ok,const char* message) { if(!ok) throw std::runtime_error(message); }
void exhaust(DB& db,const char* schema) {
  const std::string name(schema);
  db.exec(("CREATE TABLE "+name+".payload(value BLOB)").c_str());
  storage::limitDatabase(db,schema,32*1024);
  bool stopped=false;
  try {
    for(int i=0;i<64;++i) db.exec(("INSERT INTO "+name+".payload VALUES(zeroblob(8192))").c_str());
  } catch(const std::exception& error) { stopped=std::string(error.what())=="ANALYSIS_STORAGE_LIMIT"; }
  require(stopped,"database grew beyond budget");
  int64_t pages=0,pageSize=0;
  { Query query(db,("PRAGMA "+name+".page_count").c_str());require(query.next(),"page count missing");pages=query.num(0); }
  { Query query(db,("PRAGMA "+name+".page_size").c_str());require(query.next(),"page size missing");pageSize=query.num(0); }
  require(pages*pageSize<=32*1024,"database size exceeds budget");
}
}
int main() {
  try {
    {
      DB db(":memory:");
      db.exec("PRAGMA temp_store=FILE;");
      exhaust(db,"main");
      exhaust(db,"temp");
    }
    {
      DB db(":memory:");
      db.exec("CREATE TABLE existing(value BLOB);INSERT INTO existing VALUES(zeroblob(65536));");
      bool stopped=false;
      try { storage::limitDatabase(db,"main",32*1024); }
      catch(const std::exception& error) { stopped=std::string(error.what())=="ANALYSIS_STORAGE_LIMIT"; }
      require(stopped,"oversized checkpoint was accepted");
      Query saved(db,"SELECT length(value) FROM existing");
      require(saved.next() && saved.num(0)==65536,"checkpoint was modified on rejection");
    }
    {
      // A checkpoint at the old 512 MiB ceiling can grow using available disk
      // space. Keep this regression small by imposing a 32 KiB ceiling first.
      DB db(":memory:");
      db.exec("PRAGMA temp_store=FILE;");
      for(const char* schema:{"main","temp"}) {
        const std::string name(schema);
        storage::limitDatabase(db,schema,32*1024);
        storage::limitAvailableDatabase(db,schema,fs::current_path());
        db.exec(("CREATE TABLE "+name+".resumed(value BLOB);INSERT INTO "+name+".resumed VALUES(zeroblob(65536));").c_str());
        Query saved(db,("SELECT length(value) FROM "+name+".resumed").c_str());
        require(saved.next() && saved.num(0)==65536,"available disk space did not replace the old ceiling");
      }
      const uint64_t oldCeiling=512ULL*1024*1024;
      require(storage::databaseBudget(oldCeiling,storage::reserveBytes+oldCeiling)==2*oldCeiling,"existing checkpoint pages charged twice");
      require(storage::databaseBudget(oldCeiling,storage::reserveBytes)==oldCeiling,"reserve must not fund database growth");
      bool stopped=false;
      try { storage::databaseBudget(oldCeiling,storage::reserveBytes-1); }
      catch(const std::exception& error) { stopped=std::string(error.what())=="ANALYSIS_STORAGE_LIMIT"; }
      require(stopped,"insufficient reserve was ignored");
    }
    require(!storage::hasReserve(fs::current_path(),std::numeric_limits<uint64_t>::max()),"impossible reserve accepted");
    {
      DB db(":memory:");
      db.interruptionReason="ANALYSIS_STORAGE_LIMIT";
      sqlite3_progress_handler(db.db,1,[](void*) { return 1; },nullptr);
      bool stopped=false;
      try { Query query(db,"SELECT 1");query.next(); }
      catch(const std::exception& error) { stopped=std::string(error.what())=="ANALYSIS_STORAGE_LIMIT"; }
      require(stopped,"storage interruption reason was lost");
    }
    // Exercise the actual read regulator in every mode, including high mode.
    // 16 MiB at 128 MiB/s needs at least 125 ms minus its 20 ms credit.
    const std::chrono::milliseconds minimumDelay[]={970ms,220ms,95ms};
    for(int mode=0;mode<3;++mode) {
      ScanContext context;context.loadMode=mode;
      const auto start=std::chrono::steady_clock::now();
      context.accountRead(0,16*1024*1024);
      require(std::chrono::steady_clock::now()-start>=minimumDelay[mode],"read budget was bypassed");
      require(context.readBytes==16*1024*1024,"read accounting changed");
    }
    return 0;
  } catch(const std::exception& error) { std::cerr<<error.what()<<'\n';return 1; }
}
