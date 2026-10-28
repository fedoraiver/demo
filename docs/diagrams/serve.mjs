import { runServeCli } from './src/serve.mjs';

runServeCli().catch(error => { console.error(error.message); process.exitCode = 1; });
