#pragma once
#include "platform.h"
#include <sqlite3.h>
struct DB {
  sqlite3* db=nullptr;
  explicit DB(const std::string& path) {
    if(sqlite3_open(path.c_str(),&db)!=SQLITE_OK) {
      sqlite3_close(db);
      throw std::runtime_error("DATABASE_OPEN_FAILED");
    }
  }
  DB(const DB&)=delete;
  DB& operator=(const DB&)=delete;
  ~DB(){sqlite3_close(db);}
  void exec(const char* sql) {
    if(sqlite3_exec(db,sql,nullptr,nullptr,nullptr)!=SQLITE_OK)
      throw std::runtime_error("DATABASE_EXEC_FAILED");
  }
};
struct Query {
  sqlite3_stmt* s=nullptr;
  Query(DB& db,const char* sql,const json& args=json::array()) {
    try {
      if(sqlite3_prepare_v2(db.db,sql,-1,&s,nullptr)!=SQLITE_OK)
        throw std::runtime_error("DATABASE_PREPARE_FAILED");
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
  bool next() {
    int result=sqlite3_step(s);
    if(result!=SQLITE_ROW&&result!=SQLITE_DONE)throw std::runtime_error("DATABASE_STEP_FAILED");
    return result==SQLITE_ROW;
  }
  int64_t num(int i){return sqlite3_column_int64(s,i);}
  std::string str(int i) {
    auto p=sqlite3_column_text(s,i);
    return p?reinterpret_cast<const char*>(p):"";
  }
};
inline void put(DB& d,const char* s,const json& a=json::array()){Query q(d,s,a);q.next();}
