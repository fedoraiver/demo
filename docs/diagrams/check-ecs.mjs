import { checkArchitecture } from './src/check-ecs.mjs';
import { repositoryRoot } from './src/paths.mjs';

try {
  console.log(JSON.stringify(checkArchitecture(repositoryRoot)));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
