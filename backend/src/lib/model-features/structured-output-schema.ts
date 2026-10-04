import { z } from 'zod';

// JSON schema for a model's structured reply, from a `/shared` Zod schema,
// whether a provider enforces it or a prompt describes it. Keeps only types,
// properties, items, `anyOf`, `enum`, `const` and descriptions, with every
// property required and no extra properties. Length and range limits are
// dropped here and enforced when the feature's normaliser parses the reply.
// (The SDK's own helper also moves `enum` and `const` into descriptions,
// which would leave the outcome discriminator unenforced.)

type JsonSchema = Record<string, unknown>;

const KEPT_KEYWORDS = ['type', 'description', 'enum', 'const'] as const;

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strict(node: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants)) {
    out.anyOf = variants.filter(isSchema).map(strict);
  }
  for (const keyword of KEPT_KEYWORDS) {
    if (keyword in node) out[keyword] = node[keyword];
  }
  if (node.type === 'object') {
    const properties = isSchema(node.properties) ? node.properties : {};
    out.properties = Object.fromEntries(
      Object.entries(properties)
        .filter((entry): entry is [string, JsonSchema] => isSchema(entry[1]))
        .map(([key, value]) => [key, strict(value)]),
    );
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  if (node.type === 'array' && isSchema(node.items)) {
    out.items = strict(node.items);
  }
  return out;
}

export function toStructuredOutputSchema(schema: z.ZodType): JsonSchema {
  return strict(z.toJSONSchema(schema, { reused: 'inline' }));
}
