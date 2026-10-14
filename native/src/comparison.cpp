#include "comparison.h"
#include <picosha2.h>
#include <fstream>
#include <algorithm>
std::string digest(const fs::path& p,int root,ScanContext& context){
 std::ifstream in(p,std::ios::binary);if(!in)return "";
 picosha2::hash256_one_by_one h; std::array<unsigned char,65536>b{};
 while(in){if(!context.waitFor(root))return "";in.read(reinterpret_cast<char*>(b.data()),b.size());auto n=in.gcount();
  h.process(b.begin(),b.begin()+n);
  context.throttle();
 }
 if(!in.eof())return "";
 h.finish();
 return picosha2::get_hash_hex_string(h);
}
bool equalBytes(const fs::path& a,const fs::path& b,int root,ScanContext& context){
 std::ifstream x(a,std::ios::binary),y(b,std::ios::binary);if(!x||!y)return false;
 std::array<char,65536> bx{},by{};
 do{if(!context.waitFor(root))return false;x.read(bx.data(),bx.size());y.read(by.data(),by.size());if(x.gcount()!=y.gcount()||!std::equal(bx.begin(),bx.begin()+x.gcount(),by.begin()))return false;context.throttle();}while(x&&y);
 return x.eof()&&y.eof();
}
bool current(const std::string& p,int64_t size,int64_t time){std::error_code ec;auto path=fs::u8path(p);auto n=fs::file_size(path,ec);if(ec||n!=uint64_t(size)||excluded(path))return false;auto t=fs::last_write_time(path,ec);return !ec&&t.time_since_epoch().count()==time;}
