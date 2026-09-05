import io
import json

import pytest

from pi_dspy_gepa.learning import CampaignAdapter, components, learn, texts
from pi_dspy_gepa.program import REPAIR_PROMPT, STAGES, Report, ShippingCampaign, campaign
from pi_dspy_gepa.worker import serve

REVIEW = {
    "schema": "pi-dspy-gepa.review.v1",
    "completeness": True,
    "correctness": False,
    "maintainability": True,
    "findings": "Fix the edge case.",
}
OUTPUTS = {
    "plan": {"plan": {"plan": "Do it", "criteria": ["done"], "commands": ["true"], "blocker": ""}},
    "implement": {"report": {"summary": "Implemented", "notes": ["n1"], "blocker": ""}},
    "review": {"review": REVIEW},
    "fix": {"report": {"summary": "Fixed", "notes": [], "blocker": ""}},
}
NEXT = {"plan": "implement", "implement": "review", "review": "fix", "fix": "review"}


def candidate():
    value = {"stages": {stage: {"instructions": f"Perform {stage} precisely."} for stage in STAGES}}
    value["stages"]["review"]["demonstrations"] = []
    return value


class Host:
    """Deterministic campaign host: owns the stage order and records every exchange with its stage."""

    def __init__(self, stage="plan", responses=None, verdicts=(False, True)):
        self.state = {"status": "active", "stage": stage}
        self.calls = []
        self.responses = list(responses or [])
        self.verdicts = list(verdicts)
        self.sessions = []

    def __call__(self, kind, payload):
        stage = self.state["stage"]
        self.calls.append((kind, {"stage": stage, **payload}))
        if kind == "status":
            return dict(self.state)
        if kind == "inputs":
            inputs = {"inheritedInstructions": "rules", "brief": "goal", **self.state}
            if stage == "review":
                inputs["evidence"] = "diff and checks"
            return inputs
        if kind == "session":
            self.sessions.append(self.calls[-1][1])
            if self.responses:
                return {"text": self.responses.pop(0)}
            return {"text": json.dumps(OUTPUTS[stage])}
        assert kind == "record"
        if stage == "review" and self.verdicts.pop(0):
            self.state["status"] = "completed"
        elif payload["output"].get("blocker"):
            self.state["status"] = "blocked"
        else:
            self.state["stage"] = NEXT[stage]
        return dict(self.state)


def stages(host):
    return [payload["stage"] for kind, payload in host.calls if kind == "record"]


def test_forward_declares_plan_implement_review_fix_review_in_fresh_sessions():
    host = Host()
    result = campaign(candidate(), host)
    assert result["status"] == "completed"
    assert stages(host) == ["plan", "implement", "review", "fix", "review"]
    assert all(session["fresh"] for session in host.sessions)
    assert [session["stage"] for session in host.sessions] == stages(host)
    for session in host.sessions:
        assert f"Perform {session['stage']} precisely" in session["prompt"]
        assert "goal" in session["prompt"]
    assert "diff and checks" in host.sessions[2]["prompt"]
    assert {name for name, _ in ShippingCampaign(candidate(), host).named_predictors()} == set(
        STAGES
    )
    recorded = [payload for kind, payload in host.calls if kind == "record"]
    assert recorded[0]["output"] == OUTPUTS["plan"]["plan"]
    assert recorded[2]["output"] == REVIEW
    assert set(recorded[2]["input"]) == {"inheritedInstructions", "brief", "evidence"}


@pytest.mark.parametrize(
    "stage,expected",
    [
        ("implement", ["implement", "review", "fix", "review"]),
        ("review", ["review", "fix", "review"]),
        ("fix", ["fix", "review", "fix", "review"]),
    ],
)
def test_resume_restarts_the_recorded_stage_without_replay(stage, expected):
    host = Host(stage=stage)
    campaign(candidate(), host)
    assert stages(host) == expected


def test_repairs_a_missing_json_object_in_the_same_session_once():
    host = Host(responses=["I will plan this now.", json.dumps(OUTPUTS["plan"])])
    campaign(candidate(), host)
    assert host.sessions[0]["fresh"] is True
    assert host.sessions[1] == {"stage": "plan", "fresh": False, "prompt": REPAIR_PROMPT}
    assert host.sessions[2]["stage"] == "implement"
    with pytest.raises(Exception):
        campaign(candidate(), Host(responses=["no json", "still no json"]))


def test_blockers_and_pauses_stop_the_workflow_without_further_sessions():
    blocked = Host(
        responses=[
            json.dumps({"plan": {"plan": "?", "criteria": [], "commands": [], "blocker": "Which"}})
        ]
    )
    assert campaign(candidate(), blocked)["status"] == "blocked"
    assert len(blocked.sessions) == 1

    class Paused(Host):
        def __call__(self, kind, payload):
            result = super().__call__(kind, payload)
            if kind == "record" and self.calls[-1][1]["stage"] == "implement":
                self.state["status"] = "paused"
            return result

    paused = Paused()
    assert campaign(candidate(), paused)["status"] == "paused"
    assert stages(paused) == ["plan", "implement"]


def test_review_demonstrations_reach_only_the_review_session():
    value = candidate()
    value["stages"]["review"]["demonstrations"] = [
        {
            "input": {"inheritedInstructions": "r", "brief": "b", "evidence": "e"},
            "review": {**REVIEW, "findings": "Demonstrated finding"},
        }
    ]
    host = Host(verdicts=(True,))
    campaign(value, host)
    assert "Demonstrated finding" in host.sessions[2]["prompt"]
    assert all("Demonstrated finding" not in s["prompt"] for s in host.sessions[:2])
    assert components(texts(value)) == value


@pytest.mark.parametrize(
    "field,value",
    [
        ("code", "evil"),
        ("plan.instructions", ""),
        ("implement.demonstrations", "[]"),
        ("review.demonstrations", "{}"),
        ("review.demonstrations", '[{"input":{},"review":{}}]'),
        (
            "review.demonstrations",
            json.dumps(
                [
                    {
                        "input": {"inheritedInstructions": "r", "brief": "b", "evidence": "e"},
                        "review": {"schema": "other"},
                    }
                ]
            ),
        ),
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


def test_learning_uses_standalone_gepa_with_five_text_components(monkeypatch):
    def optimize(**kwargs):
        assert kwargs["max_metric_calls"] == 3
        assert kwargs["trainset"] == [{"role": "training"}]
        assert kwargs["valset"] == [{"role": "validation"}]
        assert kwargs["reflection_lm"]("prompt") == "reflection"
        assert len(kwargs["seed_candidate"]) == 5
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


def test_worker_drives_a_campaign_over_ndjson_and_reports_explicit_errors():
    host = Host(verdicts=(True,))
    lines = [{"operation": "campaign", "candidate": candidate()}]
    # Replay the host protocol: every request the worker will make gets its scripted answer.
    for kind, payload in (("status", {}),):
        lines.append({"result": host(kind, payload)})
    script = [
        ("inputs", {}),
        ("session", {}),
        ("record", {"output": OUTPUTS["plan"]["plan"]}),
        ("inputs", {}),
        ("session", {}),
        ("record", {"output": OUTPUTS["implement"]["report"]}),
        ("inputs", {}),
        ("session", {}),
        ("record", {"output": REVIEW}),
    ]
    for kind, payload in script:
        lines.append({"result": host(kind, payload)})
    lines.append({"operation": "unsupported"})
    writer = io.StringIO()
    serve(io.StringIO("\n".join(json.dumps(line) for line in lines) + "\n"), writer)
    outputs = [json.loads(line) for line in writer.getvalue().splitlines()]
    requests = [line for line in outputs if line["schema"] == "pi-dspy-gepa.python-request.v1"]
    assert [line["kind"] for line in requests][:4] == ["status", "inputs", "session", "record"]
    responses = [line for line in outputs if line["schema"] == "pi-dspy-gepa.python-response.v1"]
    assert responses[0]["result"]["status"] == "completed"
    assert responses[1]["error"] == "Unknown Python worker operation"
    with pytest.raises(ValueError):
        Report.model_validate({"summary": "x", "notes": [], "approve": True})


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
