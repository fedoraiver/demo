// 真实类型声明共用目录；浏览分组不会改变组件的定义位置。
import { BEVY_SOURCE_DEFINITIONS } from './bevy-source-definitions.mjs';
import { THIRD_PARTY_SOURCE_DEFINITIONS } from './third-party-source-definitions.mjs';
import { BEVY_SYSTEM_SOURCE_DEFINITIONS } from './bevy-system-source-definitions.mjs';
import { THIRD_PARTY_SYSTEM_SOURCE_DEFINITIONS } from './third-party-system-source-definitions.mjs';

export const DEPENDENCY_SOURCE_DEFINITIONS = Object.freeze({ ...BEVY_SOURCE_DEFINITIONS, ...THIRD_PARTY_SOURCE_DEFINITIONS, ...BEVY_SYSTEM_SOURCE_DEFINITIONS, ...THIRD_PARTY_SYSTEM_SOURCE_DEFINITIONS });
