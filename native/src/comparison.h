#pragma once
#include "scanner.h"
#include "file_access.h"
struct DB;
enum class ByteMatch { equal, different, leftUnavailable, rightUnavailable, stopped };
std::string digest(const fs::path&, const FileInfo&, int root, ScanContext&, Directory* pinnedParent = nullptr);
ByteMatch equalBytes(const fs::path&, const FileInfo&, const fs::path&, const FileInfo&,
                     int root, ScanContext&, int otherRoot = -1, DirectoryCursor* left = nullptr, DirectoryCursor* right = nullptr);
bool current(const std::string&, const FileInfo&, DirectoryCursor* cursor = nullptr);
// Hashes select candidates only. Every group is established by byte comparison.
void groupExactFiles(DB&, ScanContext&, const std::function<void(const std::string&,int)>& invalid,
                     const std::function<void()>& progress);
