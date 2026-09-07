import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("converter", Path(__file__).resolve().parents[2] / "scripts/convert-citygml.py")
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)


class ConverterTests(unittest.TestCase):
    def test_origin_and_axes(self):
        origin = [34.705,135.4967,3]
        self.assertEqual(converter.local_point(origin, origin), [0,0,0])
        self.assertGreater(converter.local_point([34.705,135.4977,3],origin)[0],80)
        self.assertLess(converter.local_point([34.706,135.4967,3],origin)[2],-100)
        self.assertAlmostEqual(converter.local_point([34.705,135.4967,13],origin)[1],10)

    def test_concave_triangulation_area(self):
        points = [[0,0,0],[4,0,0],[4,0,1],[1,0,1],[1,0,4],[0,0,4]]
        indices=converter.triangulate(points)
        area=0
        for i in range(0,len(indices),3):
            a,b,c=[points[j] for j in indices[i:i+3]]
            area+=abs(converter.cross([a[0],a[2]],[b[0],b[2]],[c[0],c[2]]))/2
        self.assertAlmostEqual(area,7)
        self.assertEqual(len(indices),12)

    def test_non_planar_geometry_rejected(self):
        with self.assertRaises(ValueError):converter.triangulate([[0,0,0],[10,0,0],[10,3,10],[0,0,10]])

    def test_no_signed_url(self):
        with self.assertRaises(ValueError):converter.public_url("https://example.com/file?sig=private")

    def test_entities_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/"test.xml";path.write_text('<!DOCTYPE a [<!ENTITY x "test">]><a/>')
            with self.assertRaises(ValueError):converter.scan_source(path)

    def test_source_hashes_and_survey_geometry(self):
        metadata={"title":"Synthetic converter test","provider":"Test","datasetYear":2020,"surveyYear":None,"url":"https://example.com/data","license":"Test only","licenseUrl":"https://example.com/license","attribution":"Test fixture","retrievedAt":"2026-09-07"}
        ring="34.705 135.4967 3 34.705 135.497 3 34.7053 135.497 3 34.7053 135.4967 3 34.705 135.4967 3"
        polygon=f'<gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>{ring}</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>'
        xml=f'''<core:CityModel xmlns:core="http://www.opengis.net/citygml/2.0" xmlns:gml="http://www.opengis.net/gml" xmlns:bldg="http://www.opengis.net/citygml/building/2.0" xmlns:tran="http://www.opengis.net/citygml/transportation/2.0"><gml:boundedBy><gml:Envelope srsName="http://www.opengis.net/def/crs/EPSG/0/6697"/></gml:boundedBy><core:cityObjectMember><bldg:Building><bldg:lod1Solid>{polygon}</bldg:lod1Solid></bldg:Building></core:cityObjectMember><core:cityObjectMember><tran:Road><tran:lod1MultiSurface>{polygon}</tran:lod1MultiSurface></tran:Road></core:cityObjectMember></core:CityModel>'''
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/"test.xml";path.write_text(xml)
            result=converter.convert([path],metadata,[34.705,135.4967,3],125,[0,2,0])
            self.assertEqual(len(result["meshes"]),2)
            self.assertEqual(len(result["sources"][0]["sha256"]),64)
            self.assertNotIn(temp,json.dumps(result))
            self.assertEqual(result["sources"][0]["surveyYear"],None)


if __name__ == "__main__":unittest.main()
