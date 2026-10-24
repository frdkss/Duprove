#pragma once
#include "file_access.h"

// A refusal leaves both paths present; an uncertain result requires manual review.
const char* recycleWindows(const fs::path& candidate,const FileInfo& candidateInfo,
                           const fs::path& original,const FileInfo& originalInfo);
