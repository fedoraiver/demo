import { main } from './src/maintenance-cli.mjs';

main().catch(error => { console.error(error.message); process.exitCode = 1; });
