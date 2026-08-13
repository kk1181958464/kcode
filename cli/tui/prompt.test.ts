import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  editPromptValue,
  matchingCommands,
  TerminalPrompt,
  type PromptCommand,
} from "./prompt";
import type { WriteSink } from "./renderer";
import { visibleWidth } from "./ansi";

const commands: PromptCommand[] = [
  { name: "/help", desc: "显示命令" },
  { name: "/model", desc: "切换模型" },
  { name: "/mode", desc: "切换权限" },
];

class FakeInput extends EventEmitter {
  isTTY = true;
  rawModes: boolean[] = [];
  setRawMode(value: boolean): this {
    this.rawModes.push(value);
    return this;
  }
  resume(): this {
    return this;
  }
}

class Sink implements WriteSink {
  output = "";
  columns = 60;
  rows = 18;
  write(data: string): void {
    this.output += data;
  }
}

const key = (
  input: FakeInput,
  value: string,
  props: { name?: string; sequence?: string; ctrl?: boolean } = {},
) => input.emit("keypress", value, { sequence: value, ...props });

test("prompt command matching opens for a bare slash", () => {
  assert.deepEqual(
    matchingCommands("/", commands).map((item) => item.name),
    ["/help", "/model", "/mode"],
  );
  assert.deepEqual(
    matchingCommands("/mo", commands).map((item) => item.name),
    ["/model", "/mode"],
  );
  assert.deepEqual(matchingCommands("hello", commands), []);
});

test("prompt editor inserts, navigates and deletes without parent state", () => {
  let state = { value: "ab", cursor: 2, selectedCommand: 0 };
  state = editPromptValue(state, { name: "left" });
  state = editPromptValue(state, { sequence: "你" });
  assert.deepEqual(state, { value: "a你b", cursor: 2, selectedCommand: 0 });
  state = editPromptValue(state, { name: "backspace" });
  assert.deepEqual(state, { value: "ab", cursor: 1, selectedCommand: 0 });
  state = editPromptValue(state, { name: "delete" });
  assert.deepEqual(state, { value: "a", cursor: 1, selectedCommand: 0 });
});

test("interactive prompt shows slash commands and selects with arrows", async () => {
  const input = new FakeInput();
  const sink = new Sink();
  const prompt = new TerminalPrompt({
    input: input as unknown as NodeJS.ReadStream,
    output: sink,
  });
  const pending = prompt.ask({ placeholder: "输入任务", commands });

  key(input, "/");
  assert.match(sink.output, /\/help/);
  assert.match(sink.output, /\/model/);
  key(input, "", { name: "down", sequence: "\x1b[B" });
  key(input, "", { name: "tab", sequence: "\t" });
  key(input, "", { name: "return", sequence: "\r" });

  assert.equal(await pending, "/model ");
  assert.deepEqual(input.rawModes, [true, false]);
});

test("interactive secret prompt never writes the secret", async () => {
  const input = new FakeInput();
  const sink = new Sink();
  const prompt = new TerminalPrompt({
    input: input as unknown as NodeJS.ReadStream,
    output: sink,
  });
  const pending = prompt.ask({ label: "API Key", secret: true });
  for (const ch of "sk-secret") key(input, ch);
  key(input, "", { name: "return", sequence: "\r" });

  assert.equal(await pending, "sk-secret");
  assert.ok(!sink.output.includes("sk-secret"));
  assert.match(sink.output, /••••/);
});

test("background notifications preserve the active prompt value", async () => {
  const input = new FakeInput();
  const sink = new Sink();
  const prompt = new TerminalPrompt({
    input: input as unknown as NodeJS.ReadStream,
    output: sink,
  });
  const pending = prompt.ask({ placeholder: "输入任务", commands });

  for (const ch of "继续修复") key(input, ch);
  prompt.notify(
    "发现 KCode CLI 新版本 0.1.8\n更新命令：npm install -g @kk1181958464/kcode@latest",
  );
  key(input, "", { name: "return", sequence: "\r" });

  assert.equal(await pending, "继续修复");
  assert.match(sink.output, /新版本 0\.1\.8/);
  assert.match(sink.output, /继续修复/);
});

test("notifications received between prompts are shown on the next prompt", async () => {
  const input = new FakeInput();
  const sink = new Sink();
  const prompt = new TerminalPrompt({
    input: input as unknown as NodeJS.ReadStream,
    output: sink,
  });

  prompt.notify("发现 KCode CLI 新版本 0.1.8");
  const pending = prompt.ask({ placeholder: "输入任务" });
  key(input, "确");
  key(input, "认");
  key(input, "", { name: "return", sequence: "\r" });

  assert.equal(await pending, "确认");
  assert.match(sink.output, /新版本 0\.1\.8/);
});

test("prompt rendering does not emit visible rows wider than the terminal", async () => {
  const input = new FakeInput();
  const sink = new Sink();
  sink.columns = 28;
  const writes: string[] = [];
  sink.write = (data: string) => {
    writes.push(data);
    sink.output += data;
  };
  const prompt = new TerminalPrompt({
    input: input as unknown as NodeJS.ReadStream,
    output: sink,
  });
  const pending = prompt.ask({
    label: "非常长的输入标题用于测试终端宽度",
    placeholder: "输入非常长的任务描述",
    commands,
  });
  key(input, "/");
  key(input, "", { name: "return", sequence: "\r" });
  await pending;

  for (const write of writes) {
    for (const line of write.split(/\r?\n/)) {
      const printable = line
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
        .replace(/\r/g, "");
      assert.ok(visibleWidth(printable) <= 28, printable);
    }
  }
});

test("prompt keeps long input and its cursor inside the box", async () => {
  const input = new FakeInput();
  const sink = new Sink();
  sink.columns = 24;
  const prompt = new TerminalPrompt({
    input: input as unknown as NodeJS.ReadStream,
    output: sink,
  });
  const pending = prompt.ask({ placeholder: "输入任务" });
  for (const ch of "这是一个很长很长的中文任务描述") key(input, ch);
  key(input, "", { name: "return", sequence: "\r" });

  assert.equal(await pending, "这是一个很长很长的中文任务描述");
  assert.ok(!sink.output.includes("undefined"));
});

test("select keeps the active option inside a bounded visible window", async () => {
  const input = new FakeInput();
  const sink = new Sink();
  sink.rows = 9;
  const prompt = new TerminalPrompt({
    input: input as unknown as NodeJS.ReadStream,
    output: sink,
  });
  const options = Array.from({ length: 20 }, (_, index) => ({
    label: `模型 ${index + 1}`,
    value: index + 1,
  }));
  const pending = prompt.select("选择模型", options);
  for (let index = 0; index < 12; index++)
    key(input, "", { name: "down", sequence: "\x1b[B" });
  assert.match(sink.output, /13/);
  assert.match(sink.output, /20/);
  key(input, "", { name: "return", sequence: "\r" });

  assert.equal(await pending, 13);
});
