#pragma once
#include "comparison.h"
#include <condition_variable>
#include <deque>
#include <future>
#include <mutex>
#include <thread>

struct HashResult {
  std::string hash;
  uint64_t readBytes=0;
  bool cacheHit=false;
};

// Only the caller accesses SQLite, JSON and ScanContext callbacks. Workers own
// their readers, SHA state and pinned directory chains; controls are atomic.
class ParallelHasher {
 public:
  ParallelHasher(ScanContext&,int root,size_t candidates,int memoryMiB=2048);
  ~ParallelHasher();
  ParallelHasher(const ParallelHasher&)=delete;
  ParallelHasher& operator=(const ParallelHasher&)=delete;
  size_t size() const { return threads.size(); }
  std::future<HashResult> submit(std::string path,FileInfo expected,std::string cachedHash);
  uint64_t takeReadBytes() { return bytes.exchange(0); }
 private:
  struct Task {
    std::string path;
    FileInfo expected;
    std::string cachedHash;
    std::promise<HashResult> result;
  };
  void run();
  void shutdown();
  ScanContext& owner;
  int root;
  size_t workerCount=1;
  std::atomic<bool> stopping{false};
  std::atomic<uint64_t> bytes{0};
  std::mutex mutex;
  std::condition_variable available;
  std::deque<Task> queue;
  std::vector<std::thread> threads;
};
