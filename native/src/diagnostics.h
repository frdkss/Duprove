#pragma once
#include "platform.h"
#include <algorithm>

// Local diagnostics only. Group repeats and retain at most three short examples
// per reason/stage, so errors cannot create an unbounded stream of private paths.
inline void recordIssue(json& state,const char* code,const std::string& path,const char* operation=nullptr) {
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
  auto& examples=(*issue)["examples"];
  if(!path.empty() && path.size()<=1024 && examples.size()<3 && std::find(examples.begin(),examples.end(),path)==examples.end()) examples.push_back(path);
}
