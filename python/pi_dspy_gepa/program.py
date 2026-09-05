from typing import Any

import dspy
from dspy.core.types import LMOutput, LMRequest, LMResponse, LMTextPart
from pydantic import BaseModel, ConfigDict


class ToolCall(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str
    name: str
    arguments: dict[str, Any]


class Action(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    text: str
    toolCalls: list[ToolCall]


class NextAction(dspy.Signature):
    """Choose the next assistant action. The host owns execution and completion."""

    inheritedInstructions: str = dspy.InputField()
    brief: str = dspy.InputField()
    context: str = dspy.InputField()
    tools: str = dspy.InputField()
    action: Action = dspy.OutputField()


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


class CampaignProgram(dspy.Module):
    def __init__(self, candidate):
        super().__init__()
        self.next = dspy.Predict(NextAction.with_instructions(candidate["instructions"]))
        self.next.demos = [
            dspy.Example(**demo["input"], action=Action.model_validate(demo["action"])).with_inputs(
                "inheritedInstructions", "brief", "context", "tools"
            )
            for demo in candidate["demonstrations"]
        ]

    def forward(self, **inputs):
        return self.next(**inputs)


def decide(candidate, inputs, exchange):
    lm = PiLM(exchange)
    with dspy.context(lm=lm, adapter=dspy.JSONAdapter(use_native_function_calling=False)):
        prediction = CampaignProgram(candidate)(**inputs)
    return {"action": prediction.action.model_dump(), "trace": lm.history}
