"""Repõe somente mídias locais de um ZIP Elozi verificado. Python 3.9+.
Não acessa Supabase, não sobrescreve arquivos diferentes e não altera o banco.
Primeiro simule: python scripts/recover-local-media.py backup.zip --public-dir public
Depois aplique: repita acrescentando --apply.
"""
import argparse
import hashlib
import importlib.util
import os
from pathlib import Path, PurePosixPath
import re
import tempfile
import zipfile

spec = importlib.util.spec_from_file_location('verify_backup', Path(__file__).with_name('verify-backup.py'))
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


def reject_symlinks(path):
    for node in (path, *path.parents):
        if node.is_symlink():
            raise ValueError(f'Não é permitido gravar através de links simbólicos: {node}')


def recover(backup_path, public_dir, apply=False):
    manifest = verifier.verify(backup_path)
    root = Path(os.path.abspath(public_dir))
    reject_symlinks(root)
    plan = []
    seen = set()
    with zipfile.ZipFile(backup_path) as archive:
        for media in manifest['media']:
            if media.get('sourceKind') != 'local':
                continue
            source = media.get('sourceUrl', '')
            if not re.fullmatch(r'/(images|videos)/[A-Za-z0-9_./-]+', source):
                raise ValueError('Caminho local inválido no manifesto.')
            parts = PurePosixPath(source[1:]).parts
            if any(part in ('.', '..') for part in source[1:].split('/')):
                raise ValueError('Caminho com travessia não permitido.')
            relative = Path(*parts)
            destination = root / relative
            if str(destination).casefold() in seen:
                raise ValueError('Destino local duplicado no manifesto.')
            seen.add(str(destination).casefold())
            reject_symlinks(destination)
            content = archive.read(media['path'])
            if destination.exists():
                if not destination.is_file() or hashlib.sha256(destination.read_bytes()).hexdigest() != media['sha256']:
                    raise ValueError(f'Já existe um arquivo diferente: {destination}. Nada foi substituído.')
                print(f'Já íntegro: {relative}')
                continue
            plan.append((destination, content))
        print(f'{len(plan)} arquivos locais para repor. Nenhum arquivo diferente será sobrescrito.')
        if not apply:
            print('Simulação concluída. Use --apply para gravar os arquivos ausentes.')
            return
        for destination, content in plan:
            reject_symlinks(destination)
            destination.parent.mkdir(parents=True, exist_ok=True)
            reject_symlinks(destination)
            # Hard link publica um arquivo completo e falha se o destino surgiu
            # desde a simulação. Não usa os.replace, que sobrescreveria dados.
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as handle:
                    temporary = Path(handle.name)
                    handle.write(content)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.link(temporary, destination)
                print(f'Reposto: {destination.relative_to(root)}')
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
    print('Mídias locais recuperadas. Publique a pasta public e valide pelo painel.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backup')
    parser.add_argument('--public-dir', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        recover(args.backup, args.public_dir, args.apply)
    except (ValueError, KeyError, TypeError, OSError, zipfile.BadZipFile) as error:
        raise SystemExit(f'FALHOU: {error}')
