#pragma once
#include "platform.h"
#include <atomic>
#include <array>
#include <functional>
#include <chrono>
struct ScanContext {
  std::array<std::atomic<int>,64> controls{};
  std::atomic<int> loadMode{0};
  std::function<void(const json&)> emit = [](const json&) {};
  std::function<void()> pulse = [] {};
  std::function<void(int,size_t)> readProgress = [](int,size_t) {};
  std::function<void(int)> fileProgress = [](int) {};
  std::function<void(int,const std::string&)> currentFile = [](int,const std::string&) {};
  uint64_t readBytes=0, reusedHashes=0;
  // Parallel readers divide the I/O budget; only their owner regulates CPU.
  double readBudgetShare=1.0;
  bool regulateCpu=true;
  bool waitFor(int root) const;
  void throttle(bool notify=true) const;
  void accountRead(int root,size_t bytes);
 private:
  mutable int budgetMode=-1;
  mutable double cpuStart=0;
  mutable std::chrono::steady_clock::time_point budgetStart{},readDue{};
};
void configureProcess(int mode);
int scan(const json& job, ScanContext& context);
