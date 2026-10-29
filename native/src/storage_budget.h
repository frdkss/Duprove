#pragma once
#include "storage.h"
#include <algorithm>
#include <limits>

namespace storage {
constexpr uint64_t reserveBytes=512ULL*1024*1024;

inline bool hasReserve(const fs::path& directory,uint64_t reserve=reserveBytes) {
  std::error_code error;
  const auto space=fs::space(directory,error);
  return !error && space.available>=reserve;
}

inline void limitDatabase(DB& db,const char* schema,uint64_t bytes) {
  const std::string name(schema);
  if(name!="main" && name!="temp") throw std::runtime_error("INVALID_DATABASE_SCHEMA");
  int64_t pageSize=0;
  { Query query(db,("PRAGMA "+name+".page_size").c_str());if(query.next()) pageSize=query.num(0); }
  if(pageSize<=0 || bytes<uint64_t(pageSize)) throw std::runtime_error("ANALYSIS_STORAGE_LIMIT");
  const auto pages=bytes/uint64_t(pageSize);
  // SQLite cannot lower the limit below an existing database's page count.
  // Reject that case without deleting or truncating the user's checkpoints.
  Query limit(db,("PRAGMA "+name+".max_page_count="+std::to_string(pages)).c_str());
  if(!limit.next() || uint64_t(limit.num(0))>pages) throw std::runtime_error("ANALYSIS_STORAGE_LIMIT");
}

inline uint64_t databaseBudget(uint64_t allocated,uint64_t available) {
  if(available<reserveBytes) throw std::runtime_error("ANALYSIS_STORAGE_LIMIT");
  // Existing pages are already allocated and must not be charged a second time.
  return allocated+std::min(available-reserveBytes,std::numeric_limits<uint64_t>::max()-allocated);
}

inline void limitAvailableDatabase(DB& db,const char* schema,const fs::path& directory) {
  const std::string name(schema);
  if(name!="main" && name!="temp") throw std::runtime_error("INVALID_DATABASE_SCHEMA");
  int64_t pageCount=0,pageSize=0;
  { Query query(db,("PRAGMA "+name+".page_count").c_str());if(query.next()) pageCount=query.num(0); }
  { Query query(db,("PRAGMA "+name+".page_size").c_str());if(query.next()) pageSize=query.num(0); }
  if(pageCount<0 || pageSize<=0) throw std::runtime_error("ANALYSIS_STORAGE_LIMIT");
  std::error_code error;
  const auto space=fs::space(directory,error);
  if(error) throw std::runtime_error("ANALYSIS_STORAGE_LIMIT");
  limitDatabase(db,schema,databaseBudget(uint64_t(pageCount)*uint64_t(pageSize),space.available));
}
}
