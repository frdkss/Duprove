#include "scanner.h"
#include <chrono>
#include <thread>
using namespace std::chrono_literals;
bool ScanContext::waitFor(int root) const {
  while(controls.at(root)==1) std::this_thread::sleep_for(75ms);
  return controls.at(root)!=2;
}
void ScanContext::throttle() const {
  int v=loadMode;
  if(v<2) std::this_thread::sleep_for(v==0?4ms:1ms);
}
