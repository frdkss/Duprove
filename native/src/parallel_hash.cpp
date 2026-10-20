#include "parallel_hash.h"
#include "load_profile.h"

ParallelHasher::ParallelHasher(ScanContext& context,int selectedRoot,size_t candidates,int memoryMiB):owner(context),root(selectedRoot) {
  // Reserve headroom for per-thread stacks/allocator arenas under the process
  // memory limit (including Linux RLIMIT_AS), as well as SQLite and the report.
  const auto count=std::max<size_t>(1,std::min({candidates,
    hashWorkerLimit(std::thread::hardware_concurrency()),size_t(std::max(1,memoryMiB/128))}));
  workerCount=count;
  try { for(size_t i=0;i<count;++i) threads.emplace_back([this] { run(); }); }
  catch(...) { shutdown();throw; }
}
ParallelHasher::~ParallelHasher() { shutdown(); }
void ParallelHasher::shutdown() {
  // Change the condition under the same mutex as wait(): otherwise notify can
  // arrive between a worker's predicate check and its wait, leaving join stuck.
  { std::lock_guard<std::mutex> lock(mutex);stopping=true; }
  available.notify_all();
  for(auto& thread:threads) if(thread.joinable()) thread.join();
}
std::future<HashResult> ParallelHasher::submit(std::string path,FileInfo expected,std::string cachedHash) {
  Task task{std::move(path),std::move(expected),std::move(cachedHash),{}};
  auto future=task.result.get_future();
  { std::lock_guard<std::mutex> lock(mutex);queue.push_back(std::move(task)); }
  available.notify_one();return future;
}
void ParallelHasher::run() {
  ScanContext local;
  local.loadMode=2;
  local.regulateCpu=false;
  // Do not read threads.size() here: workers start during construction.
  local.readBudgetShare=1.0/workerCount;
  local.pulse=[&] { local.controls[root]=stopping ? 2 : owner.controls[root].load();local.loadMode=owner.loadMode.load(); };
  local.readProgress=[&](int,size_t n) { bytes.fetch_add(n); };
  DirectoryCursor directory;
  for(;;) {
    Task task;
    {
      std::unique_lock<std::mutex> lock(mutex);
      available.wait(lock,[&] { return stopping || !queue.empty(); });
      if(stopping) return;
      task=std::move(queue.front());queue.pop_front();
    }
    try {
      HashResult result;
      const auto before=local.readBytes;
      if(local.waitFor(root)) {
        const auto path=fs::u8path(task.path);
        try {
          auto* parent=directory.parent(path);
          result.cacheHit=task.cachedHash.size()==64;
          result.hash=result.cacheHit ? task.cachedHash : digest(path,task.expected,root,local,parent);
          if(!result.hash.empty() && !current(task.path,task.expected,&directory)) result.hash.clear();
        } catch(const std::exception&) { result.hash.clear(); }
      }
      result.readBytes=local.readBytes-before;
      task.result.set_value(std::move(result));
    } catch(...) { task.result.set_exception(std::current_exception()); }
  }
}
