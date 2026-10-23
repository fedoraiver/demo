import mermaid from 'mermaid';
import { mermaidConfiguration, renderEntityExpansion } from './architecture-renderer.mjs';
import { compileRoutedView, measureNativeLabelBounds, normalizeMermaidSvg } from './mermaid-core.mjs';

async function compileNativeView(view, registry) {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;width:20000px;contain:layout style;';
  document.body.append(host);
  try {
    const { svg } = await mermaid.render(view.id, view.mermaid, host);
    host.innerHTML = svg;
    const nativeSvg = host.querySelector('svg');
    nativeSvg.setAttribute('data-architecture-measurement', 'true');
    const clusterLabelBounds = measureNativeLabelBounds();
    nativeSvg.removeAttribute('data-architecture-measurement');
    return normalizeMermaidSvg(view, new XMLSerializer().serializeToString(nativeSvg), registry, { clusterLabelBounds });
  } finally {
    host.remove();
  }
}

mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', maxTextSize: mermaidConfiguration('data').maxTextSize });

globalThis.architectureEntityRuntime = Object.freeze({
  async compile(baseView, expandedEntityIds, registry, features) {
    await document.fonts.ready;
    const definition = renderEntityExpansion(baseView, expandedEntityIds, registry, features);
    return compileRoutedView(definition, registry, compileNativeView);
  },
});
