#pragma once
#include <array>
#include <string>
#include <stdexcept>
#include <limits>
#ifdef _WIN32
#include <windows.h>
#include <bcrypt.h>
#include <vector>
#else
#include <picosha2.h>
#endif

// Keep the SHA-256 format identical across platforms and existing hash caches.
// Windows uses its optimized provider; other platforms retain the portable code.
class Sha256 {
#ifdef _WIN32
  struct Provider {
    BCRYPT_ALG_HANDLE handle=nullptr;
    DWORD objectSize=0;
    Provider() {
      if(BCryptOpenAlgorithmProvider(&handle,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)
        throw std::runtime_error("HASH_PROVIDER_FAILED");
      DWORD written=0;
      if(BCryptGetProperty(handle,BCRYPT_OBJECT_LENGTH,reinterpret_cast<PUCHAR>(&objectSize),sizeof(objectSize),&written,0)<0 ||
         written!=sizeof(objectSize) || !objectSize) {
        BCryptCloseAlgorithmProvider(handle,0);
        throw std::runtime_error("HASH_PROVIDER_FAILED");
      }
    }
    ~Provider() { BCryptCloseAlgorithmProvider(handle,0); }
  };
  static const Provider& provider() { static const Provider value; return value; }
  std::vector<unsigned char> object;
  BCRYPT_HASH_HANDLE handle=nullptr;
#else
  picosha2::hash256_one_by_one hash;
#endif
 public:
  Sha256() {
#ifdef _WIN32
    const auto& algorithm=provider();
    object.resize(algorithm.objectSize);
    if(BCryptCreateHash(algorithm.handle,&handle,object.data(),DWORD(object.size()),nullptr,0,0)<0) {
      if(handle) BCryptDestroyHash(handle);
      throw std::runtime_error("HASH_CREATE_FAILED");
    }
#endif
  }
  ~Sha256() {
#ifdef _WIN32
    if(handle) BCryptDestroyHash(handle);
#endif
  }
  Sha256(const Sha256&)=delete;
  Sha256& operator=(const Sha256&)=delete;
  void process(unsigned char* bytes,size_t length) {
#ifdef _WIN32
    // Callers stream bounded chunks rather than passing an entire file.
    if(length>std::numeric_limits<ULONG>::max() || BCryptHashData(handle,bytes,ULONG(length),0)<0)
      throw std::runtime_error("HASH_UPDATE_FAILED");
#else
    hash.process(bytes,bytes+length);
#endif
  }
  std::string finish() {
#ifdef _WIN32
    std::array<unsigned char,32> digest{};
    if(BCryptFinishHash(handle,digest.data(),ULONG(digest.size()),0)<0)
      throw std::runtime_error("HASH_FINISH_FAILED");
    constexpr char hex[]="0123456789abcdef";
    std::string result;result.reserve(64);
    for(auto byte:digest) { result+=hex[byte>>4];result+=hex[byte&15]; }
    return result;
#else
    hash.finish();return picosha2::get_hash_hex_string(hash);
#endif
  }
};
