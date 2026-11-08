import fs from 'node:fs';
import path from 'node:path';

// 编译器与缓存共用实际浏览器选择，自动发现不能绕过工具身份校验。
export function architectureBrowserPath({ environment = process.env, platform = process.platform, required = true } = {}) {
  if (environment.MERMAID_CHROMIUM_PATH) {
    if (!fs.existsSync(environment.MERMAID_CHROMIUM_PATH)) throw new Error('MERMAID_CHROMIUM_PATH does not exist');
    return environment.MERMAID_CHROMIUM_PATH;
  }
  const candidates = platform === 'win32'
    ? [environment.ProgramFiles, environment['ProgramFiles(x86)'], environment.LOCALAPPDATA].filter(Boolean)
      .flatMap(base => [path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe')])
    : platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found && required) throw new Error('Mermaid needs Chromium; set MERMAID_CHROMIUM_PATH to Chrome/Edge/Chromium');
  return found || null;
}
