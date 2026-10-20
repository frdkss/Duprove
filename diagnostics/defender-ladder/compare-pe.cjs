const { readFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
function inspect(file) {
  const bytes=readFileSync(file),pe=bytes.readUInt32LE(60)
  if(bytes.toString('ascii',pe,pe+4)!=='PE\0\0') throw Error('INVALID_PE')
  const optional=pe+24,optionalSize=bytes.readUInt16LE(pe+20)
  const directories=optional+(bytes.readUInt16LE(optional)===0x20b?112:96)
  const sections=[]
  for(let index=0;index<bytes.readUInt16LE(pe+6);++index) {
    const offset=optional+optionalSize+40*index
    const size=bytes.readUInt32LE(offset+16),start=bytes.readUInt32LE(offset+20)
    sections.push({name:bytes.toString('ascii',offset,offset+8).replace(/\0.*$/,''),
      virtualAddress:bytes.readUInt32LE(offset+12),virtualSize:bytes.readUInt32LE(offset+8),
      offset:start,size,sha256:createHash('sha256').update(bytes.subarray(start,start+size)).digest('hex')})
  }
  function raw(rva) {
    const section=sections.find(value=>rva>=value.virtualAddress&&rva<value.virtualAddress+Math.max(value.size,value.virtualSize))
    return section?section.offset+rva-section.virtualAddress:null
  }
  const debug=raw(bytes.readUInt32LE(directories+6*8)),debugSize=bytes.readUInt32LE(directories+6*8+4)
  const pdb=[],debugRecords=[]
  if(debug!==null) for(let offset=debug;offset+28<=debug+debugSize;offset+=28) {
    debugRecords.push({type:bytes.readUInt32LE(offset+12),timestampOffset:offset+4,timestamp:bytes.readUInt32LE(offset+4)})
    if(bytes.readUInt32LE(offset+12)!==2) continue
    const start=bytes.readUInt32LE(offset+24),size=bytes.readUInt32LE(offset+16)
    if(bytes.toString('ascii',start,start+4)!=='RSDS') continue
    pdb.push({guidBytes:bytes.subarray(start+4,start+20).toString('hex'),age:bytes.readUInt32LE(start+20),
      path:bytes.toString('utf8',start+24,start+size).replace(/\0.*$/,'')})
  }
  return {file,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),
    timestamp:new Date(bytes.readUInt32LE(pe+8)*1000).toISOString(),machine:bytes.readUInt16LE(pe+4),
    certificateBytes:bytes.readUInt32LE(directories+4*8+4),pdb,debugRecords,
    timestampFields:[{offset:pe+8,size:4},...debugRecords.map(record=>({offset:record.timestampOffset,size:4}))],sections}
}
function compare(a,b) {
  const first=inspect(a),second=inspect(b)
  const firstBytes=readFileSync(a),secondBytes=readFileSync(b)
  let differingBytes=Math.abs(firstBytes.length-secondBytes.length)
  let confinedToTimestamps=firstBytes.length===secondBytes.length
  for(let offset=0;offset<Math.min(firstBytes.length,secondBytes.length);++offset) if(firstBytes[offset]!==secondBytes[offset]) {
    ++differingBytes
    if(!first.timestampFields.some(field=>offset>=field.offset&&offset<field.offset+field.size)) confinedToTimestamps=false
  }
  return {first,second,differingBytes,differencesConfinedToTimestampFields:confinedToTimestamps,sections:first.sections.map(section=>{
    const other=second.sections.find(value=>value.name===section.name)
    return {name:section.name,same:section.sha256===other?.sha256,firstBytes:section.size,secondBytes:other?.size}
  })}
}
module.exports={compare,inspect}
if(require.main===module) console.log(JSON.stringify(compare(process.argv[2],process.argv[3]),null,2))
