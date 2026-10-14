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
std::string identity(const fs::path& path);
std::string category(const fs::path& path);
std::string extension(const fs::path& path);
