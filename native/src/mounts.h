#pragma once
#include <istream>
#include <string>
#include <vector>

namespace mounts {
struct Entry {
  std::string path, source, type, root, device;
  int id = 0, parent = 0;
  bool hidden = false;
};
std::string decode(const std::string& value);
bool within(const std::string& path, const std::string& base);
bool systemPath(const std::string& path);
std::vector<Entry> readLinux(std::istream& input);
std::vector<Entry> selectLinux(const std::vector<Entry>& entries);
std::vector<Entry> selectMac(const std::vector<Entry>& entries);
}
