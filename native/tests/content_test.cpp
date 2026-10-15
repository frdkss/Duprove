#include "content.h"
#include <lodepng.h>
#include <turbojpeg.h>
#include <chrono>
#include <fstream>
#include <iostream>

namespace {
void require(bool value,const char* message) { if(!value) throw std::runtime_error(message); }
std::vector<unsigned char> bytes(const std::string& text) { return {text.begin(),text.end()}; }
std::vector<unsigned char> picture(unsigned width,unsigned height,bool different=false) {
  std::vector<unsigned char> pixels(size_t(width)*height*4);
  for(unsigned y=0;y<height;++y) for(unsigned x=0;x<width;++x) {
    const auto i=(size_t(y)*width+x)*4;
    pixels[i]=static_cast<unsigned char>(different ? 250-200*x/width : 20+200*x/width);
    pixels[i+1]=static_cast<unsigned char>(30+180*y/height);
    pixels[i+2]=static_cast<unsigned char>(different ? 220 : 50); pixels[i+3]=255;
  }
  return pixels;
}
std::vector<unsigned char> png(unsigned width,unsigned height,bool different=false) {
  const auto pixels=picture(width,height,different); std::vector<unsigned char> encoded;
  require(!lodepng::encode(encoded,pixels,width,height),"PNG fixture encode");return encoded;
}
std::vector<unsigned char> jpeg(unsigned width,unsigned height,int quality) {
  const auto pixels=picture(width,height);
  std::unique_ptr<void,decltype(&tj3Destroy)> encoder(tj3Init(TJINIT_COMPRESS),tj3Destroy);
  require(bool(encoder),"JPEG fixture encoder");
  require(!tj3Set(encoder.get(),TJPARAM_QUALITY,quality) && !tj3Set(encoder.get(),TJPARAM_SUBSAMP,TJSAMP_420),"JPEG fixture settings");
  unsigned char* output=nullptr;size_t length=0;
  require(!tj3Compress8(encoder.get(),pixels.data(),int(width),0,int(height),TJPF_RGBA,&output,&length),"JPEG fixture encode");
  std::unique_ptr<unsigned char,decltype(&tj3Free)> holder(output,tj3Free);return {output,output+length};
}
void write(const fs::path& path,const std::vector<unsigned char>& data) {
  fs::create_directories(path.parent_path());std::ofstream out(path,std::ios::binary);
  out.write(reinterpret_cast<const char*>(data.data()),std::streamsize(data.size()));require(bool(out),"fixture write");
}
}
int main() {
  const auto base=fs::current_path()/("duprove-content-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  try {
    auto text=content::decodeText(bytes(" \tПривет\u00a0мир\r\n"),".txt");
    require(text.status==content::Status::ready && text.text=="Привет мир","Unicode whitespace normalization");
    const auto markdown=content::decodeText(bytes("# Привет **мир**\n"),".md");
    require(markdown.text==text.text,"Markdown formatting removed");
    require(content::decodeText(bytes("<b>hello</b>"),".md").status==content::Status::unsupported,"HTML is not silently stripped");
    require(content::decodeText({0xc0,0xaf},".txt").status==content::Status::invalid,"invalid UTF-8");
    require(content::decodeText({0xff,0xfe,0x00,0xd8},".txt").status==content::Status::invalid,"invalid UTF-16");
    require(content::decodeText(bytes(" \r\n\t"),".txt").status==content::Status::empty,"blank text cannot warn");
    require(content::decodeText({0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1},".docx").status==content::Status::protectedFile,"encrypted Office container");
    const auto original=png(256,192),small=png(128,96),compressed=jpeg(128,96,70),different=png(128,96,true);
    const auto a=content::decodeImage(original,".png"),b=content::decodeImage(small,".png"),c=content::decodeImage(compressed,".jpg"),d=content::decodeImage(different,".png");
    require(a.status==content::Status::ready && b.status==content::Status::ready && c.status==content::Status::ready,"decode valid images");
    require(content::similarImages(a,b),"PNG resize should warn");
    require(content::similarImages(a,c),"JPEG compression and resize should warn");
    require(!content::similarImages(a,d),"different colors and layout should not warn");
    auto damaged=original; damaged[damaged.size()-5]^=1;
    require(content::decodeImage(damaged,".png").status==content::Status::invalid,"PNG CRC checked");
    auto truncated=compressed;truncated.resize(truncated.size()-8);
    require(content::decodeImage(truncated,".jpg").status==content::Status::invalid,"truncated JPEG rejected");
    require(!content::imageCandidate(100,100,0,100,50,0),"aspect ratio filter");

    const auto first=base/"first",second=base/"second";
    write(first/"a.png",original);write(first/"exact.png",original);write(second/"resized.PNG",small);
    write(second/"compressed.jpg",compressed);write(second/"different.png",different);
    write(first/"a.txt",bytes("private-content-marker hello"));
    write(second/"b.md",bytes("**private-content-marker**  hello\n"));
    ScanContext context;context.loadMode=2;json result;
    context.emit=[&](const json& event) { if(event["type"]=="result") result=event; };
    const json job={{"roots",json::array({utf8(first),utf8(second)})},{"database",utf8(base/"work"/"index.sqlite")},{"content",true}};
    scan(job,context);
    require(result["report"]["complete"]==true,"complete image/text scan");
    require(result["report"]["statistics"]["total"]["duplicates"]==1,"warn does not inflate exact duplicates");
    require(result["content"]["warning_pairs"]["image"]==5,"all unequal-byte image pairs, no exact pair");
    require(result["content"]["warning_pairs"]["text"]==1,"text warning");
    require(result["content"].dump().find("private-content-marker")==std::string::npos,"no extracted content in events");
    require(result["report"].dump().find("warn")==std::string::npos,"public contract stays exact-only");

    // Deterministic replacement after extraction must invalidate both kinds of result.
    bool changed=false;
    context.emit=[&](const json& event) {
      if(event["type"]=="result") result=event;
      if(!changed && event["type"]=="progress" && event["disks"][0]["phase"]=="content_comparing") {
        changed=true;fs::rename(first/"a.txt",base/"old.txt");write(first/"a.txt",bytes("different content now"));
      }
    };
    scan(job,context);
    require(changed && result["report"]["complete"]==false,"mutation after content extraction reported");
    require(result["content"]["warning_pairs"]["text"]==0,"no stale content warning");
    require(result["content"]["complete"]==false,"partial content result");
  } catch(const std::exception& error) {
    std::cerr<<error.what()<<'\n';std::error_code ec;fs::remove_all(base,ec);return 1;
  }
  std::error_code ec;fs::remove_all(base,ec);if(ec) return 1;return 0;
}
