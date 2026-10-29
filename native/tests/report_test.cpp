#include "report.h"
#include "user_dirs.h"
#include "diagnostics.h"
#include <iostream>

namespace {
void require(bool value) { if(!value) throw std::runtime_error("STATISTICS_TEST_FAILED"); }
void check(const json& value,int files,int empty,int members,int groups) {
  require(value.at("files")==files && value.at("empty")==empty &&
          value.at("duplicate_members")==members && value.at("duplicate_groups")==groups);
}
}

int main() {
  try {
    DB db(":memory:");
    db.exec("CREATE TABLE files(path TEXT,root INTEGER,cat TEXT,ext TEXT,size INTEGER,gid INTEGER,hash TEXT,seen INTEGER DEFAULT 1);");
    const auto base=fs::temp_directory_path()/"PRIVATE_STATISTICS";
    UserFolders folders;
    for(auto name:{"downloads","documents","videos","pictures","music","desktop"})
      folders.emplace_back(base/name,name);
    // Category comes from location, never file extension or a directory's basename.
    require(folderCategory(base/"custom"/"documents"/"a.txt",folders)=="custom");
    require(folderCategory(base/"documents-other"/"a.txt",folders)=="custom");
    auto nested=folders;
    nested.emplace_back(base/"documents"/"nested","pictures");
    require(folderCategory(base/"documents"/"nested"/"a.txt",nested)=="pictures");
    int serial=0;
    auto file=[&](int disk,const char* folder,const char* ext,int group,bool empty=false) {
      const auto path=base/folder/("PRIVATE_FILE_"+std::to_string(++serial));
      put(db,"INSERT INTO files(path,root,cat,ext,size,gid,hash) VALUES(?,?,?,?,?,?,?)",
          {utf8(path),disk,folderCategory(path,folders),ext,empty?0:12,group,"PRIVATE_HASH"});
    };
    file(0,"downloads",".txt",1); file(0,"documents",".md",1);
    file(1,"custom",".bin",1); file(1,"pictures",".txt",1);
    file(0,"videos",".dat",2); file(1,"music",".dat",2);
    file(0,"custom",".dat",3); file(1,"custom",".dat",3);
    file(0,"desktop","none",4); file(0,"desktop","none",4);
    file(0,"downloads",".jpg",0); file(1,"custom",".unique",5); // singleton gid is not a group
    for(auto name:{"downloads","documents","videos","pictures","music","desktop","custom"})
      file(1,name,"empty",99,true); // even a stale gid cannot include empty files
    const auto report=buildReport(db,2,true);
    const auto& s=report.at("statistics");
    check(s["total"],19,7,10,4); require(s["total"]["duplicates"]==6);
    require(s["total"]["file_bytes"]==144 && s["total"]["duplicate_bytes"]==120 && s["total"]["reclaimable_bytes"]==72);
    require(s["disks"][0]["file_bytes"]==84 && s["disks"][0]["duplicate_bytes"]==72);
    require(s["disks"][1]["file_bytes"]==60 && s["disks"][1]["duplicate_bytes"]==48);
    check(s["disks"][0],7,0,6,4); check(s["disks"][1],12,7,4,3);
    const auto& standard=s["locations"]["standard"];
    check(standard["total"],14,6,7,3);
    check(s["locations"]["custom"],5,1,3,2);
    for(auto name:{"documents","videos","pictures","music"}) check(standard["categories"][name],2,1,1,1);
    check(standard["categories"]["downloads"],3,1,1,1);
    check(standard["categories"]["desktop"],3,1,2,1);
    require(report["duplicates"].size()==4);
    const auto& group=report["duplicates"][0];
    require(group["copies"]==4 && group["duplicates"]==3);
    require(group["size_bytes"]==12);
    require(group["extensions"]==json({{".txt",2},{".md",1},{".bin",1}}));
    require(group["disks"]==json({{"0",2},{"1",2}}));
    require(group["categories"]==json({{"downloads",1},{"documents",1},{"custom",1},{"pictures",1}}));
    require(report.dump().find("PRIVATE_")==std::string::npos);
    auto partial=buildReport(db,2,false);
    require(partial["complete"]==false); partial["complete"]=true; require(partial==report);
    db.exec("DELETE FROM files;");
    auto empty=buildReport(db,1,true);
    check(empty["statistics"]["total"],0,0,0,0); require(empty["duplicates"].empty());
    require(empty["statistics"]["total"]["file_bytes"]==0 && empty["statistics"]["total"]["duplicate_bytes"]==0);
    db.exec("INSERT INTO files(path,root,cat,ext,size,gid,hash) VALUES('a',0,'custom','.bin',9007199254740991,1,'x');"
            "INSERT INTO files(path,root,cat,ext,size,gid,hash) VALUES('b',0,'custom','.bin',1,1,'x');");
    bool overflow=false;
    try { buildReport(db,1,true); } catch(const std::exception&) { overflow=true; }
    require(overflow);
    db.exec("DELETE FROM files;");
    for(int disks:{0,65}) {
      bool rejected=false;
      try { buildReport(db,disks,true); } catch(const std::exception&) { rejected=true; }
      require(rejected);
    }
    json state={{"errors",0},{"work",{{"operation","hashing"}}}};
    for(int i=0;i<100;++i) recordIssue(state,"file_unavailable_or_changed");
    require(state["errors"]==100 && state["issues"].size()==1 && state["issues"][0]["count"]==100);
    require(state["issues"][0]["examples"].empty());
    for(const char* code:{"metadata_unavailable","directory_unavailable","directory_changed","enumeration_failed"}) recordIssue(state,code,"discovering");
    require(!hasBlockingIssues(state));
    recordIssue(state,"root_unavailable","discovering");
    require(hasBlockingIssues(state));
    return 0;
  } catch(const std::exception&) { std::cerr<<"STATISTICS_TEST_FAILED\n"; return 1; }
}
