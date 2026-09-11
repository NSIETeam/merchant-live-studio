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
    def scenario(self, fail_new=False, active=False):
        from unittest.mock import patch
        import os, sqlite3, types
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()/'studio';root.mkdir();(root/'releases').mkdir();(root/'backups').mkdir()
            old=root/'releases'/'old';old.mkdir();(old/'REVISION').write_text('b'*40)
            (old/'dist/web/assets').mkdir(parents=True)
            (root/'current').symlink_to(old)
            database=Path(directory)/'live.sqlite'
            with connection(database) as db:
                db.execute('CREATE TABLE rooms(status TEXT)');db.execute('INSERT INTO rooms VALUES(?)',('live' if active else 'ended',))
            artifact=Path(directory)/'artifact';artifact.mkdir()
            names=['REVISION','package.json','package-lock.json','dist/web/index.html','dist/server/server/index.js','dist/server/agent/index.js']
            for name in names:
                dest=artifact/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text('a'*40 if name=='REVISION' else '{}')
            (artifact/'dist/web/assets').mkdir()
            archive=Path(directory)/'artifact.tgz'
            with tarfile.open(archive,'w:gz') as bundle:
                for name in ['REVISION','package.json','package-lock.json','dist']:bundle.add(artifact/name,arcname=name)
            calls=[]
            def fake_run(*args,**kwargs):calls.append(args)
            def health(release):
                if fail_new and release!=old:
                    with connection(database) as db:db.execute("UPDATE rooms SET status='migration-change'")
                    raise RuntimeError('simulated failed candidate')
            with archive.open('rb') as data,patch.object(deploy,'ROOT',root),patch.object(deploy,'MAINTENANCE',root/'maintenance'),patch.object(deploy,'DATABASES',[('live',database,'unused')]),patch.object(deploy,'run',fake_run),patch.object(deploy,'ready',health),patch.object(deploy.time,'sleep'),patch.object(deploy.shutil,'chown'),patch.object(deploy.sys,'stdin',types.SimpleNamespace(buffer=data)),patch.dict(os.environ,{'SSH_ORIGINAL_COMMAND':'deploy '+'a'*40}):
                if fail_new or active:
                    with self.assertRaises(RuntimeError):deploy.main()
                    self.assertEqual((root/'current').resolve(),old)
                else:
                    deploy.main();self.assertEqual((root/'current').resolve().name,'a'*40)
            self.assertFalse((root/'maintenance').exists())
            with connection(database) as db:self.assertEqual(db.execute('SELECT status FROM rooms').fetchone()[0],'live' if active else 'ended')
            if active:self.assertEqual(calls,[])
            elif fail_new:self.assertTrue(any(a[:2]==('systemctl','start') for a in calls))
    def test_success(self):self.scenario()
    def test_rollback_restores_database(self):self.scenario(fail_new=True)
    def test_active_stream_rejects_maintenance(self):self.scenario(active=True)
if __name__=='__main__':unittest.main()
