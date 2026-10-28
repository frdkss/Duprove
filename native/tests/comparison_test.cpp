#include "comparison.h"
#include "storage.h"
#include <chrono>
#include <fstream>
#include <iostream>

namespace {
void require(bool value,const char* reason) { if(!value) throw std::runtime_error(reason); }
void write(const fs::path& path,const std::string& data) {
  fs::create_directories(path.parent_path());
  std::ofstream file(path,std::ios::binary); file.write(data.data(),std::streamsize(data.size()));
  require(bool(file),"fixture write");
}
FileInfo info(const fs::path& path) {
  FileInfo result; require(inspectFile(path,result),"fixture metadata"); return result;
}
}
int main() {
  const auto base=fs::current_path()/("duprove-comparison-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  try {
    ScanContext context; context.loadMode=2;
    const auto a=base/"a", b=base/"b";
    // Published SHA-256 test vectors exercise empty input, padding and multiple blocks.
    write(a,"");
    require(digest(a,info(a),0,context)=="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","empty SHA-256");
    write(a,"abc");
    require(digest(a,info(a),0,context)=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","abc SHA-256");
    write(a,std::string(1000000,'a'));
    require(digest(a,info(a),0,context)=="cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0","streaming SHA-256");
    for(size_t length:{size_t(1),size_t(262144),size_t(262145),size_t(1048593)}) {
      const std::string data(length,'x'); write(a,data); write(b,data);
      require(equalBytes(a,info(a),b,info(b),0,context)==ByteMatch::equal,"equal block boundaries");
      for(const auto offset:{size_t(0),length/2,length-1}) {
        auto different=data; different[offset]='y'; write(b,different);
        require(equalBytes(a,info(a),b,info(b),0,context)==ByteMatch::different,"different byte");
      }
    }
    write(a,"same"); write(b,"same");
    const auto oldA=info(a),oldB=info(b);
    write(a,"longer");
    require(digest(a,oldA,0,context).empty(),"stale hash metadata rejected");
    require(equalBytes(a,oldA,b,oldB,0,context)==ByteMatch::leftUnavailable,"changed left");
    require(equalBytes(b,oldB,a,oldA,0,context)==ByteMatch::rightUnavailable,"changed right");
    fs::remove(a);
    require(equalBytes(a,oldA,b,oldB,0,context)==ByteMatch::leftUnavailable,"missing left is not different");
    write(a,"same");
    context.controls[0]=2;
    require(digest(a,info(a),0,context).empty(),"cancelled hash");
    require(equalBytes(a,info(a),b,info(b),0,context)==ByteMatch::stopped,"cancelled comparison");
    context.controls[0]=0; context.controls[1]=2;
    require(equalBytes(a,info(a),b,info(b),0,context,1)==ByteMatch::stopped,"cancelled other root");
    context.controls[1]=0;

    // Mutations during streaming stop the current file before reading it all.
    const std::string large(4*1024*1024,'x');
    ScanContext streaming;streaming.loadMode=2;streaming.regulateCpu=false;
    write(a,large);bool mutated=false;
    streaming.readProgress=[&](int,size_t) { if(!mutated) { mutated=true;std::ofstream out(a,std::ios::binary|std::ios::app);out<<'x'; } };
    require(digest(a,info(a),0,streaming).empty() && mutated,"file changed during hashing is skipped");
    require(streaming.readBytes<large.size(),"changed hash stops reading early");
    for(bool right:{false,true}) {
      write(a,large);write(b,large);mutated=false;streaming.readBytes=0;
      streaming.readProgress=[&](int,size_t) { if(!mutated) { mutated=true;std::ofstream out(right?b:a,std::ios::binary|std::ios::app);out<<'x'; } };
      require(equalBytes(a,info(a),b,info(b),0,streaming)==(right?ByteMatch::rightUnavailable:ByteMatch::leftUnavailable),"file changed during comparison is skipped");
      require(streaming.readBytes<large.size(),"changed comparison stops reading early");
    }

    // Deliberately inject a collision into the private candidate index. Production
    // grouping must separate different bytes even when the supplied hashes match.
    DB db(":memory:");
    db.exec("CREATE TABLE files(path TEXT PRIMARY KEY,root INTEGER,size INTEGER,mtime INTEGER,ctime INTEGER,identity TEXT,hash TEXT,gid INTEGER,name TEXT);");
    for(int i=0;i<4;++i) {
      const auto path=base/("collision-"+std::to_string(i));
      write(path,i%2 ? "diff" : "same");
      const auto metadata=info(path);
      put(db,"INSERT INTO files VALUES(?,?,?,?,?,?,?,0,?)",{utf8(path),i%2,metadata.size,metadata.modified,metadata.changed,metadata.id,"forced-collision",utf8(path.filename())});
    }
    groupExactFiles(db,context,[](const std::string&,int) { throw std::runtime_error("unexpected invalid file"); },[] {});
    Query groups(db,"SELECT count(*) FROM files GROUP BY gid ORDER BY gid");
    require(groups.next() && groups.num(0)==2,"first byte group after hash collision");
    require(groups.next() && groups.num(0)==2 && !groups.next(),"second byte group after hash collision");

    // A file replaced after hashing cannot keep its match, even with restored mtime.
    bool replaced=false; json result;
    const auto selected=base/"selected";
    write(selected/"a","same"); write(selected/"b","same");
    context.emit=[&](const json& event) {
      if(event["type"]=="result") result=event;
      if(!replaced && event["type"]=="progress" && event["disks"][0]["phase"]=="comparing") {
        replaced=true;
        const auto stamp=fs::last_write_time(selected/"b");
        fs::rename(selected/"b",base/"old-b"); write(selected/"b","diff");
        fs::last_write_time(selected/"b",stamp);
      }
    };
    scan({{"roots",json::array({utf8(selected)})},{"database",utf8(base/"work"/"scan.sqlite")}},context);
    require(replaced && result["report"]["complete"]==true && result["disks"][0]["errors"]==1,"change between hash and comparison is skipped");
    require(result["report"]["statistics"]["total"]["duplicates"]==0,"no stale duplicate");
  } catch(const std::exception& error) {
    std::cerr<<error.what()<<'\n'; std::error_code ec; fs::remove_all(base,ec); return 1;
  }
  std::error_code ec; fs::remove_all(base,ec);
  if(ec) { std::cerr<<"FIXTURE_CLEANUP_FAILED\n"; return 1; }
  return 0;
}
