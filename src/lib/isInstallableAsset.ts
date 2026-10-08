export default function isInstallableAsset(filename: string) {
  return (
    /\.(exe|msi|msix|zip|7z|appimage|deb|rpm|tar\.gz|tar\.xz|tgz)$/i.test(filename) &&
    !/(?:^|[._-])(source|sources|symbols|debug)(?:[._-]|$)/i.test(filename)
  )
}
