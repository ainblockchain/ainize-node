import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lm_eval_ainize import AinizeClient, AinizeLM, CompareRun, NoRedirect, bound_job, digest, encoded, evaluate, finish_stack, idle_runtime, run, save_new, score_results, task_for, valid_answer


def answer(content="정답"):
    return {"content": content, "usage": {"completion_tokens": 2}, "finish_reason": "stop", "truncated": None, "model": "fixture"}


class Client:
    endpoint = "http://localhost:3410"

    def __init__(self):
        self.calls = []
        self.response = {"patch_id": "patch-one", "mode": "compare", "dirty": [], "base": answer("오답"), "patched": answer()}
        self.stack = []

    def request(self, route, body=None):
        self.calls.append((route, body))
        if route == "/api/info":
            return {"runtime": {"available": True, "applied": [item["patch_id"] for item in self.stack], "queue": {"running": None, "waiting": 0, "queued": [], "lock": None}, "model": "fixture"}}
        if route == "/api/runtime/stack":
            return {"stack": copy.deepcopy(self.stack)}
        if route.endswith("/remove"):
            self.stack = []
            return {"stack": []}
        return copy.deepcopy(self.response)


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.client = Client()
        self.binding = {"patch_id": "patch-one", "patch_sha256": "a" * 64}
        self.comparison = CompareRun(self.client, self.root / "requests", self.binding)

    def tearDown(self):
        self.temporary.cleanup()

    def test_two_columns_reuse_one_real_compare_response(self):
        request = SimpleNamespace(args=("질문", {"until": [], "max_gen_toks": 32}))
        self.assertEqual(AinizeLM(self.comparison, "base").generate_until([request]), ["오답"])
        self.assertEqual(AinizeLM(self.comparison, "patched").generate_until([request]), ["정답"])
        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual((self.comparison.fresh, self.comparison.reused), (1, 1))
        self.assertLessEqual(len(self.client.calls[0][1]["request_id"]), 64)

    def test_resume_reuses_bound_response_without_resubmission(self):
        expected = self.comparison.compare("질문", 32)
        resumed = CompareRun(self.client, self.comparison.output, self.binding)
        self.assertEqual(resumed.compare("질문", 32), expected)
        self.assertEqual(len(self.client.calls), 1)

    def test_tampered_response_fails_closed(self):
        self.comparison.compare("질문", 32)
        filename = next(self.comparison.output.glob("*.response.json"))
        record = json.loads(filename.read_text())
        record["response"]["patched"]["content"] = "changed"
        filename.write_text(json.dumps(record))
        with self.assertRaisesRegex(ValueError, "hash changed"):
            self.comparison.compare("질문", 32)

    def test_uncertain_submission_is_not_retried(self):
        def timeout(route, body):
            raise TimeoutError("fixture timeout after submission")
        self.client.request = timeout
        with self.assertRaises(TimeoutError):
            self.comparison.compare("질문", 32)
        with self.assertRaisesRegex(ValueError, "uncertain outcome"):
            self.comparison.compare("질문", 32)

    def test_wrong_patch_or_dirty_stack_is_never_scored(self):
        for field, value in [("patch_id", "foreign"), ("mode", "patched"), ("dirty", ["foreign"])]:
            with self.subTest(field=field):
                client = Client()
                client.response[field] = value
                comparison = CompareRun(client, self.root / field, self.binding)
                with self.assertRaises(ValueError):
                    comparison.compare("질문", 32)

    def test_malformed_truncated_and_empty_generations_are_invalid(self):
        self.assertTrue(valid_answer(answer(), 32))
        candidates = [None, {}, {**answer(), "usage": None}, {**answer(), "content": "  "}, {**answer(), "finish_reason": "length"}, {**answer(), "truncated": True}, {**answer(), "usage": {"completion_tokens": True}}, {**answer(), "usage": {"completion_tokens": 33}}]
        for candidate in candidates:
            self.assertFalse(valid_answer(candidate, 32))

    def test_invalid_generation_stays_in_denominator(self):
        self.client.response["patched"]["finish_reason"] = "length"
        model = AinizeLM(self.comparison, "patched")
        generated = model.generate_until([SimpleNamespace(args=("질문", {"until": []}))])
        self.assertEqual(generated, [""])
        self.assertEqual(score_results({"answer": "정답"}, generated), {"exact_match": 0.0, "response_nonempty": 0.0})
        self.assertEqual(model.invalid, 1)

    def test_sampling_and_probability_requests_are_not_faked(self):
        model = AinizeLM(self.comparison, "base")
        for options in [{"temperature": 0}, {"until": ["stop"]}, {"max_gen_toks": 257}]:
            with self.assertRaises(ValueError):
                model.generate_until([SimpleNamespace(args=("질문", options))])
        with self.assertRaises(NotImplementedError):
            model.loglikelihood([])
        with self.assertRaises(NotImplementedError):
            model.loglikelihood_rolling([])

    def test_native_lm_eval_tasks_score_primary_and_heldout(self):
        facts = [{"prompt": "질문 하나", "alt_prompt": "대체 하나", "answer": "정답"}, {"prompt": "질문 둘", "alt_prompt": "대체 둘", "answer": "다른 정답"}]
        tasks = {f"fixture_{variant}": task_for("fixture", variant, facts) for variant in ["primary", "heldout"]}
        result = evaluate(AinizeLM(self.comparison, "patched"), tasks, bootstrap_iters=1000, log_samples=True)
        for name in tasks:
            self.assertEqual(result["results"][name]["exact_match,none"], 0.5)
            self.assertEqual(result["results"][name]["response_nonempty,none"], 1.0)
            self.assertEqual(len(result["samples"][name]), 2)
            self.assertEqual(result["n-samples"][name]["effective"], 2)
        self.assertEqual(self.comparison.fresh, 4)

    def test_exact_match_is_not_substring_matching(self):
        self.assertEqual(score_results({"answer": "정답"}, [" 정답\n"])["exact_match"], 1.0)
        self.assertEqual(score_results({"answer": "정답"}, ["아마 정답입니다"])["exact_match"], 0.0)

    def test_private_credentials_and_origin_only_urls(self):
        filename = self.root / "cli.json"
        filename.write_text(json.dumps({"nodeUrl": "http://localhost:3410", "token": "fixture-not-secret"}))
        filename.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "private"):
            AinizeClient(filename)
        filename.chmod(0o600)
        self.assertEqual(AinizeClient(filename).endpoint, "http://localhost:3410")
        for endpoint in ["http://remote.example", "https://user:secret@example.com", "https://example.com/api", "https://example.com?query=1"]:
            filename.write_text(json.dumps({"nodeUrl": endpoint, "token": "fixture-not-secret"}))
            with self.assertRaises(ValueError):
                AinizeClient(filename)
        with self.assertRaises(ValueError):
            NoRedirect().redirect_request(None, None, 302, None, None, "https://elsewhere.example")

    def test_cleanup_only_removes_own_chat_patch(self):
        own = {**self.binding, "sha256": self.binding["patch_sha256"], "base_stack": [], "reason": "chat:fixture"}
        self.client.stack = [own]
        result = finish_stack(self.client, self.binding)
        self.assertTrue(result["only_own_patch_removed"])
        for changed in [{"patch_id": "foreign"}, {"reason": "manual"}, {"sha256": "changed"}, {"base_stack": ["parent"]}]:
            self.client.stack = [{**own, **changed}]
            count = len(self.client.calls)
            with self.assertRaises(ValueError):
                finish_stack(self.client, self.binding)
            self.assertFalse(any(route.endswith("/remove") for route, body in self.client.calls[count:]))

    def test_bound_dataset_is_not_replaced_by_a_job_name(self):
        entry = {"jobId": "job", "datasetId": "dataset", "sha256": "d" * 64, "rows": 2}
        job = {"id": "job", "status": "READY", "checks": {"executed": True}, "mode": "scratch", "context_patch_ids": [], "dataset": {"id": "dataset", "sha256": entry["sha256"], "rows": 2, "revision": 1}, "draft_id": "patch", "result": {"sha256": "a" * 64}}
        self.assertEqual(bound_job(job, entry)["dataset_id"], "dataset")
        job["dataset"]["sha256"] = "different"
        with self.assertRaises(ValueError):
            bound_job(job, entry)

    def test_exclusive_evidence_write_never_overwrites(self):
        filename = self.root / "immutable.json"
        save_new(filename, {"value": 1})
        before = filename.read_bytes()
        with self.assertRaises(FileExistsError):
            save_new(filename, {"value": 2})
        self.assertEqual(filename.read_bytes(), before)

    def test_complete_driver_binds_existing_dataset_and_replays_metrics(self):
        lesson = "dart-001-fixture"
        registration = self.root / "registration"
        registration.mkdir()
        facts = [{"prompt": "primary one", "alt_prompt": "heldout one", "answer": "정답"}, {"prompt": "primary two", "alt_prompt": "heldout two", "answer": "other"}]
        canonical = b"".join(encoded(row) + b"\n" for row in facts)
        (registration / f"{lesson}-canonical.jsonl").write_bytes(canonical)
        manifest = encoded({"fixture": True})
        (registration / "progress.json").write_bytes(manifest)
        entry = {"lessonId": lesson, "jobId": "existing-job", "datasetId": "existing-dataset", "sha256": digest(canonical), "rows": 2}
        lifecycle = self.root / "lifecycle"
        lifecycle.mkdir()
        (lifecycle / "progress.json").write_bytes(encoded({"identity": {"registrationRun": "registration", "registrationSha256": digest(manifest)}, "entries": [entry]}))
        job = {"id": entry["jobId"], "status": "ANNOUNCED", "checks": {"executed": True}, "mode": "scratch", "context_patch_ids": [], "facts": facts, "dataset": {"id": entry["datasetId"], "sha256": entry["sha256"], "rows": 2, "revision": 1}, "draft_id": "patch-one", "result": {"sha256": "a" * 64}}
        original = self.client.request
        def request(route, body=None):
            if route == "/api/teach/jobs":
                raise AssertionError("operator enumeration must not use the teacher-signature-only endpoint")
            if route == "/api/me/teach/jobs":
                return {"items": [job]}
            if route == "/api/teach/jobs/existing-job":
                return {"job": job}
            return original(route, body)
        self.client.request = request
        args = SimpleNamespace(evidence=str(self.root), lifecycle="lifecycle", lessons=[lesson], cli_state="fixture-only", output=str(self.root / "output"))
        with patch("lm_eval_ainize.AinizeClient", return_value=self.client):
            run(args)
            run(args)
        self.assertEqual(len([route for route, body in self.client.calls if route == "/api/chat"]), 4)
        summaries = [json.loads(filename.read_text()) for filename in (self.root / "output").glob("summary-*.json")]
        self.assertEqual(len(summaries), 2)
        self.assertEqual(sorted(summary["reports"][0]["fresh_compare_requests"] for summary in summaries), [0, 4])
        for summary in summaries:
            self.assertEqual(summary["evaluated_datasets"], 1)
            self.assertEqual(summary["target_datasets"], 100)
            self.assertFalse(summary["distinct_base_models_proven"])
        job["status"] = "TRAINING"
        with patch("lm_eval_ainize.AinizeClient", return_value=self.client):
            with self.assertRaisesRegex(ValueError, "unfinished"):
                run(args)


if __name__ == "__main__":
    unittest.main()
