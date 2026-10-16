#pragma once
#include "comparison.h"
#include <array>
#include <vector>
namespace content {
inline thread_local size_t maxTextBytes=8*1024*1024, maxFileBytes=64*1024*1024;
inline thread_local uint64_t maxPixels=16*1024*1024;
inline thread_local int decoderMemoryMiB=64;
constexpr unsigned sampleSide=32;
enum class Status { ready, empty, unsupported, invalid, protectedFile, limit, unavailable, stopped };
const char* statusName(Status);
struct Value {
  Status status=Status::unsupported;
  std::string kind,hash,text;
  unsigned width=0,height=0;
  uint64_t imageHash=0;
  std::array<float,sampleSide*sampleSide*4> pixels{};
};
struct Failure { Status status; };
std::string unicodeText(const std::vector<unsigned char>&);
std::string normalizeText(const std::string&);
Value decodeText(const std::vector<unsigned char>&,const std::string& extension);
Value decodeImage(const std::vector<unsigned char>&,const std::string& extension);
Value read(const fs::path&,const FileInfo&,int root,ScanContext&);
bool similarImages(const Value&,const Value&);
bool imageCandidate(unsigned,unsigned,uint64_t,unsigned,unsigned,uint64_t);
void compareFiles(DB&,ScanContext&,json& states,const std::function<void(const std::string&,int)>& invalid,
                  const std::function<void()>& progress);
void validate(DB&,ScanContext&,const std::function<void(const std::string&,int)>& invalid);
json result(DB&,bool enabled);
}
