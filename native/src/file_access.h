#pragma once
#include "platform.h"
#include <memory>

// Metadata comes from one handle/stat operation, never from content reads.
struct FileInfo {
  enum class Kind { regular, directory, skip } kind = Kind::skip;
  std::string id, device;
  int64_t size = 0, modified = 0, changed = 0;
  bool same(const FileInfo& other) const;
};
struct FileEntry { fs::path path; FileInfo info; bool error = false; };

// Opens every path component without following symlinks. Windows directories
// stay pinned against rename/replacement for the lifetime of the object.
class Directory {
 public:
  explicit Directory(const fs::path& path);
  ~Directory();
  Directory(const Directory&) = delete;
  Directory& operator=(const Directory&) = delete;
  const FileInfo& info() const;
  bool next(FileEntry& entry);
  bool inspect(const fs::path& name, FileInfo& result) const;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl;
  friend class FileReader;
};

class FileReader {
 public:
  explicit FileReader(const fs::path& path);
  ~FileReader();
  FileReader(const FileReader&) = delete;
  FileReader& operator=(const FileReader&) = delete;
  FileInfo info() const;
  size_t read(char* buffer, size_t length);
 private:
  struct Impl;
  std::unique_ptr<Impl> impl;
};
bool inspectFile(const fs::path& path, FileInfo& result);
