#include "mounts.h"
#include "platform.h"
#include <iostream>
#include <sstream>
#include <stdexcept>

static void require(bool ok,const char* message) { if(!ok)throw std::runtime_error(message); }
static bool has(const std::vector<mounts::Entry>& entries,const std::string& path) {
  for(const auto& entry:entries)if(entry.path==path)return true;
  return false;
}
int main() {
  try {
    std::istringstream input(R"(1 0 8:1 / / rw - ext4 /dev/sda1 rw
2 1 0:3 / /proc rw - proc proc rw
3 1 8:2 / /run/media/user/USB\040drive rw shared:4 - exfat /dev/sdb1 rw
4 1 0:9 / /mnt/nfs rw - nfs4 server:/data rw
5 1 8:1 / /mnt/root-alias rw - ext4 /dev/sda1 rw
6 1 0:10 /@home /home rw - btrfs /dev/sdc1 rw
7 1 0:10 /@data /data rw - btrfs /dev/sdc1 rw
8 1 0:11 / /mnt/windows rw - 9p C:\134 rw
9 1 7:0 / /snap/package/1 ro - squashfs /dev/loop0 ro
10 1 0:12 / /mnt/ssh rw - fuse.sshfs user@host: rw
11 1 8:3 / /mnt/hidden rw - ext4 /dev/sdd1 rw
12 11 0:13 / /mnt/hidden rw - tmpfs tmpfs rw
broken line
13 1 8:4 / /media/line\012break rw - ext4 /dev/sde1 rw
14 1 8:5 / /media/literal\134040 rw - ext4 /dev/sdf1 rw
15 1 8:6 / /media/tab\011name rw - ext4 /dev/sdg1 rw
16 1 0:14 / /media/zpool rw - zfs pool/data rw
)");
    const auto selected=mounts::selectLinux(mounts::readLinux(input));
    require(selected.size()==11,"Linux mount count");
    require(has(selected,"/run/media/user/USB drive"),"udisks volume");
    require(has(selected,"/mnt/nfs")&&has(selected,"/mnt/ssh"),"network volumes");
    require(has(selected,"/home")&&has(selected,"/data"),"separate Btrfs subvolumes");
    require(has(selected,"/mnt/windows")&&has(selected,"/media/zpool"),"WSL and ZFS");
    require(!has(selected,"/mnt/root-alias")&&!has(selected,"/mnt/hidden"),"alias and covered mount");
    require(has(selected,"/media/line\nbreak")&&has(selected,"/media/tab\tname")&&has(selected,"/media/literal\\040"),"single-pass escapes");
    require(!mounts::systemPath("/run/media/user/USB")&&mounts::systemPath("/run/user/1000"),"run/media exception");
    std::vector<mounts::Entry> mac={
      {"/","/dev/disk1s1s1","apfs","/","root"},
      {"/System/Volumes/Data","/dev/disk1s2","apfs","/","data"},
      {"/System/Volumes/Preboot","/dev/disk1s3","apfs","/","preboot"},
      {"/Volumes/Renamed System","/dev/disk1s1s1","apfs","/","root"},
      {"/Volumes/Macintosh HD","/dev/disk2s1","exfat","/","external"},
      {"/Volumes/Network","server:/share","smbfs","/","network"},
      {"/Volumes/Hidden","/dev/disk3","apfs","/","hidden",0,0,true},
      {"/Volumes/Auto","map auto","autofs","/","auto"}
    };
    const auto volumes=mounts::selectMac(mac);
    require(volumes.size()==3&&has(volumes,"/"),"Mac visible volumes");
    require(has(volumes,"/Volumes/Macintosh HD"),"do not exclude an external volume by its label");
    require(has(volumes,"/Volumes/Network"),"Mac network volume");
#ifndef _WIN32
    require(!excluded("/run/media/user/USB")&&excluded("/System/Volumes/Data"),"scanner path policy");
#endif
    return 0;
  } catch(const std::exception& e) {std::cerr<<e.what()<<'\n';return 1;}
}
