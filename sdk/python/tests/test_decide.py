"""`client.decide()` — the one method `connect()` adds to OpenAI's client.

Driven through a real node, which forwards `POST /v1/systemone` to the stub decision backend in conftest.py: what
is asserted is the wire the node actually speaks, authentication included.

    cd sdk/python && .venv/bin/python -m pytest tests/test_decide.py
"""

from __future__ import annotations

import openai
import pytest

import ainize

STATE = "The payment webhook is failing and customers cannot check out."
QUESTIONS = {
    "team": {"type": "choice", "instructions": "Who should handle this?", "criteria": {"billing": "Payments or invoices", "technical": "Bugs or outages"}},
    "severity": {"type": "score", "instructions": "How severe is it?", "criteria": ["low", "medium", "high"]},
    "a1": {"type": "noul", "instructions": "Is a service down?"},
}


def test_connect_still_returns_openai_and_decide_is_the_only_addition(node_url, issued_key):
    client = ainize.connect(node_url, api_key=issued_key)
    assert isinstance(client, openai.OpenAI)
    assert isinstance(client, ainize.Client)
    assert callable(client.decide)


def test_decide_round_trips_every_question_type(node_url, issued_key):
    client = ainize.connect(node_url, api_key=issued_key)
    out = client.decide("clef-flash", state=STATE, questions=QUESTIONS)
    assert isinstance(out, ainize.DecideResult)
    assert out.model == "clef-flash"
    assert out.answers["a1"]["noul"] == pytest.approx(0.91)
    assert out.answers["severity"]["score"] == 2
    assert out.answers["team"]["choice"] == "billing"
    assert out.usage["questions"] == 3
    assert out.debug is None, "no debug unless asked"


def test_result_is_also_the_dict_the_node_sent(node_url, issued_key):
    out = ainize.connect(node_url, api_key=issued_key).decide("clef-flash", state={}, questions={"a1": {"type": "noul"}})
    assert out["answers"]["a1"]["noul"] == pytest.approx(0.91)
    assert "usage" in out and "debug" not in out
    assert set(dict(out)) == {"model", "answers", "usage"}
    assert out.to_dict() == dict(out)


def test_debug_prompt_returns_the_prompt_the_model_saw(node_url, issued_key):
    out = ainize.connect(node_url, api_key=issued_key).decide(
        "clef-flash", state={"k": 1}, questions={"a1": {"type": "noul"}}, debug={"prompt": True}
    )
    assert out.debug is not None
    assert out.debug["prompt"].startswith("STATE ")
    assert '"k": 1' in out.debug["prompt"]
    assert out.debug["questions"] == 1


def test_empty_questions_are_refused_before_any_request(node_url, issued_key):
    client = ainize.connect(node_url, api_key=issued_key)
    with pytest.raises(ValueError):
        client.decide("clef-flash", state={}, questions={})


def test_a_bad_key_is_an_authentication_error_with_the_nodes_code(node_url):
    client = ainize.connect(node_url, api_key="ainize-sk-not-a-real-key")
    with pytest.raises(ainize.DecideError) as raised:
        client.decide("clef-flash", state={}, questions={"a1": {"type": "noul"}})
    assert raised.value.status_code == 401
    assert isinstance(raised.value, openai.APIStatusError), "the error family callers already catch"


def test_an_unknown_model_is_404_model_not_found(node_url, issued_key):
    with pytest.raises(ainize.DecideError) as raised:
        ainize.connect(node_url, api_key=issued_key).decide("not-a-model", state={}, questions={"a1": {"type": "noul"}})
    assert raised.value.status_code == 404
    assert raised.value.code == "model_not_found"
