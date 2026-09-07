import os,pathlib,subprocess,json,sys,shutil
ROOT=pathlib.Path('/Users/macmini2024/Documents/CARPETA RENE/CRM')
BACK=ROOT/'backend-crm-montalvo'
TMP=pathlib.Path('/tmp/crm-etapa2-local')
TMP.mkdir(exist_ok=True)
env={k:v for k,v in os.environ.items() if k in ['PATH','TMPDIR','LANG','HOME']}
env.update(NODE_ENV='test',PORT='3001',DATABASE_URL='postgresql://crm_app@127.0.0.1:5433/crm_audit',JWT_SECRET='audit-local-synthetic-secret-not-production',CORS_ORIGINS='http://localhost:4200',DOTENV_CONFIG_PATH='/dev/null')
def run(args):
 subprocess.run(args,cwd=TMP,env=env,check=True)
if sys.argv[1]=='setup':
 if not (TMP/'data/PG_VERSION').exists():
  run(['/opt/homebrew/bin/initdb','-D',str(TMP/'data'),'-U','crm_app','--auth=trust','-E','UTF8','--no-locale'])
 run(['/opt/homebrew/bin/pg_ctl','-D',str(TMP/'data'),'-l',str(TMP/'postgres.log'),'-o',f'-p 5433 -h 127.0.0.1 -k {TMP}','-w','start'])
 run(['/opt/homebrew/bin/createdb','-h','127.0.0.1','-p','5433','-U','crm_app','crm_audit'])
 run(['node',str(BACK/'node_modules/prisma/build/index.js'),'migrate','deploy','--config',str(BACK/'prisma.config.ts')])
elif sys.argv[1]=='serve':
 os.chdir(TMP)
 os.execve(shutil.which('node'),['node',str(BACK/'dist/main.js')],env)
