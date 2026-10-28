import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, webcrypto } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { createArchitectureAssetLoader, readArchitectureResource, validateArchitectureSvg, assetLoaderAssets } from '../src/architecture-asset-loader.mjs';
import vm from 'node:vm';

const baseUrl='http://localhost:4173/generated/pages/ecs-architecture.html';
const hash=text=>createHash('sha256').update(text).digest('hex');
const svg=(id,extra='')=>'<svg xmlns="http://www.w3.org/2000/svg" id="'+id+'" data-diagram-engine="mermaid" viewBox="0 0 100 60"><defs><filter id="shadow"><feDropShadow dx="1" dy="1" stdDeviation="1"/></filter></defs><g title="Metadata::Data::Value"><path d="M0 0L30 30" filter="url(#shadow)"/>'+extra+'</g></svg>';
function resourceFixture(count=1){
  const files=new Map(),refs=[];
  for(let index=1;index<=count;index++){
    const id='view-'+index,metadata={id,aspect:'object',engine:'mermaid',filename:id+'.svg',width:100,height:60,nodes:[],links:[],sections:[]},data=JSON.stringify(metadata),image=svg(id);
    const dataUrl='../data/views/'+id+'.json',svgUrl='../svg/object/'+id+'.svg';files.set(new URL(dataUrl,baseUrl).href,data);files.set(new URL(svgUrl,baseUrl).href,image);
    refs.push({...metadata,resources:{data:{url:dataUrl,sha256:hash(data)},svg:{url:svgUrl,sha256:hash(image)}}});
  }
  const calls=[];
  const fetch=async(url,{signal}={})=>{calls.push(url);if(signal?.aborted)throw signal.reason;return new Response(files.get(url)||'',{status:files.has(url)?200:404})};
  return{files,refs,calls,fetch};
}

test('external views validate both hashes, retain exact SVG bytes and never mutate lightweight descriptors',async()=>{
  const fixture=resourceFixture(),ref=fixture.refs[0],before=structuredClone(ref),loader=createArchitectureAssetLoader({...fixture,baseUrl,crypto:webcrypto,DOMParser});
  const view=await loader.loadView(ref);assert.equal(view.svg,svg(ref.id));assert.deepEqual(ref,before);assert.equal(Object.hasOwn(ref,'svg'),false);assert.equal(await loader.loadView(ref),view);assert.equal(fixture.calls.length,2);loader.dispose();
});

test('bounded LRU keeps the pinned current view while older inactive views are fetched again',async()=>{
  const fixture=resourceFixture(10),loader=createArchitectureAssetLoader({...fixture,baseUrl,crypto:webcrypto,DOMParser});
  await loader.loadView(fixture.refs[0]);loader.pin('view-1');for(const ref of fixture.refs.slice(1,9))await loader.loadView(ref);
  const count=fixture.calls.length;await loader.loadView(fixture.refs[0]);assert.equal(fixture.calls.length,count);await loader.loadView(fixture.refs[1]);assert.equal(fixture.calls.length,count+2);loader.dispose();
});

test('inflight requests are shared and only the last consumer cancellation aborts their fetches',async()=>{
  const fixture=resourceFixture(),requests=[];
  const fetch=(url,{signal})=>new Promise((resolve,reject)=>{requests.push({url,signal,resolve});signal.addEventListener('abort',()=>reject(signal.reason),{once:true})});
  const loader=createArchitectureAssetLoader({baseUrl,fetch,crypto:webcrypto,DOMParser}),a=new AbortController(),b=new AbortController();
  const first=loader.loadView(fixture.refs[0],{signal:a.signal}),second=loader.loadView(fixture.refs[0],{signal:b.signal});assert.equal(requests.length,2);a.abort();await assert.rejects(first,{name:'AbortError'});assert.equal(requests[0].signal.aborted,false);
  for(const request of requests)request.resolve(new Response(fixture.files.get(request.url)));await second;
  loader.dispose();const abandoned=createArchitectureAssetLoader({baseUrl,fetch,crypto:webcrypto,DOMParser}),c=new AbortController(),pending=abandoned.loadView(fixture.refs[0],{signal:c.signal});c.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(requests.at(-1).signal.aborted,true);abandoned.dispose();
});

test('failed hash and identity checks do not poison the cache and can be retried',async()=>{
  const fixture=resourceFixture(),ref=fixture.refs[0],loader=createArchitectureAssetLoader({...fixture,baseUrl,crypto:webcrypto,DOMParser}),url=new URL(ref.resources.svg.url,baseUrl).href;
  fixture.files.set(url,svg('wrong'));await assert.rejects(loader.loadView(ref),/hash mismatch/);fixture.files.set(url,svg(ref.id));await loader.loadView(ref);assert.equal(fixture.calls.length,4);
  const other={...ref,id:'different'};await assert.rejects(loader.loadView(other),/metadata mismatch/);loader.dispose();
});

test('SVG safety accepts native shadows and Rust labels while rejecting active content and external references',()=>{
  assert.equal(validateArchitectureSvg(svg('view-1'),{DOMParser}),svg('view-1'));
  for(const fragment of ['<script>alert(1)</script>','<path onclick="alert(1)"/>','<a href="https://example.com"><text>link</text></a>','<style>@import "https://example.com/x.css";</style>','<path fill="url(https://example.com/x.svg)"/>','<image href="data:image/png;base64,x"/>'])assert.throws(()=>validateArchitectureSvg(svg('view-1',fragment),{DOMParser}),/Unexpected/);
  assert.throws(()=>validateArchitectureSvg('<!DOCTYPE svg>'+svg('view-1'),{DOMParser}),/Invalid/);
});

test('optional missing SVG resources preserve empty views and foreign origins and bad hashes are refused',async()=>{
  const fixture=resourceFixture(),ref=fixture.refs[0];delete ref.resources.svg;
  const loader=createArchitectureAssetLoader({...fixture,baseUrl,crypto:webcrypto,DOMParser});assert.equal((await loader.loadView(ref)).svg,null);assert.equal(fixture.calls.length,1);loader.dispose();
  await assert.rejects(readArchitectureResource({url:'https://example.com/a.svg',sha256:hash('')},{baseUrl,fetch:fixture.fetch,crypto:webcrypto}),/HTTP server/);
  await assert.rejects(readArchitectureResource({url:'../missing',sha256:'wrong'},{baseUrl,fetch:fixture.fetch,crypto:webcrypto}),/descriptor/);new vm.Script(assetLoaderAssets().script);
});
