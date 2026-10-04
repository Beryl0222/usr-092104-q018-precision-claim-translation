/**
 * 零依赖的 JSON Schema（draft 2020-12 子集）校验器。
 * 支持本仓库契约实际用到的关键字：type / properties / required / enum / const /
 * items / minItems / minLength / minimum / additionalProperties / allOf / if-then /
 * $ref（仅 #/$defs）/ format: date-time。
 * 返回错误信息数组，空数组表示通过。
 */

const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function resolveRef(root, ref) {
  const m = /^#\/\$defs\/(.+)$/.exec(ref);
  if (!m) throw new Error(`不支持的 $ref：${ref}`);
  return root.$defs[m[1]];
}

function checkType(value, type) {
  if (Array.isArray(type)) return type.some((t) => checkType(value, t));
  if (value === null) return type === "null";
  if (type === "integer") return Number.isInteger(value);
  if (type === "array") return Array.isArray(value);
  if (type === "object") return typeof value === "object" && !Array.isArray(value);
  return typeof value === type;
}

function validateNode(schema, value, root, path, errors) {
  if (schema.$ref) schema = resolveRef(root, schema.$ref);

  if (schema.type && !checkType(value, schema.type)) {
    errors.push(`${path} 类型应为 ${schema.type}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} 不在允许取值内：${JSON.stringify(value)}`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path} 必须等于 ${JSON.stringify(schema.const)}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path} 长度不得小于 ${schema.minLength}`);
    }
    if (schema.format === "date-time" && !DATETIME.test(value)) {
      errors.push(`${path} 不是合法的 date-time：${value}`);
    }
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path} 不得小于 ${schema.minimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path} 至少包含 ${schema.minItems} 项`);
    }
    if (schema.items) {
      value.forEach((item, i) => validateNode(schema.items, item, root, `${path}[${i}]`, errors));
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path} 缺少字段：${key}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${path} 不允许额外字段：${key}`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) validateNode(sub, value[key], root, `${path}.${key}`, errors);
    }
  }
  if (schema.if) {
    if (valueSatisfiesIf(schema.if, value, root) && schema.then) {
      validateNode(schema.then, value, root, path, errors);
    }
  }
  for (const branch of schema.allOf ?? []) {
    validateNode(branch, value, root, path, errors);
  }
}

/** 仅判断 if 分支是否命中（if 只写 properties+required 形式时可用结构判断）。 */
function valueSatisfiesIf(ifSchema, value, root) {
  if (ifSchema.$ref) ifSchema = resolveRef(root, ifSchema.$ref);
  if (typeof value !== "object" || value === null) return false;
  for (const key of ifSchema.required ?? []) {
    if (!(key in value)) return false;
  }
  for (const [key, sub] of Object.entries(ifSchema.properties ?? {})) {
    if (!(key in value)) continue;
    const expect = sub.$ref ? resolveRef(root, sub.$ref) : sub;
    if (expect.const !== undefined && value[key] !== expect.const) return false;
  }
  return true;
}

/** 按契约 schema 校验单条记录，返回错误信息数组。 */
export function validateAgainstSchema(schema, record) {
  const errors = [];
  validateNode(schema, record, schema, "$", errors);
  return errors;
}
