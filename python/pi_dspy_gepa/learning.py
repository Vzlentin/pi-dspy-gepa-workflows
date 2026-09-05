import json

from gepa import optimize
from gepa.core.adapter import EvaluationBatch

from .program import INPUTS, STAGES, Action, Review


def components(candidate):
    expected = {
        f"{stage}.{field}" for stage in STAGES for field in ("instructions", "demonstrations")
    }
    if set(candidate) != expected:
        raise ValueError("GEPA may change only stage instructions and demonstrations")
    stages = {}
    for stage in STAGES:
        instructions = candidate[f"{stage}.instructions"]
        if not isinstance(instructions, str) or not instructions.strip():
            raise ValueError("Instructions must be nonempty text")
        examples = json.loads(candidate[f"{stage}.demonstrations"])
        if not isinstance(examples, list):
            raise ValueError("Demonstrations must be an array")
        output = "review" if stage == "review" else "action"
        output_type = Review if stage == "review" else Action
        for example in examples:
            if set(example) != {"input", output} or set(example["input"]) != set(INPUTS):
                raise ValueError("Invalid stage demonstration fields")
            if not all(isinstance(value, str) for value in example["input"].values()):
                raise ValueError("Demonstration inputs must be text")
            output_type.model_validate(example[output])
        stages[stage] = {"instructions": instructions, "demonstrations": examples}
    return {"stages": stages}


def texts(candidate):
    return {
        f"{stage}.{field}": json.dumps(value) if field == "demonstrations" else value
        for stage, policy in candidate["stages"].items()
        for field, value in policy.items()
    }


class CampaignAdapter:
    propose_new_texts = None

    def __init__(self, exchange, campaign_evidence):
        self.exchange = exchange
        self.campaign_evidence = campaign_evidence

    def evaluate(self, batch, candidate, capture_traces=False):
        learned = components(candidate)
        if any(case["role"] == "heldOut" for case in batch):
            raise ValueError("Held-out cases cannot enter optimization")
        results = self.exchange("evaluate", {"cases": batch, "components": learned})
        if any(result["score"] is None for result in results):
            raise ValueError("Evaluation error; missing reviewer evidence cannot be scored")
        return EvaluationBatch(
            outputs=results,
            scores=[result["score"] for result in results],
            trajectories=results if capture_traces else None,
        )

    def make_reflective_dataset(self, candidate, eval_batch, components_to_update):
        return {
            component: [
                {
                    "Inputs": result["caseId"],
                    "Outputs": result,
                    "Feedback": result["feedback"],
                    "Completed campaign evidence": self.campaign_evidence,
                }
                for result in eval_batch.trajectories
            ]
            for component in components_to_update
        }


def learn(request, exchange):
    cases = request["cases"]
    if any(case["role"] == "heldOut" for case in cases):
        raise ValueError("Held-out content is prohibited in GEPA inputs")
    seed = texts(request["candidate"])
    components(seed)
    result = optimize(
        seed_candidate=seed,
        trainset=[case for case in cases if case["role"] == "training"],
        valset=[case for case in cases if case["role"] == "validation"],
        adapter=CampaignAdapter(exchange, request["campaignEvidence"]),
        reflection_lm=lambda prompt: exchange("reflection", {"prompt": prompt})["text"],
        max_metric_calls=request["maxTrials"],
        reflection_minibatch_size=1,
        display_progress_bar=False,
        raise_on_exception=True,
    )
    return {"candidates": [components(candidate) for candidate in result.candidates]}
