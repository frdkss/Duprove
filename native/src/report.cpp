#include "report.h"
#include <set>
#include <map>

namespace {
json summary() {
  return {{"files",0},{"empty",0},{"types",json::object()},
          {"duplicate_members",0},{"duplicate_groups",0},{"file_bytes",0},{"duplicate_bytes",0}};
}
void add(json& value, const std::string& key, int64_t amount) {
  constexpr int64_t maxSafe = 9007199254740991LL;
  auto previous=value.value(key,int64_t(0));
  if(amount<0 || previous>maxSafe-amount) throw std::runtime_error("COUNTER_OVERFLOW");
  value[key]=previous+amount;
}
int64_t bytes(int64_t size,int64_t copies) {
  if(size<0 || copies<0 || (copies && size>9007199254740991LL/copies)) throw std::runtime_error("COUNTER_OVERFLOW");
  return size*copies;
}
void addFiles(json& value,const std::string& ext,int64_t n,int64_t size) {
  add(value,"files",n);add(value["types"],ext,n);
  add(value,"file_bytes",size);
  if(ext=="empty")add(value,"empty",n);
}
}

json buildReport(DB& db,int diskCount,bool complete) {
  if(diskCount<1 || diskCount>64) throw std::runtime_error("INVALID_DISK_COUNT");
  json total=summary(),disks=json::array(),categories=json::object();
  for(auto name:{"downloads","documents","videos","pictures","music","desktop"})categories[name]=summary();
  json standard=summary(),custom=summary(),groups=json::array();
  for(int i=0;i<diskCount;i++){auto disk=summary();disk["id"]=i;disks.push_back(disk);}
  Query files(db,"SELECT root,cat,ext,count(*),sum(size) FROM files WHERE seen=1 GROUP BY root,cat,ext");
  while(files.next()) {
    int root=int(files.num(0));auto cat=files.str(1),ext=files.str(2);auto n=files.num(3);
    auto size=files.num(4);
    addFiles(total,ext,n,size);addFiles(disks.at(root),ext,n,size);
    if(cat=="custom")addFiles(custom,ext,n,size);
    else{addFiles(categories.at(cat),ext,n,size);addFiles(standard,ext,n,size);}
  }
  total["duplicates"]=0;total["reclaimable_bytes"]=0;
  // One ordered query instead of one query per group, including for checkpoints.
  Query members(db,"SELECT gid,root,cat,ext,size,count(*) FROM files WHERE size>0 AND gid IN "
                   "(SELECT gid FROM files WHERE gid>0 AND size>0 GROUP BY gid HAVING count(*)>1) "
                   "GROUP BY gid,root,cat,ext,size ORDER BY gid");
  int64_t previous=-1,copies=0,size=0;
  json exts=json::object(),locations=json::object(),cats=json::object();
  bool inStandard=false;
  auto finish=[&] {
    if(!copies) return;
    for(auto it=locations.begin();it!=locations.end();++it)add(disks.at(std::stoi(it.key())),"duplicate_groups",1);
    for(auto it=cats.begin();it!=cats.end();++it) {
      if(it.key()=="custom")add(custom,"duplicate_groups",1);
      else add(categories.at(it.key()),"duplicate_groups",1);
    }
    if(inStandard)add(standard,"duplicate_groups",1);
    add(total,"duplicate_members",copies);add(total,"duplicate_groups",1);
    add(total,"duplicates",copies-1);add(total,"duplicate_bytes",bytes(size,copies));
    add(total,"reclaimable_bytes",bytes(size,copies-1));
    groups.push_back({{"copies",copies},{"duplicates",copies-1},{"size_bytes",size},{"extensions",exts},{"disks",locations},{"categories",cats}});
  };
  while(members.next()) {
      if(members.num(0)!=previous) {
        finish();previous=members.num(0);copies=0;size=members.num(4);inStandard=false;
        exts=json::object();locations=json::object();cats=json::object();
      }
      if(members.num(4)!=size) throw std::runtime_error("INVALID_GROUP_SIZE");
      int root=int(members.num(1));auto cat=members.str(2),ext=members.str(3);auto n=members.num(5);
      copies+=n;
      add(exts,ext,n);add(locations,std::to_string(root),n);add(cats,cat,n);
      add(disks.at(root),"duplicate_members",n);
      const auto amount=bytes(size,n);add(disks.at(root),"duplicate_bytes",amount);
      if(cat=="custom") { add(custom,"duplicate_members",n);add(custom,"duplicate_bytes",amount); }
      else{add(categories.at(cat),"duplicate_members",n);add(standard,"duplicate_members",n);
        add(categories.at(cat),"duplicate_bytes",amount);add(standard,"duplicate_bytes",amount);inStandard=true;}
  }
  finish();
  return {{"schema_version",1},{"complete",complete},{"statistics",{
    {"total",total},{"disks",disks},{"locations",{{"standard",{{"total",standard},{"categories",categories}}},{"custom",custom}}}}},
    {"duplicates",groups}};
}
