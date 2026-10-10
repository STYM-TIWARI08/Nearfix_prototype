const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

// Lightweight .env loader so the project works without an extra dependency.
const envPath = path.join(__dirname, '.env');
try {
  if (require('fs').existsSync(envPath)) {
    for (const line of require('fs').readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
} catch {}

const startPort = Number(process.env.PORT || 5050);
const backend = spawn(process.execPath, [path.join(__dirname, 'backend', 'server.js')], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(startPort) }
});

let opened = false;
let outputBuffer = '';
function openBrowser(url) {
  if (opened) return;
  opened = true;
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  console.log(`\nNearFix is ready: ${url}`);
}
function check(port, tries = 0) {
  if (tries > 15 || opened) return;
  const req = http.get({host:'127.0.0.1', port, path:'/api/health', timeout:300}, res => {
    let body='';
    res.setEncoding('utf8');
    res.on('data',chunk=>body+=chunk);
    res.on('end',()=>{
      let health={};
      try{health=JSON.parse(body);}catch{}
      // When a key is configured, skip stale demo servers that still answer on an older port.
      const hasAgent=health.mode==='tinyfish-agent';
      if(res.statusCode===200&&(hasAgent||!process.env.TINYFISH_API_KEY)) return openBrowser(`http://localhost:${port}`);
      setTimeout(() => check(port + 1, tries + 1), 150);
    });
  });
  req.on('error', () => setTimeout(() => check(port + 1, tries + 1), 150));
  req.on('timeout', () => { req.destroy(); setTimeout(() => check(port + 1, tries + 1), 150); });
}
backend.stdout.on('data', chunk => {
  const output=String(chunk);
  process.stdout.write(output);
  outputBuffer+=output;
  // The backend may move to the next free port when an older copy is still running.
  // Open the port this child actually claimed instead of whichever old server answers first.
  const match=outputBuffer.match(/NearFix API \+ web running at http:\/\/0\.0\.0\.0:(\d+)/);
  if(match) check(Number(match[1]));
});
backend.stderr.on('data', chunk => process.stderr.write(chunk));
backend.on('exit', code => process.exit(code ?? 0));
process.on('SIGINT', () => backend.kill('SIGINT'));
process.on('SIGTERM', () => backend.kill('SIGTERM'));
