import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { AGGREGATES, EVENT_RULES } from "../src/constants.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("schema 与 constants 的事件、聚合枚举保持一致", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  const schemaEvents = schema.$defs.eventType.enum;
  const codeEvents = Object.keys(EVENT_RULES);
  assert.deepEqual([...schemaEvents].sort(), [...codeEvents].sort());

  const schemaAggregates = schema.$defs.aggregateType.enum;
  const codeAggregates = Object.values(AGGREGATES);
  assert.deepEqual([...schemaAggregates].sort(), [...codeAggregates].sort());
});
