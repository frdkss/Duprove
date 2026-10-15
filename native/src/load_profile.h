#pragma once
#include <algorithm>
struct LoadProfile {
  double cpuDuty;
  double readMiB; // Zero means no artificial read limit.
  int memoryMiB;
  int databaseCacheMiB;
  int hashBatch;
};
inline const LoadProfile& loadProfile(int mode) {
  static const LoadProfile profiles[]={{0.60,64,512,16,512},{0.85,256,1024,32,1024},{1.0,0,2048,64,2048}};
  return profiles[std::clamp(mode,0,2)];
}
