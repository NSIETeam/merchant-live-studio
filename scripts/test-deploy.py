from contextlib import contextmanager, closing
import sqlite3
@contextmanager
def connection(path):
    with closing(sqlite3.connect(path)) as db:
        with db:
            yield db
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('deploy',Path(__file__).resolve().parents[1]/'infra/deploy-release.py')
deploy=importlib.util.module_from_spec(spec);spec.loader.exec_module(deploy)
class DeploymentTests(unittest.TestCase):
    def test_command(self):
        self.assertEqual(deploy.command('deploy '+'a'*40),'a'*40)
        for value in ['bash','deploy main','deploy '+'a'*40+'; id','deploy '+'A'*40]:
            with self.assertRaises(ValueError): deploy.command(value)
    def test_archive_rejection(self):
        for name,kind in [('../escape','file'),('/tmp/escape','file'),('dist/link','link'),('studio.env','file')]:
            with self.subTest(name=name),tempfile.TemporaryDirectory() as directory:
                archive=Path(directory)/'bad.tgz'
                with tarfile.open(archive,'w:gz') as bundle:
                    item=tarfile.TarInfo(name)
                    if kind=='link': item.type=tarfile.SYMTYPE;item.linkname='/etc/passwd'
                    bundle.addfile(item,io.BytesIO(b''))
                with self.assertRaises(ValueError):deploy.extract(archive,Path(directory)/'out')
    def test_missing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            archive=Path(directory)/'empty.tgz'
            with tarfile.open(archive,'w:gz'):pass
            with self.assertRaises(ValueError):deploy.extract(archive,Path(directory)/'out')


class TransactionTests(unittest.TestCase):
    def scenario(self, fail_new=False, active=False, fail_rollback=False, corrupt_backup=False, pending_recovery=False):
        from unittest.mock import patch
        import os, sqlite3, types
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()/'studio';root.mkdir();(root/'releases').mkdir();(root/'backups').mkdir()
            old=root/'releases'/'old';old.mkdir();(old/'REVISION').write_text('b'*40)
            (old/'dist/web/assets').mkdir(parents=True)
            # Represent a tab which has not yet loaded its old lazy module/CSS.
            old_assets = {'workbench-old.js': b'export const version = 1;',
                          'workbench-old.css': b'.card { color: #334155; }',
                          'shared.js': b'old shared contents'}
            for name, content in old_assets.items():
                (old/'dist/web/assets'/name).write_bytes(content)
            (root/'current').symlink_to(old)
            if pending_recovery:(root/'maintenance').touch()
            database=Path(directory)/'live.sqlite'
            with connection(database) as db:
                db.execute('CREATE TABLE rooms(status TEXT)');db.execute('INSERT INTO rooms VALUES(?)',('live' if active else 'ended',))
                db.execute('CREATE TABLE team_access(actor_id TEXT PRIMARY KEY,disabled INTEGER,version INTEGER)');db.execute("INSERT INTO team_access VALUES('member',1,7)")
            artifact=Path(directory)/'artifact';artifact.mkdir()
            names=['REVISION','package.json','package-lock.json','dist/web/index.html','dist/server/server/index.js','dist/server/agent/index.js']
            for name in names:
                dest=artifact/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text('a'*40 if name=='REVISION' else '{}')
            (artifact/'dist/web/assets').mkdir()
            new_assets = {'workbench-new.js': b'export const version = 2;',
                          'shared.js': b'new shared contents'}
            for name, content in new_assets.items():
                (artifact/'dist/web/assets'/name).write_bytes(content)
            archive=Path(directory)/'artifact.tgz'
            with tarfile.open(archive,'w:gz') as bundle:
                for name in ['REVISION','package.json','package-lock.json','dist']:bundle.add(artifact/name,arcname=name)
            calls=[]
            def fake_run(*args,**kwargs):calls.append(args)
            def health(release):
                if fail_new and release!=old:
                    with connection(database) as db:
                        db.execute("UPDATE rooms SET status='migration-change'")
                        db.execute("ALTER TABLE team_access ADD COLUMN role_override TEXT")
                        db.execute("UPDATE team_access SET disabled=0,version=8,role_override='editor'")
                    if corrupt_backup:
                        for snapshot in (root/'backups').glob('*/live.sqlite'):
                            snapshot.write_bytes(b'corrupted snapshot')
                    raise RuntimeError('simulated failed candidate')
                if fail_rollback and release==old:
                    raise RuntimeError('simulated rollback startup failure')
            with archive.open('rb') as data,patch.object(deploy,'ROOT',root),patch.object(deploy,'MAINTENANCE',root/'maintenance'),patch.object(deploy,'DATABASES',[('live',database,'unused')]),patch.object(deploy,'run',fake_run),patch.object(deploy,'ready',health),patch.object(deploy.time,'sleep'),patch.object(deploy.shutil,'chown'),patch.object(deploy.sys,'stdin',types.SimpleNamespace(buffer=data)),patch.dict(os.environ,{'SSH_ORIGINAL_COMMAND':'deploy '+'a'*40}):
                if fail_new or active or pending_recovery:
                    with self.assertRaises(RuntimeError):deploy.main()
                    self.assertEqual((root/'current').resolve(),old)
                else:
                    deploy.main();self.assertEqual((root/'current').resolve().name,'a'*40)
            current_assets = (root/'current').resolve()/'dist/web/assets'
            for name in ['workbench-old.js', 'workbench-old.css']:
                self.assertEqual((current_assets/name).read_bytes(), old_assets[name])
            if not (fail_new or active or pending_recovery):
                for name, content in new_assets.items():
                    self.assertEqual((current_assets/name).read_bytes(), content)
            else:
                self.assertEqual((current_assets/'shared.js').read_bytes(), old_assets['shared.js'])
            self.assertEqual((root/'maintenance').exists(),fail_rollback or corrupt_backup or pending_recovery)
            with connection(database) as db:
                self.assertEqual(db.execute('SELECT status FROM rooms').fetchone()[0],'migration-change' if corrupt_backup else 'live' if active else 'ended')
                if not corrupt_backup:
                    self.assertEqual(db.execute('SELECT disabled,version FROM team_access').fetchone(),(1,7))
                    self.assertNotIn('role_override',[row[1] for row in db.execute('PRAGMA table_info(team_access)')])
            if corrupt_backup:
                self.assertEqual(calls[-1][:2],('systemctl','stop'))
            if active or pending_recovery:self.assertEqual(calls,[])
            elif fail_new and not corrupt_backup:self.assertTrue(any(a[:2]==('systemctl','start') for a in calls))
    def test_success(self):self.scenario()
    def test_rollback_restores_database(self):self.scenario(fail_new=True)
    def test_active_stream_rejects_maintenance(self):self.scenario(active=True)
    def test_failed_rollback_keeps_maintenance(self):self.scenario(fail_new=True,fail_rollback=True)
    def test_corrupt_backup_keeps_services_stopped(self):self.scenario(fail_new=True,corrupt_backup=True)
    def test_pending_recovery_blocks_next_deployment(self):self.scenario(pending_recovery=True)
if __name__=='__main__':unittest.main()
