#!/usr/bin/env python3
"""One bounded PLATEAU job. JSON-lines stdout; no credentials or arbitrary URLs."""
import datetime
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import urllib.request
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / '.local/city-build/sources'
FILE_LIMIT = 32 * 1024 * 1024
TOTAL_LIMIT = 64 * 1024 * 1024
OUTPUT_LIMIT = 4 * 1024 * 1024
HOSTS = {'api.plateauview.mlit.go.jp', 'assets.cms.plateau.reearth.io'}


def emit(kind, **data):
    print(json.dumps({'event': kind, **data}, ensure_ascii=False, separators=(',', ':')), flush=True)


def check_url(url):
    p = urlsplit(url)
    if p.scheme != 'https' or p.hostname not in HOSTS or p.port not in (None, 443) or p.username or p.password or p.fragment:
        raise ValueError('SOURCE_URL_REJECTED')
    if p.hostname == 'assets.cms.plateau.reearth.io' and (p.query or not p.path.startswith('/assets/')):
        raise ValueError('SOURCE_URL_REJECTED')
    return url


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url, limit, cache=True):
    check_url(url)
    CACHE.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(url.encode()).hexdigest()
    path = CACHE / key
    if cache and path.exists() and time.time() - path.stat().st_mtime < 86400 and path.stat().st_size <= limit:
        return path.read_bytes(), True
    # Bound disk use; unfinished responses remain in memory and never become hits.
    files = sorted(CACHE.glob('*'), key=lambda f: f.stat().st_mtime)
    size = sum(f.stat().st_size for f in files)
    for f in files:
        if size <= 256 * 1024 * 1024 - limit: break
        size -= f.stat().st_size
        f.unlink(missing_ok=True)
    request = urllib.request.Request(url, headers={'User-Agent': 'dopagaki-town-city-demo/1.0', 'Accept-Encoding': 'identity'})
    opener = urllib.request.build_opener(SafeRedirect())
    started = time.monotonic()
    with opener.open(request, timeout=25) as response:
        if int(response.headers.get('Content-Length', '0')) > limit: raise ValueError('SOURCE_TOO_LARGE')
        chunks, size = [], 0
        while chunk := response.read(65536):
            size += len(chunk)
            if size > limit: raise ValueError('SOURCE_TOO_LARGE')
            if time.monotonic() - started > 60: raise ValueError('SOURCE_TIMEOUT')
            chunks.append(chunk)
    data = b''.join(chunks)
    if cache:
        temporary = path.with_suffix(f'.{os.getpid()}.partial')
        temporary.write_bytes(data)
        os.replace(temporary, path)
    return data, False


def discover(latitude, longitude):
    if not (math.isfinite(latitude) and math.isfinite(longitude) and 20 <= latitude <= 46 and 122 <= longitude <= 154):
        raise ValueError('AREA_OUTSIDE_JAPAN')
    # A 5m query margin avoids losing intersecting features at the local-frame edge.
    dy = 130 / 110574
    dx = 130 / (111320 * math.cos(math.radians(latitude)))
    bounds = ','.join(f'{v:.7f}' for v in [longitude-dx, latitude-dy, longitude+dx, latitude+dy])
    raw, _ = download(f'https://api.plateauview.mlit.go.jp/datacatalog/citygml/r:{bounds}?types=bldg,tran', 4*1024*1024, False)
    cities = json.loads(raw).get('cities', [])
    latest = {}
    for city in cities:
        code = city['cityCode']
        if code not in latest or city['year'] > latest[code]['year']: latest[code] = city
    if not latest: raise ValueError('NO_DATA')
    if len(latest) != 1: raise ValueError('MULTI_CITY_UNSUPPORTED')
    city = next(iter(latest.values()))
    files = [{**f, 'kind': kind} for kind in ['bldg', 'tran'] for f in city['files'].get(kind, [])]
    if not any(f['kind'] == 'bldg' for f in files) or not any(f['kind'] == 'tran' for f in files): raise ValueError('MISSING_ROADS_OR_BUILDINGS')
    if len(files) > 8 or any(f['fileSize'] > FILE_LIMIT for f in files) or sum(f['fileSize'] for f in files) > TOTAL_LIMIT:
        raise ValueError('SOURCE_TOO_LARGE')
    for f in files: check_url(f['url'])
    urls = [u for u in city.get('metadataZipUrls', []) if urlsplit(u).path.endswith('_metadata.zip')]
    if len(urls) != 1: raise ValueError('LICENSE_REVIEW_REQUIRED')
    data, _ = download(urls[0], 8*1024*1024)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        pattern = rf'(^|/)udx_{re.escape(str(city["cityCode"]))}_city_{city["year"]}_op\.xml$'
        names = [n for n in archive.namelist() if re.search(pattern, n)]
        if len(names) != 1 or archive.getinfo(names[0]).file_size > 2*1024*1024: raise ValueError('LICENSE_REVIEW_REQUIRED')
        xml = archive.read(names[0])
        if b'<!DOCTYPE' in xml.upper() or b'<!ENTITY' in xml.upper() or b'\x00' in xml: raise ValueError('METADATA_REJECTED')
        root = ET.fromstring(xml)
        conditions = [''.join(n.itertext()).strip() for n in root.iter() if n.tag.endswith('}useLimitation')]
        # Do not generalize one city's license to other datasets.
        if not conditions or any(c != 'Licensed under CC BY 4.0' for c in conditions): raise ValueError('LICENSE_REVIEW_REQUIRED')
        if any(n.tag.split('}')[-1] in ['accessConstraints','useConstraints','otherConstraints'] for n in root.iter()):
            raise ValueError('LICENSE_REVIEW_REQUIRED')
    return {'latitude': latitude, 'longitude': longitude, 'city': city['cityName'], 'year': city['year'],
            'files': [{'url': f['url'], 'bytes': f['fileSize'], 'kind': f['kind']} for f in files],
            'metadataUrl': urls[0], 'metadataSha256': hashlib.sha256(data).hexdigest(), 'license': 'CC BY 4.0'}


def triangle_height(x, z, a, b, c):
    denominator = (b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2])
    if abs(denominator) < 1e-7: return None
    u = ((b[2]-c[2])*(x-c[0])+(c[0]-b[0])*(z-c[2])) / denominator
    v = ((c[2]-a[2])*(x-c[0])+(a[0]-c[0])*(z-c[2])) / denominator
    if min(u, v, 1-u-v) < -1e-7: return None
    return u*a[1]+v*b[1]+(1-u-v)*c[1]


def choose_spawn(meshes, half=125):
    roads, buildings, candidates = [], [], []
    for mesh in meshes:
        points = [mesh['positions'][i:i+3] for i in range(0, len(mesh['positions']), 3)]
        for i in range(0, len(mesh['indices']), 3):
            triangle = [points[j] for j in mesh['indices'][i:i+3]]
            if mesh['kind'] == 'building': buildings.append(triangle)
            else:
                roads.append(triangle)
                candidates.append([sum(p[k] for p in triangle)/3 for k in range(3)])
    def road_height(x, z):
        values = [y for t in roads if (y := triangle_height(x, z, *t)) is not None]
        return max(values) if values else None
    for x, y, z in sorted(candidates, key=lambda p: p[0]**2+p[2]**2):
        if max(abs(x), abs(z)) > half-2: continue
        clear = True
        for dx, dz in [(0,0),(.6,0),(-.6,0),(0,.6),(0,-.6),(.45,.45),(-.45,.45),(.45,-.45),(-.45,-.45)]:
            ground = road_height(x+dx, z+dz)
            if ground is None or abs(ground-y) > .25 or any((h := triangle_height(x+dx, z+dz, *t)) is not None and h >= y-.1 for t in buildings):
                clear = False; break
        if clear: return [round(x,4), round(y+.95,4), round(z,4)]
    raise ValueError('NO_SAFE_SPAWN')


def build(catalog, lod):
    spec = importlib.util.spec_from_file_location('city_convert', ROOT / 'scripts/convert-citygml.py')
    converter = importlib.util.module_from_spec(spec); spec.loader.exec_module(converter)
    started, paths, received, hits = time.monotonic(), [], 0, 0
    for i, source in enumerate(catalog['files']):
        emit('progress', phase='download', completed=i, total=len(catalog['files']), bytes=received)
        data, hit = download(source['url'], FILE_LIMIT)
        received += len(data)
        if received > TOTAL_LIMIT: raise ValueError('SOURCE_TOO_LARGE')
        paths.append(CACHE / hashlib.sha256(source['url'].encode()).hexdigest()); hits += int(hit)
    emit('progress', phase='convert', bytes=received)
    metadata = {'title': f'{catalog["city"]} 3D都市モデル {catalog["year"]}年度',
                'provider': f'{catalog["city"]} / Project PLATEAU', 'datasetYear': catalog['year'], 'surveyYear': None,
                'url': catalog['metadataUrl'], 'license': 'CC BY 4.0', 'licenseUrl': 'https://creativecommons.org/licenses/by/4.0/',
                'attribution': f'{catalog["city"]} 3D都市モデル（{catalog["year"]}年度）を加工して作成',
                'retrievedAt': datetime.date.today().isoformat()}
    manifest = converter.convert(paths, metadata, (catalog['latitude'], catalog['longitude'], 0), 125, (0,1,0),
                                 max_lod=lod, title=f'{catalog["city"]} / 選択した250m街区')
    # Record the exact source URLs and content hashes, plus the license evidence.
    by_hash = {hashlib.sha256(p.read_bytes()).hexdigest(): f['url'] for p, f in zip(paths, catalog['files'])}
    for source in manifest['sources']: source['url'] = by_hash[source['sha256']]
    manifest['sources'].append({**metadata, 'sha256': catalog['metadataSha256']})
    vertices = sum(len(m['positions'])//3 for m in manifest['meshes'])
    if vertices > (40000 if lod == 1 else 80000) or len(manifest['meshes']) > 600: raise ValueError('GEOMETRY_BUDGET')
    emit('progress', phase='validate', vertices=vertices)
    manifest['spawn'] = choose_spawn(manifest['meshes'])
    manifest['limitations'].extend(['地面は収録された道路面に限定します。地形DEM・歩道の補完・街路樹・看板は未取込です。',
                                    f'建物はLOD{lod}を上限に収録形状を使用します。AIによる建物形状の創作は行いません。'])
    payload = json.dumps(manifest, ensure_ascii=False, separators=(',', ':'))
    if len(payload.encode()) > OUTPUT_LIMIT: raise ValueError('GEOMETRY_BUDGET')
    return {'manifest': manifest, 'stats': {'sourceBytes': received, 'sourceCacheHits': hits, 'vertices': vertices,
            'meshes': len(manifest['meshes']), 'manifestBytes': len(payload.encode()), 'workerSeconds': round(time.monotonic()-started, 2)}}


if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.buffer.read(65537))
        result = discover(request['latitude'], request['longitude']) if request['action'] == 'discover' else build(request['catalog'], request['lod'])
        emit('result', value=result)
    except Exception as error:
        # Public errors never contain source XML, paths, credentials or provider bodies.
        code = str(error)
        if not re.fullmatch('[A-Z_]{3,60}', code):
            code = 'DEPENDENCIES_MISSING' if isinstance(error, ImportError) else 'SOURCE_OR_GEOMETRY_UNSUPPORTED' if isinstance(error, ValueError) else 'SOURCE_UNAVAILABLE'
        emit('error', code=code)
        sys.exit(1)
