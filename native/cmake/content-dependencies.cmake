# Pinned, statically linked parsers. No external programs or network at runtime.
include(FetchContent)
include(ExternalProject)
function(duprove_content_dependencies)
  set(CMAKE_POLICY_DEFAULT_CMP0077 NEW)
  set(BUILD_SHARED_LIBS OFF)
  set(BUILD_TESTING OFF)
  set(BUILD_TESTS OFF)
  set(BUILD_EXAMPLES OFF)
  set(INSTALL_PROJECT OFF)
  set(PUGIXML_INSTALL OFF)
  set(PUGIXML_STATIC_CRT ON)
  FetchContent_Declare(miniz
    URL https://codeload.github.com/richgel999/miniz/tar.gz/174573d60290f447c13a2b1b3405de2b96e27d6c
    URL_HASH SHA256=3cb61250e4ec1890423273fe58752f1e63d9a6d0c3b58dea61e6fe6c82d6d349)
  FetchContent_Declare(pugixml
    URL https://codeload.github.com/zeux/pugixml/tar.gz/ee86beb30e4973f5feffe3ce63bfa4fbadf72f38
    URL_HASH SHA256=51c102d4187fac99daa38af281b0772c5e6c586f65004cdc63f8f2e011a21492)
  FetchContent_Declare(cmark
    URL https://codeload.github.com/commonmark/cmark/tar.gz/bb3678d7a73cb02d35c8876ecd097072636200a8
    URL_HASH SHA256=504be268650122b3cdae316b273e321e08dd8e4ccd82e3b97bc73a33536e8416)
  FetchContent_Declare(lodepng
    URL https://codeload.github.com/lvandeve/lodepng/tar.gz/e584a8490db1b76b81bf298c11c09d3b55d9c270
    URL_HASH SHA256=c9cc1dcd143bd1365f0ce50cfc14bacab43d7bee5a2be212d6f4b73eefa8626f
    SOURCE_SUBDIR duprove-no-cmake)
  FetchContent_Declare(turbojpeg
    URL https://codeload.github.com/libjpeg-turbo/libjpeg-turbo/tar.gz/4e151a4ad91001b3aa8c2ece2205c15f487ce320
    URL_HASH SHA256=de49f4f268ac2845173c0a51055e1a78cf4636b05724c0c31dfc2af8284da962
    SOURCE_SUBDIR duprove-no-cmake)
  FetchContent_MakeAvailable(miniz pugixml cmark lodepng turbojpeg)
  add_library(duprove-png STATIC ${lodepng_SOURCE_DIR}/lodepng.cpp)
  target_include_directories(duprove-png PUBLIC ${lodepng_SOURCE_DIR})
  # Keep metadata chunks out of the decoder's allocations; CRC checks stay on.
  target_compile_definitions(duprove-png PUBLIC LODEPNG_NO_COMPILE_ANCILLARY_CHUNKS LODEPNG_NO_COMPILE_DISK)

  # libjpeg-turbo explicitly requires ExternalProject instead of add_subdirectory.
  if(MSVC)
    set(jpeg_library "${turbojpeg_BINARY_DIR}/lib/$<CONFIG>/turbojpeg-static.lib")
  else()
    set(jpeg_library "${turbojpeg_BINARY_DIR}/lib/libturbojpeg.a")
  endif()
  set(jpeg_platform_args)
  foreach(variable CMAKE_TOOLCHAIN_FILE CMAKE_OSX_ARCHITECTURES CMAKE_OSX_DEPLOYMENT_TARGET CMAKE_OSX_SYSROOT)
    if(DEFINED ${variable} AND NOT "${${variable}}" STREQUAL "")
      list(APPEND jpeg_platform_args "-D${variable}=${${variable}}")
    endif()
  endforeach()
  ExternalProject_Add(duprove-jpeg-build
    SOURCE_DIR "${turbojpeg_SOURCE_DIR}" BINARY_DIR "${turbojpeg_BINARY_DIR}"
    DOWNLOAD_COMMAND "" UPDATE_COMMAND "" INSTALL_COMMAND ""
    CMAKE_ARGS -DCMAKE_BUILD_TYPE=${CMAKE_BUILD_TYPE}
      -DCMAKE_C_COMPILER=${CMAKE_C_COMPILER}
      -DCMAKE_ARCHIVE_OUTPUT_DIRECTORY=${turbojpeg_BINARY_DIR}/lib
      -DENABLE_SHARED=OFF -DENABLE_STATIC=ON -DWITH_TURBOJPEG=ON
      -DWITH_SIMD=OFF -DWITH_TOOLS=OFF -DWITH_TESTS=OFF -DWITH_CRT_DLL=OFF
      ${jpeg_platform_args}
    BUILD_COMMAND ${CMAKE_COMMAND} --build <BINARY_DIR> --config $<CONFIG> --target turbojpeg-static
    BUILD_BYPRODUCTS "${jpeg_library}")
  add_library(duprove-jpeg STATIC IMPORTED GLOBAL)
  set_target_properties(duprove-jpeg PROPERTIES IMPORTED_LOCATION "${jpeg_library}"
    # Keep the pinned header ahead of CPATH/Homebrew headers. Imported includes
    # are otherwise -isystem and can silently select an incompatible host API.
    IMPORTED_NO_SYSTEM TRUE
    INTERFACE_INCLUDE_DIRECTORIES "${turbojpeg_SOURCE_DIR}/src")
  if(MSVC)
    foreach(config Debug Release RelWithDebInfo MinSizeRel)
      string(TOUPPER ${config} upper)
      set_property(TARGET duprove-jpeg PROPERTY IMPORTED_LOCATION_${upper} "${turbojpeg_BINARY_DIR}/lib/${config}/turbojpeg-static.lib")
    endforeach()
  endif()
  add_dependencies(duprove-jpeg duprove-jpeg-build)
  add_library(duprove-content-libraries INTERFACE)
  target_link_libraries(duprove-content-libraries INTERFACE miniz pugixml::pugixml cmark duprove-png duprove-jpeg)
  if(UNIX)
    target_link_libraries(duprove-content-libraries INTERFACE m)
  endif()
  file(MAKE_DIRECTORY "${CMAKE_BINARY_DIR}/licenses")
  foreach(item miniz/LICENSE pugixml/LICENSE.md cmark/COPYING lodepng/LICENSE turbojpeg/LICENSE.md turbojpeg/README.ijg)
    string(REPLACE "/" ";" parts ${item})
    list(GET parts 0 dependency)
    list(GET parts 1 license)
    configure_file("${${dependency}_SOURCE_DIR}/${license}" "${CMAKE_BINARY_DIR}/licenses/${dependency}-${license}" COPYONLY)
  endforeach()
endfunction()
duprove_content_dependencies()
