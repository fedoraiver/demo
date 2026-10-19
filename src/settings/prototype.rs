//! 运动、物理与场景共用的原型参数；运行时实体状态由各功能拥有。

use bevy::prelude::*;

/// 原型的运动、平地和持箱参数。
#[derive(Resource, Reflect, Clone, Debug)]
#[reflect(Resource)]
pub struct PrototypeConfig {
    pub move_speed: f32,
    pub acceleration: f32,
    pub braking_acceleration: f32,
    pub air_acceleration: f32,
    pub jump_speed: f32,
    pub gravity: f32,
    pub pickup_radius: f32,
    pub hold_offset: Vec3,
    pub ground_y: f32,
    pub parcel_half_height: f32,
    pub character_mass: f32,
    pub character_height: f32,
    pub character_radius: f32,
    pub parcel_mass: f32,
}

impl Default for PrototypeConfig {
    fn default() -> Self {
        Self {
            move_speed: 4.5,
            acceleration: 30.0,
            braking_acceleration: 45.0,
            air_acceleration: 6.0,
            jump_speed: 5.0,
            gravity: 9.81,
            pickup_radius: 1.8,
            hold_offset: Vec3::new(0.0, 1.0, -0.9),
            ground_y: 0.0,
            parcel_half_height: 0.3,
            character_mass: 75.0,
            character_height: 1.9,
            character_radius: 0.32,
            parcel_mass: 3.0,
        }
    }
}
