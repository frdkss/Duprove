#include "report.h"
#include <set>
#include <map>

namespace {
json summary() {
  return {{"files",0},{"empty",0},{"types",json::object()},
          {"duplicate_members",0},{"duplicate_groups",0}};
}
void add(json& value, const std::string& key, int64_t amount) {
  constexpr int64_t maxSafe = 9007199254740991LL;
  auto previous=value.value(key,int64_t(0));
  if(amount<0 || previous>maxSafe-amount) throw std::runtime_error("COUNTER_OVERFLOW");
  value[key]=previous+amount;
}
void addFiles(json& value,const std::string& ext,int64_t n) {
  add(value,"files",n);add(value["types"],ext,n);
  if(ext=="empty")add(value,"empty",n);
}
}

json buildReport(DB& db,int diskCount,bool complete) {
  json total=summary(),disks=json::array(),categories=json::object();
  for(auto name:{"downloads","documents","videos","pictures","music","desktop"})categories[name]=summary();
  json standard=summary(),custom=summary(),groups=json::array();
  for(int i=0;i<diskCount;i++){auto disk=summary();disk["id"]=i;disks.push_back(disk);}
  Query files(db,"SELECT root,cat,ext,count(*) FROM files GROUP BY root,cat,ext");
  while(files.next()) {
    int root=int(files.num(0));auto cat=files.str(1),ext=files.str(2);auto n=files.num(3);
    addFiles(total,ext,n);addFiles(disks.at(root),ext,n);
    if(cat=="custom")addFiles(custom,ext,n);
    else{addFiles(categories.at(cat),ext,n);addFiles(standard,ext,n);}
  }
  int64_t extra=0;
  Query grouped(db,"SELECT gid,count(*) FROM files WHERE gid>0 AND size>0 GROUP BY gid HAVING count(*)>1");
  while(grouped.next()) {
    auto copies=grouped.num(1);json exts=json::object(),locations=json::object(),cats=json::object();
    Query members(db,"SELECT root,cat,ext,count(*) FROM files WHERE gid=? AND size>0 GROUP BY root,cat,ext",{grouped.num(0)});
    bool inStandard=false;
    while(members.next()) {
      int root=int(members.num(0));auto cat=members.str(1),ext=members.str(2);auto n=members.num(3);
      add(exts,ext,n);add(locations,std::to_string(root),n);add(cats,cat,n);
      add(disks.at(root),"duplicate_members",n);
      if(cat=="custom")add(custom,"duplicate_members",n);
      else{add(categories.at(cat),"duplicate_members",n);add(standard,"duplicate_members",n);inStandard=true;}
    }
    for(auto it=locations.begin();it!=locations.end();++it)add(disks.at(std::stoi(it.key())),"duplicate_groups",1);
    for(auto it=cats.begin();it!=cats.end();++it) {
      if(it.key()=="custom")add(custom,"duplicate_groups",1);
      else add(categories.at(it.key()),"duplicate_groups",1);
    }
    if(inStandard)add(standard,"duplicate_groups",1);
    add(total,"duplicate_members",copies);add(total,"duplicate_groups",1);
    extra+=copies-1;
    groups.push_back({{"copies",copies},{"duplicates",copies-1},{"extensions",exts},{"disks",locations},{"categories",cats}});
  }
  total["duplicates"]=extra;
  return {{"schema_version",1},{"complete",complete},{"statistics",{
    {"total",total},{"disks",disks},{"locations",{{"standard",{{"total",standard},{"categories",categories}}},{"custom",custom}}}}},
    {"duplicates",groups}};
}
