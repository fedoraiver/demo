#![allow(dead_code)]
use bevy_ecs::{
    prelude::*,
    system::{IntoSystem, SystemParam},
};
use bevy_scene::prelude::*;

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
