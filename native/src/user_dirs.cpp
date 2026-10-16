#include "user_dirs.h"
#include <map>
#include <algorithm>

UserFolders readUserDirs(std::istream& input,const fs::path& home) {
  // This is a data parser, not a shell evaluator. Unknown expansion is rejected.
  const std::map<std::string,std::string> names={{"DOWNLOAD","downloads"},{"DOCUMENTS","documents"},
    {"VIDEOS","videos"},{"PICTURES","pictures"},{"MUSIC","music"},{"DESKTOP","desktop"}};
  std::map<std::string,fs::path> values;
  std::string line;
  while(std::getline(input,line)) {
    const auto first=line.find_first_not_of(" \t");
    if(first==std::string::npos || line.compare(first,4,"XDG_")) continue;
    const auto end=line.find("_DIR",first+4);
    if(end==std::string::npos) continue;
    const auto name=names.find(line.substr(first+4,end-first-4));
    if(name==names.end()) continue;
    auto pos=line.find_first_not_of(" \t",end+4);
    if(pos==std::string::npos || line[pos++]!='=') continue;
    pos=line.find_first_not_of(" \t",pos);
    if(pos==std::string::npos || line[pos++]!='"') continue;
    std::string value;
    if(line.compare(pos,5,"$HOME")==0 && (pos+5==line.size() || line[pos+5]=='/' || line[pos+5]=='"')) { value=utf8(home); pos+=5; }
    bool valid=true,closed=false;
    for(;pos<line.size();++pos) {
      const auto c=line[pos];
      if(c=='"') { ++pos; closed=true; break; }
      if(c=='\\') {
        if(++pos==line.size()) { valid=false; break; }
        const char escaped=line[pos];
        if(escaped!='\\' && escaped!='"' && escaped!='$' && escaped!='`') value+='\\';
        value+=escaped;
      } else if(c=='$' || c=='`') { valid=false; break; }
      else value+=c;
    }
    pos=line.find_first_not_of(" \t\r",pos);
    if(!valid || !closed || (pos!=std::string::npos && line[pos]!='#')) continue;
    auto path=fs::u8path(value).lexically_normal();
    if(!path.is_absolute()) continue;
    values[name->second]=path;
  }
  UserFolders result;
  for(const auto& item:values) if(pathKey(item.second)!=pathKey(home)) result.emplace_back(item.second,item.first);
  return result;
}
std::string folderCategory(const fs::path& path,const UserFolders& folders) {
  const std::pair<fs::path,std::string>* match=nullptr;
  for(const auto& folder:folders)
    if(pathWithin(path,folder.first) && (!match || folder.first.native().size()>match->first.native().size())) match=&folder;
  return match ? match->second : "custom";
}
