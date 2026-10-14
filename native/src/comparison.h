#pragma once
#include "scanner.h"
std::string digest(const fs::path&, int root, ScanContext&);
bool equalBytes(const fs::path&, const fs::path&, int root, ScanContext&);
bool current(const std::string&, int64_t size, int64_t time);
