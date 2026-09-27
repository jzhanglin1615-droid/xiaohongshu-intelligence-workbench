import assert from "node:assert/strict";
import test from "node:test";
import { parseKeywordTaskFile } from "./task-file-parser.js";

test("TXT task files normalize and deduplicate keywords", () => {
  assert.deepEqual(parseKeywordTaskFile("tasks.txt", " 词一\r\n词二\n词一\n"), ["词一", "词二"]);
});

test("CSV task files accept a header and quoted first column", () => {
  assert.deepEqual(parseKeywordTaskFile("tasks.csv", "关键词,备注\n\"词,一\",a\n词二,b"), ["词,一", "词二"]);
});

test("JSON task files accept object rows and reject unsupported shapes", () => {
  assert.deepEqual(parseKeywordTaskFile("tasks.json", JSON.stringify({ tasks: [{ keyword: "词一" }, { name: "词二" }] })), ["词一", "词二"]);
  assert.throws(() => parseKeywordTaskFile("tasks.json", "{}"), /keywords\/seeds\/tasks/);
});
