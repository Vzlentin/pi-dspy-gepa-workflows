"""Fixed shipping-campaign workflow declared as one DSPy module.

Every stage is one fresh Pi session: the host opens it, Pi runs its own tools, and the
final assistant message is the LM response that DSPy parses into the stage's typed output.
The host owns state, stage order, checks, the independent evaluator, authority, and completion.
"""

from typing import Literal

import dspy
from dspy.core.types import LMOutput, LMRequest, LMResponse, LMTextPart
from dspy.utils.exceptions import AdapterParseError
from pydantic import BaseModel, ConfigDict, Field, ValidationError

STAGES = ("plan", "implement", "review", "fix")
REVIEW_INPUTS = ("inheritedInstructions", "brief", "evidence")
REPAIR_PROMPT = (
    "Your previous reply did not contain the required JSON object. "
    "Reply with only that JSON object, following the field structure from the instructions."
)


class Plan(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    plan: str
    criteria: list[str]
    commands: list[str]
    blocker: str = ""


class Report(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    summary: str
    notes: list[str]
    blocker: str = ""


class Review(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, serialize_by_alias=True)
    schema_id: Literal["pi-dspy-gepa.review.v1"] = Field(alias="schema")
    completeness: bool
    correctness: bool
    maintainability: bool
    findings: str


class PlanStage(dspy.Signature):
    """Inspect the repository in a fresh read-only Pi session and return one complete plan."""

    inheritedInstructions: str = dspy.InputField()
    brief: str = dspy.InputField()
    plan: Plan = dspy.OutputField()


class WorkStage(dspy.Signature):
    """Do this stage's work in a fresh Pi session, then report it for the next stage."""

    inheritedInstructions: str = dspy.InputField()
    brief: str = dspy.InputField()
    report: Report = dspy.OutputField()


class ReviewStage(dspy.Signature):
    """Review the whole change in a fresh read-only Pi session without the author's conversation."""

    inheritedInstructions: str = dspy.InputField()
    brief: str = dspy.InputField()
    evidence: str = dspy.InputField()
    review: Review = dspy.OutputField()


OUTPUTS = {"plan": "plan", "implement": "report", "review": "review", "fix": "report"}


class PiSessionLM(dspy.BaseLM):
    """One fresh Pi session per stage; the host runs it and returns the final assistant text."""

    forward_contract = "typed_lm"

    def __init__(self, host, stage):
        super().__init__(model=f"pi/{stage}", cache=False, num_retries=0)
        self.host = host
        self.stage = stage
        self.repair = False

    def forward(self, request: LMRequest) -> LMResponse:
        # In repair mode the DSPy request is ignored: the open session is asked once more for
        # the JSON object instead of being re-prompted with the full stage inputs.
        if self.repair:
            payload = {"fresh": False, "prompt": REPAIR_PROMPT}
        else:
            messages = [(message.role, text(message)) for message in request.messages]
            *context, (role, prompt) = messages
            if role != "user":
                raise ValueError("A stage prompt must end with a user message")
            # Pi keeps its own system prompt; DSPy's system text and demonstrations lead the
            # single user prompt of the fresh session.
            preamble = [
                content if role == "system" else f"Example {role} message:\n{content}"
                for role, content in context
            ]
            payload = {"fresh": True, "prompt": "\n\n".join([*preamble, prompt])}
        response = self.host("session", payload)
        return LMResponse(
            model=self.model,
            outputs=[LMOutput(parts=[LMTextPart(text=response["text"])], finish_reason="stop")],
        )


def text(message):
    if any(not isinstance(part, LMTextPart) for part in message.parts):
        raise ValueError("Campaigns support text inputs only")
    return "".join(part.text for part in message.parts)


def predictor(policy, signature, output, output_type):
    result = dspy.Predict(signature.with_instructions(policy["instructions"]))
    result.demos = [
        dspy.Example(
            **demo["input"], **{output: output_type.model_validate(demo[output])}
        ).with_inputs(*signature.input_fields)
        for demo in policy.get("demonstrations", [])
    ]
    return result


class ShippingCampaign(dspy.Module):
    """plan -> implement -> review -> (fix -> review)* until the host accepts.

    `forward` runs the host's recorded stage until the campaign leaves `active`. The host owns
    the stage order; GEPA edits only stage instructions and review demonstrations. Only the
    host completes or blocks.
    """

    def __init__(self, candidate, host):
        super().__init__()
        stages = candidate["stages"]
        self.plan = predictor(stages["plan"], PlanStage, "plan", Plan)
        self.implement = predictor(stages["implement"], WorkStage, "report", Report)
        self.review = predictor(stages["review"], ReviewStage, "review", Review)
        self.fix = predictor(stages["fix"], WorkStage, "report", Report)
        self.host = host

    def forward(self):
        state = self.host("status", {})
        while state["status"] == "active":
            state = self.step(state["stage"])
        return state

    def step(self, name):
        inputs = self.host("inputs", {})
        if inputs["status"] != "active":
            return inputs
        predictor = getattr(self, name)
        fields = {key: inputs[key] for key in predictor.signature.input_fields}
        lm = PiSessionLM(self.host, name)
        with dspy.context(lm=lm, adapter=dspy.JSONAdapter(use_native_function_calling=False)):
            try:
                prediction = predictor(**fields)
            except (AdapterParseError, ValidationError):
                # One repair turn in the same session keeps the stage's context and isolation.
                lm.repair = True
                prediction = predictor(**fields)
        output = getattr(prediction, OUTPUTS[name]).model_dump()
        return self.host("record", {"input": fields, "output": output, "trace": lm.history})


def campaign(candidate, host):
    return ShippingCampaign(candidate, host).forward()
