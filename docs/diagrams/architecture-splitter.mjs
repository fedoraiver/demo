// 宽度只保存在当前查看器内存中，不写入工作区配置或浏览器存储。
export function createArchitectureSplitter({ workspace, separator, canvas, window, onResize }) {
  let width = 286, drag = null;
  const limits = () => ({ min: 240, max: Math.min(720, Math.max(240, workspace.clientWidth - 28 - 10 - 360)) });
  const desktop = () => !(window.innerWidth <= 900);
  function apply(requested, preserveCenter = true) {
    const { min, max } = limits(), before = canvas.clientWidth;
    width = Math.max(min, Math.min(max, requested));
    workspace.style.setProperty('--details-width', width + 'px');
    separator.setAttribute('aria-valuemin', String(min)); separator.setAttribute('aria-valuemax', String(max)); separator.setAttribute('aria-valuenow', String(width));
    if (preserveCenter) onResize(canvas.clientWidth - before);
  }
  function finish(event) {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null; workspace.classList.remove('resizing');
    if (separator.hasPointerCapture(event.pointerId)) separator.releasePointerCapture(event.pointerId);
  }
  function refresh(preserveCenter = false) {
    separator.hidden = !desktop(); separator.setAttribute('aria-disabled', String(!desktop()));
    if (desktop()) apply(width, preserveCenter);
    else if (drag) finish({ pointerId: drag.id });
  }
  separator.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !desktop()) return;
    event.preventDefault();
    drag = { id: event.pointerId, x: event.clientX, width };
    separator.setPointerCapture(event.pointerId); workspace.classList.add('resizing');
  });
  separator.addEventListener('pointermove', event => {
    if (drag && event.pointerId === drag.id) { event.preventDefault(); apply(drag.width + drag.x - event.clientX); }
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) separator.addEventListener(name, finish);
  separator.addEventListener('keydown', event => {
    if (!desktop()) return;
    const { min, max } = limits();
    const requested = { ArrowLeft: width + 16, ArrowRight: width - 16, Home: min, End: max }[event.key];
    if (requested === undefined) return;
    event.preventDefault(); apply(requested);
  });
  refresh();
  return { refresh };
}

export function architectureSplitterAssets() {
  return { script: createArchitectureSplitter.toString() };
}
