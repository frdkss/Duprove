#include "scanner.h"
#include "load_profile.h"
#include <algorithm>
#include <ctime>
#include <cstdlib>
#include <thread>
#ifdef _WIN32
#include <windows.h>
#else
#include <sys/resource.h>
#ifdef __APPLE__
#include <mach/mach.h>
#endif
#endif
using Clock=std::chrono::steady_clock;
using namespace std::chrono_literals;
namespace {
void sleepFor(std::chrono::nanoseconds duration) {
  if(duration.count()<=0) return;
#ifdef _WIN32
  struct Timer {
    HANDLE handle=CreateWaitableTimerExW(nullptr,nullptr,0x00000002,TIMER_ALL_ACCESS);
    ~Timer() { if(handle) CloseHandle(handle); }
  };
  thread_local Timer timer;
  if(timer.handle) {
    LARGE_INTEGER due;due.QuadPart=-std::max<int64_t>(1,duration.count()/100);
    if(SetWaitableTimer(timer.handle,&due,0,nullptr,nullptr,FALSE)) { WaitForSingleObject(timer.handle,100);return; }
  }
#endif
  std::this_thread::sleep_for(duration);
}
double cpuSeconds() {
#ifdef _WIN32
  FILETIME created,exited,kernel,user;
  if(!GetProcessTimes(GetCurrentProcess(),&created,&exited,&kernel,&user)) return 0;
  auto seconds=[](FILETIME t) { return double((uint64_t(t.dwHighDateTime)<<32)|t.dwLowDateTime)/1e7; };
  return seconds(kernel)+seconds(user);
#else
  return double(std::clock())/CLOCKS_PER_SEC;
#endif
}
}
bool ScanContext::waitFor(int root) const {
  pulse();
  while(controls.at(root)==1) { pulse(); std::this_thread::sleep_for(25ms); }
  return controls.at(root)!=2;
}
void ScanContext::throttle(bool notify) const {
  if(!regulateCpu) { if(notify) pulse();return; }
  const auto now=Clock::now();
  const int mode=std::clamp(loadMode.load(),0,2);
  if(budgetMode!=mode) { budgetMode=mode; budgetStart=now; cpuStart=cpuSeconds(); }
  const auto due=budgetStart+std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double>((cpuSeconds()-cpuStart)/loadProfile(mode).cpuDuty));
  while(Clock::now()<due) {
    if(notify) pulse();
    bool stopped=true; for(const auto& control:controls) if(control!=2) { stopped=false;break; }
    if(stopped) break;
    sleepFor(std::min(std::chrono::nanoseconds(25ms),std::chrono::duration_cast<std::chrono::nanoseconds>(due-Clock::now())));
  }
  if(Clock::now()-budgetStart>1s) { budgetStart=Clock::now(); cpuStart=cpuSeconds(); }
  if(notify) pulse();
}
void ScanContext::accountRead(int root,size_t bytes) {
  readBytes+=bytes; readProgress(root,bytes);
  const auto now=Clock::now();
  const auto limit=loadProfile(loadMode.load()).readMiB*readBudgetShare;
  // Carry 20 ms of credit: do not sleep separately for every tiny file or add
  // a full read delay on top of time already spent hashing/reading the chunk.
  readDue=std::max(now-20ms,readDue)+std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double>(bytes/(limit*1024*1024)));
  while(Clock::now()<readDue && controls.at(root)!=2) {
    pulse();sleepFor(std::min(std::chrono::nanoseconds(25ms),std::chrono::duration_cast<std::chrono::nanoseconds>(readDue-Clock::now())));
  }
  throttle();
}
// Only the CLI applies process-wide limits; embedding the core has no OS side effects.
void configureProcess(int mode) {
  const uint64_t memory=uint64_t(loadProfile(mode).memoryMiB)*1024*1024;
#ifdef _WIN32
  if(!SetPriorityClass(GetCurrentProcess(),BELOW_NORMAL_PRIORITY_CLASS)) throw std::runtime_error("PRIORITY_FAILED");
  // Commit limit, not working set. The handle lives until process exit.
  HANDLE job=CreateJobObjectW(nullptr,nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info{};
  info.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_PROCESS_MEMORY;
  info.ProcessMemoryLimit=SIZE_T(memory);
  if(!job || !SetInformationJobObject(job,JobObjectExtendedLimitInformation,&info,sizeof(info)) ||
     !AssignProcessToJobObject(job,GetCurrentProcess())) { if(job) CloseHandle(job); throw std::runtime_error("MEMORY_LIMIT_FAILED"); }
#else
  if(setpriority(PRIO_PROCESS,0,10)!=0) throw std::runtime_error("PRIORITY_FAILED");
#ifdef __APPLE__
  // macOS reserves large virtual ranges; RLIMIT_AS would reject normal allocations.
  // A watchdog caps resident memory, with up to one sampling interval of overshoot.
  std::thread([memory] {
    for(;;) {
      mach_task_basic_info_data_t info{};mach_msg_type_number_t count=MACH_TASK_BASIC_INFO_COUNT;
      if(task_info(mach_task_self(),MACH_TASK_BASIC_INFO,reinterpret_cast<task_info_t>(&info),&count)!=KERN_SUCCESS || info.resident_size>memory) std::_Exit(3);
      std::this_thread::sleep_for(25ms);
    }
  }).detach();
#else
  rlimit old{}; if(getrlimit(RLIMIT_AS,&old)!=0) throw std::runtime_error("MEMORY_LIMIT_FAILED");
  rlimit limit{std::min(rlim_t(memory),old.rlim_max),old.rlim_max};
  if(setrlimit(RLIMIT_AS,&limit)!=0) throw std::runtime_error("MEMORY_LIMIT_FAILED");
#endif
#endif
}
