import io
import json

import pytest

from pi_dspy_gepa.learning import CampaignAdapter, components, learn, texts
from pi_dspy_gepa.program import STAGES, Action, CampaignProgram, decide
from pi_dspy_gepa.worker import serve


def candidate():
    return {
        "stages": {
            stage: {"instructions": f"Perform {stage} precisely.", "demonstrations": []}
            for stage in STAGES
        }
    }


def inputs():
    return {"inheritedInstructions": "rules", "brief": "goal", "context": "[]", "tools": "[]"}


def output(stage):
    if stage == "review":
        return {
            "review": {
                "schema": "pi-dspy-gepa.review.v1",
                "completeness": True,
                "correctness": False,
                "maintainability": True,
                "findings": "Fix the edge case.",
            }
        }
    return {"action": {"text": "done", "toolCalls": []}}


@pytest.mark.parametrize("stage", STAGES)
def test_real_dspy_program_routes_named_stages_and_typed_outputs(stage):
    calls = []

    def exchange(kind, payload):
        calls.append((kind, payload))
        return {"text": json.dumps(output(stage))}

    result = decide(candidate(), stage, inputs(), exchange)
    field = "review" if stage == "review" else "action"
    assert result[field] == output(stage)[field]
    assert calls[0][0] == "model"
    assert f"Perform {stage} precisely" in json.dumps(calls)
    assert {name for name, _ in CampaignProgram(candidate()).named_predictors()} == set(STAGES)


def test_unknown_stage_cannot_change_the_workflow():
    with pytest.raises(ValueError, match="Unknown workflow stage"):
        decide(candidate(), "deploy", inputs(), lambda *_: None)


@pytest.mark.parametrize("stage", STAGES)
def test_demonstrations_are_applied_only_to_their_stage(stage):
    value = candidate()
    value["stages"][stage]["demonstrations"] = [{"input": inputs(), **output(stage)}]
    requests = []

    def exchange(_kind, payload):
        requests.append(payload)
        return {"text": json.dumps(output(stage))}

    decide(value, stage, inputs(), exchange)
    expected = "Fix the edge case" if stage == "review" else "done"
    assert expected in json.dumps(requests)
    assert components(texts(value)) == value


@pytest.mark.parametrize(
    "field,value",
    [
        ("code", "evil"),
        ("plan.instructions", ""),
        ("fix.demonstrations", "{}"),
        ("implement.demonstrations", '[{"input":{},"action":{}}]'),
        ("review.demonstrations", json.dumps([{"input": inputs(), **output("plan")}])),
    ],
)
def test_optimizer_components_reject_contract_changes(field, value):
    learned = texts(candidate())
    learned[field] = value
    with pytest.raises(ValueError):
        components(learned)


def test_adapter_scores_fixed_evidence_and_preserves_stage_traces():
    value = texts(candidate())
    adapter = CampaignAdapter(
        lambda kind, payload: [
            {"score": 0, "caseId": "train", "feedback": "check failed", "trace": "fix"}
        ],
        {"traces": "completed campaign plan and fix"},
    )
    batch = adapter.evaluate([{"role": "training"}], value, capture_traces=True)
    assert batch.scores == [0]
    reflection = adapter.make_reflective_dataset(value, batch, ["fix.instructions"])
    assert reflection["fix.instructions"][0]["Feedback"] == "check failed"
    assert "completed campaign" in json.dumps(reflection)
    with pytest.raises(ValueError, match="Held-out"):
        adapter.evaluate([{"role": "heldOut"}], value)
    with pytest.raises(ValueError, match="missing reviewer"):
        CampaignAdapter(lambda *_: [{"score": None}], None).evaluate([], value)


def test_learning_uses_standalone_gepa_with_stage_components(monkeypatch):
    def optimize(**kwargs):
        assert kwargs["max_metric_calls"] == 3
        assert kwargs["trainset"] == [{"role": "training"}]
        assert kwargs["valset"] == [{"role": "validation"}]
        assert kwargs["reflection_lm"]("prompt") == "reflection"
        assert len(kwargs["seed_candidate"]) == 8
        return type("Result", (), {"candidates": [kwargs["seed_candidate"]]})()

    monkeypatch.setattr("pi_dspy_gepa.learning.optimize", optimize)
    request = {
        "candidate": candidate(),
        "cases": [{"role": "training"}, {"role": "validation"}],
        "campaignEvidence": {"traces": "real completed work"},
        "maxTrials": 3,
    }
    assert learn(request, lambda *_: {"text": "reflection"})["candidates"] == [candidate()]
    request["cases"].append({"role": "heldOut"})
    with pytest.raises(ValueError, match="Held-out"):
        learn(request, lambda *_: None)


def test_worker_handles_multiple_stages_and_explicit_errors():
    lines = []
    for stage in STAGES:
        lines += [
            {"operation": "decide", "stage": stage, "candidate": candidate(), "input": inputs()},
            {"result": {"text": json.dumps(output(stage))}},
        ]
    lines.append({"operation": "unsupported"})
    writer = io.StringIO()
    serve(io.StringIO("\n".join(json.dumps(line) for line in lines) + "\n"), writer)
    outputs = [json.loads(line) for line in writer.getvalue().splitlines()]
    assert len([line for line in outputs if "result" in line]) == 4
    assert outputs[-1]["error"] == "Unknown Python worker operation"
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
        score = float(
            any(
                policy["instructions"] == "Improved instructions"
                for policy in payload["components"]["stages"].values()
            )
        )
        return [
            {"score": score, "caseId": case["id"], "feedback": "Concrete fixed check evidence"}
            for case in payload["cases"]
        ]

    result = learn(
        {
            "candidate": candidate(),
            "cases": [{"id": "train", "role": "training"}, {"id": "val", "role": "validation"}],
            "campaignEvidence": None,
            "maxTrials": 4,
        },
        exchange,
    )
    assert any(
        policy["instructions"] == "Improved instructions"
        for value in result["candidates"]
        for policy in value["stages"].values()
    )
    assert evaluated
