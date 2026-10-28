#pragma once
#include "platform.h"
// Only bounded codes, operations and counters may enter diagnostics.
// Keep the empty examples array for compatibility with local protocol v1.
inline void recordIssue(json& state,const char* code,const char* operation=nullptr) {
  state["errors"]=state["errors"].get<int64_t>()+1;
  if(!state.contains("issues")) state["issues"]=json::array();
  const std::string stage=operation ? operation : state.at("work").value("operation",std::string("validating"));
  auto& issues=state["issues"];
  json* issue=nullptr;
  for(auto& item:issues) if(item["code"]==code && item["operation"]==stage) { issue=&item;break; }
  if(!issue) {
    if(issues.size()>=16) return;
    issues.push_back({{"code",code},{"operation",stage},{"count",0},{"examples",json::array()}});
    issue=&issues.back();
  }
  (*issue)["count"]=(*issue)["count"].get<int64_t>()+1;
}

// Individual unavailable/changed entries are skipped; unfinished directory
// traversal and unknown failures still make a run incomplete.
inline bool hasBlockingIssues(const json& state) {
  int64_t skipped=0;
  if(state.contains("issues")) for(const auto& issue:state["issues"])
    if(issue["code"]=="metadata_unavailable" || issue["code"]=="file_unavailable_or_changed")
      skipped+=issue["count"].get<int64_t>();
  return state.value("errors",int64_t(0))>skipped;
}
