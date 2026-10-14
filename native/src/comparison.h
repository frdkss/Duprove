#pragma once
#include "scanner.h"
#include "file_access.h"
std::string digest(const fs::path&, const FileInfo&, int root, ScanContext&);
bool equalBytes(const fs::path&, const FileInfo&, const fs::path&, const FileInfo&, int root, ScanContext&);
bool current(const std::string&, const FileInfo&);
