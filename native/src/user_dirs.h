#pragma once
#include "platform.h"
#include <istream>
using UserFolders = std::vector<std::pair<fs::path,std::string>>;
UserFolders readUserDirs(std::istream& input,const fs::path& home);
UserFolders knownFolders();
std::string folderCategory(const fs::path& path,const UserFolders& folders);
#ifdef __APPLE__
UserFolders macKnownFolders();
#endif
