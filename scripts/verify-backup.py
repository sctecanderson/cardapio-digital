"""Confere um ZIP Elozi sem extrair nem alterar dados. Python 3.9+.
Uso: python scripts/verify-backup.py caminho/do/backup.zip
Não restaura dados e não comprova autenticidade criptográfica do emissor.
"""
import hashlib
import json
from pathlib import PurePosixPath
import re
import sys
import zipfile

MAX_FILE = 32 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024
UUID = re.compile(r'^[0-9a-fA-F-]{36}$')

def verify(path):
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        names = [entry.filename for entry in infos]
        if len(set(names)) != len(names):
            raise ValueError('Caminhos duplicados no ZIP.')
        if sum(entry.file_size for entry in infos) > MAX_TOTAL:
            raise ValueError('ZIP acima de 128 MiB descompactado.')
        for entry in infos:
            parts = PurePosixPath(entry.filename).parts
            if entry.file_size > MAX_FILE or entry.is_dir() or not parts or '\\' in entry.filename or entry.filename.startswith('/') or '..' in parts:
                raise ValueError('Caminho ou tamanho de arquivo inválido.')
        manifests = [name for name in names if name.endswith('/manifest.json')]
        if len(manifests) != 1:
            raise ValueError('O ZIP deve conter exatamente um manifesto.')
        manifest = json.loads(archive.read(manifests[0]))
        backup_id = manifest.get('backupId', '')
        if not UUID.fullmatch(backup_id) or manifests[0] != f'{backup_id}/manifest.json':
            raise ValueError('Identificador da cópia inválido.')
        if manifest.get('format') != 'elozi-restaurant-backup' or manifest.get('version') != 1:
            raise ValueError('Formato de backup não suportado.')
        if manifest.get('snapshotPath') != f'{backup_id}/snapshot.json':
            raise ValueError('Caminho do snapshot inválido.')
        expected = {manifests[0], manifest['snapshotPath']}
        snapshot_bytes = archive.read(manifest['snapshotPath'])
        if hashlib.sha256(snapshot_bytes).hexdigest() != manifest.get('snapshotSha256'):
            raise ValueError('Checksum do snapshot divergiu.')
        snapshot = json.loads(snapshot_bytes)
        if snapshot.get('restaurantId') != manifest.get('restaurantId'):
            raise ValueError('Restaurantes diferentes no snapshot e no manifesto.')
        if not isinstance(manifest.get('media'), list):
            raise ValueError('Lista de mídias inválida.')
        for media in manifest['media']:
            file_id = media.get('id', '')
            target = media.get('path', '')
            if not UUID.fullmatch(file_id) or target != f'{backup_id}/media/{file_id}' or target in expected:
                raise ValueError('Referência de mídia inválida ou duplicada.')
            expected.add(target)
            content = archive.read(target)
            if len(content) != media.get('bytes') or hashlib.sha256(content).hexdigest() != media.get('sha256'):
                raise ValueError(f'Mídia corrompida: {file_id}')
        if set(names) != expected:
            raise ValueError('Há arquivos ausentes ou não declarados no manifesto.')
        print(f"OK: {manifest['restaurant']['name']} — {len(manifest['media'])} mídias íntegras.")
        print('Dados e arquivos conferidos. Restauração ainda deve ser testada separadamente.')
        return manifest

if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Uso: python scripts/verify-backup.py backup.zip')
    try:
        verify(sys.argv[1])
    except (ValueError, KeyError, TypeError, zipfile.BadZipFile, OSError) as error:
        raise SystemExit(f'FALHOU: {error}')
