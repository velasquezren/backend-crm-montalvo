from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
import pathlib,gzip,urllib.parse
ROOT=pathlib.Path('/Users/macmini2024/Documents/CARPETA RENE/CRM/frontend-crm-montalvo/dist/montalvo-crm-frontend/browser')
class Handler(SimpleHTTPRequestHandler):
 def do_GET(self):
  path=ROOT/urllib.parse.urlparse(self.path).path.lstrip('/')
  if not path.is_file(): path=ROOT/'index.html'
  data=path.read_bytes()
  self.send_response(200)
  self.send_header('Content-Type',self.guess_type(str(path)))
  if 'gzip' in self.headers.get('Accept-Encoding',''):
   data=gzip.compress(data); self.send_header('Content-Encoding','gzip')
  self.send_header('Content-Length',str(len(data)))
  self.send_header('Cache-Control','no-cache')
  self.end_headers(); self.wfile.write(data)
 def log_message(self,*args): pass
ThreadingHTTPServer(('127.0.0.1',4200),Handler).serve_forever()
