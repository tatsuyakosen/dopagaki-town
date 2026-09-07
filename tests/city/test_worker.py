import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('worker', Path(__file__).resolve().parents[2] / 'scripts/city-worker.py')
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def test_destination_allowlist_and_redirects(self):
        for url in ['http://api.plateauview.mlit.go.jp/', 'https://127.0.0.1/',
                    'https://api.plateauview.mlit.go.jp.evil.example/', 'https://user@api.plateauview.mlit.go.jp/',
                    'file:///etc/passwd', 'https://assets.cms.plateau.reearth.io/assets/data?key=value']:
            with self.subTest(url=url), self.assertRaises(ValueError): worker.check_url(url)
        with self.assertRaises(ValueError):
            worker.SafeRedirect().redirect_request(None, None, 302, '', {}, 'https://127.0.0.1/')

    def test_unknown_license_is_not_generalized(self):
        city={'cityCode':'12345','cityName':'Test city','year':2025,'files':{
            'bldg':[{'url':'https://assets.cms.plateau.reearth.io/assets/building','fileSize':100}],
            'tran':[{'url':'https://assets.cms.plateau.reearth.io/assets/road','fileSize':100}]},
            'metadataZipUrls':['https://assets.cms.plateau.reearth.io/assets/test_metadata.zip']}
        def archive(condition, extra=''):
            stream=io.BytesIO()
            with zipfile.ZipFile(stream,'w') as z:
                z.writestr('metadata/udx_12345_city_2025_op.xml', f'<root xmlns:g="urn:test"><g:useLimitation>{condition}</g:useLimitation>{extra}</root>')
            return stream.getvalue()
        for license, extra, allowed in [('Licensed under CC BY 4.0','',True),('Restricted','',False),
                                       ('Licensed under CC BY 4.0','<g:useConstraints><g:code value="restricted"/></g:useConstraints>',False)]:
            with patch.object(worker,'download',side_effect=[(json.dumps({'cities':[city]}).encode(),False),(archive(license,extra),False)]):
                if allowed:
                    result=worker.discover(34.7,135.5)
                    self.assertEqual(result['license'],'CC BY 4.0');self.assertEqual(len(result['metadataSha256']),64)
                else:
                    with self.assertRaisesRegex(ValueError,'LICENSE_REVIEW_REQUIRED'): worker.discover(34.7,135.5)

    def test_no_coverage_and_outside_area(self):
        with self.assertRaises(ValueError): worker.discover(float('nan'),135)
        with patch.object(worker,'download',return_value=(b'{"cities":[]}',False)):
            with self.assertRaisesRegex(ValueError,'NO_DATA'): worker.discover(34.7,135.5)

    def test_source_budget_before_download(self):
        city={'cityCode':'12345','year':2025,'files':{
            'bldg':[{'url':'https://assets.cms.plateau.reearth.io/assets/b','fileSize':worker.FILE_LIMIT+1}],
            'tran':[{'url':'https://assets.cms.plateau.reearth.io/assets/r','fileSize':100}]}}
        with patch.object(worker,'download',return_value=(json.dumps({'cities':[city]}).encode(),False)) as fetch:
            with self.assertRaisesRegex(ValueError,'SOURCE_TOO_LARGE'): worker.discover(34.7,135.5)
            self.assertEqual(fetch.call_count,1)

    def test_spawn_has_road_clearance_and_rejects_roof(self):
        road={'kind':'road','positions':[-10,0,-10,10,0,-10,10,0,10,-10,0,10],'indices':[0,1,2,0,2,3]}
        spawn=worker.choose_spawn([road]);self.assertAlmostEqual(spawn[1],.95)
        roof={**road,'kind':'building','positions':[-10,4,-10,10,4,-10,10,4,10,-10,4,10]}
        with self.assertRaisesRegex(ValueError,'NO_SAFE_SPAWN'): worker.choose_spawn([road,roof])

    def test_triangle_height_does_not_fill_outside(self):
        triangle=[[0,0,0],[10,2,0],[0,0,10]]
        self.assertAlmostEqual(worker.triangle_height(5,2,*triangle),1)
        self.assertIsNone(worker.triangle_height(9,9,*triangle))


if __name__ == '__main__': unittest.main()
