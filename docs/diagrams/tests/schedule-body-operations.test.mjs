import test from 'node:test';
import assert from 'node:assert/strict';
import {scanScheduleRustFile} from '../src/schedule-source-catalog.mjs';
import {createScheduleBodyOperationCatalog,sourceFragmentMatches} from '../src/schedule-body-operations.mjs';

function fixture(source,operations) {
  const declarations=scanScheduleRustFile(source,{filename:'src/lib.rs',crate:'fixture'});
  const sourceAt=(file,offset,role,label)=>({path:file.path,line:file.text.slice(0,offset).split('\n').length,role,label});
  const catalog=createScheduleBodyOperationCatalog({repository:process.cwd(),metadata:{packages:[]},sourceAt,operations,gaps:{},resolveDeclaration:name=>declarations.find(d=>d.fullName===name),resolveType:(type,fullName,options)=>({fullName:'fixture::'+type,kind:options.kind,sourceEntries:[{path:'src/lib.rs',line:1,role:'definition'}]})});
  return {catalog,declaration:declarations.find(d=>d.kind==='fn'),declarations};
}

test('body fragments preserve raw operation location across whitespace and require explicit repeats',()=>{
  assert.deepEqual(sourceFragmentMatches('a.\n insert ( A );','a.insert(A);'),[{start:0,end:17}]);
  const spec={kind:'Resource',type:'A',operation:'insert',via:'commands',method:'insert_resource',match:'commands.insert_resource(A)'};
  const {catalog,declaration}=fixture('fn f() { commands.insert_resource(A);\n commands.insert_resource(A); }',{'fixture::f':[spec]});
  assert.throws(()=>catalog.resolve(declaration,'fixture::f'),/ambiguous/);
  const explicit=fixture('fn f() { commands.insert_resource(A);\n commands.insert_resource(A); }',{'fixture::f':[{...spec,allMatches:true}]});
  const [operation]=explicit.catalog.resolve(explicit.declaration,'fixture::f').bodyOperations;
  assert.equal(operation.sourceEntries.length,2);assert.equal(operation.deferred,true);
  assert.ok(operation.sourceEntries.every(s=>s.role==='operation'));
  assert.equal(operation.typeSourceEntries[0].role,'definition');
});

test('body mutable reference and queued structural operations preserve different meanings',()=>{
  const source='fn f() { let a=world.resource_mut::<A>();\n commands.queue(move |world: &mut World| { world.insert_resource(A); }); }';
  const {catalog,declaration}=fixture(source,{'fixture::f':[
    {kind:'Resource',type:'A',operation:'mutable_access',via:'world',method:'resource_mut',match:'world.resource_mut::<A>()',scope:'main'},
    {kind:'Resource',type:'A',operation:'insert',via:'world',method:'insert_resource',match:'world.insert_resource(A)',queueMatch:'commands.queue(move |world: &mut World| {'},
  ]});
  const result=catalog.resolve(declaration,'fixture::f').bodyOperations;
  assert.equal(result[0].operation,'mutable_access');assert.equal(result[0].deferred,false);assert.equal(result[0].scope,'main');
  assert.equal(result[1].operation,'insert');assert.equal(result[1].deferred,true);
});

test('explicit helper carries both caller and helper operation evidence in helper type scope',()=>{
  const {catalog,declaration}=fixture('fn f(){ helper(); }\nfn helper(){ commands.insert_resource(A); }',{'fixture::f':[{kind:'Resource',type:'A',operation:'insert',via:'commands',method:'insert_resource',match:'commands.insert_resource(A)',helper:'fixture::helper',callMatch:'helper()'}]});
  const [op]=catalog.resolve(declaration,'fixture::f').bodyOperations;
  assert.equal(op.helper,'fixture::helper');assert.equal(op.sourceEntries.length,2);
  assert.deepEqual(op.sourceEntries.map(s=>s.line),[1,2]);
});

test('message publication and entity trigger remain distinct semantic kinds',()=>{
  const {catalog,declaration}=fixture('fn f(){ writer.write(E); commands.trigger(E); }',{'fixture::f':[
    {kind:'Messages<T>',type:'E',operation:'publish',via:'message_writer',method:'write',match:'writer.write(E)'},
    {kind:'EntityEvent',type:'E',operation:'trigger',via:'commands',method:'trigger',match:'commands.trigger(E)'},
  ]});
  const ops=catalog.resolve(declaration,'fixture::f').bodyOperations;
  assert.deepEqual(ops.map(o=>[o.kind,o.operation,o.deferred]),[['Messages<T>','publish',false],['EntityEvent','trigger',true]]);
});
