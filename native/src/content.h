#pragma once
#include "platform.h"

enum class ContentMatch { unsupported, different, warn };
class ContentComparator {
public:
  virtual ~ContentComparator() = default;
  virtual ContentMatch compare(const fs::path& left, const fs::path& right) const = 0;
};
