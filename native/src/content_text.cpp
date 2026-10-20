#include "content.h"
#include <cmark.h>

namespace content {
std::string docxText(const std::vector<unsigned char>&);
namespace {
[[noreturn]] void fail(Status status=Status::invalid) { throw Failure{status}; }
void append(std::string& out,uint32_t cp) {
  if(cp<0x80) out+=char(cp);
  else if(cp<0x800) { out+=char(0xc0|(cp>>6)); out+=char(0x80|(cp&63)); }
  else if(cp<0x10000) { out+=char(0xe0|(cp>>12)); out+=char(0x80|((cp>>6)&63)); out+=char(0x80|(cp&63)); }
  else { out+=char(0xf0|(cp>>18)); out+=char(0x80|((cp>>12)&63)); out+=char(0x80|((cp>>6)&63)); out+=char(0x80|(cp&63)); }
}
uint32_t next(const std::string& text,size_t& i) {
  const auto first=static_cast<unsigned char>(text[i++]);
  if(first<0x80) return first;
  unsigned n; uint32_t cp,minimum;
  if(first>=0xc2 && first<=0xdf) { n=1;cp=first&31;minimum=0x80; }
  else if(first>=0xe0 && first<=0xef) { n=2;cp=first&15;minimum=0x800; }
  else if(first>=0xf0 && first<=0xf4) { n=3;cp=first&7;minimum=0x10000; }
  else fail();
  if(n>text.size()-i) fail();
  while(n--) { const auto c=static_cast<unsigned char>(text[i++]); if((c&0xc0)!=0x80) fail(); cp=(cp<<6)|(c&63); }
  if(cp<minimum || cp>0x10ffff || (cp>=0xd800 && cp<=0xdfff)) fail();
  return cp;
}
bool whitespace(uint32_t cp) {
  return (cp>=9 && cp<=13) || cp==32 || cp==0x85 || cp==0xa0 || cp==0x1680 ||
    (cp>=0x2000 && cp<=0x200a) || cp==0x2028 || cp==0x2029 || cp==0x202f || cp==0x205f || cp==0x3000;
}
std::string markdown(const std::string& input) {
  std::unique_ptr<cmark_node,decltype(&cmark_node_free)> document(cmark_parse_document(input.data(),input.size(),CMARK_OPT_DEFAULT),cmark_node_free);
  if(!document) fail(Status::limit);
  std::unique_ptr<cmark_iter,decltype(&cmark_iter_free)> iterator(cmark_iter_new(document.get()),cmark_iter_free);
  if(!iterator) fail(Status::limit);
  std::string out;
  cmark_event_type event;
  while((event=cmark_iter_next(iterator.get()))!=CMARK_EVENT_DONE) {
    auto* node=cmark_iter_get_node(iterator.get()); const auto type=cmark_node_get_type(node);
    // HTML/images cannot be reduced to their visible text without another parser.
    if(type==CMARK_NODE_HTML_BLOCK || type==CMARK_NODE_HTML_INLINE || type==CMARK_NODE_IMAGE) fail(Status::unsupported);
    if(event==CMARK_EVENT_ENTER) {
      if(type==CMARK_NODE_TEXT || type==CMARK_NODE_CODE || type==CMARK_NODE_CODE_BLOCK) out+=cmark_node_get_literal(node);
      if(type==CMARK_NODE_SOFTBREAK || type==CMARK_NODE_LINEBREAK || type==CMARK_NODE_CODE_BLOCK) out+=' ';
    }
    if(event==CMARK_EVENT_EXIT && (type==CMARK_NODE_PARAGRAPH || type==CMARK_NODE_HEADING || type==CMARK_NODE_ITEM)) out+=' ';
    if(out.size()>maxTextBytes) fail(Status::limit);
  }
  return out;
}
}
std::string unicodeText(const std::vector<unsigned char>& bytes) {
  std::string out;
  if(bytes.size()>=2 && ((bytes[0]==0xff && bytes[1]==0xfe) || (bytes[0]==0xfe && bytes[1]==0xff))) {
    if(bytes.size()%2) fail();
    const bool le=bytes[0]==0xff;
    auto unit=[&](size_t i) { return uint32_t(le ? bytes[i]|(unsigned(bytes[i+1])<<8) : (unsigned(bytes[i])<<8)|bytes[i+1]); };
    for(size_t i=2;i<bytes.size();i+=2) {
      uint32_t cp=unit(i);
      if(cp>=0xd800 && cp<=0xdbff) { if(i+3>=bytes.size()) fail(); const auto low=unit(i+2); if(low<0xdc00 || low>0xdfff) fail(); cp=0x10000+((cp-0xd800)<<10)+(low-0xdc00); i+=2; }
      else if(cp>=0xdc00 && cp<=0xdfff) fail();
      append(out,cp);
    }
  } else {
    size_t start=bytes.size()>=3 && bytes[0]==0xef && bytes[1]==0xbb && bytes[2]==0xbf ? 3 : 0;
    out.assign(bytes.begin()+start,bytes.end());
  }
  for(size_t i=0;i<out.size();) {
    const auto cp=next(out,i);
    if((cp<32 || (cp>=0x7f && cp<=0x9f)) && !whitespace(cp)) fail();
  }
  return out;
}
std::string normalizeText(const std::string& text) {
  std::string out; bool space=false;
  for(size_t i=0;i<text.size();) {
    const auto cp=next(text,i);
    if((cp<32 || (cp>=0x7f && cp<=0x9f)) && !whitespace(cp)) fail();
    if(whitespace(cp)) space=!out.empty();
    else { if(space) out+=' '; space=false; append(out,cp); }
  }
  return out;
}
Value decodeText(const std::vector<unsigned char>& bytes,const std::string& ext) {
  Value value; value.kind="text";
  try {
    auto text=ext==".docx" ? docxText(bytes) : unicodeText(bytes);
    if(ext==".md" || ext==".markdown") text=markdown(text);
    value.text=normalizeText(text);
    if(value.text.size()>maxTextBytes) fail(Status::limit);
    value.status=value.text.empty() ? Status::empty : Status::ready;
  } catch(const Failure& error) { value.status=error.status; }
  return value;
}
}
