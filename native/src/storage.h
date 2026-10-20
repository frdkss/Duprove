#pragma once
#include "platform.h"
#include <sqlite3.h>
struct DB {
  sqlite3* db=nullptr;
  const char* interruptionReason=nullptr;
  explicit DB(const std::string& path) {
    if(sqlite3_open(path.c_str(),&db)!=SQLITE_OK) {
      sqlite3_close(db);
      throw std::runtime_error("DATABASE_OPEN_FAILED");
    }
  }
  DB(const DB&)=delete;
  DB& operator=(const DB&)=delete;
  ~DB(){sqlite3_close(db);}
  [[noreturn]] void fail(int code,const char* fallback) const {
    if((code&0xff)==SQLITE_FULL) throw std::runtime_error("ANALYSIS_STORAGE_LIMIT");
    if((code&0xff)==SQLITE_INTERRUPT && interruptionReason) throw std::runtime_error(interruptionReason);
    throw std::runtime_error(fallback);
  }
  void exec(const char* sql) {
    const int code=sqlite3_exec(db,sql,nullptr,nullptr,nullptr);
    if(code!=SQLITE_OK) fail(code,"DATABASE_EXEC_FAILED");
  }
};
struct Query {
  sqlite3_stmt* s=nullptr;
  DB& owner;
  Query(DB& db,const char* sql,const json& args=json::array()):owner(db) {
    try {
      const int code=sqlite3_prepare_v2(db.db,sql,-1,&s,nullptr);
      if(code!=SQLITE_OK) owner.fail(code,"DATABASE_PREPARE_FAILED");
      int i=1;
      for(const auto& a:args) {
        int result;
        if(a.is_string()) {
          const auto& value=a.get_ref<const std::string&>();
          result=sqlite3_bind_text(s,i,value.c_str(),-1,SQLITE_TRANSIENT);
        } else if(a.is_null())result=sqlite3_bind_null(s,i);
        else result=sqlite3_bind_int64(s,i,a.get<int64_t>());
        if(result!=SQLITE_OK)throw std::runtime_error("DATABASE_BIND_FAILED");
        ++i;
      }
    } catch(...) {sqlite3_finalize(s);throw;}
  }
  Query(const Query&)=delete;
  Query& operator=(const Query&)=delete;
  ~Query(){sqlite3_finalize(s);}
  void reset() {
    if(sqlite3_reset(s)!=SQLITE_OK || sqlite3_clear_bindings(s)!=SQLITE_OK) throw std::runtime_error("DATABASE_RESET_FAILED");
  }
  void bind(int i,const std::string& value) {
    if(sqlite3_bind_text(s,i,value.data(),int(value.size()),SQLITE_TRANSIENT)!=SQLITE_OK) throw std::runtime_error("DATABASE_BIND_FAILED");
  }
  void bind(int i,int64_t value) {
    if(sqlite3_bind_int64(s,i,value)!=SQLITE_OK) throw std::runtime_error("DATABASE_BIND_FAILED");
  }
  bool next() {
    int result=sqlite3_step(s);
    if(result!=SQLITE_ROW&&result!=SQLITE_DONE)owner.fail(result,"DATABASE_STEP_FAILED");
    return result==SQLITE_ROW;
  }
  int64_t num(int i){return sqlite3_column_int64(s,i);}
  std::string str(int i) {
    auto p=sqlite3_column_text(s,i);
    return p?reinterpret_cast<const char*>(p):"";
  }
};
inline void put(DB& d,const char* s,const json& a=json::array()){Query q(d,s,a);q.next();}
struct Transaction {
  DB& db;
  bool active=true;
  explicit Transaction(DB& value):db(value) { db.exec("BEGIN"); }
  ~Transaction() { if(active) sqlite3_exec(db.db,"ROLLBACK",nullptr,nullptr,nullptr); }
  void commit() { db.exec("COMMIT"); active=false; }
  void checkpoint() { commit(); db.exec("BEGIN"); active=true; }
};
