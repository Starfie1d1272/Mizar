/** Executed in an isolated, finite-lifetime worker. Input descriptors are already safely opened. */
export const archiveWorkerSource = String.raw`
const { workerData: d, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Zip, ZipDeflate } = require(d.fflate);
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const MAX = 18874368;
function redact(value,key='') {
 if(value&&typeof value==='object'&&['program_all_chat','program_all_chat_reset'].includes(value.kind||value.stage)) {
   return Object.fromEntries(Object.entries(value).filter(([name])=>['schema','eventId','producerKind','producerRunId','sequence','kind','stage','phase','outcome','time','observedAt','recordedAt','startupSessionId','taskId','operationId','parentOperationId','attemptId','sourceInterval'].includes(name)).concat([['evidence',{excluded:'raw-chat-body',scope:'identity and source interval only'}],['coverage',{excluded:['raw-chat-body'],unknown:[]}]]));
 }

 if(/authorization|cookie|password|passwd|token|secret|credential|api[_-]?key|stream[_-]?key|ticket/i.test(key))return '[redacted]';
 if(typeof value==='string'&&/^\s*[{[]/.test(value)){try{return JSON.stringify(redact(JSON.parse(value)));}catch{}}
 if(typeof value==='string')value=value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi,text=>{try{const url=new URL(text);if(url.username||url.password){url.username='[redacted]';url.password='';}for(const key of [...url.searchParams.keys()])if(/password|token|secret|credential|key|code|auth/i.test(key))url.searchParams.set(key,'[redacted]');if(/^rtmps?:$/.test(url.protocol)){const parts=url.pathname.split('/');if(parts.length>2){parts[parts.length-1]='[redacted]';url.pathname=parts.join('/');}}return url.toString();}catch{return text;}});
 if(typeof value==='string')return value.replace(/\b(Bearer|Basic)\s+[^\s"',}]+/gi,'$1 [redacted]').replace(/((?:password|passwd|token|secret|credential|api[_-]?key|stream[_-]?key|ticket)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&?#]+)/gi,'$1[redacted]');
 if(Array.isArray(value))return value.map(v=>redact(v));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redact(v,k)]));
 return value;
}
let zip, fd, bytes = 0, totalBytes = 0, digest, part = 0, entries = [], parts = [];
let carrierRecords = 0, uniqueEvents = 0, aggregatedOccurrences = 0, processedBytes = 0;
const journey = [], business = [], journeyParts=[],businessParts=[], gaps = [...d.gaps];
let indexBytes=0;
const indexDirectory=d.output+'/.identity-index';fs.mkdirSync(indexDirectory,{mode:0o700});
function accept(id,bodyHash) {
 const key=hash(id),path=indexDirectory+'/'+key.slice(0,3);
 const handle=fs.openSync(path,'a+',0o600);
 try {
   const size=fs.fstatSync(handle).size;
   if(size>2*1024*1024)throw Error('identity_partition_budget');
   const bytes=Buffer.alloc(size);if(size)fs.readSync(handle,bytes,0,size,0);
   let variants=0;
   for(const line of bytes.toString('ascii').split('\n'))if(line.startsWith(key+':')){if(line===key+':'+bodyHash)return -1;variants++;}
   const record=key+':'+bodyHash+'\n';
   if(indexBytes+totalBytes+record.length>256*1024*1024)throw Error('export_disk_budget');
   fs.writeSync(handle,record);indexBytes+=record.length;return variants;
 } finally {fs.closeSync(handle);}
}
function begin() {
  part++; bytes = 0; entries = []; digest = crypto.createHash('sha256');
  fd = fs.openSync(d.output + '/part-' + part + '.zip.partial', 'wx', 0o600);
  zip = new Zip((error, data, final) => {
    if (error) throw error;
    if (bytes + data.length > MAX || totalBytes + indexBytes + data.length > 256 * 1024 * 1024) throw Error('export_disk_budget');
    fs.writeSync(fd, data); digest.update(data); bytes += data.length; totalBytes += data.length;
  });
  add('bundle.json', Buffer.from(JSON.stringify({schema:'mizar-support-bundle/2',bundleId:d.exportId,partIndex:part,snapshot:{asOf:d.snapshot.asOf,atomic:false,sources:d.snapshot.sources,unknown:d.snapshot.unknown},range:d.range,partCount:'see-total-manifest'})));
}
function finish() {
  add('coverage.json', Buffer.from(JSON.stringify({uniqueEvents,carrierRecords,aggregatedOccurrences,gaps,entries,scope:'cumulative through this part; total manifest is authoritative'})));
  zip.end(); fs.fsyncSync(fd); fs.closeSync(fd);
  const name = 'part-' + part + '.zip';
  fs.renameSync(d.output + '/' + name + '.partial', d.output + '/' + name);
  parts.push({name,bytes,sha256:digest.digest('hex')});
}
function add(name, data) {
  if(name!=='bundle.json'&&name!=='coverage.json'&&bytes+data.length*1.02+262144>MAX){finish();begin();}
  if (data.length > 2 * 1024 * 1024) throw Error('export_entry_budget');
  const file = new ZipDeflate(name, {level:6}); zip.add(file); file.push(data,true);
  entries.push({name,bytes:data.length,sha256:hash(data)});
}
let chunk = [], chunkBytes = 0, chunkIndex = 0;
function flush() {
  if (!chunk.length) return;
  // Deflate worst-case reserve, local headers and central directory, never recompress completed parts.
  if (bytes + chunkBytes * 1.02 + 262144 > MAX) { finish(); begin(); }
  add('events/' + (++chunkIndex) + '.ndjson', Buffer.from(chunk.join(''))); chunk=[]; chunkBytes=0;
}
function emit(event, source, offset) {
  carrierRecords++;
  if (!event || typeof event !== 'object') event={evidence:event};
  if (event.stage === 'native_host_records' && Array.isArray(event.evidence?.entries)) {
    const refs=[];
    for (const e of event.evidence.entries) {
      const id=e.entry?.eventId||e.sourceRecordId||'legacy:'+hash(source+':'+(e.offset||offset));
      if(emit({...e.entry,eventId:id},source,e.offset||0))refs.push(id);
    }
    emit({...event,kind:'native_carrier_reference',stage:'native_carrier_reference',sourceInterval:{from:null,to:null},evidence:{source:event.evidence.source,eventRefs:refs,rangeExcludedChildren:event.evidence.entries.length-refs.length}},source,offset);
    return true;
  }
  if((event.kind||event.stage)==='cs2_console_records') {
    let detail=event.evidence; if(!detail&&typeof event.detail==='string'){try{detail=JSON.parse(event.detail);}catch{}}
    if(Array.isArray(detail?.records)) {
      const refs=[];
      for(const record of detail.records){const id=record.sourceRecordId || 'legacy:'+hash(source+':'+(record.sourceOffset||offset));if(emit({...record,eventId:id,producerRunId:event.producerRunId || event.startupSessionId,kind:'cs2_console_observation',observedAt:record.capturedAt,sourceInterval:{from:record.sourceAfterUtc||null,to:record.lastCapturedAt||record.capturedAt||null},evidence:record},source,record.sourceOffset || offset))refs.push(id);}
      const {detail:ignored,...header}=event;
      emit({...header,kind:'console_carrier_reference',stage:'console_carrier_reference',sourceInterval:{from:null,to:null},evidence:{eventRefs:refs,rangeExcludedChildren:detail.records.length-refs.length}},source,offset);return true;
    }
  }
  const stamp=event.observedAt || event.time || event.recordedAt || null;
  let interval=event.sourceInterval;
  if(!interval && Array.isArray(event.evidence?.samples)) {
    const times=event.evidence.samples.map(sample=>sample?.time).filter(time=>typeof time==='string'&&Number.isFinite(Date.parse(time))).sort((a,b)=>Date.parse(a)-Date.parse(b));
    if(times.length)interval={from:times[0],to:times.at(-1)};
  }
  const from=Date.parse(interval ? interval.from : stamp), to=Date.parse(interval ? interval.to : stamp);
  // Keep intersecting aggregates and unknown bounds; a late endpoint is not an exclusion.
  if ((d.range.from && Number.isFinite(to) && to < Date.parse(d.range.from)) || (d.range.to && Number.isFinite(from) && from > Date.parse(d.range.to))) return false;
  const id=event.eventId || (event.source?.recordSequence && typeof event.id==='string' ? event.id : null) || (event.startupSessionId && Number.isSafeInteger(event.sequence) ? event.startupSessionId+':'+event.sequence : 'legacy:'+hash(source+':'+offset));
  const originalHash=hash(JSON.stringify(event));
  const variant=accept(id,originalHash);
  if(variant<0)return true;
  if(!variant){uniqueEvents++;aggregatedOccurrences += typeof event.occurrences === 'number' ? event.occurrences : event.coverage?.occurrences || 1;}
  const output={...redact(event),eventId:id,carrier:{source,offset,role:source.startsWith('diagnostic-outbox/')?'technical-copy':'local-original'}, ...(variant?{variant,variantReason:'nonidentical-carrier-preserved'}:{})};
  const line=JSON.stringify(output)+'\n'; const size=Buffer.byteLength(line);
  if(size > 2*1024*1024) { gaps.push({source,offset,reason:'record_exceeds_entry_budget'}); throw Error('record_exceeds_entry_budget'); }
  if(chunkBytes+size>1024*1024) flush();
  chunk.push(line);chunkBytes+=size;
  const ref={eventId:id,variant,kind:event.kind || event.stage || null,taskId:event.taskId || null,operationId:event.operationId || null};
  if(ref.taskId || ref.operationId) journey.push(ref);
  if(String(ref.kind).startsWith('business')) business.push(ref);
  if(journey.length>2000) { flush();const name='indexes/journey-'+chunkIndex+'.json';add(name,Buffer.from(JSON.stringify(journey.splice(0))));journeyParts.push({partIndex:part,name}); }
  if(business.length>2000) { flush();const name='indexes/business-'+chunkIndex+'.json';add(name,Buffer.from(JSON.stringify(business.splice(0))));businessParts.push({partIndex:part,name}); }
  return true;
}
function decode(value, source) {
  if(Array.isArray(value)) { value.forEach((event,index)=>emit(event,source,index)); }
  else if(value?.schema==='mizar-performance-pending/1') {
    const raw=zlib.gunzipSync(Buffer.from(value.gzipBase64,'base64'),{maxOutputLength:4*1024*1024});
    if(hash(raw)!==value.sha256) throw Error('performance_digest_mismatch');
    JSON.parse(raw).forEach((e,i)=>emit(e,source,i));
  } else if(Array.isArray(value?.events)) value.events.forEach((e,i)=>emit(e,source,i));
  else if(Array.isArray(value?.files)) {
    for(const f of value.files) {
      let tail='',offset=0;
      for(const volume of f.volumes || []) {
        const raw=zlib.gunzipSync(Buffer.from(volume.gzipBase64,'base64'),{maxOutputLength:2*1024*1024});
        if(hash(raw)!==volume.sha256) throw Error('legacy_volume_digest_mismatch');
        const lines=(tail+raw.toString('utf8')).split('\n');tail=lines.pop();
        for(const line of lines) { if(line) { let value;try { value=JSON.parse(line); } catch { value={evidence:{text:line}}; }emit(value,source+'/'+f.name,offset); } offset+=Buffer.byteLength(line)+1; }
      }
      if(tail) emit({evidence:{text:tail}},source+'/'+f.name,offset);
    }
  } else emit(value,source,0);
}
try {
 begin();
 for(const source of d.sources) {
  parentPort.postMessage({phase:'encoding',inputBytes:processedBytes,outputBytes:totalBytes});
  try {
  if(source.rawIndex) {
    if(source.bytes>8*1024*1024)throw Error('migration_index_budget');
    const raw=Buffer.alloc(source.bytes);let read=0;while(read<raw.length){const n=fs.readSync(source.fd,raw,read,raw.length-read,read);if(!n)throw Error('index_short_read');read+=n;}processedBytes+=raw.length;
    if(source.name.endsWith('inventory.json')) {
      const inventory=JSON.parse(raw.toString('utf8'));let items=[],size=0,index=0;
      const write=()=>{if(items.length){add('indexes/migration/inventory-'+(++index)+'.json',Buffer.from(JSON.stringify({...inventory,sources:items})));items=[];size=0;}};
      for(const item of inventory.sources||[]){const n=Buffer.byteLength(JSON.stringify(item));if(size+n>1024*1024)write();items.push(item);size+=n;}write();
    } else add('indexes/'+source.name,raw);
  } else if(source.rawAttachment) {
    let position=0,tail='',body='',index=0;const decoder=new(require('node:string_decoder').StringDecoder)('utf8');
    const write=line=>{for(const secret of source.secrets||[])if(secret)line=line.split(secret).join('[redacted]');line=redact(line)+'\n';if(Buffer.byteLength(body)+Buffer.byteLength(line)>1024*1024){add(source.name+'-'+(++index)+'.log',Buffer.from(body));body='';}body+=line;};
    while(position<source.bytes){const raw=Buffer.alloc(Math.min(65536,source.bytes-position));const n=fs.readSync(source.fd,raw,0,raw.length,position);if(!n)throw Error('obs_snapshot_short_read');position+=n;processedBytes+=n;const lines=(tail+decoder.write(raw.subarray(0,n))).split('\n');tail=lines.pop();if(Buffer.byteLength(tail)>1024*1024)throw Error('obs_line_budget');for(const line of lines)write(line);}
    tail+=decoder.end();if(tail)write(tail);if(body)add(source.name+'-'+(++index)+'.log',Buffer.from(body));
  } else if(source.name.endsWith('.gz') || source.name.endsWith('.json')) {
    if(source.bytes>16*1024*1024) throw Error('legacy_decode_budget');
    const raw=Buffer.alloc(source.bytes); let n=0;
    while(n<raw.length) { const read=fs.readSync(source.fd,raw,n,raw.length-n,n);if(!read) throw Error('snapshot_short_read');n+=read; }
    decode(JSON.parse(source.name.endsWith('.gz')?zlib.gunzipSync(raw,{maxOutputLength:4*1024*1024}).toString('utf8'):raw.toString('utf8')),source.name);
    processedBytes+=raw.length;
  } else {
    const decoder=new (require('node:string_decoder').StringDecoder)('utf8');let tail='',position=0,offset=0;
    while(position<source.bytes) {
      const raw=Buffer.alloc(Math.min(65536,source.bytes-position));const n=fs.readSync(source.fd,raw,0,raw.length,position);
      if(!n) throw Error('snapshot_short_read');position+=n;processedBytes+=n;
      const lines=(tail+decoder.write(raw.subarray(0,n))).split('\n');tail=lines.pop();
      if(Buffer.byteLength(tail)>2*1024*1024) throw Error('source_line_budget');
      for(const line of lines) { if(line) { let value;try{value=JSON.parse(line);}catch{value={evidence:{text:line},coverage:{unknown:['unstructured-source-time']}};}emit(value,source.name,offset); } offset+=Buffer.byteLength(line)+1; }
    }
    if(tail) gaps.push({source:source.name,offset,reason:'uncommitted_partial_line'});
  }
  } catch(error) {if(/export_disk_budget|identity_partition_budget/.test(String(error)))throw error;gaps.push({source:source.name,reason:String(error),scope:'remaining source not decoded; original retained'});}
 }
 flush();
 add('indexes/journey.json',Buffer.from(JSON.stringify({schema:'mizar-reference-index/2',parts:journeyParts,tail:journey})));
 add('indexes/business.json',Buffer.from(JSON.stringify({schema:'mizar-reference-index/2',parts:businessParts,tail:business})));
 add('snapshots/current.json',Buffer.from(JSON.stringify(redact(d.snapshot))));
 finish();
 fs.rmSync(indexDirectory,{recursive:true});
 parentPort.postMessage({phase:'ready',knownGaps:gaps.length,completeKnownSources:gaps.length===0,parts,uniqueEvents,carrierRecords,aggregatedOccurrences,gaps,inputBytes:processedBytes,outputBytes:totalBytes});
} catch(error) { try {if(fd!==undefined)fs.closeSync(fd);}catch{} parentPort.postMessage({phase:'failed',error:String(error)}); }
`;
