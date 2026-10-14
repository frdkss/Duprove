#include "user_dirs.h"
#import <Foundation/Foundation.h>
UserFolders macKnownFolders() {
  UserFolders result;
  @autoreleasepool {
    const NSSearchPathDirectory dirs[]={NSDownloadsDirectory,NSDocumentDirectory,NSMoviesDirectory,NSPicturesDirectory,NSMusicDirectory,NSDesktopDirectory};
    const char* names[]={"downloads","documents","videos","pictures","music","desktop"};
    for(int i=0;i<6;++i) {
      NSArray<NSURL*>* urls=[[NSFileManager defaultManager] URLsForDirectory:dirs[i] inDomains:NSUserDomainMask];
      for(NSURL* url in urls) if(url.fileURL) result.emplace_back(fs::path(url.fileSystemRepresentation),names[i]);
    }
  }
  return result;
}
