import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function pathsForRepository(root = repositoryRoot) {
  const packageRoot = path.resolve(root, 'docs/diagrams');
  const generatedDirectory = path.join(packageRoot, 'generated');
  return {
    repositoryRoot: path.resolve(root), packageRoot, generatedDirectory,
    sourceDirectory: path.join(packageRoot, 'src'), catalogDirectory: path.join(packageRoot, 'catalog'),
    testsDirectory: path.join(packageRoot, 'tests'), licensesDirectory: path.join(packageRoot, 'licenses'),
    pagesDirectory: path.join(generatedDirectory, 'pages'), dataDirectory: path.join(generatedDirectory, 'data'),
    viewDataDirectory: path.join(generatedDirectory, 'data/views'),
    objectSvgDirectory: path.join(generatedDirectory, 'svg/object'), scheduleSvgDirectory: path.join(generatedDirectory, 'svg/schedule'),
    legendSvgDirectory: path.join(generatedDirectory, 'svg/legend'), dotDirectory: path.join(generatedDirectory, 'dot'),
    mermaidDirectory: path.join(generatedDirectory, 'mermaid'),
    temporaryDirectory: path.resolve(root, 'tmp/ecs-architecture'),
  };
}

export function artifactRelativePath(view, kind = 'svg') {
  const filename = kind === 'svg' ? view.filename : kind === 'mermaid' ? view.mermaidFilename : view.dotFilename;
  if (!filename || path.basename(filename) !== filename) throw new Error('Invalid architecture artifact basename');
  return kind === 'svg' ? `svg/${view.aspect === 'schedule' ? 'schedule' : 'object'}/${filename}`
    : `${kind === 'mermaid' ? 'mermaid' : 'dot'}/${filename}`;
}

export function artifactFile(paths, view, kind = 'svg') {
  return path.join(paths.generatedDirectory, artifactRelativePath(view, kind));
}
