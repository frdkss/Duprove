#pragma once
#include "platform.h"
#include <atomic>
#include <array>
#include <functional>
struct ScanContext {
  std::array<std::atomic<int>,64> controls{};
  std::atomic<int> loadMode{0};
  std::function<void(const json&)> emit = [](const json&) {};
  bool waitFor(int root) const;
  void throttle() const;
};
int scan(const json& job, ScanContext& context);
