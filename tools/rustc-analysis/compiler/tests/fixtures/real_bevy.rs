#![allow(dead_code)]
use bevy_ecs::{
    prelude::*,
    system::{IntoSystem, SystemParam},
};
use bevy_scene::prelude::*;
use bevy_ui::prelude::Text;
use bevy_ui_widgets::Button;

#[derive(Component, Default, Clone)]
#[require(Required)]
struct Position;

#[derive(Component, Default, Clone)]
struct Required;

#[derive(Resource, Default)]
struct Settings {
    value: u32,
}

#[derive(Bundle)]
struct PositionBundle {
    position: Position,
}

#[derive(SystemParam)]
struct Custom<'w, 's> {
    settings: Res<'w, Settings>,
    cache: Local<'s, u32>,
}

#[derive(Message)]
struct Pulse;

#[derive(Event)]
struct Notice;

fn canonical_params(
    _resource: ResMut<Settings>,
    _non_send: NonSend<String>,
    _non_send_mut: NonSendMut<Vec<u8>>,
    _components: Query<Ref<Position>>,
    _reader: MessageReader<Pulse>,
    _writer: MessageWriter<Pulse>,
    _mutator: MessageMutator<Pulse>,
    _event: On<Notice>,
) {
}

fn typed(mut commands: Commands, mut query: Query<&mut Position, With<Required>>, custom: Custom) {
    for _position in &mut query {}
    commands.spawn((Name::new("Deferred"), Position));
    let _value = custom.settings.value;
}

fn assembly(world: &mut World) {
    world.spawn((Name::new("Direct"), PositionBundle { position: Position }));
    world.insert_resource(Settings::default());
    if world.get_resource::<Settings>().is_some() {}
    world
        .spawn_scene(bsn! {
            Name("Scene root")
            Position
            Children [
                Name("Scene child")
                Required
            ]
        })
        .unwrap();
}

fn concrete_wrapper() {
    let _system = IntoSystem::into_system(typed);
}

pub fn external_assembly(app: &mut bevy_app::App) {
    app.add_plugins(architecture_external::ExternalGenericPlugin::<
        architecture_external::ExternalMarker,
    >::default());
}

fn branch_content(text: bool) -> Box<dyn Scene> {
    if text {
        Box::new(bsn! {
            Name("Text branch")
            Text("Text")
            Children [Name("Text child") Text("Child")]
        })
    } else {
        Box::new(bsn! {
            Name("Button branch")
            Button
            Children [Name("Button child") Button]
        })
    }
}

fn branch_assembly(world: &mut World, text: bool) {
    let content = branch_content(text);
    world.spawn_scene(content).unwrap();
}

fn nested_branch_assembly(world: &mut World, text: bool) {
    world
        .spawn_scene(bsn! {
            Name("Choice host")
            Children [@branch_content(text)]
        })
        .unwrap();
}

fn repeated_roots(world: &mut World) {
    let bundle = (Name::new("Repeated template"), Position);
    world.spawn_batch([bundle.clone(), bundle]);
}

fn protocol_branch_assembly(world: &mut World, text: bool) {
    world
        .spawn_scene(bevy_scene::SceneFunction(
            move |_: &mut bevy_scene::ResolveContext, scene: &mut bevy_scene::ResolvedScene| {
                scene.insert_template(Name::new("Protocol branch"));
                if text {
                    scene.insert_template(Text::new("Text"));
                } else {
                    scene.insert_template(Button);
                }
            },
        ))
        .unwrap();
}

fn no_scene_outcome(world: &mut World) {
    world
        .spawn_scene(bevy_scene::SceneFunction(
            |_: &mut bevy_scene::ResolveContext, _: &mut bevy_scene::ResolvedScene| {
                panic!("This fixture is only interpreted, never executed")
            },
        ))
        .unwrap();
}

#[derive(Component, Default, Clone)]
#[require(Name::new("Required fixture name"))]
struct NamedRequired;

fn required_names(world: &mut World) {
    world.spawn(NamedRequired);
    world.spawn((NamedRequired, Name::new("Explicit fixture name")));
}

fn named_bundle() -> (Name, Position) {
    (Name::new("Helper fixture name"), Position)
}

fn copied_names(world: &mut World) {
    let name = Name::new("Cloned fixture name");
    world.spawn(name.clone());
    world.spawn(named_bundle());
    world.spawn_scene(bsn! {
        #NamedFixtureRoot
        Children [#NamedFixtureChild]
    }).unwrap();
}

fn dynamic_names(world: &mut World, index: u32) {
    world.spawn(Name::new(format!("Named item {}", index)));
    world.spawn(Name::from(format!("From item {}", index)));
    let mut name = Name::new("Before set");
    name.set(format!("Set item {}", index));
    world.spawn(name);
    world.spawn_scene(bsn! {
        Name({format!("BSN item {}", index)})
        Children [Name({format!("BSN child {}", index)})]
    }).unwrap();
}

const CONSTANT_ENTITY_NAME: &str = "Constant fixture name";

fn constant_name(world: &mut World) {
    world.spawn(Name::new(CONSTANT_ENTITY_NAME));
}

fn type_named_entities(world: &mut World) {
    world.spawn(Name::new(std::any::type_name::<Position>()));
    world.spawn(Name::new(std::any::type_name::<
        architecture_external::ExternalGenericPlugin<architecture_external::ExternalMarker>,
    >()));
    world.spawn(Name::new(std::any::type_name::<Vec<Option<String>>>()));
    world.spawn(Name::new(std::any::type_name::<u32>()));
}

fn forward_name(value: String) -> Name {
    Name::new(value)
}

fn forwarded_dynamic_name(world: &mut World, index: u32) {
    world.spawn(forward_name(format!("Forwarded item {}", index)));
}

fn dynamic_parameter_name(world: &mut World, value: String) {
    world.spawn(Name::new(value));
}

fn mutated_dynamic_name(world: &mut World, index: u32) {
    let mut value = format!("Before mutation {}", index);
    value.push_str(" suffix");
    world.spawn(Name::new(value));
}

fn mutated_static_name(world: &mut World) {
    let mut value = "Before static mutation".to_owned();
    value.push_str(" suffix");
    world.spawn(Name::new(value));
}

fn unknown_text_modifier(world: &mut World, index: u32, modify: fn(&mut String)) {
    let mut value = format!("Before unknown modification {}", index);
    modify(&mut value);
    world.spawn(Name::new(value));
}

fn unknown_static_text_modifier(world: &mut World, modify: fn(&mut String)) {
    let mut value = "Before unknown static modification".to_owned();
    modify(&mut value);
    world.spawn(Name::new(value));
}

fn unknown_dyn_text_modifier(world: &mut World, index: u32, modify: &dyn Fn(&mut String)) {
    let mut value = format!("Before unknown dyn modification {}", index);
    modify(&mut value);
    world.spawn(Name::new(value));
}

fn unknown_text_factory(world: &mut World, make: fn() -> String) {
    let value = make();
    world.spawn(Name::new(value));
}

fn trimmed_parameter_name(world: &mut World, text: &'static str) {
    let view = text.trim();
    world.spawn(Name::new(view));
}

fn rebound_trimmed_name(world: &mut World, text: &'static str, modify: fn(&mut &'static str)) {
    let mut view = text.trim();
    modify(&mut view);
    world.spawn(Name::new(view));
}

fn rebound_shared_text(world: &mut World, modify: fn(&mut &String)) {
    let value = "Original shared name".to_owned();
    let mut borrowed = &value;
    modify(&mut borrowed);
    world.spawn(Name::new(value.clone()));
    world.spawn(Name::new(String::clone(borrowed)));
}

fn rebound_mutable_text(world: &mut World, modify: fn(&mut &mut String)) {
    let mut value = "Original mutable name".to_owned();
    {
        let mut borrowed = &mut value;
        modify(&mut borrowed);
        world.spawn(Name::new(String::clone(borrowed)));
    }
    world.spawn(Name::new(value));
}

fn same_shape_names(world: &mut World) {
    world.spawn_batch([
        (Name::new("First same-shape name"), Position),
        (Name::new("Second same-shape name"), Position),
    ]);
}

fn same_shape_scene_names(world: &mut World, first: bool) {
    world.spawn_scene(bevy_scene::SceneFunction(
        move |_: &mut bevy_scene::ResolveContext, scene: &mut bevy_scene::ResolvedScene| {
            scene.insert_template(if first {
                Name::new("First scene name")
            } else {
                Name::new("Second scene name")
            });
        },
    )).unwrap();
}

fn same_shape_unknown_name(world: &mut World, known: bool, name: Name) {
    let name = if known { Name::new("Confirmed name") } else { name };
    world.spawn((name, Position));
}

fn branch_required_scene_name(world: &mut World, explicit: bool) {
    world.spawn_scene((
        bevy_scene::SceneFunction(
            move |_: &mut bevy_scene::ResolveContext, scene: &mut bevy_scene::ResolvedScene| {
                if explicit {
                    scene.insert_template(Name::new("Branch explicit name"));
                } else {
                    scene.insert_template(Position);
                }
            },
        ),
        bsn! { NamedRequired },
    )).unwrap();
}

fn unknown_scene_after_name(world: &mut World, scene: Box<dyn Scene>) {
    world.spawn_scene((bsn! { Name("Before unknown scene") }, scene)).unwrap();
}

fn unknown_scene_before_name(world: &mut World, scene: Box<dyn Scene>) {
    world.spawn_scene((scene, bsn! { Name("After unknown scene") })).unwrap();
}

fn unknown_component_after_name(world: &mut World, component: Position) {
    world.spawn_scene(bevy_scene::SceneFunction(
        move |_: &mut bevy_scene::ResolveContext, scene: &mut bevy_scene::ResolvedScene| {
            scene.insert_template(Name::new("Before unknown component"));
            scene.insert_template(component);
        },
    )).unwrap();
}

#[derive(Component, Default)]
#[require(Name::new("First required name"))]
struct FirstNamedRequired;

#[derive(Component, Default)]
#[require(Name::new("Second required name"))]
struct SecondNamedRequired;

#[derive(Component, Default)]
#[require(FirstNamedRequired, SecondNamedRequired)]
struct IndirectNamedRequired;

#[derive(Component, Default)]
#[require(FirstNamedRequired, Name::new("Direct required name"))]
struct DirectNamedRequired;

fn required_bundle_first(world: &mut World) {
    world.spawn((FirstNamedRequired, SecondNamedRequired));
}

fn required_bundle_reversed(world: &mut World) {
    world.spawn((SecondNamedRequired, FirstNamedRequired));
}

fn required_inherited_first(world: &mut World) {
    world.spawn(IndirectNamedRequired);
}

fn required_direct_override(world: &mut World) {
    world.spawn(DirectNamedRequired);
}
