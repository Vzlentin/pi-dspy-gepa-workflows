import json

from gepa import optimize
from gepa.core.adapter import EvaluationBatch

from .program import REVIEW_INPUTS, STAGES, Review

FIELDS = tuple(f"{stage}.instructions" for stage in STAGES) + ("review.demonstrations",)


def components(candidate):
    if set(candidate) != set(FIELDS):
        raise ValueError("GEPA may change only stage instructions and review demonstrations")
    stages = {}
    for stage in STAGES:
        instructions = candidate[f"{stage}.instructions"]
        if not isinstance(instructions, str) or not instructions.strip():
            raise ValueError("Instructions must be nonempty text")
        stages[stage] = {"instructions": instructions}
    examples = json.loads(candidate["review.demonstrations"])
    if not isinstance(examples, list):
        raise ValueError("Demonstrations must be an array")
    for example in examples:
        if set(example) != {"input", "review"} or set(example["input"]) != set(REVIEW_INPUTS):
            raise ValueError("Invalid review demonstration fields")
        if not all(isinstance(value, str) for value in example["input"].values()):
            raise ValueError("Demonstration inputs must be text")
        Review.model_validate(example["review"])
    stages["review"]["demonstrations"] = examples
    return {"stages": stages}


def texts(candidate):
    stages = candidate["stages"]
    result = {f"{stage}.instructions": stages[stage]["instructions"] for stage in STAGES}
    result["review.demonstrations"] = json.dumps(stages["review"]["demonstrations"])
    return result


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
