use bevy_app::{App, Plugin, Update};
use bevy_ecs::prelude::*;
use std::marker::PhantomData;

pub struct ExternalMarker;
pub struct ExternalGenericPlugin<T>(PhantomData<T>);

impl<T> Default for ExternalGenericPlugin<T> {
    fn default() -> Self {
        Self(PhantomData)
    }
}

#[derive(Resource)]
pub struct ExternalResource<T: Send + Sync + 'static> {
    value: u32,
    marker: PhantomData<T>,
}

impl<T: Send + Sync + 'static> Default for ExternalResource<T> {
    fn default() -> Self {
        Self {
            value: 0,
            marker: PhantomData,
        }
    }
}

impl<T: Send + Sync + 'static> Plugin for ExternalGenericPlugin<T> {
    fn build(&self, app: &mut App) {
        init_asset_like::<T>(app);
    }
}

fn init_asset_like<T: Send + Sync + 'static>(app: &mut App) {
    app.init_resource::<ExternalResource<T>>()
        .add_systems(Update, (external_generic_system::<T>, external_zero));
}

fn external_generic_system<T: Send + Sync + 'static>(mut resource: ResMut<ExternalResource<T>>) {
    resource.value += 1;
}

fn external_zero() {}
