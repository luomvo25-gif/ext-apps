import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
  StandardTypedV1,
} from "@standard-schema/spec";

export type { StandardJSONSchemaV1, StandardSchemaV1, StandardTypedV1 };

/**
 * A schema that implements both Standard Schema (validation) and Standard JSON
 * Schema (serialization). Zod ≥3.25, ArkType, and Valibot (via
 * `@valibot/to-json-schema`) all satisfy this.
 *
 * Mirrors the type of the same name in `@modelcontextprotocol/core` v2 so that
 * bumping to that package later is a drop-in import swap.
 *
 * @see https://standardschema.dev/
 * @see https://github.com/modelcontextprotocol/typescript-sdk/pull/1689
 */
export interface StandardSchemaWithJSON<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output> &
    StandardJSONSchemaV1.Props<Input, Output>;
}

export namespace StandardSchemaWithJSON {
  export type InferInput<S extends StandardTypedV1> =
    StandardTypedV1.InferInput<S>;
  export type InferOutput<S extends StandardTypedV1> =
    StandardTypedV1.InferOutput<S>;
}

/** JSON-Schema target draft used for tool input/output schemas (matches core MCP). */
const TARGET = { target: "draft-2020-12" } as const;

/**
 * Serialize a Standard Schema to JSON Schema for the given direction.
 * Thin wrapper around `~standard.jsonSchema.{input,output}` that fixes the
 * target to draft-2020-12 (the dialect MCP `Tool.inputSchema`/`outputSchema`
 * uses).
 */
export function standardSchemaToJsonSchema(
  schema: StandardSchemaWithJSON,
  io: "input" | "output",
): Record<string, unknown> {
  return schema["~standard"].jsonSchema[io](TARGET);
}

/**
 * Validate a value against a Standard Schema. Returns the parsed value on
 * success or throws with a formatted issue list on failure.
 */
export async function validateStandardSchema<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<StandardSchemaV1.InferOutput<S>> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) {
    const msg = result.issues
      .map((i) => {
        const path = i.path
          ?.map((p) => (typeof p === "object" ? p.key : p))
          .join(".");
        return path ? `${path}: ${i.message}` : i.message;
      })
      .join("; ");
    throw new Error(msg);
  }
  return result.value;
}
