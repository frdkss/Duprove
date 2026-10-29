#include "scanner.h"
#include "file_access.h"
#include "user_dirs.h"
#include "traversal.h"
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
json run(const fs::path& db,const std::vector<fs::path>& roots,const std::function<void(const json&)>& hook={},bool content=false,int mode=2) {
  ScanContext context; context.loadMode=mode;
  json result;
  context.emit=[&](const json& event) { if(hook) hook(event); if(event["type"]=="result") result=event; };
  json paths=json::array(); for(const auto& root:roots) paths.push_back(utf8(root));
  require(scan({{"roots",paths},{"database",utf8(db)},{"content",content}},context)==0,"scan status");
  require(!result.is_null(),"result missing");
  if(content) {
    int64_t counted=0;for(const auto& number:result["content"]["files"]) counted+=number.get<int64_t>();
    require(counted==result["report"]["statistics"]["total"]["files"].get<int64_t>(),"content and inventory count the same files");
  }
  return result;
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
    // Observe directory callbacks directly, independent of the scanner's 250 ms
    // telemetry throttle and how quickly this small inventory is traversed.
    const auto inventory=base/"inventory";
    for(int index=0;index<4;++index) write(inventory/std::to_string(index)/"file","fixture");
    auto inventoryResult=run(base/"work"/"inventory.sqlite",{inventory});
    {
      DB db(utf8(base/"work"/"inventory.sqlite"));
      ScanContext context; context.loadMode=2; context.emit=[](const json&) {};
      json states=inventoryResult["disks"];
      bool inventoryAdvanced=false;
      discover(db,{utf8(inventory)},base/"work",states,context,[&] {
        const auto& disk=states[0]; const auto& work=disk["work"];
        require(disk["phase"]=="discovering","directory progress phase");
        require(work["unit"]=="directories","directory work unit");
        require(disk["percent"].get<double>()<100,"discovery does not claim completion");
        require(work["done"].get<int64_t>()<=work["total"].get<int64_t>(),"directory work bounds");
        inventoryAdvanced|=work["done"].get<int64_t>()>0 && work["done"].get<int64_t>()<work["total"].get<int64_t>();
      });
      require(inventoryAdvanced,"directory work advances before traversal ends");
    }
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
    require(changed && result["report"]["complete"]==true && result["disks"][0]["phase"]=="completed","replacement skipped without failing the run");
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
    require(changed && result["report"]["complete"]==true && result["disks"][0]["errors"]==2,"same-size edits skipped with restored mtime");
    require(result["report"]["statistics"]["total"]["duplicates"]==0,"changed files do not use stale metadata");

    const auto first=base/"first", second=base/"second";
    write(first/"a","same"); write(second/"b","same"); changed=false;
    result=run(base/"work"/"late.sqlite",{first,second},[&](const json& event) {
      if(!changed && event["type"]=="progress" && event["disks"][1]["phase"]=="hashing" && event["disks"][0]["phase"]=="waiting") {
        changed=true; fs::remove(first/"a");
      }
    });
    require(changed && result["report"]["complete"]==true && result["report"]["statistics"]["total"]["duplicates"]==0,"disappearance between phases is skipped");

    const auto skipRoot=base/"skip-once",moved=base/"temporarily-unavailable";
    for(const char* name:{"a.txt","b.txt","c.txt"}) write(skipRoot/name,"same");
    bool removed=false,restored=false;
    result=run(base/"work"/"skip-once.sqlite",{skipRoot},[&](const json& event) {
      if(event["type"]!="progress") return;
      if(!removed && event["disks"][0]["phase"]=="hashing") {
        fs::rename(skipRoot/"a.txt",moved);removed=true;
      } else if(removed && !restored && event["disks"][0]["phase"]=="content") {
        fs::rename(moved,skipRoot/"a.txt");restored=true;
      }
    },true);
    require(removed && restored && result["report"]["complete"]==true,"remaining files complete after a skip");
    require(result["disks"][0]["errors"]==1,"skipped file is reported once across stages");
    require(result["report"]["statistics"]["total"]["duplicates"]==1,"other healthy duplicates are preserved");
    require(result["content"]["files"]["unavailable"]==0 && result["content"]["files"]["ready"]==2,"hash failure remains excluded from content inventory");
    require(result["report"]["statistics"]["total"]["files"]==2 && result["disks"][0]["files"]==2,"restored file stays excluded from inventory until the next run");
    result=run(base/"work"/"skip-once.sqlite",{skipRoot},{},true);
    require(result["report"]["complete"]==true && result["disks"][0]["errors"]==0,"next explicit scan retries recovered files");
    require(result["report"]["statistics"]["total"]["duplicates"]==2,"recovered file is included on next scan");

    // Fail a file in every exact-analysis phase, including serial and parallel
    // hashing. Healthy copies must still be counted and the run must reach 100%.
    for(int mode:{0,1,2}) for(const char* phase:{"hashing","comparing","validating"}) {
      const auto label=std::to_string(mode)+"-"+phase;
      const auto selected=base/("failure-"+label),database=base/"work"/(label+".sqlite"),removedFile=base/("removed-"+label);
      write(selected/"a.bad","same");write(selected/"b.txt","same");write(selected/"c.txt","same");
      bool failed=false;
      result=run(database,{selected},[&](const json& event) {
        if(!failed && event["type"]=="progress" && event["disks"][0]["phase"]==phase) {
          fs::rename(selected/"a.bad",removedFile);failed=true;
        }
      },false,mode);
      require(failed && result["report"]["complete"]==true && result["disks"][0]["percent"]==100,"file failure must not interrupt analysis");
      require(result["disks"][0]["errors"]==1 && result["disks"][0]["issues"][0]["operation"]==phase,"file failure reported once at its stage");
      const auto& total=result["report"]["statistics"]["total"];
      require(total["files"]==2 && total["file_bytes"]==8 && total["duplicates"]==1,"only healthy files are counted");
      require(result["disks"][0]["files"]==2 && result["disks"][0]["types"]==json({{".txt",2}}),"failed extension removed from disk counters");
      {
        DB index(utf8(database));Query remaining(index,"SELECT count(*) FROM files");
        require(remaining.next() && remaining.num(0)==2,"failed file removed from local catalog inventory");
      }
      fs::rename(removedFile,selected/"a.bad");
      result=run(database,{selected},{},false,mode);
      require(result["report"]["complete"]==true && result["disks"][0]["errors"]==0 && result["report"]["statistics"]["total"]["duplicates"]==2,"next run retries the recovered file");
    }

    const auto contentRoot=base/"content-failure";
    write(contentRoot/"a.txt","unique length");write(contentRoot/"b.txt","same");write(contentRoot/"c.txt","same");
    bool contentFailed=false;
    result=run(base/"work"/"content-failure.sqlite",{contentRoot},[&](const json& event) {
      if(!contentFailed && event["type"]=="progress" && event["disks"][0]["phase"]=="content") {
        fs::rename(contentRoot/"a.txt",base/"content-removed");contentFailed=true;
      }
    },true);
    require(contentFailed && result["report"]["complete"]==true && result["disks"][0]["phase"]=="completed","content access failure does not interrupt the run");
    require(result["disks"][0]["errors"]==1 && result["content"]["files"]["ready"]==2,"content access failure is recorded without counting the skipped file");
    require(result["report"]["statistics"]["total"]["files"]==2 && result["report"]["statistics"]["total"]["duplicates"]==1,"content access failure excluded without losing healthy copies");

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
