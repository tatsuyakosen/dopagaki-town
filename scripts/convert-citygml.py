#!/usr/bin/env python3
"""Bounded CityGML 2.0 -> local mesh manifest. No network, no credentials.

Only explicit EPSG:6697 / 3D coordinates and simple planar polygon rings are
supported. Holes, XLinks and unsupported geometry fail closed in selected
input files; textures are not imported. Never infer missing geometry.
"""
import argparse
import datetime
import hashlib
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET
from urllib.parse import urlsplit

NS = {"gml": "http://www.opengis.net/gml", "core": "http://www.opengis.net/citygml/2.0"}
MAX_SOURCE = 128 * 1024 * 1024
MAX_OUTPUT = 20 * 1024 * 1024


def ecef(latitude, longitude, height):
    lat, lon = math.radians(latitude), math.radians(longitude)
    a, flattening = 6378137.0, 1 / 298.257222101  # GRS80 / JGD2011
    e2 = flattening * (2 - flattening)
    n = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
    return ((n + height) * math.cos(lat) * math.cos(lon),
            (n + height) * math.cos(lat) * math.sin(lon),
            (n * (1 - e2) + height) * math.sin(lat))


def local_point(point, origin):
    lat, lon, height = point
    if not (-90 <= lat <= 90 and -180 <= lon <= 180 and all(map(math.isfinite, point))):
        raise ValueError("Invalid latitude/longitude/height or axis order")
    base = ecef(*origin)
    dx, dy, dz = [v - b for v, b in zip(ecef(lat, lon, height), base)]
    p, l = math.radians(origin[0]), math.radians(origin[1])
    east = -math.sin(l) * dx + math.cos(l) * dy
    north = -math.sin(p) * math.cos(l) * dx - math.sin(p) * math.sin(l) * dy + math.cos(p) * dz
    up = math.cos(p) * math.cos(l) * dx + math.cos(p) * math.sin(l) * dy + math.sin(p) * dz
    return [round(east, 4), round(up, 4), round(-north, 4)]


def cross(a, b, c):
    return (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0])


def triangulate(points):
    """Ear clipping on the dominant plane; never fan-fill concave streets."""
    normal = [0.0, 0.0, 0.0]
    for a, b in zip(points, points[1:] + points[:1]):
        normal[0] += (a[1]-b[1])*(a[2]+b[2])
        normal[1] += (a[2]-b[2])*(a[0]+b[0])
        normal[2] += (a[0]-b[0])*(a[1]+b[1])
    length = math.sqrt(sum(v*v for v in normal))
    if length < 1e-6:
        raise ValueError("Degenerate polygon")
    unit = [v/length for v in normal]
    if any(abs(sum((v-b)*n for v, b, n in zip(p, points[0], unit))) > .05 for p in points):
        raise ValueError("Non-planar polygon exceeds 5cm tolerance")
    omit = max(range(3), key=lambda i: abs(normal[i]))
    plane = [[p[i] for i in range(3) if i != omit] for p in points]
    signed = sum(a[0]*b[1]-b[0]*a[1] for a, b in zip(plane, plane[1:]+plane[:1]))
    orientation = 1 if signed > 0 else -1
    remaining, result = list(range(len(points))), []
    # Collinear vertices may be removed from the triangulation, not moved.
    while len(remaining) > 3:
        found = False
        for j, b in enumerate(remaining):
            a, c = remaining[j-1], remaining[(j+1) % len(remaining)]
            area = cross(plane[a], plane[b], plane[c]) * orientation
            if abs(area) < 1e-8:
                remaining.pop(j); found = True; break
            if area <= 0:
                continue
            def inside(p):
                return all(cross(plane[u], plane[v], plane[p])*orientation >= -1e-8 for u,v in [(a,b),(b,c),(c,a)])
            if any(inside(p) for p in remaining if p not in [a,b,c]):
                continue
            result.extend([a,b,c]);remaining.pop(j);found=True;break
        if not found:
            raise ValueError("Self-intersecting or unsupported polygon")
    if len(remaining) == 3:
        result.extend(remaining)
    return result


def ring_points(polygon, origin):
    if polygon.find("gml:interior", NS) is not None:
        raise ValueError("Polygon holes require a reviewed external triangulator")
    ring = polygon.find("gml:exterior/gml:LinearRing", NS)
    if ring is None:
        raise ValueError("Explicit exterior LinearRing required")
    poslist = ring.find("gml:posList", NS)
    if poslist is not None:
        if poslist.get("srsDimension", "3") != "3":
            raise ValueError("3D coordinates required")
        values = [float(v) for v in (poslist.text or "").split()]
    else:
        values = [float(v) for pos in ring.findall("gml:pos", NS) for v in (pos.text or "").split()]
    if len(values) < 12 or len(values) % 3:
        raise ValueError("Closed 3D ring required")
    points = [local_point(values[i:i+3], origin) for i in range(0, len(values), 3)]
    if points[0] != points[-1]:
        raise ValueError("Unclosed ring")
    points.pop()
    if len(points) > 2000:
        raise ValueError("Ring exceeds triangulation budget")
    return points


def public_url(value):
    url = urlsplit(value)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("Use public HTTPS URLs without signed queries/credentials")
    return value


def scan_source(path):
    if path.stat().st_size > MAX_SOURCE:
        raise ValueError("Source exceeds 128MiB: select smaller mesh files")
    digest, tail = hashlib.sha256(), b""
    with path.open("rb") as stream:
        while chunk := stream.read(65536):
            digest.update(chunk)
            if b"\x00" in chunk:
                raise ValueError("Only UTF-8 XML is supported; NUL/UTF-16 input is rejected")
            upper = (tail + chunk).upper()
            if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper:
                raise ValueError("DTD/entity declarations are forbidden")
            tail = upper[-16:]
    return digest.hexdigest()


def convert(paths, metadata, origin, half_size, spawn):
    required = {"title","provider","datasetYear","surveyYear","url","license","licenseUrl","attribution","retrievedAt"}
    if set(metadata) != required:
        raise ValueError("Source metadata fields must exactly match the documented schema")
    public_url(metadata["url"]);public_url(metadata["licenseUrl"])
    if any(not isinstance(metadata[key], str) or not metadata[key].strip() for key in ["title","provider","license","attribution"]):
        raise ValueError("Source attribution must be non-empty")
    datetime.date.fromisoformat(metadata["retrievedAt"])
    if not isinstance(metadata["datasetYear"], int) or not 2000 <= metadata["datasetYear"] <= 2100:
        raise ValueError("Dataset year required")
    if metadata["surveyYear"] is not None and (not isinstance(metadata["surveyYear"], int) or not 1900 <= metadata["surveyYear"] <= 2100):
        raise ValueError("Survey year must be a year or null (unknown)")
    if not all(math.isfinite(v) for v in [*origin,*spawn,half_size]) or not 20 <= half_size <= 500:
        raise ValueError("Invalid extent or origin")
    if not (34.69 <= origin[0] <= 34.72 and 135.48 <= origin[1] <= 135.515):
        raise ValueError("This profile is limited to the Umeda area")
    if any(any(word in metadata[key].lower() for word in ["todo", "replace", "記入", "未確認"]) for key in ["title","provider","license","attribution"]):
        raise ValueError("Replace template metadata only after source review")
    if abs(spawn[0]) >= half_size-1 or abs(spawn[2]) >= half_size-1:
        raise ValueError("Spawn must lie inside the playable block")
    meshes, sources, seen = [], [], set()
    for path in paths:
        digest = scan_source(path)
        if digest in seen:
            continue
        seen.add(digest)
        sources.append({**metadata, "sha256": digest})
        crs_checked = False
        for event, node in ET.iterparse(path, events=("start", "end")):
            if event == "start":
                srs = node.get("srsName")
                if srs:
                    if not srs.endswith(("/6697", ":6697")):
                        raise ValueError("Only explicitly declared EPSG:6697 is supported")
                    crs_checked = True
                continue
            if node.tag != "{" + NS["core"] + "}cityObjectMember":
                continue
            if not crs_checked:
                raise ValueError("Missing EPSG:6697 envelope")
            objects = list(node)
            if not objects:
                node.clear();continue
            obj = objects[0]
            kind_name = obj.tag.split("}")[-1]
            kind = {"Building":"building","Road":"road","ReliefFeature":"terrain"}.get(kind_name)
            if kind is None:
                node.clear();continue
            geometries = []
            preferred = ["lod2MultiSurface","lod2Solid","lod1Solid"] if kind == "building" else ["lod2MultiSurface","lod1MultiSurface","TriangulatedSurface","Tin"]
            for tag in preferred:
                geometries = [g for g in obj.iter() if g.tag.split("}")[-1] == tag]
                if geometries:
                    break
            if not geometries:
                raise ValueError("Unsupported geometry representation: " + kind_name)
            # XLinks must be expanded by an external converter; do not omit surfaces.
            if any("{http://www.w3.org/1999/xlink}href" in g.attrib for root in geometries for g in root.iter()):
                raise ValueError("Unresolved XLink geometry")
            polygons = [g for root in geometries for g in root.iter() if g.tag.split("}")[-1] in ("Polygon", "Triangle")]
            if not polygons:
                raise ValueError("Object has no supported polygons")
            rings = [ring_points(polygon, origin) for polygon in polygons]
            all_points = [p for ring in rings for p in ring]
            # Keep whole geometry intersecting the block: do not fabricate cut walls.
            if (max(p[0] for p in all_points) < -half_size or min(p[0] for p in all_points) > half_size or
                max(p[2] for p in all_points) < -half_size or min(p[2] for p in all_points) > half_size):
                node.clear();continue
            positions, indices = [], []
            for ring in rings:
                base = len(positions)//3
                indices.extend(i+base for i in triangulate(ring))
                positions.extend(v for point in ring for v in point)
            meshes.append({"id":f"mesh-{len(meshes):05d}","kind":kind,"positions":positions,"indices":indices})
            node.clear()
            if len(meshes) > 5000 or sum(len(m["positions"]) for m in meshes) > 1_500_000:
                raise ValueError("One-block geometry budget exceeded")
    if not any(m["kind"] == "building" for m in meshes) or not any(m["kind"] != "building" for m in meshes):
        raise ValueError("Both measured buildings and road/terrain surfaces are required")
    return {"version":1,"mode":"survey","title":"大阪・梅田 / 実データ街区",
            "coordinateSystem":"LOCAL_ENU_Y_UP_METERS","origin":dict(zip(["latitude","longitude","altitude"],origin)),
            "extentMeters":1000,"playableHalfSize":half_size,"spawn":spawn,"sources":sources,"meshes":meshes,
            "limitations":["形状は出典データの年度に対応します。現在の大阪の完全再現ではありません。",
            "外壁材・窓・夕景は汎用の演出で、実際の外観や点灯状態を示しません。原データのテクスチャは未取込です。",
            "1km四方は計画範囲です。今回の変換は開始街区と交差する地物に限定し、街区境界はゲーム用制約です。",
            "GRS80局所接平面を使用。標高を近傍相対高度として扱い、ジオイド補正は未実施です。測量精度は保証しません。",
            "地下・建物内部・歩道の通行権・私有地・工事による通行規制は未再現です。"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--source-metadata", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--origin", nargs=3, required=True, type=float, metavar=("LAT","LON","ALT"))
    parser.add_argument("--block-half-size", type=float, default=125)
    parser.add_argument("--spawn", nargs=3, type=float, default=[0,2,0], metavar=("EAST","UP","SOUTH"))
    args = parser.parse_args()
    if args.out.exists():
        parser.error("Output exists; choose a new output path to preserve the previous conversion")
    try:
        manifest = convert(args.inputs, json.loads(args.source_metadata.read_text()),args.origin,args.block_half_size,args.spawn)
        content = json.dumps(manifest,ensure_ascii=False,separators=(",", ":"),allow_nan=False)
        if len(content.encode()) > MAX_OUTPUT:
            raise ValueError("Output exceeds 20MiB budget")
        args.out.parent.mkdir(parents=True,exist_ok=True)
        with args.out.open("x",encoding="utf-8") as output:
            output.write(content)
        print(json.dumps({"meshes":len(manifest["meshes"]),"sources":len(manifest["sources"]),"bytes":len(content.encode())}))
    except (ValueError, ET.ParseError, OSError):
        # Do not echo input paths, raw coordinates, or arbitrary source text.
        print("Conversion failed: check supported geometry, metadata, file access and budgets.")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
