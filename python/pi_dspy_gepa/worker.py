"""Persistent NDJSON worker. No code loading, tool execution, or operation replay."""

import contextlib
import json
import sys
import traceback

from .learning import learn
from .program import campaign


def serve(reader, writer):
    def send(value):
        writer.write(json.dumps(value, default=str) + "\n")
        writer.flush()

    def exchange(kind, payload):
        send({"schema": "pi-dspy-gepa.python-request.v1", "kind": kind, "payload": payload})
        line = reader.readline()
        if not line:
            raise RuntimeError("Campaign host disconnected; resume explicitly")
        response = json.loads(line)
        if response.get("error"):
            raise RuntimeError(response["error"])
        return response["result"]

    for line in reader:
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                if request["operation"] == "campaign":
                    result = campaign(request["candidate"], exchange)
                elif request["operation"] == "learn":
                    result = learn(request, exchange)
                else:
                    raise ValueError("Unknown Python worker operation")
            send({"schema": "pi-dspy-gepa.python-response.v1", "result": result})
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            send({"schema": "pi-dspy-gepa.python-response.v1", "error": str(error)})


if __name__ == "__main__":
    serve(sys.stdin, sys.stdout)
