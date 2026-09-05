import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import {
  AcceptanceSchema,
  AllowanceSchema,
  AuthoritySchema,
  validate,
} from "../state/contracts.js";

const ConfigAllowance = Type.Object(
  {
    ...AllowanceSchema.properties,
    concurrency: Type.Optional(AllowanceSchema.properties.concurrency),
  },
  { additionalProperties: false },
);
const ConfigSchema = Type.Object(
  {
    schema: Type.Literal("pi-dspy-gepa.launch.v1"),
    constraints: Type.Optional(Type.Array(Type.String())),
    authority: Type.Optional(AuthoritySchema),
    acceptance: Type.Optional(AcceptanceSchema),
    allowance: Type.Optional(ConfigAllowance),
    casesFile: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export async function loadConfig(file?: string) {
  const config = validate(
    ConfigSchema,
    file ? JSON.parse(await readFile(file, "utf8")) : { schema: "pi-dspy-gepa.launch.v1" },
  );
  const { allowance, ...rest } = config;
  return {
    ...rest,
    ...(allowance ? { allowance: { ...allowance, concurrency: allowance.concurrency ?? 1 } } : {}),
  };
}
