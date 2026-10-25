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
  // Windows can share still-pinned common ancestors with the preceding directory.
  // The new object owns those pins; the preceding object may then be destroyed.
  explicit Directory(const fs::path& path, const Directory* preceding = nullptr);
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
  friend class FileWriter;
};

class FileReader {
 public:
  // A borrowed Windows parent must outlive this reader and pin the same path.
  explicit FileReader(const fs::path& path, Directory* pinnedParent = nullptr);
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

// Exclusive creation in a pinned directory; never overwrite an existing file.
class FileWriter {
 public:
  explicit FileWriter(const fs::path& path);
  ~FileWriter();
  void write(const unsigned char* data,size_t length);
 private:
  struct Impl;
  std::unique_ptr<Impl> impl;
};

// Reuse one pinned Windows directory chain across nearby paths. POSIX keeps
// full path validation on each access because descriptors do not prevent rename.
class DirectoryCursor {
 public:
  Directory* parent(const fs::path& path);
  bool inspect(const fs::path& path,FileInfo& result);
 private:
  fs::path parentPath;
  std::unique_ptr<Directory> directory;
};
