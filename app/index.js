const http = require('http');

const VERSION = process.env.APP_VERSION || 'dev';

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<h1>Prometheus practice app</h1><p>Version: ${VERSION}</p><p>Host: ${require('os').hostname()}</p>`);
});

server.listen(80, () => console.log('Listening on port 80'));
