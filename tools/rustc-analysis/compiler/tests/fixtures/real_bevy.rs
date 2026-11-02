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
