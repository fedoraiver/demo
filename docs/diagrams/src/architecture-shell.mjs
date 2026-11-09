export const architectureShellStyle = `
*{box-sizing:border-box}
body{margin:0;height:100vh;height:100dvh;display:flex;flex-direction:column;overflow:hidden;background:var(--ui-bg);color:var(--ui-text);font:14px/1.6 'Segoe UI','Microsoft YaHei',sans-serif}
header{flex:none;padding:8px 12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--ui-surface);border-bottom:1px solid var(--ui-border);z-index:2}
.brand{font-size:11px;font-weight:600;letter-spacing:1.5px;color:var(--ui-muted)}
.main{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0}
.view-picker{min-width:160px;max-width:360px;flex:1;padding:5px 8px;background:var(--ui-bg)}
.tools{display:flex;gap:4px;align-items:center;margin-left:auto;flex-wrap:wrap}
.object-search{position:relative;flex:0 1 240px;min-width:140px}.object-search>input{width:100%;padding:5px 10px;background:var(--ui-bg);font-size:12px}
.object-results{position:fixed;display:flex;flex-direction:column;width:min(480px,calc(100vw - 24px));max-height:65vh;overflow:hidden;padding:12px;background:var(--ui-surface);border:1px solid var(--ui-border);border-radius:8px;box-shadow:0 8px 28px #0003;z-index:5}.object-results h2{font-size:14px;margin:0 0 8px;overflow-wrap:anywhere}.object-results p{font-size:12px;margin:0 0 8px}
#search-kind-controls{flex:none;display:flex;flex-direction:column}.search-filter-header{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex:none}.search-filter-header button{font-size:12px;padding:4px 8px}.search-filter-header #search-kinds-toggle{flex:1;text-align:left}.search-kinds{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 12px;overflow:auto;max-height:190px;padding:0 0 10px;margin-bottom:10px;border-bottom:1px solid var(--ui-border)}.search-kind{display:flex;align-items:flex-start;gap:7px;min-width:0;cursor:pointer;font-size:12px}.search-kind input{flex:none;width:auto;margin:4px 0}.search-kind span{overflow-wrap:anywhere}.search-matches{overflow:auto;min-height:0;flex:1}
.result.active{background:var(--ui-active);outline:2px solid var(--ui-accent);outline-offset:-2px}
.schedule-filter{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 12px;background:var(--ui-surface);border-bottom:1px solid var(--ui-border);font-size:12px;flex:none}.schedule-filter button{font-size:12px;padding:4px 8px}
.filter-toggle{min-width:135px;text-align:left}.filter-menu{position:fixed;display:flex;flex-direction:column;gap:8px;overflow:hidden;padding:12px;background:var(--ui-surface);border:1px solid var(--ui-border);border-radius:8px;box-shadow:0 8px 28px #0003;z-index:6}.filter-menu>input{flex:none;width:100%;min-width:0;padding:5px 8px;background:var(--ui-bg);font-size:12px}.filter-actions{display:flex;gap:6px;flex:none}.filter-options{overflow:auto;min-height:0}.filter-choice{display:flex;align-items:flex-start;gap:8px;padding:7px 4px;cursor:pointer}.filter-choice:hover{background:var(--ui-hover)}.filter-choice input{flex:none;width:auto;margin:4px 0}.filter-option-text{display:block;min-width:0;flex:1}.filter-option-name,.filter-option-text small{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.filter-option-name{font-size:12px}.filter-option-text small{font:11px/1.6 Consolas,monospace;color:var(--ui-muted)}.filter-option-text .filter-missing{color:#9A6700}.filter-empty{padding:8px;color:var(--ui-muted)}
.schedule-status{padding:5px 12px;background:var(--ui-surface);font-size:12px;color:var(--ui-muted);flex:none}.schedule-status.error{color:#B91C1C}
[hidden]{display:none!important}
.tools button{padding:4px 8px;font-size:12px}.tools #zoom-label{font-size:11px;min-width:38px;text-align:center;color:var(--ui-muted)}
#return-overview:not(:disabled){color:var(--ui-accent)}
.workspace{--details-width:286px;display:grid;grid-template-columns:minmax(360px,1fr) 10px var(--details-width);gap:0;min-height:0;flex:1}
.canvas-wrap{min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--ui-bg);overflow:hidden}
.canvas{flex:1;position:relative;overflow:hidden;touch-action:none;cursor:grab;min-height:0}
.canvas:focus{outline:none}
.canvas,.canvas *{user-select:none;-webkit-user-select:none}.canvas.dragging{cursor:grabbing}
.diagram{position:absolute;left:0;top:0;transform-origin:0 0}.diagram svg{display:block;overflow:visible}
.diagram [data-id],.diagram [data-schedule-id],.diagram [data-link-id],.diagram [data-schedule-link-id],.diagram [data-schedule-node]{cursor:pointer}.diagram [data-schedule-node]:focus{outline:none}.diagram [data-schedule-node]:focus-visible:not(.selected):not([data-schedule-title]){outline:2px solid #2563EB;outline-offset:4px}
.details-resizer{cursor:col-resize;touch-action:none;position:relative;outline-offset:-2px}
.details-resizer::after{content:"";position:absolute;inset:10px 3px;border-radius:3px;background:transparent}
.details-resizer:hover::after,.details-resizer:focus-visible::after,.workspace.resizing .details-resizer::after{background:#93C5FD}
.details-resizer[hidden]{display:none}.workspace.resizing,.workspace.resizing *{cursor:col-resize!important;user-select:none!important}
.side{min-width:0;background:var(--ui-surface);border:1px solid var(--ui-border);border-radius:var(--ui-radius);overflow:auto;padding:18px;overflow-wrap:anywhere;box-shadow:0 1px 2px #0F172A04}
.side h2{font-size:18px;line-height:1.45;margin:8px 0 14px;font-weight:650}.side h3{font-size:12px;color:var(--ui-muted);margin:22px 0 8px;font-weight:600}
.side h2:first-child{margin-top:0}
.side p{margin:8px 0}.side ul{padding-left:16px;margin:6px 0}.side li{margin:6px 0}
.side code,.side .data-link{font:11px/1.7 Consolas,monospace;background:var(--ui-bg);padding:3px 6px;border:0;border-radius:4px;overflow-wrap:anywhere;max-width:100%;text-align:left}
.side .data-link:hover{background:var(--ui-active);color:var(--ui-accent)}
.badge{display:inline-block;background:var(--ui-hover);color:var(--ui-muted);font-size:10px;padding:3px 7px;border-radius:4px}
.side .source{display:block;font-size:11px;padding:7px 9px;background:var(--ui-bg);border-radius:6px;margin:5px 0}.side .source:hover{background:var(--ui-active)}
.source-group-label{font-size:11px;color:var(--ui-muted);font-weight:500;margin:14px 0 6px}.side .source-entry-label{font-size:11px;margin:10px 0 4px;color:var(--ui-muted)}.source-entry,.source-actions{min-width:0}
.side button[data-object]{margin:8px 0;color:var(--ui-accent);background:var(--ui-active);font-size:12px}.side button[data-object]:hover{background:#DBEAFE}
.reset{width:100%;margin-top:24px;border-color:var(--ui-border);font-size:12px;color:var(--ui-muted)}
.guide h3:first-child{margin-top:0}.guide-row{display:grid;grid-template-columns:88px minmax(0,1fr);gap:12px;align-items:center;margin:14px 0;font-size:12px;line-height:1.6}
.guide-sample{display:flex;align-items:center;justify-content:center;height:44px}.guide-sample svg,.guide-sample img{display:block;width:88px;height:44px;max-width:100%;overflow:visible;object-fit:contain}
.guide-reference{font-size:12px;color:var(--ui-muted);margin:12px 0 18px}
.empty-state{position:absolute;inset:0;display:grid;place-content:center;text-align:center;padding:36px;color:var(--ui-muted)}.empty-state h3{font-size:19px;color:var(--ui-text);font-weight:600}
.result{width:100%;text-align:left;margin:4px 0;font-size:12px;white-space:normal;overflow-wrap:anywhere;min-width:0}.result small{display:block;overflow-wrap:anywhere;color:var(--ui-muted);font:10px/1.6 Consolas,monospace}
@media(max-width:900px){header{gap:6px}.brand{display:none}.view-picker{max-width:none;min-width:140px}.tools{margin-left:0}.object-search{flex:1}.workspace{display:flex;flex-direction:column;overflow:auto}.workspace .canvas-wrap{height:55svh;min-height:280px;flex:none}.side{max-height:none;overflow:visible;flex:none}.details-resizer{display:none}.object-search input,.filter-menu>input{font-size:16px}.schedule-multiselect{flex:1;min-width:140px}.filter-toggle{width:100%}}
`;
