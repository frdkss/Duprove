#include "mounts.h"
#include <algorithm>
#include <map>
#include <set>
#include <sstream>

namespace mounts {
bool within(const std::string& path, const std::string& base) {
  return path == base || (path.size() > base.size() && path.compare(0, base.size(), base) == 0
    && (base == "/" || path[base.size()] == '/'));
}

std::string decode(const std::string& value) {
  std::string out;
  for (size_t i = 0; i < value.size(); ++i) {
    if (value[i] == '\\' && i + 3 < value.size()) {
      const auto escaped = value.substr(i, 4);
      char decoded = 0;
      if (escaped == "\\040") decoded = ' ';
      else if (escaped == "\\011") decoded = '\t';
      else if (escaped == "\\012") decoded = '\n';
      else if (escaped == "\\134") decoded = '\\';
      if (decoded) { out += decoded; i += 3; continue; }
    }
    out += value[i]; // Decode once: a literal \\040 must not become a space.
  }
  return out;
}

bool systemPath(const std::string& path) {
  if (within(path, "/run/media")) return false; // udisks on e.g. Fedora/Arch.
  for (const auto* base : {"/proc", "/sys", "/dev", "/run", "/boot", "/usr", "/bin", "/sbin",
       "/lib", "/lib64", "/etc", "/var", "/System", "/Library", "/private", "/snap"})
    if (within(path, base)) return true;
  return false;
}

std::vector<Entry> readLinux(std::istream& input) {
  std::vector<Entry> result;
  std::string line;
  while (std::getline(input, line)) {
    std::istringstream fields(line);
    Entry entry;
    std::string options, field, superOptions;
    if (!(fields >> entry.id >> entry.parent >> entry.device >> entry.root >> entry.path >> options)
      || entry.id <= 0 || entry.parent < 0 || entry.device.find(':') == std::string::npos) continue;
    while (fields >> field && field != "-") {}
    if (field != "-" || !(fields >> entry.type >> entry.source >> superOptions)) continue;
    entry.path = decode(entry.path); entry.root = decode(entry.root); entry.source = decode(entry.source);
    if (entry.path.empty() || entry.path[0] != '/' || entry.root.empty() || entry.root[0] != '/') continue;
    result.push_back(entry);
  }
  return result;
}

static bool linuxFilesystem(const Entry& entry) {
  if (entry.path == "/") return true;
  for (const auto* type : {"proc", "sysfs", "devtmpfs", "tmpfs", "devpts", "autofs", "overlay",
       "squashfs", "nsfs", "cgroup", "cgroup2", "tracefs", "debugfs", "fusectl",
       "fuse.gvfsd-fuse", "fuse.portal", "fuse.lxcfs"})
    if (entry.type == type) return false;
  // 9p/drvfs are needed for Windows volumes mounted inside WSL.
  return entry.source.rfind("/dev/", 0) == 0 || entry.type == "nfs" || entry.type == "nfs4"
    || entry.type == "cifs" || entry.type == "smb3" || entry.type == "9p" || entry.type == "drvfs"
    || entry.type == "zfs" || entry.type == "fuseblk" || entry.type.rfind("fuse.", 0) == 0;
}

std::vector<Entry> selectLinux(const std::vector<Entry>& entries) {
  std::map<std::string, Entry> visible;
  std::set<int> covered;
  std::map<int, const Entry*> byId;
  for (const auto& entry : entries) byId[entry.id] = &entry;
  // A stacked mount hides its parent at the same mount point, regardless of line order.
  for (const auto& entry : entries) {
    const auto parent = byId.find(entry.parent);
    if (parent != byId.end() && parent->second->path == entry.path) covered.insert(entry.parent);
  }
  for (const auto& entry : entries) if (!covered.count(entry.id)) visible[entry.path] = entry;
  std::vector<Entry> candidates, result;
  for (const auto& pair : visible) {
    const auto& entry = pair.second;
    if (!systemPath(entry.path) && linuxFilesystem(entry)) candidates.push_back(entry);
  }
  std::sort(candidates.begin(), candidates.end(), [](const Entry& a, const Entry& b) {
    return a.path.size() == b.path.size() ? a.path < b.path : a.path.size() < b.path.size();
  });
  std::set<std::pair<std::string, std::string>> seen;
  for (const auto& entry : candidates) {
    // Same filesystem root mounted again is an alias. Distinct Btrfs subvolumes stay distinct.
    if (seen.emplace(entry.device, entry.root).second) result.push_back(entry);
  }
  return result;
}

std::vector<Entry> selectMac(const std::vector<Entry>& entries) {
  std::vector<Entry> candidates, result;
  for (const auto& entry : entries) {
    if (entry.path.empty() || entry.path[0] != '/' || systemPath(entry.path)) continue;
    if (entry.path != "/" && (entry.hidden || entry.type == "autofs" || entry.type == "devfs")) continue;
    candidates.push_back(entry);
  }
  std::sort(candidates.begin(), candidates.end(), [](const Entry& a, const Entry& b) { return a.path < b.path; });
  std::set<std::string> devices, paths;
  for (const auto& entry : candidates)
    if (paths.insert(entry.path).second && devices.insert(entry.device).second) result.push_back(entry);
  return result;
}
}
