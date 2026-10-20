// Static-link diagnostics, never invoked by the runner. Volatile stores retain
// real symbol references; merely naming a static library would not link it in.
#ifndef DIAGNOSTIC_STAGE
#error DIAGNOSTIC_STAGE must be set
#endif
#if DIAGNOSTIC_STAGE >= 3
#include <sqlite3.h>
template<class T> __declspec(noinline) void retain(T address) {
  T volatile reference=address;
  (void)reference;
}
#endif
#if DIAGNOSTIC_STAGE >= 4
#include "sha256.h"
static std::string shaProbe() {
  Sha256 hash;
  unsigned char sample[]={1,2,3};
  hash.process(sample,sizeof(sample));return hash.finish();
}
#endif
#if DIAGNOSTIC_STAGE >= 5
#define MINIZ_NO_ZLIB_COMPATIBLE_NAMES
#include <miniz.h>
#endif
#if DIAGNOSTIC_STAGE >= 6
#include <pugixml.hpp>
#include <cmark.h>
static bool xmlProbe() {
  pugi::xml_document document;
  return bool(document.load_string("<diagnostic/>"));
}
#endif
#if DIAGNOSTIC_STAGE >= 7
#include <lodepng.h>
#include <turbojpeg.h>
#endif
#if DIAGNOSTIC_STAGE >= 8
#include "platform.h"
#endif
#if DIAGNOSTIC_STAGE >= 9
#include "file_access.h"
static void fileProbe() {
  Directory directory(fs::path("C:/"));
  FileEntry entry;directory.next(entry);
  FileInfo info;directory.inspect("diagnostic.fixture",info);
  FileReader reader(fs::path("C:/diagnostic.fixture"),&directory);
  char buffer[1];reader.read(buffer,sizeof(buffer));reader.info();
}
#endif
#if DIAGNOSTIC_STAGE >= 10
#include "traversal.h"
#endif
#if DIAGNOSTIC_STAGE >= 11
#include "parallel_hash.h"
static void parallelProbe() {
  ScanContext context;
  ParallelHasher pool(context,0,1);
  pool.submit("diagnostic.fixture",FileInfo{},"");
}
#endif
#if DIAGNOSTIC_STAGE >= 12
#include "content.h"
#endif

int main() {
#if DIAGNOSTIC_STAGE >= 3
  retain(&sqlite3_open);retain(&sqlite3_exec);retain(&sqlite3_close);
#endif
#if DIAGNOSTIC_STAGE >= 4
  retain(&shaProbe);
#endif
#if DIAGNOSTIC_STAGE >= 5
  retain(&mz_zip_reader_init_mem);retain(&mz_zip_reader_file_stat);
  retain(&mz_zip_reader_extract_to_mem);retain(&mz_zip_reader_end);
#endif
#if DIAGNOSTIC_STAGE >= 6
  retain(&xmlProbe);retain(&cmark_parse_document);retain(&cmark_node_free);
#endif
#if DIAGNOSTIC_STAGE >= 7
  retain(&lodepng_decode32);retain(&tjInitDecompress);retain(&tjDecompressHeader3);
  retain(&tjDecompress2);retain(&tjDestroy);
#endif
#if DIAGNOSTIC_STAGE >= 8
  retain(&drives);retain(&excluded);retain(&extension);retain(&pathWithin);
#endif
#if DIAGNOSTIC_STAGE >= 9
  retain(&fileProbe);retain(&inspectFile);
#endif
#if DIAGNOSTIC_STAGE >= 10
  retain(&discover);
#endif
#if DIAGNOSTIC_STAGE >= 11
  retain(&digest);retain(&equalBytes);retain(&groupExactFiles);retain(&parallelProbe);
#endif
#if DIAGNOSTIC_STAGE >= 12
  retain(&content::read);retain(&content::decodeText);retain(&content::decodeImage);
  retain(&content::compareFiles);retain(&content::validate);retain(&content::result);
#endif
  return 0;
}
