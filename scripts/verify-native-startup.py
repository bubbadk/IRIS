#!/usr/bin/env python3
"""Smoke-test the release binary with isolated app data; never modify the user's profile.

Run after pnpm build:binary in a graphical desktop session. Logs remain in a
new temporary directory printed on success. No provider calls or messages are sent.
"""
import os, pathlib, subprocess, tempfile, time, sqlite3, json, signal, sys
root=pathlib.Path(tempfile.mkdtemp(prefix='iris-native-verify-'))
env=os.environ.copy()
for key,part in [('XDG_DATA_HOME','data'),('XDG_CONFIG_HOME','config'),('XDG_CACHE_HOME','cache')]:
 p=root/part;p.mkdir();env[key]=str(p)
binary=str(pathlib.Path(sys.argv[1]).resolve()) if len(sys.argv)>1 else str(pathlib.Path(__file__).resolve().parents[1]/'apps/desktop/src-tauri/target/release/iris')
results=[]
fixture=json.dumps([{'id':'restart-fixture','content':'Isolated restart verification','createdAt':'2026-09-05T00:00:00Z','updatedAt':'2026-09-05T00:00:00Z','provenance':{'source':'user','actorId':'verification','actorName':'Verification','capturedAt':'2026-09-05T00:00:00Z'}}])
for iteration in range(2):
 with open(root/f'boot-{iteration}.log','w') as log:
  process=subprocess.Popen([binary],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try:
   deadline=time.monotonic()+15
   found=None
   while time.monotonic()<deadline:
    if process.poll() is not None: raise RuntimeError(f'Native process exited early: {process.returncode}')
    paths=list(root.rglob('repositories.sqlite3'))
    if paths:
     connection=sqlite3.connect(paths[0])
     try:
      migrated=connection.execute("select count(*) from migrations where name='localstorage-v1'").fetchone()[0]
      integrity=connection.execute('pragma integrity_check').fetchone()[0]
      if migrated==1 and integrity=='ok':found=paths[0];break
     except sqlite3.OperationalError:pass
     finally:connection.close()
    time.sleep(.25)
   if not found: raise RuntimeError('Native UI did not initialize the database through IPC within 15 seconds')
   time.sleep(2)
   if process.poll() is not None:raise RuntimeError('Native app stopped after initialization')
   if iteration == 1:
    with sqlite3.connect(found) as check:
     assert check.execute("select value from documents where key='iris.memory.records.v1'").fetchone()[0] == fixture, 'Saved memory did not survive restart'
   results.append({'boot':iteration+1,'alive':True,'databaseInitialized':True,'integrity':integrity})
  finally:
   os.killpg(process.pid,signal.SIGTERM)
   process.wait(timeout=5)
 if iteration == 0:
  with sqlite3.connect(found) as seed:
   seed.execute("insert into documents(key,value,revision) values('iris.memory.records.v1',?,1)",(fixture,))
 contents=(root/f'boot-{iteration}.log').read_text()
 if 'panicked at' in contents or 'PluginInitialization' in contents:raise RuntimeError('Native boot panic: see log')
print(json.dumps({'directory':str(root),'results':results,'savedMemorySurvivedRestart':True}))
