#include "scanner.h"
#include "file_access.h"
#include "user_dirs.h"
#include <chrono>
#include <fstream>
#include <iostream>
#include <sstream>

namespace {
void require(bool value,const char* message) { if(!value) throw std::runtime_error(message); }
void write(const fs::path& path,const std::string& bytes) {
  fs::create_directories(path.parent_path());
  std::ofstream file(path,std::ios::binary); file<<bytes;
  require(bool(file),"fixture write");
}
json run(const fs::path& db,const std::vector<fs::path>& roots,const std::function<void(const json&)>& hook={}) {
  ScanContext context; context.loadMode=2;
  json result;
  context.emit=[&](const json& event) { if(hook) hook(event); if(event["type"]=="result") result=event; };
  json paths=json::array(); for(const auto& root:roots) paths.push_back(utf8(root));
  require(scan({{"roots",paths},{"database",utf8(db)}},context)==0,"scan status");
  require(!result.is_null(),"result missing"); return result;
}
}
int main() {
  // No production paths are scanned; the only recursively removed path is this fixture.
  const auto base=fs::current_path()/fs::path("duprove-core-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  try {
    const auto a=base/"selected", b=a/"nested", outside=base/"unselected";
    write(a/"one.txt","same"); write(b/"two.bin","same"); write(outside/"third.txt","same");
    write(a/"empty",""); write(a/".git"/"excluded","same");
    fs::create_hard_link(a/"one.txt",a/"hardlink.txt");
    fs::create_hard_link(a/"one.txt",b/"hardlink.txt");
    write(a/"work"/"private.txt","same");
    auto result=run(a/"work"/"index.sqlite",{a,b});
    const auto& report=result["report"];
    require(report["complete"]==true,"complete scan");
    require(report["statistics"]["total"]["files"]==3,"selected paths, hardlinks, work exclusion");
    require(report["statistics"]["total"]["duplicates"]==1,"cross-root duplicate");
    require(report["statistics"]["disks"][0]["files"]==2 && report["statistics"]["disks"][1]["files"]==1,"nested root ownership");
    require(report.dump().find(utf8(base))==std::string::npos,"private path in public report");
    require(report.dump().find("one.txt")==std::string::npos,"private name in public report");
    const auto osFolders=knownFolders();
    for(const auto& folder:osFolders) require(folderCategory(folder.first/"fixture",osFolders)!="custom","OS known folder mapping");
    result=run(base/"work"/"missing.sqlite",{base/"missing",outside});
    require(result["report"]["complete"]==false && result["disks"][0]["errors"]==1,"unavailable root");
    require(result["report"]["statistics"]["total"]["files"]==1,"continue after inaccessible root");

    const auto changes=base/"changes";
    write(changes/"a","same"); write(changes/"b","same");
    bool changed=false;
    result=run(base/"work"/"change.sqlite",{changes},[&](const json& event) {
      if(!changed && event["type"]=="progress" && event["disks"][0]["phase"]=="hashing") {
        changed=true;
        const auto time=fs::last_write_time(changes/"b");
        fs::rename(changes/"b",base/"removed-file");
        write(changes/"b","DIFF"); fs::last_write_time(changes/"b",time);
      }
    });
    require(changed && result["report"]["complete"]==false,"replacement detected");
    require(result["report"]["statistics"]["total"]["duplicates"]==0,"replacement cannot match stale identity");

    const auto rewritten=base/"rewritten";
    write(rewritten/"a","same"); write(rewritten/"b","same"); changed=false;
    result=run(base/"work"/"rewrite.sqlite",{rewritten},[&](const json& event) {
      if(!changed && event["type"]=="progress" && event["disks"][0]["phase"]=="hashing") {
        changed=true;
        for(const auto* name:{"a","b"}) {
          const auto time=fs::last_write_time(rewritten/name);
          write(rewritten/name,"DIFF"); fs::last_write_time(rewritten/name,time);
        }
      }
    });
    require(changed && result["report"]["complete"]==false,"same-size edit with restored mtime detected");
    require(result["report"]["statistics"]["total"]["duplicates"]==0,"changed files do not use stale metadata");

    const auto first=base/"first", second=base/"second";
    write(first/"a","same"); write(second/"b","same"); changed=false;
    result=run(base/"work"/"late.sqlite",{first,second},[&](const json& event) {
      if(!changed && event["type"]=="progress" && event["disks"][1]["phase"]=="hashing" && event["disks"][0]["phase"]=="waiting") {
        changed=true; fs::remove(first/"a");
      }
    });
    require(changed && result["report"]["complete"]==false && result["report"]["statistics"]["total"]["duplicates"]==0,"disappearance between phases");

    FileInfo info; require(inspectFile(changes/"a",info),"file metadata");
    FileReader reader(changes/"a");
    require(reader.info().same(info),"reader metadata matches discovery");
    char bytes[16]; require(reader.read(bytes,sizeof(bytes))==4 && std::string(bytes,4)=="same","read-only reader");
    require(reader.read(bytes,sizeof(bytes))==0,"EOF");

    // Sharing a prefix must keep it pinned even after the preceding directory
    // object dies. A rename/replacement must not redirect subsequent opens.
    const auto pinned=base/"pinned";
    write(pinned/"left"/"deep"/"file","left");
    write(pinned/"right"/"file","right");
    {
      auto preceding=std::make_unique<Directory>(pinned/"left"/"deep");
      Directory next(pinned/"right",preceding.get());
      preceding.reset();
#ifdef _WIN32
      std::error_code renameError;
      fs::rename(pinned,base/"moved-pinned",renameError);
      require(bool(renameError),"shared ancestor stays pinned against replacement");
#endif
      FileReader shared(pinned/"right"/"file",&next);
      require(shared.read(bytes,sizeof(bytes))==5 && std::string(bytes,5)=="right","shared prefix reads correct sibling");
    }
    fs::rename(pinned,base/"released-pinned");

    // A cursor reuses only directory handles, never stale per-file metadata.
    const auto cursorRoot=base/"cursor";
    write(cursorRoot/"a"/"file","one");
    write(cursorRoot/"b"/"file","two");
    {
      DirectoryCursor cursor;
      FileInfo original,modified;
      require(cursor.inspect(cursorRoot/"a"/"file",original),"cursor first file");
      write(cursorRoot/"a"/"file","changed size");
      require(cursor.inspect(cursorRoot/"a"/"file",modified) && !modified.same(original),"cursor must inspect fresh file metadata");
      require(cursor.inspect(cursorRoot/"b"/"file",modified),"cursor sibling path");
      require(!cursor.inspect(cursorRoot/"missing"/"file",modified),"cursor unavailable parent");
      require(cursor.inspect(cursorRoot/"a"/"file",modified),"cursor recovers after unavailable parent");
      require(modified.size==12,"cursor returns correct recovered metadata");
    }

    const UserFolders folders={{base/"localized","documents"},{base/"localized"/"photos","pictures"}};
    require(folderCategory(base/"localized"/"photos"/"x",folders)=="pictures","most specific known folder");
    require(folderCategory(base/"localized-other"/"x",folders)=="custom","category prefix boundary");
#ifndef _WIN32
    std::istringstream xdg(" XDG_DOCUMENTS_DIR=\"$HOME/Документы\"\nXDG_DOWNLOAD_DIR=\"$HOME/\"\nXDG_VIDEOS_DIR=\"/mnt/Перенесено\"\nXDG_MUSIC_DIR=\"$(touch nope)\"\nXDG_DESKTOP_DIR=\"relative\"\nXDG_PICTURES_DIR=\"$HOME/a\\\"b\" # comment\n");
    const auto known=readUserDirs(xdg,"/home/test");
    require(known.size()==3,"XDG parser rejects executable/relative and disabled entries");
    require(folderCategory("/home/test/Документы/x",known)=="documents","localized XDG");
    require(folderCategory("/mnt/Перенесено/x",known)=="videos","relocated XDG");
    const auto linked=base/"links";
    fs::create_directory(linked);
    fs::create_directory_symlink(outside,linked/"dir");
    fs::create_symlink(outside/"third.txt",linked/"file");
    fs::create_directory_symlink(linked,linked/"cycle");
    result=run(base/"work"/"links.sqlite",{linked});
    require(result["report"]["statistics"]["total"]["files"]==0,"skip all symlinks");
    bool rejected=false;
    try { FileReader unsafe(linked/"dir"/"third.txt"); } catch(const std::exception&) { rejected=true; }
    require(rejected,"reject symlink in parent path");
    result=run(base/"work"/"root-link.sqlite",{linked/"dir"});
    require(result["report"]["complete"]==false,"reject selected symlink root");
#endif
    // reader's handle is still live on Windows; clean up after leaving this scope below.
  } catch(const std::exception& error) { std::cerr<<error.what()<<'\n'; std::error_code ec; fs::remove_all(base,ec); return 1; }
  std::error_code ec; fs::remove_all(base,ec);
  if(ec) { std::cerr<<"FIXTURE_CLEANUP_FAILED\n"; return 1; }
  return 0;
}
