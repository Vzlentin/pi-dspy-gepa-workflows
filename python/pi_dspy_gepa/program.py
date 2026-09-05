from typing import Any, Literal

import dspy
from dspy.core.types import LMOutput, LMRequest, LMResponse, LMTextPart
from pydantic import BaseModel, ConfigDict, Field

STAGES = ("plan", "implement", "review", "fix")
INPUTS = ("inheritedInstructions", "brief", "context", "tools")


class ToolCall(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str
    name: str
    arguments: dict[str, Any]


class Action(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    text: str
    toolCalls: list[ToolCall]


class Review(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, serialize_by_alias=True)
    schema_id: Literal["pi-dspy-gepa.review.v1"] = Field(alias="schema")
    completeness: bool
    correctness: bool
    maintainability: bool
    findings: str


class NextAction(dspy.Signature):
    """Choose an action in the host's current stage, never a new workflow or authority."""

    inheritedInstructions: str = dspy.InputField()
    brief: str = dspy.InputField()
    context: str = dspy.InputField()
    tools: str = dspy.InputField()
    action: Action = dspy.OutputField()


class ReviewChange(dspy.Signature):
    """Review the complete change in clean context without tools or author conversation."""

    inheritedInstructions: str = dspy.InputField()
    brief: str = dspy.InputField()
    context: str = dspy.InputField()
    tools: str = dspy.InputField()
    review: Review = dspy.OutputField()


class PiLM(dspy.BaseLM):
    forward_contract = "typed_lm"

    def __init__(self, exchange):
        super().__init__(model="pi/campaign", cache=False, num_retries=0)
        self.exchange = exchange

    def forward(self, request: LMRequest) -> LMResponse:
        messages = []
        for message in request.messages:
            if any(not isinstance(part, LMTextPart) for part in message.parts):
                raise ValueError("Campaigns support text inputs only")
            messages.append(
                {"role": message.role, "content": "".join(p.text for p in message.parts)}
            )
        response = self.exchange("model", {"messages": messages})
        return LMResponse(
            model=self.model,
            outputs=[LMOutput(parts=[LMTextPart(text=response["text"])], finish_reason="stop")],
            usage=response.get("usage"),
            cost=response.get("cost"),
        )


def predictor(policy, signature, output, output_type):
    result = dspy.Predict(signature.with_instructions(policy["instructions"]))
    result.demos = [
        dspy.Example(
            **demo["input"], **{output: output_type.model_validate(demo[output])}
        ).with_inputs(*INPUTS)
        for demo in policy["demonstrations"]
    ]
    return result


class CampaignProgram(dspy.Module):
    """Declare plan -> implement -> review -> fix -> review; Pi executes and persists it.

    Each forward call advances one stage action. Tool results return through Pi, not
    a second Python execution loop. Only the host can finish a stage or the campaign.
    """

    def __init__(self, candidate):
        super().__init__()
        stages = candidate["stages"]
        self.plan = predictor(stages["plan"], NextAction, "action", Action)
        self.implement = predictor(stages["implement"], NextAction, "action", Action)
        self.review = predictor(stages["review"], ReviewChange, "review", Review)
        self.fix = predictor(stages["fix"], NextAction, "action", Action)

    def forward(self, stage, **inputs):
        if stage not in STAGES:
            raise ValueError(f"Unknown workflow stage: {stage}")
        return getattr(self, stage)(**inputs)


def decide(candidate, stage, inputs, exchange):
    lm = PiLM(exchange)
    with dspy.context(lm=lm, adapter=dspy.JSONAdapter(use_native_function_calling=False)):
        prediction = CampaignProgram(candidate)(stage=stage, **inputs)
    output = "review" if stage == "review" else "action"
    return {output: getattr(prediction, output).model_dump(), "trace": lm.history}
