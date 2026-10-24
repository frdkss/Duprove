#include "local_file.h"
#include "file_access.h"
#include "content.h"
#include <picosha2.h>
#include <fstream>

namespace content { std::string docxText(const std::vector<unsigned char>&); }
namespace {
std::string base64(const std::vector<unsigned char>& bytes) {
  constexpr char alphabet[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;out.reserve((bytes.size()+2)/3*4);
  for(size_t i=0;i<bytes.size();i+=3) {
    const auto n=(unsigned(bytes[i])<<16)|(i+1<bytes.size()?unsigned(bytes[i+1])<<8:0)|(i+2<bytes.size()?bytes[i+2]:0);
    out+=alphabet[(n>>18)&63];out+=alphabet[(n>>12)&63];out+=i+1<bytes.size()?alphabet[(n>>6)&63]:'=';out+=i+2<bytes.size()?alphabet[n&63]:'=';
  }
  return out;
}
}
json localFile(const json& request) {
  try {
    const auto path=fs::u8path(request.at("path").get<std::string>());
    if(!path.is_absolute() || excluded(path)) throw std::runtime_error("UNSAFE_PATH");
    for(const auto& part:path) if(part=="..") throw std::runtime_error("UNSAFE_PATH");
    bool within=false;
    for(const auto& root:request.at("roots")) within|=pathWithin(path,fs::u8path(root.get<std::string>()));
    if(!within || pathWithin(path,fs::u8path(request.at("private_directory").get<std::string>()))) throw std::runtime_error("UNSAFE_PATH");
    FileInfo expected;expected.kind=FileInfo::Kind::regular;
    expected.id=request.at("identity").get<std::string>();expected.size=request.at("size").get<int64_t>();
    expected.modified=std::stoll(request.at("mtime").get<std::string>());expected.changed=std::stoll(request.at("ctime").get<std::string>());
    Directory parent(path.parent_path()); FileReader file(path,&parent);
    if(!file.info().same(expected)) throw std::runtime_error("FILE_CHANGED");
    const auto action=request.at("action").get<std::string>();
    if(action!="preview" && action!="verify") throw std::runtime_error("INVALID_FILE_ACTION");
    const auto ext=extension(path);
    const bool text=ext==".txt"||ext==".md"||ext==".markdown"||ext==".html"||ext==".htm"||ext==".docx";
    const bool image=ext==".png"||ext==".jpg"||ext==".jpeg";
    if(action=="preview" && !text && !image) return {{"status","unsupported"},{"kind","none"}};
    const size_t limit=text && ext!=".docx"?1024*1024:8*1024*1024;
    if(expected.size<0 || (action=="preview" && uint64_t(expected.size)>limit)) return {{"status","limit"},{"kind","none"}};
    picosha2::hash256_one_by_one digest;
    std::vector<unsigned char> bytes,buffer(256*1024);
    if(action=="preview") bytes.reserve(size_t(expected.size));
    int64_t read=0;
    while(read<expected.size) {
      const auto n=file.read(reinterpret_cast<char*>(buffer.data()),size_t(std::min(int64_t(buffer.size()),expected.size-read)));
      if(!n) throw std::runtime_error("FILE_CHANGED");
      digest.process(buffer.begin(),buffer.begin()+n);
      if(action=="preview") bytes.insert(bytes.end(),buffer.begin(),buffer.begin()+n);
      read+=int64_t(n);
    }
    char extra;
    FileInfo current;
    if(file.read(&extra,1) || !file.info().same(expected) || !parent.inspect(path.filename(),current) || !current.same(expected)) throw std::runtime_error("FILE_CHANGED");
    digest.finish();const auto hash=picosha2::get_hash_hex_string(digest);
    if(action=="verify") return {{"status","ready"},{"sha256",hash}};
    content::maxTextBytes=512*1024;content::maxFileBytes=8*1024*1024;content::maxPixels=4*1024*1024;content::decoderMemoryMiB=64;
    if(text) {
      auto value=ext==".docx"?content::docxText(bytes):content::unicodeText(bytes);
      size_t end=std::min(value.size(),size_t(128*1024));
      while(end<value.size() && end>0 && (static_cast<unsigned char>(value[end])&0xc0)==0x80) --end;
      const bool truncated=end<value.size();value.resize(end);
      return {{"status","ready"},{"kind","text"},{"text",value},{"truncated",truncated},{"sha256",hash}};
    }
    const auto decoded=content::decodeImage(bytes,ext);
    if(decoded.status!=content::Status::ready) return {{"status",content::statusName(decoded.status)},{"kind","none"}};
    return {{"status","ready"},{"kind","image"},{"data","data:image/"+std::string(ext==".png"?"png":"jpeg")+";base64,"+base64(bytes)},
      {"width",decoded.width},{"height",decoded.height},{"sha256",hash}};
  } catch(const content::Failure& error) { return {{"status",content::statusName(error.status)},{"kind","none"}}; }
  catch(const std::bad_alloc&) { return {{"status","limit"},{"kind","none"}}; }
  catch(...) { return {{"status","unavailable"},{"kind","none"}}; }
}
