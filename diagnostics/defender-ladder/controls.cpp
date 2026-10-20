// Reuse the L symbol references without changing or recompiling the A–L source.
#define DIAGNOSTIC_STAGE 12
#define main retained_baseline_main
#include "probes.cpp"
#undef main
#include "report.h"
int main() {
  retained_baseline_main();
  retain(&buildReport);
#if DIAGNOSTIC_CONTROL >= 2
  retain(&scan);
#endif
  return 0;
}
