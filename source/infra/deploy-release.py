#!/usr/bin/python3
"""Installed root-owned outside releases; invoked only by an SSH forced command.
Receives a bounded tar.gz on stdin. No arbitrary remote shell commands permitted.
"""
from contextlib import closing
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path('/opt/merchant-live-studio')
MAINTENANCE = ROOT / 'maintenance'
SERVICES = ['merchant-live-studio', 'merchant-live-agent']
DATABASES = [('live', Path('/var/lib/merchant-live-studio/studio.sqlite'), 'live-studio'),
             ('agent', Path('/var/lib/merchant-live-agent/agent.sqlite'), 'live-agent')]

def command(text):
    match = re.fullmatch(r'deploy ([0-9a-f]{40})', text)
    if not match:
        raise ValueError('Only deploy followed by a full commit SHA is accepted')
    return match[1]

def extract(archive, target):
    with tarfile.open(archive, 'r:gz') as bundle:
        entries = bundle.getmembers()
        if len(entries) > 20000 or sum(e.size for e in entries) > 256 * 1024 * 1024:
            raise ValueError('Artifact exceeds limit')
        for entry in entries:
            path = Path(entry.name)
            if path.is_absolute() or '..' in path.parts or not path.parts:
                raise ValueError('Unsafe artifact path')
            if path.parts[0] not in ('dist', 'package.json', 'package-lock.json', 'REVISION'):
                raise ValueError('Unexpected artifact member')
            if not entry.isfile() and not entry.isdir():
                raise ValueError('Links and special files are not permitted')
        bundle.extractall(target, filter='data')
    for name in ['REVISION', 'package.json', 'package-lock.json', 'dist/web/index.html', 'dist/server/server/index.js', 'dist/server/agent/index.js']:
        if not (target / name).is_file():
            raise ValueError('Artifact missing required files')

def file_sha256(path):
    digest=hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024*1024),b''):
            digest.update(block)
    return digest.hexdigest()

def run(*args, **kwargs):
    return subprocess.run(list(args), check=True, timeout=180, **kwargs)

def assert_idle():
    with closing(sqlite3.connect(DATABASES[0][1])) as db:
        if db.execute("SELECT 1 FROM rooms WHERE status='live' LIMIT 1").fetchone():
            raise RuntimeError('A livestream is active; retry this workflow after it ends')

def ready(release):
    for _ in range(40):
        try:
            with urllib.request.urlopen('http://127.0.0.1:18890/api/health', timeout=2) as r:
                assert json.load(r)['status'] == 'ok'
            with urllib.request.urlopen('http://127.0.0.1:18893/health', timeout=2) as r:
                assert json.load(r)['available'] is True
            with urllib.request.urlopen('http://127.0.0.1:18890/', timeout=2) as r:
                assert r.read() == (release/'dist/web/index.html').read_bytes()
            return
        except Exception:
            time.sleep(.5)
    raise RuntimeError('New release failed readiness or web artifact verification')

def point_to(release):
    link = ROOT/'current-next'
    link.unlink(missing_ok=True)
    link.symlink_to(release)
    link.replace(ROOT/'current')

def main():
    os.umask(0o077)
    revision = command(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    with open(ROOT/'deploy.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return deploy_locked(revision)

def deploy_locked(revision):
    # Consume stdin even on an idempotent rerun, avoiding a broken pipe in Actions.
    with tempfile.TemporaryDirectory(prefix='studio-deploy-') as scratch:
        archive = Path(scratch)/'artifact.tar.gz'
        size = 0
        with archive.open('wb') as out:
            while chunk := sys.stdin.buffer.read(1024*1024):
                size += len(chunk)
                if size > 64*1024*1024:
                    raise ValueError('Compressed artifact exceeds limit')
                out.write(chunk)
        if MAINTENANCE.exists():
            raise RuntimeError('Previous maintenance requires operator recovery before another deployment')
        old = (ROOT/'current').resolve(strict=True)
        if (old/'REVISION').read_text().strip() == revision:
            ready(old)
            print(json.dumps({'status':'already_current','revision':revision}))
            return
        assert_idle()
        release = ROOT/'releases'/revision
        if release.exists():
            raise RuntimeError('Release directory exists from another attempt; operator must inspect it')
        release.mkdir(mode=0o755)
        try:
            extract(archive, release)
            if (release/'REVISION').read_text().strip() != revision:
                raise ValueError('Artifact revision mismatch')
            env = os.environ.copy()
            env['PATH'] = str(ROOT/'runtime/node/bin')+':'+env.get('PATH','')
            run(str(ROOT/'runtime/node/bin/npm'), 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', cwd=release, env=env)
            # Preserve old asset URLs used by tabs that were open before the switch.
            for file in (old/'dist/web/assets').iterdir():
                dest=release/'dist/web/assets'/file.name
                if file.is_file() and not dest.exists():
                    shutil.copy2(file,dest)
            # Services run under different unprivileged accounts.
            for directory, _, files in os.walk(release):
                os.chmod(directory,0o755)
                for name in files:
                    path=Path(directory)/name
                    if not path.is_symlink():
                        path.chmod(0o755 if path.stat().st_mode & 0o111 else 0o644)
            backup = ROOT/'backups'/('auto-'+revision+'-'+str(int(time.time())))
            backup.mkdir(mode=0o700)
            # This marker is recognized only by the /studio/ nginx locations.
            MAINTENANCE.touch(mode=0o644)
            time.sleep(2)
            stopped=False
            backups_complete=False
            backup_hashes={}
            safe_to_resume=False
            try:
                stopped=True
                run('systemctl','stop',*SERVICES)
                assert_idle()  # Catch a start request racing with maintenance activation.
                for name,path,_ in DATABASES:
                    with closing(sqlite3.connect(path)) as source, closing(sqlite3.connect(backup/(name+'.sqlite'))) as dest:
                        source.backup(dest)
                        if dest.execute('PRAGMA integrity_check').fetchall()!=[('ok',)]:
                            raise RuntimeError('Database backup integrity check failed')
                    snapshot=backup/(name+'.sqlite')
                    snapshot.chmod(0o600)
                    backup_hashes[name]=file_sha256(snapshot)
                manifest=backup/'database-sha256.json'
                manifest.write_text(json.dumps(backup_hashes,sort_keys=True,indent=2))
                manifest.chmod(0o600)
                backups_complete=True
                point_to(release)
                run('systemctl','start','merchant-live-agent','merchant-live-studio')
                ready(release)
                # Record only non-secret deployment evidence.
                (ROOT/'automatic-deployment.json').write_text(json.dumps({
                    'revision':revision,'previousRevision':(old/'REVISION').read_text().strip(),
                    'artifactSha256':file_sha256(archive),
                    'backup':str(backup),'deployedAt':int(time.time())},indent=2))
                safe_to_resume=True
            except Exception:
                if stopped:
                    run('systemctl','stop',*SERVICES)
                    point_to(old)
                    if backups_complete:
                        # Validate every snapshot before restoring any database.
                        for name,_,_ in DATABASES:
                            if file_sha256(backup/(name+'.sqlite'))!=backup_hashes[name]:
                                raise RuntimeError('Database backup changed; manual recovery required')
                        for name,path,owner in DATABASES:
                            for suffix in ('-wal','-shm'):
                                Path(str(path)+suffix).unlink(missing_ok=True)
                            shutil.copy2(backup/(name+'.sqlite'),path)
                            if file_sha256(path)!=backup_hashes[name]:
                                raise RuntimeError('Database restore verification failed')
                            shutil.chown(path,owner,owner)
                            path.chmod(0o600)
                    run('systemctl','start','merchant-live-agent','merchant-live-studio')
                    ready(old)
                    safe_to_resume=True
                raise
            finally:
                # Only a completed deployment or completed rollback may reopen traffic.
                if safe_to_resume:
                    MAINTENANCE.unlink(missing_ok=True)
        except Exception:
            if (ROOT/'current').resolve()!=release:
                shutil.rmtree(release)
            raise
        print(json.dumps({'status':'deployed','revision':revision,'backup':str(backup)}))

if __name__=='__main__':
    try:
        main()
    except Exception as error:
        print('Deployment failed: '+str(error), file=sys.stderr)
        sys.exit(1)
