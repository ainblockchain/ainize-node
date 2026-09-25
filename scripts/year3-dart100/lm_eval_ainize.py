import argparse
from collections import Counter
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import random
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

from datasets import Dataset, DatasetDict
from lm_eval.api.model import LM
from lm_eval.api.task import ConfigurableTask
from lm_eval.evaluator import evaluate
from lm_eval.utils import handle_non_serializable


def digest(content):
    return hashlib.sha256(content).hexdigest()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def save_new(filename, value):
    content = json.dumps(value, ensure_ascii=False, indent=2, default=handle_non_serializable).encode() + b"\n"
    temporary = filename.with_name(filename.name + f".{os.getpid()}.tmp")
    with temporary.open("xb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.link(temporary, filename)
        descriptor = os.open(filename.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)


def require(condition, message):
    if not condition:
        raise ValueError(message)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise ValueError("Ainize redirect refused; operator credentials stay on their configured origin")


class AinizeClient:
    def __init__(self, state_file, timeout=1200):
        filename = Path(state_file)
        require(filename.stat().st_mode & 0o077 == 0, "CLI credential file must be private (0600)")
        state = json.loads(filename.read_text())
        self.endpoint = state["nodeUrl"].rstrip("/")
        address = urllib.parse.urlsplit(self.endpoint)
        require(address.scheme == "https" or address.scheme == "http" and address.hostname in {"localhost", "127.0.0.1", "::1"}, "HTTPS or loopback HTTP is required")
        require(not address.username and not address.password and not address.query and not address.fragment and not address.path, "use an origin-only node URL")
        self.token = state["token"]
        require(isinstance(self.token, str) and self.token, "operator login is required")
        self.timeout = timeout
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, route, body=None):
        require(isinstance(route, str) and route.startswith("/api/") and not route.startswith("//") and "#" not in route, "an Ainize API path is required")
        request = urllib.request.Request(self.endpoint + route, data=encoded(body) if body is not None else None, headers={"authorization": f"Bearer {self.token}", "content-type": "application/json"})
        with self.opener.open(request, timeout=self.timeout) as response:
            require(response.headers.get_content_type() == "application/json", "expected a JSON API response, not frontend HTML")
            content = response.read(8 * 1024**2 + 1)
            require(len(content) <= 8 * 1024**2, "API response exceeded 8 MiB")
            return json.loads(content)


class CompareRun:
    def __init__(self, client, output, identity):
        self.client = client
        self.output = Path(output)
        self.output.mkdir(parents=True, exist_ok=True)
        self.identity = identity
        self.fresh = 0
        self.reused = 0

    def compare(self, prompt, max_tokens):
        require(isinstance(prompt, str) and 0 < len(prompt) <= 4000, "invalid prompt")
        require(type(max_tokens) is int and 1 <= max_tokens <= 256, "max_gen_toks must be 1..256")
        binding = {"identity": self.identity, "prompt": prompt, "max_tokens": max_tokens, "endpoint": self.client.endpoint}
        key = digest(encoded(binding))
        request_id = f"eval-{key[:48]}"
        intent = self.output / f"{key}.intent.json"
        response_file = self.output / f"{key}.response.json"
        if response_file.exists():
            saved = json.loads(response_file.read_text())
            require(saved["binding"] == binding and saved["request_id"] == request_id, "cached request binding changed")
            require(json.loads(intent.read_text())["binding"] == binding, "cached submission intent changed")
            require(saved["sha256"] == digest(encoded(saved["response"])), "cached response hash changed")
            response = saved["response"]
            self.reused += 1
        else:
            require(not intent.exists(), f"request {request_id} has an uncertain outcome; inspect that request, do not resubmit")
            save_new(intent, {"binding": binding, "request_id": request_id, "at": time.time()})
            started = time.monotonic()
            response = self.client.request("/api/chat", {"patch_id": self.identity["patch_id"], "mode": "compare", "messages": [{"role": "user", "content": prompt}], "max_tokens": max_tokens, "thinking": False, "request_id": request_id})
            save_new(response_file, {"binding": binding, "request_id": request_id, "response": response, "sha256": digest(encoded(response)), "elapsed_seconds": time.monotonic() - started, "at": time.time()})
            self.fresh += 1
        require(response.get("patch_id") == self.identity["patch_id"] and response.get("mode") == "compare", "wrong patch or inference mode")
        require(response.get("dirty") == [], "comparison reports an unknown or contaminated model stack")
        if "runtime" in self.identity:
            require(all(isinstance(response.get(column), dict) and response[column].get("model") == self.identity["runtime"]["model"] for column in ["base", "patched"]), "inference model identity changed")
        return response


def valid_answer(answer, limit):
    if not isinstance(answer, dict) or not isinstance(answer.get("usage"), dict):
        return False
    return isinstance(answer.get("content"), str) and bool(answer["content"].strip()) and type(answer["usage"].get("completion_tokens")) is int and 0 < answer["usage"]["completion_tokens"] <= limit and answer.get("finish_reason") == "stop" and "truncated" in answer and (answer["truncated"] is None or answer["truncated"] is False)


class AinizeLM(LM):
    def __init__(self, comparison, column):
        super().__init__()
        require(column in {"base", "patched"}, "invalid model column")
        self.comparison = comparison
        self.column = column
        self.valid = 0
        self.invalid = 0

    def loglikelihood(self, requests):
        raise NotImplementedError("Ainize compare does not expose token log probabilities")

    def loglikelihood_rolling(self, requests):
        raise NotImplementedError("Ainize compare does not expose perplexity")

    def generate_until(self, requests):
        responses = []
        for request in requests:
            prompt, options = request.args
            require(set(options) <= {"until", "max_gen_toks"}, "sampling belongs to the Ainize node; unsupported lm-eval override")
            require(options.get("until", []) == [], "additional client-side stop sequences are unsupported")
            limit = options.get("max_gen_toks", 256)
            answer = self.comparison.compare(prompt, limit).get(self.column)
            valid = valid_answer(answer, limit)
            self.valid += int(valid)
            self.invalid += int(not valid)
            responses.append(answer["content"] if valid else "")
        return responses


def normalize(value):
    return unicodedata.normalize("NFC", value).strip()


def score_results(document, responses):
    require(len(responses) == 1, "one generation per row is required")
    answer = normalize(responses[0])
    expected = normalize(document["answer"])
    return {"exact_match": float(bool(answer) and answer == expected), "response_nonempty": float(bool(answer))}


def task_for(lesson, variant, facts):
    require(variant in {"primary", "heldout"}, "unknown task variant")
    field = "prompt" if variant == "primary" else "alt_prompt"
    selected = [row for row in facts if row.get(field)]
    require(bool(selected), f"no {variant} rows")
    config = {"task": f"{lesson}_{variant}", "dataset_path": "ainize-canonical-memory", "custom_dataset": lambda **kwargs: DatasetDict({"test": Dataset.from_list(selected)}), "test_split": "test", "doc_to_text": field, "doc_to_target": "answer", "num_fewshot": 0, "output_type": "generate_until", "generation_kwargs": {"until": [], "max_gen_toks": 256}, "process_results": score_results, "metric_list": [{"metric": metric, "aggregation": "mean", "higher_is_better": True} for metric in ["exact_match", "response_nonempty"]], "metadata": {"version": 1}}
    return ConfigurableTask(config=config)


def bound_job(job, entry):
    require(job.get("id") == entry["jobId"] and job.get("status") in {"READY", "NEEDS_MORE", "ANNOUNCED", "PENDING_REVIEW"}, "a checked existing job is required")
    require(job.get("checks", {}).get("executed") is True, "job has not run its checks")
    require(job.get("mode") == "scratch" and job.get("context_patch_ids") == [], "this evaluation supports isolated scratch lessons only")
    dataset = job["dataset"]
    require(dataset["id"] == entry["datasetId"] and dataset["sha256"] == entry["sha256"] and dataset["rows"] == entry["rows"], "job dataset binding changed")
    require(isinstance(job.get("draft_id"), str) and re.fullmatch(r"[a-f0-9]{64}", job["result"]["sha256"]), "missing patch identity")
    return {"job_id": job["id"], "dataset_id": dataset["id"], "dataset_sha256": dataset["sha256"], "dataset_revision": dataset["revision"], "patch_id": job["draft_id"], "patch_sha256": job["result"]["sha256"]}


def idle_runtime(info):
    runtime = info.get("runtime", {})
    queue = runtime.get("queue")
    require(runtime.get("available") is True and runtime.get("applied") == [] and isinstance(queue, dict) and queue.get("running") is None and queue.get("waiting") == 0 and queue.get("queued") == [] and queue.get("lock") is None, "runtime must be idle with an empty stack; do not interrupt another job")
    return {key: runtime.get(key) for key in ["api", "model", "hook", "repo", "patch_dir"]}


def finish_stack(client, binding):
    info = client.request("/api/info")
    idle_runtime({**info, "runtime": {**info["runtime"], "applied": []}})
    stack = client.request("/api/runtime/stack")["stack"]
    require(isinstance(stack, list) and len(stack) <= 1, "unexpected model stack; no cleanup attempted")
    if stack:
        top = stack[0]
        require(top.get("patch_id") == binding["patch_id"] and top.get("sha256") == binding["patch_sha256"] and top.get("base_stack") == [] and str(top.get("reason", "")).startswith("chat:"), "foreign or manual patch; no cleanup attempted")
        client.request(f"/api/patches/{urllib.parse.quote(binding['patch_id'], safe='')}/remove", {})
    require(client.request("/api/runtime/stack")["stack"] == [], "own patch cleanup did not leave an empty stack")
    idle_runtime(client.request("/api/info"))
    return {"before": stack, "after": [], "only_own_patch_removed": bool(stack)}


def run(args):
    require(importlib.metadata.version("lm_eval") == "0.4.13", "this adapter was verified with lm_eval 0.4.13")
    root = Path(args.evidence)
    lifecycle = json.loads((root / args.lifecycle / "progress.json").read_text())
    registration = root / lifecycle["identity"]["registrationRun"]
    require(digest((registration / "progress.json").read_bytes()) == lifecycle["identity"]["registrationSha256"], "registration manifest changed")
    entries = [entry for entry in lifecycle["entries"] if entry["lessonId"] in args.lessons]
    require(len(entries) == len(set(args.lessons)) == len(args.lessons), "every requested lesson must name one registered dataset")
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    identity = {"lifecycle": args.lifecycle, "lessons": args.lessons, "registration": lifecycle["identity"], "metric": "NFC-trimmed exact match on all primary and alternate prompts", "sampling": "Ainize runtime configuration; no lm-eval sampling override", "lm_eval": "0.4.13"}
    identity_file = output / "identity.json"
    if identity_file.exists():
        require(json.loads(identity_file.read_text()) == identity, "evaluation identity changed on resume")
    else:
        save_new(identity_file, identity)
    client = AinizeClient(args.cli_state)
    jobs = client.request("/api/me/teach/jobs").get("items")
    require(isinstance(jobs, list) and len(jobs) < 500 and all(job.get("status") in {"READY", "NEEDS_MORE", "ANNOUNCED", "PENDING_REVIEW", "FAILED", "REJECTED", "CANCELLED", "EXPIRED"} for job in jobs), "unfinished or unenumerated teaching work; wait without cancelling it")
    runtime_identity = idle_runtime(client.request("/api/info"))
    runtime_file = output / "runtime-identity.json"
    if runtime_file.exists():
        require(json.loads(runtime_file.read_text()) == runtime_identity, "runtime identity changed on resume")
    else:
        save_new(runtime_file, runtime_identity)
    reports = []
    for entry in entries:
        lesson = entry["lessonId"]
        require(re.fullmatch(r"[A-Za-z0-9_-]+", lesson), "unsafe lesson identifier")
        folder = output / lesson
        folder.mkdir(exist_ok=True)
        canonical = (registration / f"{lesson}-canonical.jsonl").read_bytes()
        require(digest(canonical) == entry["sha256"], "canonical data changed")
        facts = [json.loads(line) for line in canonical.decode().splitlines()]
        require(len(facts) == entry["rows"] and all(isinstance(row.get("prompt"), str) and row["prompt"].strip() and isinstance(row.get("answer"), str) and row["answer"].strip() for row in facts), "invalid canonical rows")
        job = client.request(f"/api/teach/jobs/{urllib.parse.quote(entry['jobId'], safe='')}")["job"]
        binding = bound_job(job, entry)
        fingerprint = lambda row: encoded({key: row.get(key) for key in ["prompt", "answer", "alt_prompt"]})
        require(Counter(map(fingerprint, job["facts"])) == Counter(map(fingerprint, facts)), "trained facts differ from canonical rows")
        comparison = CompareRun(client, folder / "requests", {**binding, "runtime": runtime_identity})
        for column in ["base", "patched"]:
            tasks = {f"{lesson}_{variant}": task_for(lesson, variant, facts) for variant in ["primary", "heldout"]}
            model = AinizeLM(comparison, column)
            random.seed(0)
            result = evaluate(model, tasks, bootstrap_iters=1000, log_samples=True)
            filename = folder / f"{column}.json"
            candidate = {"binding": binding, "column": column, "valid_generations": model.valid, "invalid_generations": model.invalid, "result": result}
            if filename.exists():
                existing = json.loads(filename.read_text())
                require(existing["binding"] == binding and existing["column"] == column and existing["result"]["results"] == json.loads(json.dumps(result, default=handle_non_serializable))["results"], "saved metrics changed on response replay")
            else:
                save_new(filename, candidate)
        after = client.request(f"/api/teach/jobs/{urllib.parse.quote(entry['jobId'], safe='')}")["job"]
        require(bound_job(after, entry) == binding, "job identity changed during evaluation")
        cleanup = finish_stack(client, binding)
        require(idle_runtime(client.request("/api/info")) == runtime_identity, "runtime identity changed during evaluation")
        save_new(folder / f"cleanup-{time.time_ns()}.json", cleanup)
        reports.append({"lesson": lesson, **binding, "fresh_compare_requests": comparison.fresh, "reused_compare_responses": comparison.reused, "primary_rows": len(facts), "heldout_rows": sum(bool(row.get("alt_prompt")) for row in facts)})
        print(json.dumps(reports[-1]), flush=True)
    summary = {"scope": "live Ainize compare through the lm-eval LM interface; validated resume responses are reused, not counted as new generation", "target_datasets": 100, "evaluated_datasets": len(reports), "distinct_base_models_proven": False, "reports": reports}
    destination = output / f"summary-{time.time_ns()}.json"
    save_new(destination, summary)
    print(json.dumps({"summary": str(destination), "datasets": len(reports)}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--lifecycle", required=True)
    parser.add_argument("--lessons", nargs="+", required=True)
    parser.add_argument("--cli-state", required=True)
    parser.add_argument("--output", required=True)
    run(parser.parse_args())
