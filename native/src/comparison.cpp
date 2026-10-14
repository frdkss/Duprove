#include "comparison.h"
#include <picosha2.h>
#include <algorithm>
std::string digest(const fs::path& path,const FileInfo& expected,int root,ScanContext& context) {
  try {
    FileReader file(path);
    if(!file.info().same(expected)) return "";
    picosha2::hash256_one_by_one hash;
    std::array<unsigned char,262144> buffer;
    int64_t total=0;
    for(;;) {
      if(!context.waitFor(root)) return "";
      const auto n=file.read(reinterpret_cast<char*>(buffer.data()),buffer.size());
      total+=int64_t(n);
      if(total>expected.size) return "";
      if(!n) break;
      hash.process(buffer.begin(),buffer.begin()+n);
      context.throttle();
    }
    if(total!=expected.size || !file.info().same(expected)) return "";
    hash.finish(); return picosha2::get_hash_hex_string(hash);
  } catch(const std::exception&) { return ""; }
}
bool equalBytes(const fs::path& a,const FileInfo& expectedA,const fs::path& b,const FileInfo& expectedB,int root,ScanContext& context) {
  try {
    FileReader x(a),y(b);
    if(!x.info().same(expectedA) || !y.info().same(expectedB)) return false;
    std::array<char,262144> bx,by;
    int64_t total=0;
    for(;;) {
      if(!context.waitFor(root)) return false;
      const auto nx=x.read(bx.data(),bx.size()),ny=y.read(by.data(),by.size());
      if(nx!=ny || !std::equal(bx.begin(),bx.begin()+nx,by.begin())) return false;
      total+=int64_t(nx);
      if(total>expectedA.size) return false;
      if(!nx) break;
      context.throttle();
    }
    return total==expectedA.size && x.info().same(expectedA) && y.info().same(expectedB);
  } catch(const std::exception&) { return false; }
}
bool current(const std::string& path,const FileInfo& expected) {
  FileInfo info;
  return inspectFile(fs::u8path(path),info) && info.same(expected);
}
