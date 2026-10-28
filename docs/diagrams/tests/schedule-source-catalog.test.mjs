import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScheduleSourceCatalog, scanScheduleRustFile, splitRustArguments, stripRustGenerics } from '../src/schedule-source-catalog.mjs';
import { readCargoMetadata } from '../src/dependency-sources.mjs';
import { REVIEWED_SCHEDULE_SETS } from '../catalog/schedule-source-set-mappings.mjs';

const repository=fileURLToPath(new URL('../../..',import.meta.url));
let actual;
const real=()=>actual??=createScheduleSourceCatalog({repository,metadata:readCargoMetadata(repository)});
function fixture(t,source,options={}) {
  const parent=path.join(repository,'tmp/ecs-architecture/schedule-source-tests');fs.mkdirSync(parent,{recursive:true});
  const root=fs.mkdtempSync(path.join(parent,'fixture-'));fs.mkdirSync(path.join(root,'src'));
  fs.writeFileSync(path.join(root,'src/lib.rs'),source);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  return createScheduleSourceCatalog({repository:root,strictPurposes:false,...options,metadata:{packages:[{name:'fixture',version:'0.1.0',manifest_path:path.join(root,'Cargo.toml')}]}});
}

test('Rust system identity preserves nested generic and associated-function paths',()=>{
  assert.deepEqual(splitRustArguments('A<B,C>, (D,E), X<Y<Z>>'),['A<B,C>','(D,E)','X<Y<Z>>']);
  assert.equal(stripRustGenerics('crate::Assets<foo::Mesh>::events'),'crate::Assets::events');
  const declarations=scanScheduleRustFile('mod a { struct X; impl<T> X { fn update(q: Query<&T>) {} } }',{filename:'src/render/mod.rs',crate:'fixture'});
  assert.ok(declarations.some(declaration=>declaration.fullName==='fixture::render::a::X::update'));
});

test('purpose word dictionaries never inherit Object prototype functions',t=>{
  const catalog=fixture(t,'fn init_constructor() {} fn constructor() {}');
  for(const name of ['init_constructor','constructor']){
    const result=catalog.resolveSystem('fixture::'+name);
    assert.doesNotMatch(result.description,/\[native code\]|function Object|undefined|NaN/);
    assert.match(result.description,/constructor/);
  }
  const actual=real().resolveSystem('avian3d::collision::collider::backend::init_collider_constructor_hierarchies');
  assert.match(actual.description,/逐名称配置为后代生成碰撞体/);
  assert.match(actual.description,/ColliderConstructorHierarchyReady/);
});

test('production sources reject name-and-parameter purpose fallback',t=>{
  const strict=fixture(t,'fn update_unknown_gpu_state() {}',{strictPurposes:true});
  assert.throws(()=>strict.resolveSystem('fixture::update_unknown_gpu_state'),/system purpose has not been reviewed/);
  const synthetic=fixture(t,'fn update_unknown_gpu_state() {}');
  assert.ok(synthetic.resolveSystem('fixture::update_unknown_gpu_state').sourceGaps.some(gap=>gap.includes('系统用途尚未审阅')));
});

test('body outputs expand exact ExtractComponent outputs and SyncComponent target tuples',()=>{
  const catalog=real(),name='bevy_extract::extract_component::extract_components<bevy_pbr::ssr::ScreenSpaceReflections, bevy_render::RenderApp, ()>';
  const output=catalog.resolveBodyOperationType('C::Out',name,{kind:'Component'});
  assert.equal(output.fullName,'bevy_pbr::ssr::ScreenSpaceReflectionsUniform');
  assert.ok(output.operationProofEntries.some(source=>source.role==='operation'));
  const target=catalog.resolveBodyOperationType('C::Target',name,{kind:'Component'});
  assert.equal(target.types.length,3);
  assert.ok(target.types.every(type=>!type.fullName.endsWith('::Target')));
  assert.ok(target.types.some(type=>type.fullName==='bevy_pbr::ssr::ScreenSpaceReflectionsUniform'));
  const camera=catalog.resolveBodyOperationType('C::Out','bevy_extract::extract_component::extract_components<bevy_camera::components::Camera2d, bevy_render::RenderApp, ()>',{kind:'Component'});
  assert.equal(camera.fullName,'bevy_camera::components::Camera2d');
});

test('skipping existing parameter records still verifies real body operations',t=>{
  const catalog=fixture(t,'struct A; fn f(unknown:Res<Unknown>){ commands.insert_resource(A); }',{bodyOperations:{'fixture::f':[{kind:'Resource',type:'A',operation:'insert',via:'commands',method:'insert_resource',match:'commands.insert_resource(A)'}]},bodyGaps:{}});
  const result=catalog.resolveSystem('fixture::f',{skipParameterAccess:true});
  assert.deepEqual(result.accesses,[]);assert.equal(result.bodyOperations.length,1);
  assert.equal(result.bodyOperations[0].fullName,'fixture::A');
});

test('query Ref/Mut and presence filters remain distinct from field writes',t=>{
  const catalog=fixture(t,'struct Position; struct Velocity; fn system(q: Query<(Ref<Position>, Mut<Velocity>, Has<Position>), Without<Velocity>>) {}');
  const result=catalog.resolveSystem('fixture::system');
  assert.ok(result.accesses.some(access=>access.fullName==='fixture::Position'&&access.operation==='read'));
  assert.ok(result.accesses.some(access=>access.fullName==='fixture::Velocity'&&access.operation==='write'));
  assert.ok(result.accesses.some(access=>access.fullName==='fixture::Position'&&access.operation==='filter'));
  assert.ok(result.accesses.some(access=>access.fullName==='fixture::Velocity'&&access.operation==='filter'));
});

test('tuple patterns, conditional parameter attributes and scalar Local keep their types',t=>{
  const catalog=fixture(t,'struct A; struct B; fn system((a,b):(Res<A>,ResMut<B>), #[cfg(feature="std")] local:Local<bool>) {}');
  const result=catalog.resolveSystem('fixture::system');
  assert.ok(result.accesses.some(access=>access.fullName==='fixture::A'&&access.kind==='Resource'&&access.operation==='read'));
  assert.ok(result.accesses.some(access=>access.fullName==='fixture::B'&&access.kind==='Resource'&&access.operation==='write'));
  assert.ok(result.accesses.some(access=>access.fullName==='core::primitive::bool'&&access.kind==='Local'));
});

test('derived SystemParam and QueryData expand verified fields, opaque parameters remain references',t=>{
  const catalog=fixture(t,`struct Position; struct Velocity; struct Settings; struct Opaque;
    #[derive(QueryData)] struct Data { pos: &'static Position, velocity: &'static mut Velocity }
    #[derive(SystemParam)] struct Params<'w> { settings: Res<'w,Settings>, query: Query<'w,'static,Data> }
    fn system(params:Params<'_>, opaque:Opaque) {}`);
  const result=catalog.resolveSystem('fixture::system');
  for(const[type,operation]of[['Position','read'],['Velocity','write'],['Settings','read']])assert.ok(result.accesses.some(access=>access.fullName==='fixture::'+type&&access.operation===operation),type);
  assert.deepEqual(result.accesses.filter(access=>access.fullName==='fixture::Opaque').map(access=>access.operation),['reference']);
  assert.ok(result.sourceGaps.some(gap=>gap.includes('fixture::Opaque')));
});

test('impl generic Self and function generics bind independently',t=>{
  const catalog=fixture(t,'struct Assets<T>; struct Buffer<T>; struct Mesh; struct Image; impl<A> Assets<A> { fn events(self_res:ResMut<Self>, b:Res<Buffer<A>>) {} }');
  const mesh=catalog.resolveSystem('fixture::Assets<fixture::Mesh>::events'),image=catalog.resolveSystem('fixture::Assets<fixture::Image>::events');
  assert.ok(mesh.accesses.some(access=>access.fullName==='fixture::Assets<fixture::Mesh>'));
  assert.ok(mesh.accesses.some(access=>access.fullName==='fixture::Buffer<fixture::Mesh>'));
  assert.ok(image.accesses.some(access=>access.fullName==='fixture::Buffer<fixture::Image>'));
  assert.ok(!mesh.accesses.some(access=>/\bSelf\b|<A>/.test(access.fullName)));
});

test('unbound generic data access stays a gap instead of a concrete resource',t=>{
  const catalog=fixture(t,'struct Buffer<T>; fn system<T>(b:Res<Buffer<T>>) {}');
  const result=catalog.resolveSystem('fixture::system');
  assert.equal(result.accesses.length,0);assert.ok(result.sourceGaps.some(gap=>gap.includes('未绑定泛型')));
});

test('equal Local types retain parameter identities and Pipe stage ownership',t=>{
  const catalog=fixture(t,'fn first(a:Local<bool>,b:Local<bool>) {} fn second(c:Local<bool>) {}');
  const first=catalog.resolveSystem('fixture::first');assert.equal(first.accesses.length,2);
  assert.deepEqual(first.accesses.map(access=>access.parameterKey),['a','b']);
  const pipe=catalog.resolveSystem('Pipe(fixture::first, fixture::second)');
  assert.deepEqual(pipe.accesses.map(access=>access.parameterKey),['stage0:a','stage0:b','stage1:c']);
});

test('module-local import aliases do not inherit a sibling module alias',t=>{
  const catalog=fixture(t,'struct A; struct B; mod one { use crate::A as Value; fn system(q:Query<&Value>) {} } mod two { use crate::B as Value; }');
  const result=catalog.resolveSystem('fixture::one::system');
  assert.ok(result.accesses.some(access=>access.fullName==='fixture::A'));assert.ok(!result.accesses.some(access=>access.fullName==='fixture::B'));
});

test('dependency ordering and run_if targets are not registration sites',t=>{
  const catalog=fixture(t,'fn system() {} fn other() {} fn install(app:&mut App) { app.add_systems(Update,system); app.add_systems(Update,other.after(system).run_if(system)); }');
  const result=catalog.resolveSystem('fixture::system',{scheduleLabel:'Update'});
  const entries=result.sourceEntries.filter(source=>source.role==='registration');
  assert.equal(entries.length,1);
});

test('same complete declaration in multiple branches requires an explicit choice',t=>{
  const catalog=fixture(t,'#[cfg(feature="one")] fn system() {} #[cfg(feature="two")] fn system() {}');
  assert.throws(()=>catalog.resolveSystem('fixture::system'),/missing or ambiguous/);
});

test('real extraction registration excludes another system before(extract_cameras)',()=>{
  const result=real().resolveSystem('bevy_render::camera::extract_cameras',{application:'RenderApp',scheduleLabel:'ExtractSchedule'});
  assert.ok(result.sourceEntries.some(source=>source.role==='registration'&&source.path==='src/camera.rs'));
  assert.ok(!result.sourceEntries.some(source=>source.role==='registration'&&source.path==='src/view/window/mod.rs'));
});

test('asset specialization retains distinct Self resources and message payloads',()=>{
  const mesh=real().resolveSystem('bevy_asset::assets::Assets<bevy_mesh::mesh::Mesh>::asset_events');
  const image=real().resolveSystem('bevy_asset::assets::Assets<bevy_image::image::Image>::asset_events');
  assert.ok(mesh.accesses.some(access=>access.fullName==='bevy_asset::assets::Assets<bevy_mesh::mesh::Mesh>'));
  assert.ok(mesh.accesses.some(access=>access.fullName.includes('AssetEvent<bevy_mesh::mesh::Mesh>')));
  assert.ok(image.accesses.some(access=>access.fullName.includes('AssetEvent<bevy_image::image::Image>')));
  assert.ok(mesh.name.startsWith('asset_events'));
});

test('locked three-dimensional Avian declarations and Bevy prelude reexports stay precise',()=>{
  const result=real().resolveSystem('avian3d::spatial_query::update_shape_caster_positions');
  const rotation=result.accesses.find(access=>access.fullName==='avian3d::physics_transform::transform::Rotation');
  assert.ok(rotation);assert.equal(rotation.sourceEntries[0].line,729);
  assert.ok(result.accesses.some(access=>access.fullName==='bevy_transform::components::global_transform::GlobalTransform'));
});

test('unreviewed parameter tuple names are rejected instead of assigned an input implementation',t=>{
  const catalog=fixture(t,'struct Settings;');
  assert.throws(()=>catalog.resolveSystem('(Res<Settings>,Local<bool>)'),/has not been reviewed/);
});

test('sub-state closure binds parent and child resources and points at actual definition and registration',()=>{
  const result=real().resolveSystem('<demo::game_flow::AppState as bevy_state::state::state_set::StateSet>::register_sub_state_systems_in_schedule<demo::game_flow::PlayState>::{{closure}}');
  assert.equal(result.definition.line,176);
  assert.ok(result.sourceEntries.some(source=>source.role==='registration'&&source.line===239));
  assert.ok(result.accesses.some(access=>access.fullName.includes('State<demo::game_flow::PlayState>')));
  assert.ok(result.accesses.some(access=>access.fullName.includes('StateTransitionEvent<demo::game_flow::AppState>')));
  assert.ok(!result.accesses.some(access=>/\bS::RawState\b|<T>/.test(access.fullName)));
});

test('standard message readers, writers and direct canonical buffers retain Messages kind and world scope',()=>{
  const buffers=real().resolveSystem('bevy_asset::assets::Assets<bevy_mesh::mesh::Mesh>::asset_events').accesses;
  const writer=buffers.find(access=>access.fullName.startsWith('bevy_ecs::message::messages::Messages<'));
  assert.ok(writer);assert.equal(writer.kind,'Messages<T>');assert.equal(writer.operation,'write');assert.equal(writer.scope,'current');
  assert.ok(writer.sourceEntries.some(source=>source.role==='message_definition'&&source.path==='src/event.rs'&&source.dependency?.name==='bevy_asset'));
  const input=real().resolveSystem('bevy_input_focus::dispatch_focused_input<bevy_input::keyboard::KeyboardInput>').accesses;
  const reader=input.find(access=>access.fullName.startsWith('bevy_ecs::message::messages::Messages<'));
  assert.ok(reader);assert.equal(reader.kind,'Messages<T>');assert.equal(reader.operation,'read');
  const direct=real().resolveSystem('bevy_egui::input::absorb_bevy_input_system').accesses.filter(access=>access.fullName.startsWith('bevy_ecs::message::messages::Messages<'));
  assert.equal(direct.length,3);assert.ok(direct.every(access=>access.kind==='Messages<T>'&&access.operation==='write'&&access.scope==='current'));
  const extract=real().resolveSystem('bevy_render::view::window::extract_windows').accesses.find(access=>access.fullName.startsWith('bevy_ecs::message::messages::Messages<'));
  assert.ok(extract);assert.equal(extract.kind,'Messages<T>');assert.equal(extract.operation,'read');assert.equal(extract.scope,'main');
  assert.ok(extract.sourceEntries.some(source=>source.role==='message_definition'&&source.dependency?.name==='bevy_window'));
});

test('derive-generated associated query data never borrows another type with the same member name',()=>{
  for(const type of ['bevy_anti_alias::fxaa::Fxaa','bevy_anti_alias::smaa::Smaa']){
    const result=real().resolveSystem('bevy_extract::extract_component::extract_components<'+type+'>');
    assert.ok(result.accesses.some(access=>access.fullName===type+'::QueryData'&&access.operation==='reference'));
    assert.ok(!result.accesses.some(access=>access.fullName==='bevy_anti_alias::contrast_adaptive_sharpening::ContrastAdaptiveSharpening::QueryData'));
    assert.ok(result.sourceGaps.some(gap=>gap.includes(type+'::QueryData')));
  }
});

test('qualified associated parameter projections preserve each generic owner identity',t=>{
  const catalog=fixture(t,'trait RenderAsset { type Param; } struct Mesh; struct Image; struct StaticSystemParam<P>; fn system<A:RenderAsset>(p:StaticSystemParam<<A as RenderAsset>::Param>) {}');
  const mesh=catalog.resolveSystem('fixture::system<fixture::Mesh>'),image=catalog.resolveSystem('fixture::system<fixture::Image>');
  assert.ok(mesh.accesses.some(access=>access.fullName==='fixture::StaticSystemParam<<fixture::Mesh as fixture::RenderAsset>::Param>'&&access.operation==='reference'));
  assert.ok(image.accesses.some(access=>access.fullName==='fixture::StaticSystemParam<<fixture::Image as fixture::RenderAsset>::Param>'&&access.operation==='reference'));
  assert.ok(!mesh.accesses.some(access=>access.fullName.includes('<A as ')));
});

test('exclusive SystemState parameters are parameter interfaces rather than components',()=>{
  const catalog=createScheduleSourceCatalog({repository,metadata:readCargoMetadata(repository),strictPurposes:false});
  const result=catalog.resolveSystem('bevy_pbr::material::specialize_material_meshes');
  const state=result.accesses.find(access=>access.fullName.startsWith('bevy_ecs::system::function_system::SystemState<'));
  assert.equal(state?.kind,'SystemParam');
  assert.equal(state?.operation,'reference');
  assert.ok(result.accesses.some(access=>access.fullName.includes('SpecializeMaterialMeshesSystemParam')&&access.kind==='SystemParam'));
  assert.ok(!result.accesses.some(access=>access.kind==='Component'&&access.fullName.includes('SystemState<')));
  assert.ok(result.accesses.some(access=>access.fullName==='bevy_render::render_asset::RenderAssets<bevy_render::mesh::RenderMesh>'&&access.operation==='read'));
  assert.ok(result.accesses.some(access=>access.fullName==='bevy_pbr::material::SpecializedMaterialPipelineCache'&&access.operation==='write'));
});

test('reviewed empty set mappings bind exact snapshots and reject stale DOT hashes',()=>{
  for(const record of REVIEWED_SCHEDULE_SETS)assert.equal(real().resolveSet(record.label,record,[]).fullName,record.fullName);
  const record=REVIEWED_SCHEDULE_SETS[0];assert.throws(()=>real().resolveSet(record.label,{...record,dotSha256:'stale'},[]),/stale/);
});
