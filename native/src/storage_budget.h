#pragma once
#include "storage.h"

namespace storage {
constexpr uint64_t databaseBytes=512ULL*1024*1024;
constexpr uint64_t temporaryBytes=256ULL*1024*1024;
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
}
