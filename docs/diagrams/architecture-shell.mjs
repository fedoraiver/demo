export const architectureShellStyle = `
*{box-sizing:border-box}
body{margin:0;height:100vh;display:flex;flex-direction:column;background:var(--ui-bg);color:var(--ui-text);font:14px/1.6 'Segoe UI','Microsoft YaHei',sans-serif}
header{height:48px;flex:none;padding:8px 22px;display:flex;align-items:center;justify-content:space-between;background:var(--ui-surface);border-bottom:1px solid var(--ui-border)}
.brand{font-size:11px;font-weight:600;letter-spacing:1.5px;color:var(--ui-muted)}
.shell{display:grid;grid-template-columns:210px minmax(0,1fr);min-height:0;flex:1}
.navigation{overflow:auto;padding:20px 10px;background:var(--ui-surface);border-right:1px solid var(--ui-border)}
.navigation p{margin:0 12px 10px;color:var(--ui-muted);font-size:11px;letter-spacing:1px}
.navigation #third-party-heading{margin-top:18px}
.navigation button{display:block;width:100%;text-align:left;margin:3px 0;padding:8px 12px;border-radius:7px;line-height:1.45}
.navigation button.active{background:var(--ui-active);color:#1D4ED8;box-shadow:inset 3px 0 var(--ui-accent);font-weight:600}
.navigation button small{display:block;white-space:normal;overflow-wrap:anywhere;font:10px/1.5 Consolas,monospace;color:var(--ui-muted);margin-top:3px}
.nav-divider{height:1px;background:var(--ui-border);margin:18px 12px}
.main{display:flex;flex-direction:column;min-width:0;min-height:0}
.feature-head{background:var(--ui-surface);padding:18px 22px 12px;flex:none}
.feature-head h1{font-size:22px;line-height:1.4;margin:0 0 5px;font-weight:650}
.feature-head .identifier{font:12px Consolas,monospace;color:var(--ui-muted);margin-left:10px}
.tabs-toolbar{display:flex;align-items:center;gap:12px;background:var(--ui-surface);padding:0 20px 10px;flex-wrap:wrap;border-bottom:1px solid var(--ui-border)}
.tabs{display:flex;gap:4px}.tabs[hidden]{display:none}
.tabs button{padding:6px 10px;font-size:13px;color:var(--ui-muted)}
.tabs button.active{background:var(--ui-active);color:#1D4ED8;font-weight:600}
.tools{display:flex;gap:4px;align-items:center;margin-left:auto;flex-wrap:wrap}
.tools input{width:180px;padding:5px 10px;background:var(--ui-bg);font-size:12px}
.tools button{padding:4px 8px;font-size:12px}.tools #zoom-label{font-size:11px;min-width:38px;text-align:center;color:var(--ui-muted)}
#return-overview:not(:disabled){color:var(--ui-accent)}
.workspace{--details-width:286px;display:grid;grid-template-columns:minmax(360px,1fr) 10px var(--details-width);gap:0;padding:14px;min-height:0;flex:1}
.canvas-wrap{min-width:0;min-height:0;display:flex;flex-direction:column;border:1px solid var(--ui-border);border-radius:var(--ui-radius);background:var(--ui-bg);overflow:hidden}
.caption{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:6px 10px;background:var(--ui-surface);border-bottom:1px solid var(--ui-border);color:var(--ui-muted);font-size:11px}
.caption select{max-width:180px;background:var(--ui-bg);padding:3px 6px;font-size:11px}
.canvas{flex:1;position:relative;overflow:hidden;touch-action:none;cursor:grab;min-height:200px}
.canvas:focus{outline:none}
.canvas,.canvas *{user-select:none;-webkit-user-select:none}.canvas.dragging{cursor:grabbing}
.diagram{position:absolute;left:0;top:0;transform-origin:0 0}.diagram svg{display:block;overflow:visible}
.details-resizer{cursor:col-resize;touch-action:none;position:relative;outline-offset:-2px}
.details-resizer::after{content:"";position:absolute;inset:10px 3px;border-radius:3px;background:transparent}
.details-resizer:hover::after,.details-resizer:focus-visible::after,.workspace.resizing .details-resizer::after{background:#93C5FD}
.details-resizer[hidden]{display:none}.workspace.resizing,.workspace.resizing *{cursor:col-resize!important;user-select:none!important}
.side{min-width:0;background:var(--ui-surface);border:1px solid var(--ui-border);border-radius:var(--ui-radius);overflow:auto;padding:18px;overflow-wrap:anywhere;box-shadow:0 1px 2px #0F172A04}
.side h2{font-size:18px;line-height:1.45;margin:8px 0 14px;font-weight:650}.side h3{font-size:12px;color:var(--ui-muted);margin:22px 0 8px;font-weight:600}
.side h2:first-child{margin-top:0}.access-group h4{font-size:11px;color:var(--ui-muted);font-weight:500;margin:10px 0 4px}
.access-group{padding-inline-start:16px;min-width:0}.side .access-group ul{padding-inline-start:16px}
.schedule-registration{margin:10px 0;padding:10px;background:var(--ui-bg);border-radius:6px}.schedule-registration dl{margin:0}.registration-field{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 6px;margin:5px 0}.registration-field dt{font:11px/1.7 Consolas,monospace;color:var(--ui-muted)}.registration-field dt::after{content:':'}.registration-field dd{margin:0;flex:1 1 120px;min-width:0}.registration-value{display:block}.registration-value+.registration-value{margin-top:4px}.side .registration-value code{padding:0;background:transparent}
.side p{margin:8px 0}.side ul{padding-left:16px;margin:6px 0}.side li{margin:6px 0}
.side code,.side .data-link{font:11px/1.7 Consolas,monospace;background:var(--ui-bg);padding:3px 6px;border:0;border-radius:4px;overflow-wrap:anywhere;max-width:100%;text-align:left}
.side .data-link:hover{background:var(--ui-active);color:var(--ui-accent)}
.badge{display:inline-block;background:var(--ui-hover);color:var(--ui-muted);font-size:10px;padding:3px 7px;border-radius:4px}
.side .source{display:block;font-size:11px;padding:7px 9px;background:var(--ui-bg);border-radius:6px;margin:5px 0}.side .source:hover{background:var(--ui-active)}
.source-group-label{font-size:11px;color:var(--ui-muted);font-weight:500;margin:14px 0 6px}.side .source-entry-label{font-size:11px;margin:10px 0 4px;color:var(--ui-muted)}.source-entry,.source-actions{min-width:0}
.side button[data-owner]{margin:8px 0;color:var(--ui-accent);background:var(--ui-active);font-size:12px}.side button[data-owner]:hover{background:#DBEAFE}
.reset{width:100%;margin-top:24px;border-color:var(--ui-border);font-size:12px;color:var(--ui-muted)}
.guide h3:first-child{margin-top:0}.guide-row{display:grid;grid-template-columns:88px minmax(0,1fr);gap:12px;align-items:center;margin:14px 0;font-size:12px;line-height:1.6}
.guide-sample{display:flex;align-items:center;justify-content:center;height:44px}.guide-sample svg{display:block;width:88px;height:44px;max-width:100%;overflow:visible}
.guide-reference{font-size:12px;color:var(--ui-muted);margin:12px 0 18px}
.empty-state{position:absolute;inset:0;display:grid;place-content:center;text-align:center;padding:36px;color:var(--ui-muted)}.empty-state h3{font-size:19px;color:var(--ui-text);font-weight:600}
.result{width:100%;text-align:left;margin:4px 0;font-size:12px}
@media(max-width:1250px){.shell{grid-template-columns:178px minmax(0,1fr)}.tools{margin-left:0}.feature-head{padding:15px 18px 12px}.navigation button{padding:8px 10px}}
@media(max-width:900px){body{height:auto;min-height:100vh}.shell{display:block}.navigation{display:flex;gap:4px;overflow:auto;padding:8px;border-right:0;border-bottom:1px solid var(--ui-border)}.navigation p,.navigation .nav-divider,.navigation button small{display:none}.third-party-navigation{display:flex;flex:none;gap:4px}.navigation button{width:auto;flex:none;white-space:nowrap;font-size:12px}.navigation button.active{box-shadow:inset 0 -2px var(--ui-accent)}.workspace{display:flex;flex-direction:column;gap:12px}.details-resizer{display:none}.canvas-wrap{height:55vh;height:55svh;min-height:280px;max-height:560px;flex:none}.side{max-height:none;overflow:visible}.feature-head h1{font-size:20px}.feature-head .identifier{display:block;margin:5px 0}.tabs-toolbar{padding:0 14px 10px}.caption select{max-width:100%}.tabs{flex-wrap:wrap}.tools input{font-size:16px;max-width:100%;min-width:0}header{gap:10px;padding-inline:16px}}
`;
