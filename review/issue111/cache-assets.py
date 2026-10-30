"""Cache only image URLs in supplied projections, using the system TLS trust store."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess

root = Path(os.environ['ISSUE111_ROOT'])
temp = Path(os.environ['ISSUE111_TEMP'])
web = root / 'apps/web'
assets = web / '__issue111_review_assets'
assets.mkdir()
urls = set()


def scan(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key in ('avatarUrl', 'logoUrl', 'opponentLogoUrl') and isinstance(item, str) and item.startswith('https://'):
                urls.add(item)
            scan(item)
    elif isinstance(value, list):
        for item in value:
            scan(item)


fixtures = [('1930', 'real-match-1930'), ('2000', 'rivalhub-match-2000-c400')]
projections = {fixture: json.loads((temp / f'issue111-{name}-projection.json').read_text()) for fixture, name in fixtures}
for projection in projections.values():
    scan(projection)


def fetch(url):
    path = temp / hashlib.sha256(url.encode()).hexdigest()
    result = subprocess.run(['curl', '--fail', '--silent', '--show-error', '--max-time', '15', '--output', str(path), url], capture_output=True, text=True)
    if result.returncode:
        return url, None
    content = path.read_bytes()
    if content.startswith(b'\x89PNG\r\n\x1a\n'):
        ext = '.png'
    elif content.startswith(b'\xff\xd8\xff'):
        ext = '.jpg'
    else:
        return url, None
    name = path.name + ext
    (assets / name).write_bytes(content)
    return url, '/__issue111_review_assets/' + name


with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
    mapped = dict(executor.map(fetch, sorted(urls)))


def rewrite(value):
    if isinstance(value, dict):
        return {key: rewrite(item) for key, item in value.items()}
    if isinstance(value, list):
        return [rewrite(item) for item in value]
    return mapped.get(value) or value if isinstance(value, str) else value


for fixture, projection in projections.items():
    (web / f'__issue111_review-{fixture}.json').write_text(json.dumps(rewrite(projection)))
failed = sum(value is None for value in mapped.values())
print(f'Referenced images: {len(mapped)}, fetched with verified TLS: {len(mapped) - failed}, unavailable: {failed}')
if failed:
    print('Unavailable image URLs remain unchanged; inspect unloaded counts in real/results.json.')
