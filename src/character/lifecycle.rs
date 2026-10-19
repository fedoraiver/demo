//! 角色意图随会话暂停或返回主菜单清空，不依赖设备控制或相机插件。

use bevy::prelude::*;

use super::CharacterIntent;

/// 在固定循环前丢弃旧移动轴和一次性请求，恢复后由当前设备输入重新建立意图。
pub(super) fn clear_character_intents(mut intents: Query<&mut CharacterIntent>) {
    for mut intent in &mut intents {
        *intent = CharacterIntent::default();
    }
}
