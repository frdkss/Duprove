#pragma once
#include <filesystem>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>
namespace fs = std::filesystem;
using json = nlohmann::json;
std::string utf8(const fs::path& path);
json drives();
bool excluded(const fs::path& path);
bool pathWithin(const fs::path& path, const fs::path& base);
std::string pathKey(const fs::path& path);
std::vector<fs::path> mountPaths();
std::string extension(const fs::path& path);
