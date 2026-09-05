import io
import json

import pytest

from pi_dspy_gepa.learning import CampaignAdapter, components, learn
from pi_dspy_gepa.program import Action, decide
from pi_dspy_gepa.worker import serve


def candidate():
    return {"instructions": "Choose the next action.", "demonstrations": []}


def inputs():
    return {"inheritedInstructions": "rules", "brief": "goal", "context": "[]", "tools": "[]"}


def test_real_dspy_program_uses_pi_lm_and_typed_action():
    calls = []

    def exchange(kind, payload):
        calls.append((kind, payload))
        return {"text": json.dumps({"action": {"text": "done", "toolCalls": []}})}

    result = decide(candidate(), inputs(), exchange)
    assert result["action"] == {"text": "done", "toolCalls": []}
    assert calls[0][0] == "model"
    assert "Choose the next action" in json.dumps(calls)


def test_demonstrations_are_applied_without_loading_python_code():
    value = candidate()
    value["demonstrations"] = [
        {"input": inputs(), "action": {"text": "example output", "toolCalls": []}}
    ]
    requests = []

    def exchange(_kind, payload):
        requests.append(payload)
        return {"text": '{"action":{"text":"next","toolCalls":[]}}'}

    assert decide(value, inputs(), exchange)["action"]["text"] == "next"
    assert "example output" in json.dumps(requests)


@pytest.mark.parametrize(
    "value",
    [
        {"instructions": "x", "demonstrations": "[]", "code": "evil"},
        {"instructions": "", "demonstrations": "[]"},
        {"instructions": "x", "demonstrations": "{}"},
        {"instructions": "x", "demonstrations": '[{"input":{},"action":{}}]'},
    ],
)
def test_optimizer_components_reject_contract_changes(value):
    with pytest.raises(ValueError):
        components(value)


def test_adapter_scores_fixed_evidence_and_preserves_reflection_traces():
    value = {"instructions": "x", "demonstrations": "[]"}
    adapter = CampaignAdapter(
        lambda kind, payload: [
            {"score": 0, "caseId": "train", "feedback": "check failed", "trace": "decision"}
        ]
    )
    batch = adapter.evaluate([{"role": "training"}], value, capture_traces=True)
    assert batch.scores == [0]
    assert (
        adapter.make_reflective_dataset(value, batch, ["instructions"])["instructions"][0][
            "Feedback"
        ]
        == "check failed"
    )
    with pytest.raises(ValueError, match="Held-out"):
        adapter.evaluate([{"role": "heldOut"}], value)
    with pytest.raises(ValueError, match="missing reviewer"):
        CampaignAdapter(lambda *_: [{"score": None}]).evaluate([], value)


def test_learning_uses_standalone_gepa_with_a_fixed_adapter(monkeypatch):
    def optimize(**kwargs):
        assert kwargs["max_metric_calls"] == 3
        assert kwargs["trainset"] == [{"role": "training"}]
        assert kwargs["valset"] == [{"role": "validation"}]
        assert kwargs["reflection_lm"]("prompt") == "reflection"
        return type("Result", (), {"candidates": [kwargs["seed_candidate"]]})()

    monkeypatch.setattr("pi_dspy_gepa.learning.optimize", optimize)
    request = {
        "candidate": candidate(),
        "cases": [{"role": "training"}, {"role": "validation"}],
        "maxTrials": 3,
    }
    assert learn(request, lambda *_: {"text": "reflection"})["candidates"] == [candidate()]
    request["cases"].append({"role": "heldOut"})
    with pytest.raises(ValueError, match="Held-out"):
        learn(request, lambda *_: None)


def test_worker_handles_multiple_decisions_and_explicit_errors():
    request = {"operation": "decide", "candidate": candidate(), "input": inputs()}
    response = {"result": {"text": '{"action":{"text":"ok","toolCalls":[]}}'}}
    lines = [request, response, request, response, {"operation": "unsupported"}]
    writer = io.StringIO()
    serve(io.StringIO("\n".join(json.dumps(line) for line in lines) + "\n"), writer)
    output = [json.loads(line) for line in writer.getvalue().splitlines()]
    assert len([line for line in output if "result" in line]) == 2
    assert output[-1]["error"] == "Unknown Python worker operation"
    with pytest.raises(ValueError):
        Action.model_validate({"text": "x", "toolCalls": [], "approve": True})


def test_actual_gepa_search_with_deterministic_host_evaluation(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    evaluated = []

    def exchange(kind, payload):
        if kind == "reflection":
            return {"text": "```\nImproved instructions\n```"}
        assert kind == "evaluate"
        evaluated.append(payload)
        score = 1.0 if payload["components"]["instructions"] == "Improved instructions" else 0.0
        return [
            {"score": score, "caseId": case["id"], "feedback": "Concrete fixed check evidence"}
            for case in payload["cases"]
        ]

    result = learn(
        {
            "candidate": candidate(),
            "cases": [{"id": "train", "role": "training"}, {"id": "val", "role": "validation"}],
            "maxTrials": 4,
        },
        exchange,
    )
    assert any(value["instructions"] == "Improved instructions" for value in result["candidates"])
    assert evaluated
