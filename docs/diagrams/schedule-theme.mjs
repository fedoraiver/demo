// 调度与对象图共用字体、系统和集合配色；布局仍由 Graphviz 计算。
import { ARCHITECTURE_TEXT_STYLE, NODE_STYLES, EDGE_STYLES } from './architecture-style.mjs';
import { VIEWER_BACKGROUND } from './viewer-theme.mjs';

export const SCHEDULE_THEME_VERSION = 2;
export const SCHEDULE_THEME = {
  version: SCHEDULE_THEME_VERSION,
  background: VIEWER_BACKGROUND,
  fontFamily: ARCHITECTURE_TEXT_STYLE.fontFamily,
  fontSize: ARCHITECTURE_TEXT_STYLE.fontSize,
  textColor: ARCHITECTURE_TEXT_STYLE.color,
  nodeMargin: 8,
  clusterLabelMargin: 8,
  clusterTitleLayer: 'native-foreground',
  fontMetricMarginPerCharacter: 0.02,
  system: { ...NODE_STYLES.system },
  systemSet: { ...NODE_STYLES.system_set },
  edge: { ...EDGE_STYLES.order },
};
