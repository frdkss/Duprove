#pragma once
#include <algorithm>
#include <cstddef>
struct LoadProfile {
  double cpuDuty;
  double readMiB;
  int memoryMiB;
  int databaseCacheMiB;
  int hashBatch;
};
inline const LoadProfile& loadProfile(int mode) {
  static const LoadProfile profiles[]={{0.35,16,512,16,512},{0.60,64,1024,32,1024},{0.90,128,2048,64,2048}};
  return profiles[std::clamp(mode,0,2)];
}
inline std::size_t hashWorkerLimit(unsigned processors) {
  // Leave scheduler headroom even in high mode; always permit one worker.
  return std::min(4u,std::max(1u,processors/2));
}
