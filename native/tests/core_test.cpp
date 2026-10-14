#include "report.h"
#include "scanner.h"
#include <iostream>

static void require(bool value) { if(!value)throw std::runtime_error("core test failed"); }
int main() {
  try {
    DB db(":memory:");
    db.exec("CREATE TABLE files(path TEXT,root INTEGER,cat TEXT,ext TEXT,size INTEGER,gid INTEGER);");
    db.exec("INSERT INTO files VALUES('PRIVATE_A',0,'documents','.txt',12,1),"
            "('PRIVATE_B',0,'downloads','.txt',12,1),"
            "('PRIVATE_C',1,'custom','.bin',12,1),"
            "('PRIVATE_EMPTY',1,'custom','empty',0,0),"
            "('PRIVATE_UNIQUE',1,'music','.mp3',14,0);");
    auto report=buildReport(db,2,true);
    const auto& statistics=report.at("statistics");
    require(statistics["total"]["files"]==5);
    require(statistics["total"]["duplicates"]==2);
    require(statistics["locations"]["standard"]["total"]["duplicate_groups"]==1);
    require(statistics["locations"]["standard"]["total"]["duplicate_members"]==2);
    require(statistics["locations"]["custom"]["duplicate_members"]==1);
    require(report["duplicates"][0]["extensions"][".bin"]==1);
    require(report.dump().find("PRIVATE_")==std::string::npos);
    ScanContext first,second;
    first.controls[0]=2;
    require(!first.waitFor(0)&&second.waitFor(0));
    bool rejected=false;
    try {scan({{"roots",json::array()}},first);}catch(const std::exception&){rejected=true;}
    require(rejected);
    return 0;
  } catch(const std::exception&) {std::cerr<<"CORE_TEST_FAILED\n";return 1;}
}
