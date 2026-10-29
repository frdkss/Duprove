#include "scanner.h"
#include "local_file.h"
#include <iostream>
#include <fstream>
#include <thread>
#include <mutex>
#include <algorithm>
#include <memory>
void emit(const json& v) { static std::mutex m; std::lock_guard<std::mutex> lock(m); std::cout<<v.dump(-1,' ',false,json::error_handler_t::replace)<<std::endl; }
static int run(int argc,const std::vector<std::string>& argv) {
  try {
    if(argc==2 && argv[1]=="--local-file") {
      std::string input;char byte;
      while(std::cin.get(byte)) { if(input.size()>=262144) throw std::runtime_error("REQUEST_LIMIT");input+=byte; }
      emit(localFile(json::parse(input)));return 0;
    }
    if(argc==2 && std::string(argv[1])=="--drives") {emit(drives());return 0;}
    if(argc!=3 || std::string(argv[1])!="--job") {std::cerr<<"Usage: duprove-analyzer --drives | --job file.json\n";return 2;}
    std::ifstream in(fs::u8path(argv[2])); json job;in>>job;
    if(!job.at("roots").is_array()||job["roots"].empty()||job["roots"].size()>64)throw std::runtime_error("roots");
    auto context=std::make_shared<ScanContext>();
    context->emit=emit;
    context->loadMode=std::clamp(job.value("load",0),0,2);
    configureProcess(context->loadMode);
    std::thread([context,managed=job.value("managed",false)] {std::string line;while(std::getline(std::cin,line))try {auto c=json::parse(line);auto action=c.value("action","");int root=c.value("disk",-1);
      if(action=="load")context->loadMode=std::clamp(c.value("value",0),0,2);
      else if((root==-1 || (root>=0&&root<64))&&(action=="pause"||action=="stop"||action=="resume")) {
        const int value=action=="pause"?1:action=="stop"?2:0;
        if(root==-1) for(auto& control:context->controls) control=value;
        else context->controls[root]=value;
      }
    }catch(...){} if(managed) for(auto& control:context->controls) control=2; }).detach();
    return scan(job,*context);
  } catch(const std::exception& error) {
    if(std::string(error.what())=="ANALYSIS_STORAGE_LIMIT") {
      emit({{"type","error"},{"code","ANALYSIS_STORAGE_LIMIT"},{"message","Анализ остановлен: недостаточно места для рабочей базы или временных данных с резервом 512 МиБ."}});
    } else emit({{"type","error"},{"message","Не удалось выполнить анализ. Проверьте доступ к рабочему каталогу."}});
    return 1;
  } catch(...) {emit({{"type","error"},{"message","Не удалось выполнить анализ."}});return 1;}
}
#ifdef _WIN32
int wmain(int argc,wchar_t** argv) {
  std::vector<std::string> args;
  for(int i=0;i<argc;++i) args.push_back(utf8(fs::path(argv[i])));
  return run(argc,args);
}
#else
int main(int argc,char** argv) { return run(argc,std::vector<std::string>(argv,argv+argc)); }
#endif
