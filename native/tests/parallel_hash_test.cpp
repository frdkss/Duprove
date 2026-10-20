#include "parallel_hash.h"
#include <fstream>
#include <iostream>
using namespace std::chrono_literals;
namespace {
void require(bool ok,const char* message) { if(!ok) throw std::runtime_error(message); }
FileInfo info(const fs::path& path) {
  FileInfo value;require(inspectFile(path,value),"fixture metadata");return value;
}
HashResult result(std::future<HashResult>& value) {
  require(value.wait_for(10s)==std::future_status::ready,"worker did not finish");return value.get();
}
}
int main() {
  const auto base=fs::current_path()/("duprove-parallel-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  try {
    fs::create_directories(base);
    const auto file=base/"sample.bin";
    { std::ofstream out(file,std::ios::binary);out<<std::string(1000000,'a'); }
    const auto expected=info(file);
    const std::string known="cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0";
    ScanContext owner;owner.loadMode=2;owner.controls[0]=1;
    std::atomic<bool> calledOwner{false};
    owner.pulse=[&] { calledOwner=true; };
    owner.readProgress=[&](int,size_t) { calledOwner=true; };
    {
      ParallelHasher pool(owner,0,8);
      require(pool.size()==std::min(8u,std::max(1u,std::thread::hardware_concurrency())),"worker sizing");
      std::vector<std::future<HashResult>> jobs;
      for(int i=0;i<16;++i) jobs.push_back(pool.submit(utf8(file),expected,""));
      require(jobs.front().wait_for(100ms)==std::future_status::timeout,"paused worker ran");
      require(pool.takeReadBytes()==0,"paused worker read bytes");
      owner.controls[0]=0;
      for(auto& job:jobs) { const auto value=result(job);require(value.hash==known && value.readBytes==1000000 && !value.cacheHit,"parallel digest"); }
      require(pool.takeReadBytes()==16000000 && pool.takeReadBytes()==0,"aggregate reads counted once");
      auto cached=pool.submit(utf8(file),expected,known);
      const auto hit=result(cached);require(hit.hash==known && hit.cacheHit && hit.readBytes==0,"cached validation");
      owner.controls[0]=1;
      auto changed=pool.submit(utf8(file),expected,known);
      { std::ofstream out(file,std::ios::binary);out<<"changed"; }
      owner.controls[0]=0;
      require(result(changed).hash.empty(),"changed cached file accepted");
      owner.controls[0]=1;
      jobs.clear();
      for(int i=0;i<16;++i) jobs.push_back(pool.submit(utf8(file),info(file),""));
      owner.controls[0]=2;
      for(auto& job:jobs) { const auto value=result(job);require(value.hash.empty() && value.readBytes==0,"stop did not cancel queue"); }
    }
    owner.controls[0]=1;
    const auto before=std::chrono::steady_clock::now();
    { ParallelHasher pool(owner,0,2);auto abandoned=pool.submit(utf8(file),info(file),""); }
    require(std::chrono::steady_clock::now()-before<2s,"destructor stuck on paused worker");
    require(!calledOwner,"worker accessed main-thread callbacks");
    fs::remove_all(base);return 0;
  } catch(const std::exception& error) { std::cerr<<error.what()<<'\n';fs::remove_all(base);return 1; }
}
