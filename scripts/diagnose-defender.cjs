const { spawnSync } = require('node:child_process')
const { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } = require('node:fs')
const { resolve, join, dirname } = require('node:path')
const { createHash } = require('node:crypto')
const { compare: comparePE } = require('../diagnostics/defender-ladder/compare-pe.cjs')

const root=resolve(__dirname,'..')
const directory=join(root,'.verification/defender-ladder')
const build=join(directory,'build')
const flags=new Set(process.argv.slice(2))
if(process.platform!=='win32') throw Error('WINDOWS_MSVC_DEFENDER_REQUIRED')
if([...flags].some(flag=>!['--scan-only','--update-signatures'].includes(flag))) throw Error('UNKNOWN_DIAGNOSTIC_ARGUMENT')
const runDirectory=join(directory,'runs',new Date().toISOString().replace(/[:.]/g,'-'))
mkdirSync(runDirectory,{recursive:true})
function run(command,args,options={}) {
  const result=spawnSync(command,args,{cwd:root,windowsHide:true,stdio:'inherit',...options})
  if(result.error) throw result.error
  if(result.status!==0) throw Error(`DIAGNOSTIC_COMMAND_FAILED: ${command}; exit ${result.status}`)
  return result
}
function json(file) { return JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,'')) }
function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex') }
function sourceDigest() {
  const files=[]
  function visit(path) { for(const entry of readdirSync(path,{withFileTypes:true})) {
    const file=join(path,entry.name)
    if(entry.isDirectory()) visit(file)
    else if(/\.(cpp|h|mm|cmake)$/.test(entry.name)||entry.name==='CMakeLists.txt') files.push(file)
  } }
  visit(join(root,'native'))
  const digest=createHash('sha256')
  for(const file of files.sort()) digest.update(file.slice(root.length)).update('\0').update(readFileSync(file)).update('\0')
  return digest.digest('hex')
}
const initialSourceDigest=sourceDigest()
function scan(entry,update=false) {
  const report=join(runDirectory,`${entry.stage}.json`)
  const result=spawnSync(process.execPath,[join(root,'scripts/check-windows-defender.cjs'),
    '-Path',entry.file,'-Report',report,...(update?['-UpdateSignatures']:[])],
    {cwd:root,stdio:'inherit',windowsHide:true,timeout:12*60*1000})
  const record=existsSync(report)?json(report):{status:'error',error:result.error?.message||'MISSING_SCAN_REPORT'}
  const row={...entry,status:record.status,sha256:record.sha256,size:existsSync(entry.file)?statSync(entry.file).size:null,
    engine:record.defender?.engineVersion,signatures:record.defender?.signatureVersion,
    checkedAt:record.checkedAt,hresult:record.scanHresult,scanReport:report,error:record.error}
  if(result.error || result.status!==0 && record.status==='clean') {
    row.status='error';row.error=result.error?.message||`SCAN_EXIT_${result.status}`
  }
  return row
}

const production={stage:'production-before',label:'Exact existing production analyzer before ladder',file:join(root,'build/native/bin/duprove-analyzer.exe')}
const rows=[scan(production,flags.has('--update-signatures'))]
if(!flags.has('--scan-only')) {
  const localCmake=join(root,'.venv/Scripts/cmake.exe')
  const cmake=existsSync(localCmake)?localCmake:'cmake'
  run(cmake,['-S','diagnostics/defender-ladder','-B',build,'-A','x64'])
  run(cmake,['--build',build,'--config','Release','--parallel','2','--target',
    ...'ABCDEFGHIJKLMNO'.split('').map(letter=>`defender-${letter}`)])
}
const manifest=json(join(build,'manifest-Release.json'))
const dumpbin=manifest.dumpbin||join(dirname(manifest.compiler),'dumpbin.exe')
const modules={C:['sqlite3.obj'],D:['shaProbe'],E:['miniz_zip.obj'],F:['pugixml.obj','cmark.obj'],
  G:['lodepng.obj','turbojpeg.obj'],H:['platform.obj'],I:['file_access.obj'],J:['traversal.obj'],
  K:['comparison.obj','parallel_hash.obj'],L:['content.obj','content_docx.obj','content_image.obj','content_text.obj'],
  M:['scanner.obj'],N:['report.obj'],O:['scanner.obj','report.obj']}
for(const entry of manifest.entries) {
  const mapText=readFileSync(entry.map,'utf8')
  const mapModules=[...new Set([...mapText.matchAll(/\b([\w.-]+):([\w.-]+\.obj)\b/g)].map(match=>`${match[1]}:${match[2]}`))].sort()
  const missingSymbols=(modules[entry.stage]||[]).filter(symbol=>!mapText.includes(symbol))
  if(missingSymbols.length) throw Error(`LINK_MAP_COMPONENT_MISSING: ${entry.stage}: ${missingSymbols.join(', ')}`)
  const imports=run(dumpbin,['/imports',entry.file],{stdio:'pipe',encoding:'utf8',maxBuffer:16*1024*1024}).stdout
  const importReport=join(runDirectory,`${entry.stage}-imports.txt`)
  writeFileSync(importReport,imports)
  const importedDlls=[...new Set([...imports.matchAll(/^\s+([\w.-]+\.dll)\s*$/gim)].map(match=>match[1]))].sort()
  const row=scan(entry)
  row.linkedObjects=mapModules;row.importedDlls=importedDlls;row.importReport=importReport
  row.componentSymbolsVerified=true
  rows.push(row)
}
const testDirectory=join(root,'build/native/Release')
if(existsSync(testDirectory)) for(const name of readdirSync(testDirectory).filter(name=>/^duprove-.*-test\.exe$/.test(name)).sort())
  rows.push(scan({stage:name.slice(0,-4),label:'Existing production test executable; not executed',file:join(testDirectory,name)}))
const version=json(join(root,'package.json')).version
for(const [stage,file] of [
  ['desktop-app','release/windows-installer/win-unpacked/Duprove.exe'],
  ['installer',`release/windows-installer/Duprove-${version}-win-x64.exe`]]) {
  if(existsSync(join(root,file))) rows.push(scan({stage,label:'Existing packaged release artifact',file:join(root,file)}))
}
rows.push(scan({...production,stage:'production-after',label:'Exact existing production analyzer after ladder'}))
const finalSourceDigest=sourceDigest()
const scanEnvironments=[...new Set(rows.map(row=>`${row.engine}/${row.signatures}`))]
const result={createdAt:new Date().toISOString(),toolchain:manifest,
  productionVsDiagnostic:comparePE(production.file,manifest.entries.find(entry=>entry.stage==='M').file),
  productionSourceDigest:initialSourceDigest,productionSourcesUnchanged:initialSourceDigest===finalSourceDigest,
  productionBinaryUnchanged:rows[0].sha256===rows.at(-1).sha256,
  scanEnvironmentConsistent:scanEnvironments.length===1,scanEnvironments,
  diagnosticExecutablesExecuted:false,rows}
writeFileSync(join(runDirectory,'summary.json'),JSON.stringify(result,null,2)+'\n')
writeFileSync(join(directory,'latest-run.txt'),runDirectory+'\n')
const lines=['# Windows Defender diagnostic ladder','',`Compiler: MSVC ${manifest.compilerVersion}, ${manifest.configuration}.`,
  '','Diagnostic EXEs were scanned, not executed. Original production files and source are not modified.',
  '','A uses /MD; B–O use /MT. C–L retain real entry points; linker maps verify component inclusion. N/O separately add report generation and scan(), without the analyzer CLI.',
  '','An added component also changes binary layout and reachable dependencies. A first detection is a candidate combination, not proof that a library is malicious.',
  '','| Stage | Content | Bytes | Result | Signatures | SHA-256 |','| --- | --- | ---: | --- | --- | --- |',
  ...rows.map(row=>`| ${row.stage} | ${row.label} | ${row.size??'missing'} | ${row.status} | ${row.signatures??'unknown'} | ${row.sha256??'unknown'} |`),
  '',`Production source unchanged: ${result.productionSourcesUnchanged}. Production binary unchanged: ${result.productionBinaryUnchanged}.`,
  `Scan environment consistent: ${result.scanEnvironmentConsistent}.`,
  `Production vs diagnostic M: ${result.productionVsDiagnostic.differingBytes} differing bytes; changes confined to PE timestamp fields: ${result.productionVsDiagnostic.differencesConfinedToTimestampFields}; .text identical: ${result.productionVsDiagnostic.sections.find(section=>section.name==='.text')?.same}.`,
  '',rows.some(row=>row.status==='blocked')?'Detection reproduced. Review the individual scan reports and map files; do not infer a guilty component solely from order.':
    rows.every(row=>row.status==='clean')?'Detection was not reproduced in this run. No triggering component was established.':'Some scans failed. This run cannot be interpreted as entirely clean.','']
writeFileSync(join(runDirectory,'summary.md'),lines.join('\n'))
console.log(`DEFENDER_LADDER_REPORT: ${join(runDirectory,'summary.md')}`)
console.log(JSON.stringify({clean:rows.filter(row=>row.status==='clean').length,blocked:rows.filter(row=>row.status==='blocked').length,error:rows.filter(row=>!['clean','blocked'].includes(row.status)).length,productionSourcesUnchanged:result.productionSourcesUnchanged}))
process.exitCode=rows.some(row=>!['clean','blocked'].includes(row.status))?2:rows.some(row=>row.status==='blocked')?1:0
