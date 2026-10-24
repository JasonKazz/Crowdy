import threading
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from app import api
from app.services.floorplans import import_jobs


class ImportJobTests(unittest.TestCase):
    def setUp(self):
        self.env=patch.dict('os.environ',{'CROWDY_BACKEND_TOKEN':'','VERCEL':''})
        self.env.start();self.addCleanup(self.env.stop)
        self.client=TestClient(api.app);self.addCleanup(self.client.close)

    def wait_terminal(self, identifier):
        for _ in range(100):
            data=self.client.get('/api/floorplans/jobs/'+identifier).json()
            if data['status']!='running':return data
            time.sleep(.01)
        self.fail('Worker did not finish')

    def test_upload_returns_immediately_and_poll_reports_progress_and_final_result(self):
        entered,release=threading.Event(),threading.Event()
        def pending(payload,progress):
            progress('Reading 4 detail regions');entered.set()
            if not release.wait(3):raise AssertionError('Worker not released')
            return {'plan':{'test-fixture':True},'warnings':['Review exit']}
        image={'filename':'test.png','image_base64':'fake','provider':'claude','async_import':True}
        with patch('app.api.import_floorplan',side_effect=pending):
            response=self.client.post('/api/floorplans',json=image)
            try:
                self.assertEqual(response.status_code,202)
                identifier=response.json()['job_id']
                self.assertTrue(entered.wait(1))
                status=self.client.get('/api/floorplans/jobs/'+identifier)
                self.assertEqual(status.json()['progress'],'Reading 4 detail regions')
                self.assertIn('no-store',status.headers['cache-control'])
                self.assertEqual(self.client.post('/api/floorplans',json=image).status_code,429)
            finally:release.set()
            complete=self.wait_terminal(identifier)
        self.assertEqual(complete['status'],'complete')
        self.assertEqual(complete['result']['warnings'],['Review exit'])
        self.assertFalse(api.import_status()['claude']['busy'])

    def test_failure_releases_provider_and_remains_readable_by_job_id(self):
        with patch('app.api.import_floorplan',side_effect=ValueError('No complete layout was imported')):
            response=self.client.post('/api/floorplans',json={'filename':'a.png','image_base64':'fake','async_import':True})
            status=self.wait_terminal(response.json()['job_id'])
        self.assertEqual(status['status'],'failed')
        self.assertIn('No complete layout',status['error'])
        self.assertFalse(api.import_status()['claude']['busy'])

    def test_late_import_result_is_not_reported_as_complete_and_releases_slot(self):
        def late_result(payload, progress):
            time.sleep(.02)
            return {'plan': {'late-fixture': True}}
        with patch('app.api.FLOORPLAN_IMPORT_TIME_BUDGET', .005), \
                patch('app.api.import_floorplan', side_effect=late_result):
            response = self.client.post('/api/floorplans', json={
                'filename': 'plan.png', 'image_base64': 'fake', 'async_import': True})
            status = self.wait_terminal(response.json()['job_id'])
        self.assertEqual(status['status'], 'failed')
        self.assertIn('time limit', status['error'])
        self.assertNotIn('result', status)
        self.assertFalse(api.import_status()['claude']['busy'])

    def test_upload_storage_time_consumes_the_same_provider_budget(self):
        from test_images import source
        def slow_save(*args):
            time.sleep(.02)
            return source()
        with patch('app.api.FLOORPLAN_IMPORT_TIME_BUDGET', .005), \
                patch('app.api.save_image', side_effect=slow_save), \
                patch('app.services.floorplans.images.extract_drawing') as provider:
            response = self.client.post('/api/floorplans', json={
                'filename': 'plan.png', 'image_base64': 'fake', 'async_import': True})
            status = self.wait_terminal(response.json()['job_id'])
        self.assertEqual(status['status'], 'failed')
        self.assertIn('time limit', status['error'])
        provider.assert_not_called()
        self.assertFalse(api.import_status()['claude']['busy'])

    def test_vercel_async_upload_returns_the_synchronous_result_without_creating_a_job(self):
        image={'filename':'plan.png','image_base64':'fake','provider':'claude','async_import':True}
        results=({'plan':{'test-fixture':True},'warnings':['Review exit']},
                 {'needs_scale':True,'extraction_id':'a'*32,'reason':'Mark a known distance'})
        with patch.dict('os.environ',{'VERCEL':'1'}), patch('app.api.create_job') as job:
            for result in results:
                with self.subTest(result=result), patch('app.api.import_floorplan',return_value=result) as importer:
                    response=self.client.post('/api/floorplans',json=image)
                    self.assertEqual(response.status_code,200,response.text)
                    self.assertEqual(response.json(),result)
                    self.assertNotIn('job_id',response.json())
                    self.assertIn('no-store',response.headers['cache-control'])
                    importer.assert_called_once()
                    self.assertFalse(api.import_status()['claude']['busy'])
            job.assert_not_called()

    def test_vercel_async_failure_is_reported_directly_and_releases_provider(self):
        image={'filename':'plan.png','image_base64':'fake','async_import':True}
        with patch.dict('os.environ',{'VERCEL':'1'}), patch('app.api.create_job') as job, \
                patch('app.api.import_floorplan',side_effect=ValueError('No complete layout was imported')):
            response=self.client.post('/api/floorplans',json=image)
        self.assertEqual(response.status_code,422,response.text)
        self.assertIn('No complete layout',response.json()['detail'])
        self.assertNotIn('job_id',response.json())
        self.assertFalse(api.import_status()['claude']['busy'])
        job.assert_not_called()

    def test_unknown_and_malformed_jobs_are_not_successful(self):
        self.assertEqual(self.client.get('/api/floorplans/jobs/'+'a'*32).status_code,404)
        self.assertEqual(self.client.get('/api/floorplans/jobs/invalid').status_code,400)
        with patch.dict('os.environ',{'CROWDY_BACKEND_TOKEN':'test-only-token'}):
            self.assertEqual(self.client.get('/api/floorplans/jobs/'+'a'*32).status_code,401)

    def test_finished_job_store_is_bounded(self):
        with import_jobs._guard:
            snapshot=dict(import_jobs._jobs)
            import_jobs._jobs.clear()
        try:
            for i in range(import_jobs.MAX_JOBS+2):
                identifier=import_jobs.create_job()
                import_jobs.update_job(identifier,status='complete',result={'ok':True})
            self.assertLessEqual(len(import_jobs._jobs),import_jobs.MAX_JOBS)
        finally:
            with import_jobs._guard:
                import_jobs._jobs.clear();import_jobs._jobs.update(snapshot)

if __name__=='__main__':unittest.main()
