#pragma once
#include "storage.h"
#include "scanner.h"
void discover(DB&, const std::vector<std::string>& roots, const fs::path& workingDirectory,
              json& states, ScanContext&, const std::function<void()>& progress);
