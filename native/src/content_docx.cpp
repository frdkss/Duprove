#include "content.h"
#define MINIZ_NO_ZLIB_COMPATIBLE_NAMES
#include <miniz.h>
#include <pugixml.hpp>
#include <algorithm>
#include <map>
#include <set>

namespace content {
namespace {
[[noreturn]] void fail(Status status=Status::invalid) { throw Failure{status}; }
std::string localName(const char* name) {
  const std::string value=name; const auto colon=value.find(':');
  return colon==std::string::npos ? value : value.substr(colon+1);
}
std::string nameSpace(pugi::xml_node node) {
  const std::string name=node.name(); const auto colon=name.find(':');
  const std::string attribute=colon==std::string::npos ? "xmlns" : "xmlns:"+name.substr(0,colon);
  for(auto current=node;current;current=current.parent()) if(auto value=current.attribute(attribute.c_str())) return value.value();
  return "";
}
bool word(pugi::xml_node node) {
  const auto ns=nameSpace(node);
  return ns=="http://schemas.openxmlformats.org/wordprocessingml/2006/main" || ns=="http://purl.oclc.org/ooxml/wordprocessingml/main";
}
void xml(pugi::xml_document& document,const std::vector<unsigned char>& bytes) {
  const auto text=unicodeText(bytes);
  // pugixml is non-validating and can preserve unknown entities. Reject them
  // rather than treating the same malformed text as matching content.
  for(size_t pos=0;pos<text.size();++pos) {
    if(text.compare(pos,4,"<!--")==0) {
      const auto end=text.find("-->",pos+4);if(end==std::string::npos) fail();pos=end+2;continue;
    }
    if(text.compare(pos,9,"<![CDATA[")==0) {
      const auto end=text.find("]]>",pos+9);if(end==std::string::npos) fail();pos=end+2;continue;
    }
    if(text.compare(pos,9,"<!DOCTYPE")==0 || text.compare(pos,8,"<!ENTITY")==0) fail(Status::unsupported);
    if(text[pos]!='&') continue;
    const auto end=text.find(';',pos+1);
    if(end==std::string::npos || end-pos>16) fail();
    const auto entity=text.substr(pos+1,end-pos-1);
    if(entity=="amp" || entity=="lt" || entity=="gt" || entity=="quot" || entity=="apos") continue;
    if(entity.size()<2 || entity[0]!='#') fail();
    const bool hex=entity[1]=='x'; const size_t start=hex ? 2 : 1;
    if(start==entity.size()) fail();
    uint32_t cp=0;
    for(size_t i=start;i<entity.size();++i) {
      const char c=entity[i]; unsigned digit;
      if(c>='0' && c<='9') digit=unsigned(c-'0');
      else if(hex && c>='a' && c<='f') digit=unsigned(c-'a'+10);
      else if(hex && c>='A' && c<='F') digit=unsigned(c-'A'+10);
      else fail();
      cp=cp*(hex ? 16 : 10)+digit;
      if(cp>0x10ffff) fail();
    }
    if((cp<32 && cp!=9 && cp!=10 && cp!=13) || (cp>=0xd800 && cp<=0xdfff) || cp==0xfffe || cp==0xffff) fail();
  }
  if(!document.load_buffer(text.data(),text.size(),pugi::parse_default,pugi::encoding_utf8)) fail();
  unsigned roots=0;for(auto node:document.children()) if(node.type()==pugi::node_element) ++roots;
  if(roots!=1) fail();
}
struct Zip {
  mz_zip_archive archive{};
  std::map<std::string,mz_uint> entries;
  explicit Zip(const std::vector<unsigned char>& bytes) {
    if(!mz_zip_reader_init_mem(&archive,bytes.data(),bytes.size(),0)) fail();
    try {
      const auto count=mz_zip_reader_get_num_files(&archive);
      if(count>4096) fail(Status::limit);
      uint64_t total=0;
      for(mz_uint i=0;i<count;++i) {
        mz_zip_archive_file_stat info{};
        if(!mz_zip_reader_file_stat(&archive,i,&info)) fail();
        if(info.m_is_encrypted) fail(Status::protectedFile);
        if(info.m_uncomp_size>maxFileBytes-total) fail(Status::limit);
        total+=info.m_uncomp_size;
        const std::string name=info.m_filename;
        if(mz_zip_reader_get_filename(&archive,i,nullptr,0)!=name.size()+1) fail();
        if(name.empty() || name.size()>=sizeof(info.m_filename)-1 || name[0]=='/' || name.find_first_of("\\:")!=std::string::npos) fail();
        for(const auto& part:fs::u8path(name)) if(part==".." || part==".") fail();
        if(!entries.emplace(name,i).second) fail();
      }
      if(!mz_zip_validate_archive(&archive,0)) fail();
    } catch(...) { mz_zip_reader_end(&archive); throw; }
  }
  ~Zip() { mz_zip_reader_end(&archive); }
  std::vector<unsigned char> get(const std::string& name) {
    const auto found=entries.find(name); if(found==entries.end()) fail();
    mz_zip_archive_file_stat info{};
    if(!mz_zip_reader_file_stat(&archive,found->second,&info)) fail();
    if(info.m_uncomp_size>maxTextBytes) fail(Status::limit);
    std::vector<unsigned char> bytes(size_t(info.m_uncomp_size));
    if(!mz_zip_reader_extract_to_mem(&archive,found->second,bytes.data(),bytes.size(),0)) fail();
    return bytes;
  }
};
std::string target(const std::string& base,const std::string& relative) {
  std::string decoded;
  auto hex=[](char c) -> unsigned { if(c>='0' && c<='9') return unsigned(c-'0'); if(c>='a' && c<='f') return unsigned(c-'a'+10); if(c>='A' && c<='F') return unsigned(c-'A'+10); fail(); };
  for(size_t i=0;i<relative.size();++i) {
    if(relative[i]!='%') decoded+=relative[i];
    else { if(relative.size()-i<3) fail(); decoded+=char((hex(relative[i+1])<<4)|hex(relative[i+2])); i+=2; }
  }
  unicodeText({decoded.begin(),decoded.end()});
  if(decoded.empty() || decoded.find_first_of("\\:#?")!=std::string::npos) fail(Status::unsupported);
  auto path=decoded[0]=='/' ? fs::u8path(decoded.substr(1)) : fs::u8path(base).parent_path()/fs::u8path(decoded);
  path=path.lexically_normal();
  if(path.is_absolute()) fail();
  for(const auto& part:path) if(part=="..") fail();
  return path.generic_u8string();
}
std::string partText(const std::vector<unsigned char>& bytes,bool main=false) {
  pugi::xml_document document; xml(document,bytes);
  auto root=document.document_element(); if(!word(root)) fail();
  if(main) {
    if(localName(root.name())!="document") fail();
    unsigned bodies=0;for(auto child:root.children()) if(word(child) && localName(child.name())=="body") ++bodies;
    if(bodies!=1) fail();
  }
  std::string out;
  std::vector<std::pair<pugi::xml_node,bool>> stack{{root,false}};
  while(!stack.empty()) {
    const auto [node,leave]=stack.back(); stack.pop_back();
    if(node.type()!=pugi::node_element) continue;
    const auto name=localName(node.name());
    if(!word(node)) fail(Status::unsupported);
    if(word(node)) {
      if(name=="drawing" || name=="pict" || name=="object" || name=="altChunk" || name=="fldChar" ||
         name=="fldSimple" || name=="del" || name=="moveFrom" || name=="vanish" || name=="sym" ||
         name=="instrText" || name=="delText") fail(Status::unsupported);
      if(!leave && name=="t") out+=node.child_value();
      if(!leave && (name=="tab" || name=="br" || name=="cr")) out+=' ';
      if(!leave && name=="noBreakHyphen") out+="\xe2\x80\x91";
      if(!leave && name=="softHyphen") out+="\xc2\xad";
      if(leave && (name=="p" || name=="tc" || name=="tr")) out+=' ';
    }
    if(!leave) {
      stack.push_back({node,true});
      for(auto child=node.last_child();child;child=child.previous_sibling()) stack.push_back({child,false});
    }
    if(out.size()>maxTextBytes) fail(Status::limit);
  }
  return normalizeText(out);
}
}
std::string docxText(const std::vector<unsigned char>& bytes) {
  const unsigned char ole[]={0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1};
  if(bytes.size()>=8 && std::equal(ole,ole+8,bytes.begin())) fail(Status::protectedFile);
  Zip zip(bytes);
  pugi::xml_document relationships; xml(relationships,zip.get("_rels/.rels"));
  const auto rels=relationships.document_element();
  if(localName(rels.name())!="Relationships" || nameSpace(rels)!="http://schemas.openxmlformats.org/package/2006/relationships") fail();
  std::string main;
  for(auto relationship:rels.children()) {
    const std::string type=relationship.attribute("Type").value();
    if(type=="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ||
       type=="http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument") {
      if(!main.empty() || std::string(relationship.attribute("TargetMode").value())=="External") fail();
      main=target("",relationship.attribute("Target").value());
    }
  }
  if(main.empty()) fail();
  pugi::xml_document types; xml(types,zip.get("[Content_Types].xml"));
  if(nameSpace(types.document_element())!="http://schemas.openxmlformats.org/package/2006/content-types") fail();
  bool validType=false;
  for(auto node:types.document_element().children()) {
    if(std::string(node.attribute("PartName").value())=="/"+main &&
       std::string(node.attribute("ContentType").value())=="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml") validType=true;
  }
  if(!validType) fail(Status::unsupported);
  std::set<std::string> parts;
  const auto mainPath=fs::u8path(main);
  const auto relationPath=(mainPath.parent_path()/"_rels"/fs::u8path(utf8(mainPath.filename())+".rels")).generic_u8string();
  if(zip.entries.count(relationPath)) {
    pugi::xml_document related; xml(related,zip.get(relationPath));
    if(nameSpace(related.document_element())!="http://schemas.openxmlformats.org/package/2006/relationships") fail();
    for(auto rel:related.document_element().children()) {
      const std::string type=rel.attribute("Type").value();
      const auto slash=type.rfind('/'); const auto kind=slash==std::string::npos ? "" : type.substr(slash+1);
      if(kind=="header" || kind=="footer" || kind=="footnotes" || kind=="endnotes") {
        if(std::string(rel.attribute("TargetMode").value())=="External") fail(Status::unsupported);
        parts.insert(target(main,rel.attribute("Target").value()));
      }
    }
  }
  auto out=partText(zip.get(main),true);
  // Auxiliary text is sorted by content, independent of ZIP entry/part names.
  std::vector<std::string> auxiliary;
  for(const auto& part:parts) auxiliary.push_back(partText(zip.get(part)));
  std::sort(auxiliary.begin(),auxiliary.end());
  for(const auto& text:auxiliary) { if(out.size()+text.size()+1>maxTextBytes) fail(Status::limit); out+=' '; out+=text; }
  return out;
}
}
