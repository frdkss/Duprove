#include "content.h"
#include <lodepng.h>
#include <turbojpeg.h>
#include <algorithm>
#include <cmath>
#include <cstring>

namespace content {
namespace {
[[noreturn]] void fail(Status status=Status::invalid) { throw Failure{status}; }
unsigned orientation(const unsigned char* data,size_t length) {
  if(length<8) fail();
  const bool le=data[0]=='I' && data[1]=='I';
  if(!le && !(data[0]=='M' && data[1]=='M')) fail();
  auto word=[&](size_t i) -> uint32_t { if(i>length || length-i<2) fail(); return le ? data[i]|(unsigned(data[i+1])<<8) : (unsigned(data[i])<<8)|data[i+1]; };
  auto dword=[&](size_t i) -> uint32_t { if(i>length || length-i<4) fail(); return le ? word(i)|(word(i+2)<<16) : (word(i)<<16)|word(i+2); };
  if(word(2)!=42) fail();
  const size_t offset=dword(4); const auto count=word(offset);
  if(offset>length || count>(length-offset-2)/12) fail();
  for(unsigned i=0;i<count;++i) {
    const auto at=offset+2+12*i;
    if(word(at)==0x112) {
      if(word(at+2)!=3 || dword(at+4)!=1) fail();
      const auto value=word(at+8); if(value<1 || value>8) fail(); return value;
    }
  }
  return 1;
}
unsigned jpegOrientation(const std::vector<unsigned char>& bytes) {
  if(bytes.size()<4 || bytes[0]!=0xff || bytes[1]!=0xd8 || bytes[bytes.size()-2]!=0xff || bytes.back()!=0xd9) fail();
  unsigned result=1;
  for(size_t pos=2;pos<bytes.size();) {
    if(bytes[pos++]!=0xff) fail();
    while(pos<bytes.size() && bytes[pos]==0xff) ++pos;
    if(pos>=bytes.size()) fail();
    const auto marker=bytes[pos++];
    if(marker==0xda || marker==0xd9) break;
    if(marker==0x01 || (marker>=0xd0 && marker<=0xd7)) continue;
    if(pos+2>bytes.size()) fail();
    const size_t length=(unsigned(bytes[pos])<<8)|bytes[pos+1];
    if(length<2 || length>bytes.size()-pos) fail();
    if(marker==0xe1 && length>=8 && std::memcmp(bytes.data()+pos+2,"Exif\0\0",6)==0)
      result=orientation(bytes.data()+pos+8,length-8);
    pos+=length;
  }
  return result;
}
void sample(Value& value,const unsigned char* rgba,unsigned width,unsigned height,unsigned transform) {
  value.width=transform>=5 ? height : width; value.height=transform>=5 ? width : height;
  auto pixel=[&](unsigned x,unsigned y) {
    unsigned sx=x,sy=y;
    switch(transform) {
      case 2: sx=width-1-x;break;
      case 3: sx=width-1-x;sy=height-1-y;break;
      case 4: sy=height-1-y;break;
      case 5: sx=y;sy=x;break;
      case 6: sx=y;sy=height-1-x;break;
      case 7: sx=width-1-y;sy=height-1-x;break;
      case 8: sx=width-1-y;sy=x;break;
    }
    return rgba+4*(size_t(sy)*width+sx);
  };
  for(unsigned by=0;by<sampleSide;++by) for(unsigned bx=0;bx<sampleSide;++bx) {
    const double x0=double(bx)*value.width/sampleSide,x1=double(bx+1)*value.width/sampleSide;
    const double y0=double(by)*value.height/sampleSide,y1=double(by+1)*value.height/sampleSide;
    double sums[4]={};
    for(unsigned y=unsigned(y0);y<unsigned(std::ceil(y1));++y) for(unsigned x=unsigned(x0);x<unsigned(std::ceil(x1));++x) {
      const double weight=(std::min(x1,double(x+1))-std::max(x0,double(x)))*(std::min(y1,double(y+1))-std::max(y0,double(y)));
      const auto* source=pixel(x,y); const double alpha=source[3]/255.0;
      for(int channel=0;channel<3;++channel) sums[channel]+=weight*source[channel]/255.0*alpha;
      sums[3]+=weight*alpha;
    }
    for(int channel=0;channel<4;++channel) value.pixels[(by*sampleSide+bx)*4+channel]=float(sums[channel]/((x1-x0)*(y1-y0)));
  }
  auto luminance=[&](unsigned x,unsigned y) { const auto i=(y*sampleSide+x)*4; return value.pixels[i]*0.299+value.pixels[i+1]*0.587+value.pixels[i+2]*0.114; };
  for(unsigned y=0;y<8;++y) for(unsigned x=0;x<8;++x)
    if(luminance(x*31/8,y*31/7)>luminance((x+1)*31/8,y*31/7)) value.imageHash|=uint64_t(1)<<(y*8+x);
}
void png(Value& value,const std::vector<unsigned char>& bytes) {
  lodepng::State state; unsigned width=0,height=0,transform=1;
  if(lodepng_inspect(&width,&height,&state,bytes.data(),bytes.size())) fail();
  if(!width || !height) fail();
  if(uint64_t(width)*height>maxPixels) fail(Status::limit);
  // Bound inflate output even when a tiny IHDR carries an oversized IDAT stream.
  state.decoder.zlibsettings.max_output_size=size_t(width)*height*8+size_t(height)*8+1024;
  bool ended=false;
  for(size_t pos=8;pos<bytes.size();) {
    if(bytes.size()-pos<12) fail();
    const auto* chunk=bytes.data()+pos;
    const size_t length=lodepng_chunk_length(chunk);
    if(length>bytes.size()-pos-12 || lodepng_chunk_check_crc(chunk)) fail();
    if(lodepng_chunk_type_equals(chunk,"acTL")) fail(Status::unsupported);
    if(lodepng_chunk_type_equals(chunk,"eXIf")) transform=orientation(chunk+8,length);
    pos+=length+12;
    if(lodepng_chunk_type_equals(chunk,"IEND")) { if(length || pos!=bytes.size()) fail(); ended=true; break; }
  }
  if(!ended) fail();
  unsigned char* raw=nullptr;
  const auto error=lodepng_decode(&raw,&width,&height,&state,bytes.data(),bytes.size());
  std::unique_ptr<unsigned char,decltype(&free)> pixels(raw,free);
  if(error) fail();
  sample(value,pixels.get(),width,height,transform);
}
void jpeg(Value& value,const std::vector<unsigned char>& bytes) {
  const auto transform=jpegOrientation(bytes);
  std::unique_ptr<void,decltype(&tj3Destroy)> decoder(tj3Init(TJINIT_DECOMPRESS),tj3Destroy);
  if(!decoder) fail(Status::limit);
  if(tj3Set(decoder.get(),TJPARAM_STOPONWARNING,1) || tj3Set(decoder.get(),TJPARAM_SCANLIMIT,100) ||
     tj3Set(decoder.get(),TJPARAM_MAXMEMORY,64) || tj3Set(decoder.get(),TJPARAM_MAXPIXELS,int(maxPixels))) fail();
  if(tj3DecompressHeader(decoder.get(),bytes.data(),bytes.size())) fail();
  const int width=tj3Get(decoder.get(),TJPARAM_JPEGWIDTH),height=tj3Get(decoder.get(),TJPARAM_JPEGHEIGHT);
  if(width<=0 || height<=0) fail();
  if(uint64_t(width)*height>maxPixels) fail(Status::limit);
  if(tj3Get(decoder.get(),TJPARAM_COLORSPACE)==TJCS_CMYK || tj3Get(decoder.get(),TJPARAM_COLORSPACE)==TJCS_YCCK) fail(Status::unsupported);
  std::vector<unsigned char> pixels(size_t(width)*height*4);
  if(tj3Decompress8(decoder.get(),bytes.data(),bytes.size(),pixels.data(),0,TJPF_RGBA)) fail();
  sample(value,pixels.data(),unsigned(width),unsigned(height),transform);
}
}
bool imageCandidate(unsigned aw,unsigned ah,uint64_t a,unsigned bw,unsigned bh,uint64_t b) {
  if(!aw || !ah || !bw || !bh) return false;
  const double first=double(aw)*bh,second=double(bw)*ah;
  if(std::abs(first-second)>0.01*std::max(first,second)) return false;
  auto bits=a^b; unsigned distance=0; while(bits) { bits&=bits-1; ++distance; }
  return distance<=10;
}
bool similarImages(const Value& a,const Value& b) {
  if(!imageCandidate(a.width,a.height,a.imageHash,b.width,b.height,b.imageHash)) return false;
  double square=0,absolute=0,maximum=0;
  for(size_t i=0;i<a.pixels.size();++i) { const double d=std::abs(a.pixels[i]-b.pixels[i]); square+=d*d;absolute+=d;maximum=std::max(maximum,d); }
  return absolute/a.pixels.size()<=0.035 && std::sqrt(square/a.pixels.size())<=0.06 && maximum<=0.30;
}
Value decodeImage(const std::vector<unsigned char>& bytes,const std::string& ext) {
  Value value; value.kind="image";
  try { if(ext==".png") png(value,bytes); else jpeg(value,bytes); value.status=Status::ready; }
  catch(const Failure& error) { value.status=error.status; }
  return value;
}
}
