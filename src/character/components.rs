//! 角色业务身份、持续意图和由真实物理状态派生的运动信息。

use bevy::prelude::*;

/// 具有移动和跳跃能力的角色。
#[derive(Component, Reflect, Default, Clone)]
#[reflect(Component)]
pub struct Character;

/// 来自控制者的玩法意图；输入状态跨帧保留，供固定步模拟读取。
///
/// PreUpdate 与 FixedUpdate 不一一对应：移动轴持续有效，跳跃和交互请求只消费一次。
/// 输入 Observer 仅更新意图，不按输入事件次数积分位置，避免运动速度依赖渲染帧率。
#[derive(Component, Reflect, Default, Clone)]
#[reflect(Component)]
pub struct CharacterIntent {
    /// 角色局部水平输入轴：x 表示左右横移，y 表示前后移动。
    pub movement: Vec2,
    pub jump_pending: bool,
    pub interact_pending: bool,
}

/// 接地状态由物理查询派生；实际速度直接读取 Avian 的 LinearVelocity。
#[derive(Component, Reflect, Default, Clone)]
#[reflect(Component)]
pub struct CharacterMotion {
    pub grounded: bool,
}
