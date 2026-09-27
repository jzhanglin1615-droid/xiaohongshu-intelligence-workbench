function normalize(values) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function firstCsvCell(line) {
  const source = line.replace(/^\ufeff/, "").trim();
  if (!source.startsWith('"')) return source.split(",")[0]?.trim() ?? "";
  let value = "";
  for (let index = 1; index < source.length; index += 1) {
    if (source[index] === '"' && source[index + 1] === '"') { value += '"'; index += 1; continue; }
    if (source[index] === '"') break;
    value += source[index];
  }
  return value.trim();
}

export function parseKeywordTaskFile(filename, text) {
  const lower = filename.toLowerCase();
  let values;
  if (lower.endsWith(".json")) {
    const parsed = JSON.parse(text);
    const source = Array.isArray(parsed) ? parsed : parsed.keywords ?? parsed.seeds ?? parsed.tasks;
    if (!Array.isArray(source)) throw new Error("JSON 需要是数组，或包含 keywords/seeds/tasks 数组");
    values = source.map((item) => typeof item === "string" ? item : item?.keyword ?? item?.seed ?? item?.name);
  } else if (lower.endsWith(".csv")) {
    values = text.split(/\r?\n/).map(firstCsvCell);
    if (/^(keyword|seed|关键词|种子词)$/i.test(values[0] ?? "")) values.shift();
  } else if (lower.endsWith(".txt")) values = text.split(/\r?\n/);
  else throw new Error("只支持 TXT、CSV 或 JSON 任务文件");
  const keywords = normalize(values);
  if (!keywords.length) throw new Error("任务文件没有可用关键词");
  return keywords;
}
