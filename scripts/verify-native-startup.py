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
document_fixture=json.dumps([{'version':1,'id':'document-restart-fixture','title':'Isolated document verification','format':'text','revisions':[{'id':'revision-1','number':1,'content':'Retained document revision','createdAt':'2026-09-08T00:00:00Z','author':{'kind':'user','id':'verification','name':'Verification'}}]}])
knowledge_fixture=json.dumps([{'version':1,'id':'knowledge-restart-fixture','revision':2,'scope':{'kind':'global'},'kind':'preference','topic':'Verification preference','content':'Retained approved knowledge','createdAt':'2026-09-08T00:00:00Z','status':'active','reviewedAt':'2026-09-08T00:01:00Z','provenance':{'source':'user','actorId':'verification','actorName':'Verification','capturedAt':'2026-09-08T00:00:00Z'}}])
queue_control_fixture=json.dumps({'version':1,'paused':True})
queue_job_fixture=json.dumps([{'version':1,'queueVersion':1,'id':'queued-restart-fixture','scheduleId':'isolated-absent-schedule','agentId':'isolated-absent-agent','prompt':'Isolated paused queue verification. Never execute this fixture.','status':'queued','scheduledFor':'2026-09-09T00:00:00Z','createdAt':'2026-09-09T00:00:00Z','updatedAt':'2026-09-09T00:00:00Z'}])
review_at = '2026-09-10T10:00:00.000Z'
review_check = {'id': 'check-restart', 'target': {'kind': 'document', 'title': 'Isolated document verification'}, 'assertion': 'nonempty'}
review_report = {
 'runtimeTurnId': 'review-turn', 'checkedAt': review_at,
 'results': [{'checkId': 'check-restart', 'status': 'passed', 'message': 'Non-empty text confirmed.',
              'evidence': 'Document document-restart-fixture, revision 1 (revision-1).'}],
}
review_run_fixture = json.dumps([{
 'version': 1, 'id': 'review-restart', 'projectId': 'review-project', 'taskId': 'review-task',
 'agentId': 'isolated-absent-agent', 'agentName': 'Isolated review fixture', 'status': 'completed',
 'createdAt': review_at, 'updatedAt': review_at, 'startedAt': review_at, 'returnedAt': review_at,
 'completedAt': review_at, 'runtimeTurnId': 'review-turn', 'output': 'Offline persistence fixture; no model was used.',
 'resultChecks': [review_check], 'checkReports': [review_report],
 'verification': {'method': 'human-review', 'reviewedAt': review_at, 'note': 'Isolated acceptance receipt fixture.', 'checkReport': review_report},
}])
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
   assert list(root.rglob('schedule-owner.lock')), 'The native schedule owner was not initialized'
   if iteration == 1:
    with sqlite3.connect(found) as check:
     assert check.execute("select value from documents where key='iris.memory.records.v1'").fetchone()[0] == fixture, 'Saved memory did not survive restart'
     assert check.execute("select value from documents where key='iris.documents.records.v1'").fetchone()[0] == document_fixture, 'Saved document did not survive restart'
     assert check.execute("select value from documents where key='iris.knowledge.records.v1'").fetchone()[0] == knowledge_fixture, 'Saved knowledge did not survive restart'
     assert check.execute("select value from documents where key='iris.schedules.queue-control.v1'").fetchone()[0] == queue_control_fixture, 'Queue pause did not survive restart'
     assert check.execute("select value from documents where key='iris.schedules.runs.v1'").fetchone()[0] == queue_job_fixture, 'The paused queued job changed during restart'
     assert check.execute("select value from documents where key='iris.projects.task-runs.v1'").fetchone()[0] == review_run_fixture, 'The acceptance check receipt changed during restart'
   results.append({'boot':iteration+1,'alive':True,'databaseInitialized':True,'integrity':integrity})
  finally:
   os.killpg(process.pid,signal.SIGTERM)
   process.wait(timeout=5)
 if iteration == 0:
  with sqlite3.connect(found) as seed:
   seed.execute("insert into documents(key,value,revision) values('iris.memory.records.v1',?,1)",(fixture,))
   seed.execute("insert into documents(key,value,revision) values('iris.documents.records.v1',?,1)",(document_fixture,))
   seed.execute("insert into documents(key,value,revision) values('iris.knowledge.records.v1',?,1)",(knowledge_fixture,))
   seed.execute("insert into documents(key,value,revision) values('iris.schedules.queue-control.v1',?,1)",(queue_control_fixture,))
   seed.execute("insert into documents(key,value,revision) values('iris.schedules.runs.v1',?,1)",(queue_job_fixture,))
   seed.execute("insert into documents(key,value,revision) values('iris.projects.task-runs.v1',?,1)",(review_run_fixture,))
 contents=(root/f'boot-{iteration}.log').read_text()
 if 'panicked at' in contents or 'PluginInitialization' in contents:raise RuntimeError('Native boot panic: see log')
print(json.dumps({'directory':str(root),'results':results,'savedMemorySurvivedRestart':True,'savedDocumentSurvivedRestart':True,'savedKnowledgeSurvivedRestart':True,'scheduleOwnerInitialized':True,'pausedQueueSurvivedRestart':True,'acceptanceReceiptSurvivedRestart':True}))
