#include "scanner.h"
#include <iostream>
#include <fstream>
#include <thread>
#include <mutex>
#include <algorithm>
#include <memory>
void emit(const json& v) { static std::mutex m; std::lock_guard<std::mutex> lock(m); std::cout<<v.dump(-1,' ',false,json::error_handler_t::replace)<<std::endl; }
int main(int argc,char** argv) {
  try {
    if(argc==2 && std::string(argv[1])=="--drives") {emit(drives());return 0;}
    if(argc!=3 || std::string(argv[1])!="--job") {std::cerr<<"Usage: duprove-analyzer --drives | --job file.json\n";return 2;}
    std::ifstream in(fs::u8path(argv[2])); json job;in>>job;
    if(!job.at("roots").is_array()||job["roots"].empty()||job["roots"].size()>64)throw std::runtime_error("roots");
    auto context=std::make_shared<ScanContext>();
    context->emit=emit;
    context->loadMode=std::clamp(job.value("load",0),0,2);
    std::thread([context] {std::string line;while(std::getline(std::cin,line))try {auto c=json::parse(line);auto action=c.value("action","");int root=c.value("disk",-1);
      if(action=="load")context->loadMode=std::clamp(c.value("value",0),0,2);
      else if(root>=0&&root<64&&(action=="pause"||action=="stop"||action=="resume"))context->controls[root]=(action=="pause"?1:action=="stop"?2:0);
    }catch(...){} }).detach();
    return scan(job,*context);
  } catch(...) {emit({{"type","error"},{"message","Не удалось выполнить анализ. Проверьте доступ к рабочему каталогу."}});return 1;}
}
