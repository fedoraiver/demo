// 两份离线页面共享界面色阶与控件状态；图内语义配色由 architecture-style 维护。
export const VIEWER_BACKGROUND = '#F6F8FB';
export const viewerThemeStyle = `
:root{color-scheme:light;--ui-bg:${VIEWER_BACKGROUND};--ui-surface:#FFFFFF;--ui-text:#1E293B;--ui-muted:#64748B;--ui-border:#E2E8F0;--ui-hover:#F1F5F9;--ui-accent:#2563EB;--ui-active:#EFF6FF;--ui-radius:10px}
button,input,select{font:inherit;color:inherit}button,a,select{touch-action:manipulation}button{min-height:32px;border:1px solid transparent;border-radius:6px;padding:5px 10px;background:transparent;cursor:pointer;transition:background-color .12s,color .12s}button:hover{background:var(--ui-hover)}button:disabled{opacity:.42;cursor:default}button:disabled:hover{background:transparent}button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid var(--ui-accent);outline-offset:3px}a{color:var(--ui-accent);text-underline-offset:3px}input,select{border:1px solid var(--ui-border);border-radius:6px;background:var(--ui-surface)}
@media(pointer:coarse){button,input,select{min-height:44px}}@media(prefers-reduced-motion:reduce){button{transition:none}}
`;
